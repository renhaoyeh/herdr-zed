import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { checkedExport } from './export.js';

async function chromePath() {
  const candidates = process.env.XD_CHROME_PATH ? [process.env.XD_CHROME_PATH] : process.platform === 'win32'
    ? [join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      join(process.env.PROGRAMFILES || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
      join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')]
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ...(process.env.PATH || '').split(delimiter).filter(Boolean).flatMap(p => ['google-chrome', 'chromium', 'chromium-browser'].map(n => join(p, n)))];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw Error('Chrome or Edge was not found. Set XD_CHROME_PATH to its executable.');
}

export async function verifyExport(home, input) {
  const directory = await checkedExport(home, input), executable = await chromePath();
  const manifest = JSON.parse(await readFile(join(directory, 'export.json'), 'utf8'));
  const bounds = manifest.artboard.bounds;
  const profile = await mkdtemp(join(tmpdir(), 'herdr-xd-chrome-'));
  const chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  const pending = new Map();
  let deadline;
  const exited = new Promise(resolve => { chrome.once('exit', resolve); chrome.once('error', resolve); });
  async function run() {
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = '';
      chrome.once('error', () => reject(Error('Could not start the background browser.')));
      chrome.once('exit', () => reject(Error('Background browser exited before startup.')));
      chrome.stderr.on('data', b => {
        stderr = (stderr + b).slice(-16000);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) resolve(match[1]);
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(Error('Browser connection failed.')), { once: true }); });
    let id = 0;
    socket.addEventListener('message', e => {
      const m = JSON.parse(e.data), callback = pending.get(m.id);
      if (callback) { pending.delete(m.id); m.error ? callback.reject(Error(m.error.message)) : callback.resolve(m.result); }
    });
    socket.addEventListener('close', () => { for (const p of pending.values()) p.reject(Error('Browser connection closed.')); pending.clear(); });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params = {}) => send(method, params, sessionId);
    const evaluate = async expression => {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || 'Preview script failed.');
      return r.result.value;
    };
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: Math.ceil(bounds.width + 40), height: Math.ceil(bounds.height + 200), deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise(resolve => {
      const listener = e => { const m = JSON.parse(e.data); if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { socket.removeEventListener('message', listener); resolve(); } };
      socket.addEventListener('message', listener);
    });
    await call('Page.navigate', { url: pathToFileURL(join(directory, 'index.html')).href });
    await loaded;
    const report = await evaluate('window.xdVerify()');
    report.realPointer = [];
    const ids = await evaluate(`xdPreview.controls.filter(c=>c.supported.some(e=>e.state===c.current&&e.trigger==='hover'&&e.resolved)&&c.el.getBoundingClientRect().width>0).map(c=>c.node.id)`);
    for (const nodeId of ids) {
      const select = `xdPreview.controls.find(c=>c.node.id===${JSON.stringify(nodeId)})`;
      const before = await evaluate(`(()=>{const c=${select},r=c.el.getBoundingClientRect();return {state:c.current,x:r.x+r.width/2,y:r.y+r.height/2,expected:c.supported.find(e=>e.state===c.current&&e.trigger==='hover')?.target};})()`);
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y });
      const after = await evaluate(`${select}.current`);
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      const restored = await evaluate(`${select}.current`);
      report.realPointer.push({ id: nodeId, pass: after === before.expected && restored === before.state });
    }
    await evaluate("document.querySelector('#verification').remove()");
    const clip = await evaluate(`(()=>{const r=document.querySelector('#artboard').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:0.5};})()`);
    const shot = await call('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    await writeFile(join(directory, 'preview.png'), Buffer.from(shot.data, 'base64'));
    if (await evaluate('Boolean(xdInput.images.reference)')) {
      report.visualComparison = await evaluate(`(async()=>{const a=new Image(),b=new Image();a.src='data:image/png;base64,${shot.data}';b.src=xdInput.images.reference;await Promise.all([a.decode(),b.decode()]);const c=document.createElement('canvas');c.width=b.naturalWidth;c.height=b.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(b,0,0);const expected=ctx.getImageData(0,0,c.width,c.height);ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(a,0,0,c.width,c.height);const actual=ctx.getImageData(0,0,c.width,c.height);let total=0,different=0;for(let i=0;i<actual.data.length;i+=4){let diff=0;for(let k=0;k<3;k++){const d=Math.abs(actual.data[i+k]-expected.data[i+k]);total+=d;diff+=d;}if(diff>90)different++;}return {meanAbsoluteError:total/(c.width*c.height*3),differentPixels:different,pixelCount:c.width*c.height};})()`);
    }
    report.pass = report.pass && report.brokenImages.length === 0 && report.realPointer.every(r => r.pass);
    report.complete = report.pass && report.stats.unresolved.length === 0 && report.stats.unsupported.length === 0 && manifest.warnings.length === 0;
    report.limitations = manifest.limitations;
    await writeFile(join(directory, 'verification.json'), JSON.stringify(report, null, 2));
    return { ...report, directory, preview: join(directory, 'preview.png'), report: join(directory, 'verification.json') };
  }
  try {
    return await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('XD browser verification timed out after 60 seconds.')), 60000); })]);
  } finally {
    clearTimeout(deadline);
    socket?.close();
    if (chrome.exitCode === null) chrome.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}
