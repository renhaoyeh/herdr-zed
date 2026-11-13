import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { limitations, inspectBoard } from './design.js';

export const exportRoot = home => join(home, 'data', 'herdr-zed', 'xd', 'exports');
export async function checkedExport(home, directory) {
  const root = await realpath(exportRoot(home)), target = await realpath(directory), rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Use a directory returned by export_xd in this Herdr home.');
  const marker = JSON.parse(await readFile(join(target, 'export.json'), 'utf8'));
  if (marker.version !== 1 || marker.kind !== 'herdr-xd-export') throw Error('This is not an XD export.');
  return target;
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (bytes.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw Error('Unsupported image encoding.');
}

export async function exportDesign(home, design, data) {
  const images = {}, warnings = [];
  async function image(component, key) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw Error('Invalid XD image resource ID.');
    try {
      const bytes = await design.image(component, key);
      images[key] = `data:${imageType(bytes)};base64,${bytes.toString('base64')}`;
    } catch (error) { warnings.push({ resource: key, error: error.message }); }
  }
  const thumbnail = data.board.components?.find(c => c.rel === 'thumbnail');
  if (thumbnail || design.directory) await image(thumbnail, 'reference');
  for (const uid of data.board.resources || []) await image(design.prototype.manifest.resources?.[uid], uid);
  const script = await readFile(new URL('./render.js', import.meta.url), 'utf8');
  const input = JSON.stringify({ agc: data.agc, interactions: data.interactions, globals: data.globals, images }).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'">
<title>Herdr XD preview</title><style>body{margin:0;background:#181818;color:#ddd;font:13px Arial}header{padding:16px;background:#202020}h1{font-size:16px;margin:0 0 8px}#artboard{position:relative;overflow:hidden;margin:16px}.xd-node{pointer-events:none}.state-content{position:absolute;inset:0}#original{position:absolute;inset:0;width:100%;height:100%;opacity:.5;pointer-events:none;z-index:5}#colors{display:flex;gap:12px;flex-wrap:wrap;padding:16px}#colors span{padding-left:5px}p{margin:8px 0;color:#aaa}</style>
<header><h1>XD → HTML / CSS / SVG</h1><div id="status"></div><p>Fixed coordinates. State switches have no animation interpolation.</p><label><input id="reference-toggle" type="checkbox">Overlay Adobe reference at 50%</label></header>
<div id="artboard"><img id="original" hidden alt="Adobe reference"></div><div id="colors"></div>
<script>window.xdInput=${input};</script><script>${script.replace(/<\/script/gi, '<\\/script')}</script></html>`;
  await mkdir(exportRoot(home), { recursive: true });
  const directory = await mkdtemp(join(exportRoot(home), 'xd-'));
  const report = { version: 1, kind: 'herdr-xd-export', artboard: { id: data.board.id, name: data.board.name, bounds: data.bounds },
    ...inspectBoard(data), warnings, limitations };
  await writeFile(join(directory, 'index.html'), html);
  await writeFile(join(directory, 'export.json'), JSON.stringify(report, null, 2));
  return { directory, html: join(directory, 'index.html'), report: join(directory, 'export.json'), warnings, limitations };
}
