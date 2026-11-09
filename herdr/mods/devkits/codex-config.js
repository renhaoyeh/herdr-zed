// Codex's revision-checked TOML config API, used by MCP synchronization.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { commandArgv } from './shell-command.js';

// Use Codex's TOML parser/editor, preserving comments, unrelated keys and concurrent edits.
export async function openConfig(directory, overrides = []) {
  const env = { ...process.env, CODEX_HOME: directory };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
  const [command, ...args] = commandArgv(['codex', ...overrides, '-c', 'cli_auth_credentials_store="file"', 'app-server', '--listen', 'stdio://'],
    process.platform === 'win32' ? 'windows' : process.platform);
  const child = spawn(command, args, { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume(); // Diagnostics may contain private config; do not forward them to the UI.
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  const pending = new Map();
  const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.on('error', () => fail(new Error('Could not start Codex. Check that Codex CLI is installed.')));
  child.on('exit', () => fail(new Error('Codex stopped before settings synchronization finished.')));
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message || 'Codex rejected the settings update.'));
    else item.resolve(message.result);
  });
  child.stdin.on('error', () => fail(new Error('Could not send settings to Codex.')));
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('Settings synchronization timed out.')); }, 30000);
    pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`);
  });
  const close = async () => {
    lines.close(); child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };
  try {
    await request('initialize', { clientInfo: { name: 'devkits_settings_sync', version: '0.1.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const result = await request('config/read', { includeLayers: true });
    const layer = result.layers?.find(layer => layer.name.type === 'user' && !layer.name.profile &&
      resolve(layer.name.file) === join(directory, 'config.toml'));
    if (!layer || layer.disabledReason) throw new Error('Codex did not return this account’s user settings. Update Codex CLI and retry.');
    return { config: layer.config, version: layer.version, close,
      write: edits => request('config/batchWrite', { edits, expectedVersion: layer.version,
        filePath: join(directory, 'config.toml'), reloadUserConfig: false }) };
  } catch (error) { await close(); throw error; }
}
