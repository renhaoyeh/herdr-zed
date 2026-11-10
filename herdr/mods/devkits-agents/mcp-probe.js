import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { parseSharedMcp, sharedMcpSupported } from './components/shared-mcp-model.js';
import { tasksMcpServer } from './components/session-model.js';
import { commandArgv } from './components/session-shell.js';

const protocol = '2025-06-18', limit = 2 * 1024 * 1024;
export async function mcpSetupInfo() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const suggestedBridge = platform === 'windows' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'VsMcp', 'Bridge', 'VsMcp.Bridge.exe') : null;
  let bridgePath = null;
  if (suggestedBridge) try { await access(suggestedBridge); bridgePath = suggestedBridge; } catch {}
  return { platform, bridgePath, suggestedBridge };
}
function envValue(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw Error('Use environment-variable names for credentials.');
  if (!process.env[name]) throw Error(`Environment variable is unavailable: ${name}`);
  return process.env[name];
}
async function exchange(client) {
  const initialized = await client.request(1, 'initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'devkits_connection_check', version: '1.0.0' } });
  if (!['2025-06-18', '2025-03-26', '2024-11-05'].includes(initialized?.protocolVersion) || !initialized.capabilities?.tools)
    throw Error('The server did not negotiate a supported MCP tools connection.');
  client.protocol = initialized.protocolVersion;
  await client.notify('notifications/initialized');
  const result = await client.request(2, 'tools/list', {});
  if (!Array.isArray(result?.tools) || result.tools.some(tool => typeof tool?.name !== 'string')) throw Error('The server returned an invalid tool catalog.');
  return { verifiedAt: Date.now(), toolsCount: result.tools.length, serverName: String(initialized.serverInfo?.name || 'MCP server').slice(0, 80) };
}
async function stdioProbe(server, signal) {
  for (const name of server.env_vars || []) envValue(name);
  const argv = commandArgv(process.platform === 'win32' ? ['env', server.command, ...(server.args || [])] : [server.command, ...(server.args || [])], process.platform === 'win32' ? 'windows' : process.platform);
  const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    detached: process.platform !== 'win32' });
  const pending = new Map(), decoder = new StringDecoder('utf8'); let buffer = '', failure;
  const fail = error => { failure ||= error; for (const item of pending.values()) item.reject(failure); pending.clear(); };
  child.on('error', () => fail(Error('Could not start the MCP command. Check the executable and required runtime.')));
  child.on('exit', () => fail(Error('The MCP command exited before verification completed.')));
  child.stdin.on('error', () => fail(Error('The MCP command closed its input.')));
  const abort = () => fail(Error('Connection verification timed out.'));
  signal.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', chunk => {
    if (failure) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > limit) return fail(Error('MCP response exceeds the verification limit.'));
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(Error('The command did not return valid MCP messages.')); continue; }
      if (message.method === 'ping' && message.id !== undefined) { send({ id: message.id, result: {} }); continue; }
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      if (message.error) item.reject(Error('The MCP server rejected the verification request.'));
      else item.resolve(message.result);
    }
  });
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const client = { request: (id, method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    if (signal.aborted) return reject(Error('Connection verification timed out.'));
    pending.set(id, { resolve, reject }); send({ id, method, params });
  }), notify: method => send({ method }) };
  try { return await exchange(client); }
  finally {
    signal.removeEventListener('abort', abort); fail(Error('Verification finished.')); child.stdin.end();
    if (child.pid && process.platform === 'win32') {
      await new Promise(done => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 1500, windowsHide: true }, done));
    } else if (child.pid) {
      // The probe owns this process group, including any command wrappers it started.
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await new Promise(done => { const timer = setTimeout(done, 300); child.once('close', () => { clearTimeout(timer); done(); }); });
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      if (child.exitCode === null && child.signalCode === null) await new Promise(done => {
        const timer = setTimeout(done, 1000); child.once('close', () => { clearTimeout(timer); done(); });
      });
    }
  }
}
async function httpMessage(response, id) {
  if (!response.body) throw Error('The MCP endpoint returned no response.');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', bytes = 0, eventData = [];
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length; if (bytes > limit) throw Error('MCP response exceeds the verification limit.');
      buffer += decoder.decode(value, { stream: true });
      if (sse) {
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart());
          else if (!line && eventData.length) {
            const message = JSON.parse(eventData.join('\n')); eventData = [];
            if (message.id === id) return message;
          }
        }
      }
    }
    if (!sse) { const message = JSON.parse(buffer); if (message.id === id) return message; }
    throw Error('The MCP endpoint returned no matching response.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function httpProbe(server, signal) {
  const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  if (server.bearer_token_env_var) headers.Authorization = `Bearer ${envValue(server.bearer_token_env_var)}`;
  for (const [name, variable] of Object.entries(server.env_http_headers || {})) headers[name] = envValue(variable);
  let session;
  const post = async (method, params, id) => {
    const response = await fetch(server.url, { method: 'POST', redirect: 'error', signal,
      headers: { ...headers, ...(session ? { 'Mcp-Session-Id': session } : {}), ...(client.protocol ? { 'MCP-Protocol-Version': client.protocol } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(params ? { params } : {}) }) });
    if (!response.ok) { await response.body?.cancel(); throw Error(`MCP endpoint returned HTTP ${response.status}.`); }
    if (!id) { await response.body?.cancel(); return; }
    session ||= response.headers.get('mcp-session-id');
    const message = await httpMessage(response, id);
    if (message.error) throw Error('The MCP endpoint rejected the verification request.');
    return message.result;
  };
  const client = { request: (id, method, params) => post(method, params, id), notify: method => post(method) };
  try { return await exchange(client); }
  finally {
    if (session) await fetch(server.url, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(800),
      headers: { ...headers, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': client.protocol || protocol } }).then(r => r.body?.cancel()).catch(() => {});
  }
}
export async function verifyMcp(server, { timeout = 10000, builtin = false } = {}) {
  if (!builtin) parseSharedMcp(JSON.stringify({ version: 1, servers: { candidate: server } }));
  // Tool discovery outside a terminal does not require a task-reporting identity.
  if (builtin) server = { ...server, env_vars: (server.env_vars || []).filter(name => name !== 'HC_TERMINAL_ID') };
  if (server.env_vars !== undefined && (!Array.isArray(server.env_vars) || server.env_vars.some(name => typeof name !== 'string'))) throw Error('Environment variables must be a list of names.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try { return await (server.url ? httpProbe(server, controller.signal) : stdioProbe(server, controller.signal)); }
  catch (error) {
    if (controller.signal.aborted) throw Error('Connection verification timed out.');
    if (error instanceof SyntaxError || error instanceof TypeError) throw Error('The MCP connection returned an invalid response or could not be reached.');
    throw error;
  } finally { clearTimeout(timer); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'info') console.log(JSON.stringify(await mcpSetupInfo()));
    else if (process.argv[2] === 'verify') {
      const name = process.argv[3], info = await mcpSetupInfo();
      if (!sharedMcpSupported(name, info.platform)) throw Error('This integration is available on Windows only.');
      const builtin = name === 'herdr_tasks';
      const server = builtin ? tasksMcpServer(process.argv[5]) : JSON.parse(process.argv[4]);
      console.log(JSON.stringify(await verifyMcp(server, { builtin })));
    } else throw Error('Unknown connection-check operation.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
