import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// Explicit setup only: register the installed endpoint in the existing Shared MCP schema.
// Never launch agents, synchronize account files or change other server entries.
export async function registerXd(home) {
  const server = { command: 'node', args: [join(home, 'mods', 'herdr-zed-xd', 'mcp-server.cjs').replace(/\\/g, '/'), home], tool_timeout_sec: 180 };
  await access(server.args[0]);
  const directory = join(home, 'data', 'herdr-zed'), file = join(directory, 'shared-mcp.json');
  const before = await readFile(file, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  const config = before === null ? { version: 1, servers: {} } : JSON.parse(before);
  if (config.version !== 1 || !config.servers || typeof config.servers !== 'object' || Array.isArray(config.servers)
    || Object.keys(config).some(k => !['version', 'servers'].includes(k))) throw Error('Unsupported Shared MCP configuration. No changes made.');
  const existing = config.servers.herdr_xd;
  if (existing) {
    if (existing.command !== server.command || JSON.stringify(existing.args) !== JSON.stringify(server.args))
      throw Error('A different herdr_xd connection already exists. No changes made.');
    return { changed: false, file, enabled: existing.enabled !== false };
  }
  await mkdir(directory, { recursive: true });
  const id = randomUUID(), temporary = `${file}.new-${id}`, backup = before === null ? null : `${file}.before-xd-${id}.bak`;
  try {
    if (backup) await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
    await writeFile(temporary, JSON.stringify({ ...config, servers: { ...config.servers, herdr_xd: server } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const current = await readFile(file, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (current !== before) throw Error('Shared MCP configuration changed during setup. Retry.');
    await rename(temporary, file);
    return { changed: true, file, backup, enabled: true };
  } finally { await rm(temporary, { force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (!process.argv[2]) throw Error('Pass the installed Herdr home as the only argument.');
    console.log(JSON.stringify(await registerXd(resolve(process.argv[2]))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
