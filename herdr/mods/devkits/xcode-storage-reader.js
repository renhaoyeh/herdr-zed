import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Measures Xcode's storage under ~/Library/Developer and deletes only DerivedData folders and simulators.
const run = promisify(execFile);
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const xml = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export const derivedDataDir = home => join(home, 'Library', 'Developer', 'Xcode', 'DerivedData');
const archivesDir = home => join(home, 'Library', 'Developer', 'Xcode', 'Archives');

// du still prints a total when some files are unreadable.
async function size(path) {
  const out = await run('du', ['-sk', path], { maxBuffer: 1 << 20 }).then(r => r.stdout, e => String(e.stdout || ''));
  return (Number(out.split('\t')[0]) || 0) * 1024;
}

const exists = path => stat(path).then(() => true, () => false);
const entries = async dir => (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory() && !e.name.startsWith('.'));

// Xcode names each folder <workspace>-<hash> and records the workspace it builds in info.plist.
export function parseInfo(text) {
  const value = key => new RegExp(`<key>${key}</key>\\s*<(?:string|date)>([^<]*)</`).exec(text || '')?.[1];
  const workspace = value('WorkspacePath'), accessed = value('LastAccessedDate');
  return { workspace: workspace ? xml(workspace) : null, lastUsed: accessed || null };
}

export const projectName = folder => folder.replace(/-[a-z]{28}$/, '');

async function derivedData(home) {
  const dir = derivedDataDir(home);
  return Promise.all((await entries(dir)).map(async ({ name }) => {
    const path = join(dir, name);
    const info = parseInfo(await readFile(join(path, 'info.plist'), 'utf8').catch(() => ''));
    const lastUsed = info.lastUsed || (await stat(path)).mtime.toISOString();
    return { id: name, name: info.workspace ? projectName(name) : 'Shared caches', workspace: info.workspace, missing: Boolean(info.workspace) && !(await exists(info.workspace)),
      lastUsed, size: await size(path) };
  }));
}

const runtimeLabel = id => { const m = /SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)/.exec(id || ''); return m ? `${m[1]} ${m[2]}.${m[3]}` : id || 'Unknown runtime'; };

// `simctl list devices -j` keys each device list by runtime identifier.
export function parseDevices(json) {
  return Object.entries(JSON.parse(json).devices).flatMap(([runtime, devices]) => {
    const os = runtimeLabel(runtime);
    return devices.map(d => ({ id: d.udid, name: d.name, os, runtime, booted: d.state === 'Booted', available: d.isAvailable !== false,
      lastUsed: d.lastUsedAt || null, size: (d.dataPathSize || 0) + (d.logPathSize || 0) }));
  });
}

export function parseRuntimes(json, devices = []) {
  return Object.values(JSON.parse(json)).map(r => ({ id: r.identifier, version: runtimeLabel(r.runtimeIdentifier), build: r.build, size: r.sizeBytes || 0,
    lastUsed: r.lastUsedAt || null, devices: devices.filter(d => d.runtime === r.runtimeIdentifier).length }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

async function archives(home) {
  const days = await entries(archivesDir(home));
  const list = (await Promise.all(days.map(async ({ name }) => (await entries(join(archivesDir(home), name)))
    .filter(e => e.name.endsWith('.xcarchive')).map(() => name)))).flat().sort();
  return { count: list.length, oldest: list[0] || null, size: days.length ? await size(archivesDir(home)) : 0 };
}

async function simctl(args) {
  try { return (await run('xcrun', ['simctl', ...args], { maxBuffer: 16 << 20 })).stdout; } catch { return null; }
}

export async function scan(home) {
  const [derived, devicesJson, runtimesJson, archived] = await Promise.all([derivedData(home), simctl(['list', 'devices', '-j']),
    simctl(['runtime', 'list', '-j']), archives(home)]);
  const simulators = devicesJson ? parseDevices(devicesJson) : [];
  return { derived, simulators, runtimes: runtimesJson ? parseRuntimes(runtimesJson, simulators) : [], archives: archived,
    errors: devicesJson ? [] : ['Could not list simulators. Check that Xcode is installed.'], scannedAt: new Date().toISOString() };
}

// Accepts only DerivedData folder names and simulator UDIDs; booted simulators are refused.
export async function remove(home, items, simctlDelete = id => run('xcrun', ['simctl', 'delete', id])) {
  const removed = [], errors = [];
  for (const item of items) {
    try {
      if (item.kind === 'derived') {
        if (!item.id || item.id !== item.id.replace(/[/\\]/g, '') || item.id.startsWith('.')) throw new Error('Not a DerivedData folder');
        await rm(join(derivedDataDir(home), item.id), { recursive: true, force: true });
      } else if (item.kind === 'simulator') {
        if (!UDID.test(item.id || '')) throw new Error('Not a simulator');
        await simctlDelete(item.id);
      } else throw new Error('Unsupported item');
      removed.push(item);
    } catch (error) { errors.push(`${item.label || item.id}: ${String(error.stderr || error.message || error).trim()}`); }
  }
  return { removed, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action = 'scan', items = '[]'] = process.argv.slice(2);
  try { console.log(JSON.stringify(action === 'delete' ? await remove(homedir(), JSON.parse(items)) : await scan(homedir()))); }
  catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
