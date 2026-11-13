// Finite filesystem work for the explicit Herdr Zed data reset. Never edits shared.json.
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, lstat, readFile, readdir, realpath, rename, rm, writeFile, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { extensionMetadata } from './extension-model.js';

const execFile = promisify(execFileCallback);
export const resetShortcuts = { 'cmd-n': 'herdr-zed.new-thread', 'cmd-w': 'herdr-zed.close-file', 'cmd-shift-f': 'herdr-zed.project-search', 'ctrl-shift-f': 'herdr-zed.project-search' };
const read = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const entries = path => readdir(path, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
async function plain(path) {
  const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (stat?.isSymbolicLink()) throw new Error(`Remove the symbolic link before resetting: ${path}`);
}
async function roots(directory) {
  const root = resolve(directory), physical = await realpath(root);
  if (physical === dirname(physical)) throw new Error('Invalid Herdr home.');
  await plain(join(root, 'data'));
  await plain(join(root, 'data', 'herdr-zed'));
  return { root, data: join(root, 'data', 'herdr-zed') };
}
function object(source, name) {
  let value;
  try { value = source === null ? {} : JSON.parse(source); }
  catch { throw new Error(`Could not parse ${name}. Repair it before resetting.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

async function acquireLock(path) {
  try {
    const existing = await lstat(path);
    await plain(path);
    let pid;
    try { pid = JSON.parse(await read(path))?.pid; } catch {}
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('A reset lock already exists. Check whether another reset is running.');
    let running = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
    if (running) throw new Error('Another Herdr Zed reset is running.');
    const current = await lstat(path);
    if (current.ino !== existing.ino || current.dev !== existing.dev) throw new Error('Another Herdr Zed reset is running.');
    await rm(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another Herdr Zed reset is running.'); throw error; }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); }
  catch (error) { await lock.close(); await rm(path, { force: true }); throw error; }
  return lock;
}
async function update(path, original, next) {
  await plain(path);
  if (await read(path) !== original) throw new Error('Settings changed during reset. Retry after closing other settings windows.');
  const temporary = `${path}.herdr-zed-reset-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (await read(path) !== original) throw new Error('Settings changed during reset. Please retry.');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function stopAccountSessions(data, execute = execFile) {
  const options = { timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  const { stdout } = await execute('hc', ['ls', '--json'], options);
  const listing = JSON.parse(stdout), terminals = Array.isArray(listing) ? listing : listing.terminals;
  if (!Array.isArray(terminals)) throw new Error('Could not check Herdr Zed account sessions.');
  const prefix = data.replaceAll('\\', '/') + '/';
  const owned = new Set(terminals.filter(terminal => terminal.state !== 'finished' &&
    JSON.stringify(terminal.argv || []).replaceAll('\\\\', '/').includes(prefix))
    .map(terminal => terminal.address));
  // Include actual child terminals, including children intentionally kept alive.
  for (let changed = true; changed;) {
    changed = false;
    for (const terminal of terminals) if (terminal.state !== 'finished' && owned.has(terminal.parent) && !owned.has(terminal.address)) {
      owned.add(terminal.address); changed = true;
    }
  }
  // Children first, so ending their parent cannot turn a following kill into a stale request.
  const ordered = terminals.filter(terminal => owned.has(terminal.address));
  const depth = terminal => {
    const seen = new Set(); let parent = terminal.parent;
    while (owned.has(parent) && !seen.has(parent)) { seen.add(parent); parent = terminals.find(item => item.address === parent)?.parent; }
    return seen.size;
  };
  ordered.sort((a, b) => depth(b) - depth(a));
  for (const terminal of ordered) {
    if (typeof terminal.address !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(terminal.address)) throw new Error('Invalid Herdr Zed terminal address.');
    try { await execute('hc', ['kill', terminal.address], options); }
    catch (error) {
      // Another native project close can have finished or removed it in the meantime.
      const current = JSON.parse((await execute('hc', ['ls', '--json'], options)).stdout);
      const remaining = Array.isArray(current) ? current : current.terminals;
      if (!Array.isArray(remaining) || remaining.some(item => item.address === terminal.address && item.state !== 'finished'))
        throw new Error('Could not stop a Herdr Zed account session. No account files were removed; Retry to try again.');
    }
  }
}

export async function idleAccounts(data, execute = execFile, platform = process.platform, stop = false) {
  const options = { timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  const { stdout } = await execute('hc', ['ls', '--json'], options);
  const result = JSON.parse(stdout);
  const terminals = Array.isArray(result) ? result : result.terminals;
  if (!Array.isArray(terminals)) throw new Error('Could not check running account sessions.');
  const prefix = data.replaceAll('\\', '/');
  if (terminals.some(terminal => terminal.state !== 'finished' && JSON.stringify(terminal.argv || []).replaceAll('\\\\', '/').includes(prefix)))
    throw new Error('Close the terminals using Herdr Zed accounts before clearing data.');
  // Unmounting a native view cancels its callbacks, but an already started exec can
  // finish later. In particular, analytics readers write cache files on completion.
  const root = dirname(dirname(data));
  let writers;
  if (platform === 'win32') {
    const result = await execute('cscript', ['//Nologo', join(root, 'mods/herdr-zed/reset-processes-windows.js'), root, String(process.pid), ...(stop ? ['stop'] : [])], options);
    writers = JSON.parse(result.stdout);
  } else {
    const result = await execute('ps', ['-axww', '-o', 'pid=,ppid=,comm=,args='], options);
    writers = resetProcessPids(result.stdout, root);
    if (stop) for (const pid of [...writers].reverse()) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  if (!Array.isArray(writers)) throw new Error('Could not check Herdr Zed background readers.');
  if (!stop && writers.length) throw new Error('Herdr Zed services are still stopping. Wait a moment, then Retry.');
}

export function resetProcessPids(source, root, ownPid = process.pid) {
  const rows = source.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), name: match[3], args: match[4] }] : [];
  });
  const prefix = `${root}/mods/herdr-zed`;
  const owned = rows.filter(row => {
    const offset = row.args.indexOf(prefix);
    return row.pid !== ownPid && /(?:^|\/)node$/.test(row.name) && offset >= 0 &&
      (offset === 0 || /["\s]/.test(row.args[offset - 1])) && /^(?:\/|-[a-z0-9-]+\/)/.test(row.args.slice(offset + prefix.length));
  }).map(row => row.pid);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (row.pid !== ownPid && !owned.includes(row.pid) && owned.includes(row.parent)) {
      owned.push(row.pid); changed = true;
    }
  }
  return owned;
}

export async function stopResetServices(data, execute = execFile, platform = process.platform) {
  const deadline = Date.now() + 15000;
  for (;;) {
    await idleAccounts(data, execute, platform, true);
    try { await idleAccounts(data, execute, platform); return; }
    catch (error) {
      if (!error.message.startsWith('Herdr Zed services are still stopping.') || Date.now() >= deadline) throw error;
      await delay(250);
    }
  }
}

async function providers(root) {
  await plain(join(root, 'mods'));
  const result = [];
  for (const entry of await entries(join(root, 'mods'))) {
    if (!/^herdr-zed-[a-z0-9-]+$/.test(entry.name)) continue;
    await plain(join(root, 'mods', entry.name));
    const text = await read(join(root, 'mods', entry.name, 'extension.json'));
    if (text === null) continue;
    const manifest = extensionMetadata(entry.name, text);
    if (!manifest.dataReset) { result.push({ mod: entry.name, helper: null }); continue; }
    const helper = join(root, 'mods', entry.name, manifest.dataReset.helper);
    await plain(helper);
    result.push({ mod: entry.name, helper });
  }
  return result;
}
async function providerRequest(provider, action, root) {
  const { stdout } = await execFile(process.execPath, [provider.helper, action, root, 'HERDR ZED'],
    { timeout: 600000, windowsHide: true });
  return JSON.parse(stdout);
}
export async function inspectReset(directory, request = providerRequest) {
  const { root } = await roots(directory);
  const hooks = await providers(root);
  let accounts = 0;
  for (const hook of hooks.filter(hook => hook.helper)) {
    const result = await request(hook, 'inspect', root);
    if (result.accounts !== undefined && (!Number.isSafeInteger(result.accounts) || result.accounts < 0))
      throw new Error('Invalid provider reset plan.');
    accounts += result.accounts || 0;
  }
  const state = object(await read(join(root, 'shared.json')), 'shared state');
  await plain(join(root, 'keys.json'));
  const keysSource = await read(join(root, 'keys.json'));
  return { hooks, accounts, sharedKeys: Object.keys(state).filter(key => key.startsWith('herdr-zed.')),
    keysSource, keys: object(keysSource, 'key bindings') };
}
export async function clearReset(directory, confirmation, services = {}) {
  if (confirmation !== 'HERDR ZED') throw new Error('Type HERDR ZED to confirm clearing data.');
  const { root, data } = await roots(directory);
  const lockPath = join(root, '.herdr-zed-reset.lock');
  const lock = await acquireLock(lockPath);
  let signOutStarted = false;
  try {
    await (services.stopAccounts || stopAccountSessions)(data);
    await (services.stopServices || stopResetServices)(data);
    await (services.idleAccounts || idleAccounts)(data);
    const plan = await inspectReset(root, services.providerRequest);
    signOutStarted = true;
    for (const hook of plan.hooks.filter(hook => hook.helper)) await (services.providerRequest || providerRequest)(hook, 'clear', root);
    const latest = await inspectReset(root, services.providerRequest);
    if (latest.keysSource !== plan.keysSource || JSON.stringify(latest.hooks) !== JSON.stringify(plan.hooks))
      throw new Error('Settings changed during reset. Data files were kept; retry.');
    if (plan.keysSource !== null) await update(join(root, 'keys.json'), plan.keysSource, { ...plan.keys, 'layout:herdr-zed': resetShortcuts });
    await roots(root);
    await rm(data, { recursive: true, force: true });
    // Installed packages remain installed; restore their default registry, not user preferences.
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'extensions.json'), JSON.stringify({ version: 1, extensions: plan.hooks.map(hook => hook.mod) }, null, 2) + '\n', { mode: 0o600 });
    return { sharedKeys: latest.sharedKeys };
  } catch (error) {
    error.message += signOutStarted ? ' Reset is incomplete; some accounts may already be signed out.'
      : ' Reset stopped before account sign-out; account files were kept.';
    throw error;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv[2] === 'inspect') {
      const plan = await inspectReset(process.argv[3]);
      process.stdout.write(JSON.stringify({ accounts: plan.accounts, sharedKeys: plan.sharedKeys }));
    } else if (process.argv[2] === 'clear') process.stdout.write(JSON.stringify(await clearReset(process.argv[3], process.argv[4])));
    else throw new Error('Unknown reset operation.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
