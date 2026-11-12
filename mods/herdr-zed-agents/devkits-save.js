import { isMain } from './node-main.js';
import { readFile, writeFile, rename, unlink, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDevkits, devkitsCatalog, resourceSupported } from './devkits-model.js';
import { parseSharedMcp, sharedMcpSupported } from './components/shared-mcp-model.js';

const read = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
export async function writeChecked(path, text, expected) {
  if (await read(path) !== expected) throw Error('Settings changed in another window. Reload before saving.');
  if (text === null) { await unlink(path); return; }
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    if (await read(path) !== expected) throw Error('Settings changed in another window. Reload before saving.');
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function acquire(path) {
  try { const lock = await open(path, 'wx'); await lock.writeFile(String(process.pid)); return lock; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const snapshot = await stat(path), pid = Number(await read(path));
    if (!Number.isInteger(pid) || pid < 1) throw Error('Another settings save is in progress.');
    try { process.kill(pid, 0); throw Error('Another settings save is in progress.'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    const latest = await stat(path);
    if (latest.ino !== snapshot.ino || latest.mtimeMs !== snapshot.mtimeMs) throw Error('Another settings save is in progress.');
    await unlink(path);
    const lock = await open(path, 'wx'); await lock.writeFile(String(process.pid)); return lock;
  }
}
export async function saveDevkitsConfig(root, payload, { write = writeChecked, platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux' } = {}) {
  const { capabilities, mcp } = payload;
  for (const item of [capabilities, mcp]) if (!item || !(typeof item.text === 'string' || item.text === null) || !(typeof item.expected === 'string' || item.expected === null)) throw Error('Invalid settings save request.');
  const config = parseDevkits(capabilities.text), previous = parseDevkits(capabilities.expected), servers = parseSharedMcp(mcp.text).servers, oldServers = parseSharedMcp(mcp.expected).servers;
  const catalog = devkitsCatalog(root);
  for (const kind of ['rules', 'skills']) for (const item of catalog[kind])
    if (config[kind][item.id] === true && previous[kind][item.id] !== true && !resourceSupported(item, platform)) throw Error(`${item.name} is Windows only.`);
  for (const name of new Set([...Object.keys(servers), ...Object.keys(oldServers)]))
    if (!sharedMcpSupported(name, platform) && JSON.stringify(servers[name]) !== JSON.stringify(oldServers[name])) throw Error(`${name} can only be configured on Windows.`);
  const directory = join(root, 'data', 'herdr-zed'); await mkdir(directory, { recursive: true });
  const lockPath = join(directory, '.capabilities-save.lock'), lock = await acquire(lockPath);
  const files = [[join(directory, 'codex-mcp.json'), mcp], [join(directory, 'capabilities.json'), capabilities]];
  const changes = files.filter(([, item]) => item.text !== item.expected);
  const written = [];
  try {
    for (const [path, item] of files) if (await read(path) !== item.expected) throw Error('Settings changed in another window. Reload before saving.');
    for (const [path, item] of changes) { await write(path, item.text, item.expected); written.push([path, item]); }
    for (const [path, item] of files) if (await read(path) !== item.text) throw Error('Settings changed during save. Reload to inspect them.');
    return { saved: true };
  } catch (error) {
    for (const [path, item] of written.reverse()) {
      try { await writeChecked(path, item.expected, item.text); }
      catch { throw Error('Save was interrupted and another writer changed the connection settings. Reload to inspect them; the selection draft is retained.'); }
    }
    throw error;
  } finally { await lock.close(); await unlink(lockPath); }
}
if (await isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await saveDevkitsConfig(process.argv[2], JSON.parse(process.argv[3])))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
