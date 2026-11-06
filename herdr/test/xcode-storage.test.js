import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInfo, parseDevices, parseRuntimes, projectName, derivedDataDir, remove, scan } from '../mods/devkits/xcode-storage-reader.js';

const plist = (workspace, date = '2026-10-11T17:27:01Z') => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n`
  + `\t<key>LastAccessedDate</key>\n\t<date>${date}</date>\n\t<key>WorkspacePath</key>\n\t<string>${workspace}</string>\n</dict>\n</plist>\n`;

// Loads the dialog with a fake native host; it never runs real commands.
async function loadDialog(host) {
  const read = name => readFile(new URL(`../mods/devkits/${name}`, import.meta.url), 'utf8');
  const sources = await Promise.all(['components/button.js', 'components/checkbox.js', 'components/dropdown-menu.js', 'components/dialog.js', 'xcode-storage.js'].map(read));
  const body = sources.join('\n').replace(/^import [\s\S]*?;\r?\n/gm, '').replace('export default class', 'class').replace(/^export /gm, '');
  return new Function(...Object.keys(host), `${body}\nreturn { XcodeStorage, workspaceLabel, derivedGroups, bytes, simulatorGroups, lastUsedLabel };`)(...Object.values(host));
}

function fakeHost(overrides = {}) {
  const nodes = new Map();
  const element = () => {
    const data = { children: [] };
    const el = new Proxy(data, { get(_target, key) {
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      return (...args) => {
        if (key === 'id') nodes.set(args[0], data);
        if (key === 'on_click') data.click = args[0];
        if (key === 'on_change') data.change = args[0];
        if (key === 'disabled') data.disabled = args[0];
        if (key === 'checked') data.checked = args[0];
        if (key === 'child' && typeof args[0] === 'string') data.children.push(args[0]);
        return el;
      };
    } });
    return el;
  };
  const native = { new: id => element().id(id) };
  return { nodes, host: { div: element, h_flex: element, v_flex: element, svg: element, NativeButton: native, NativeCheckbox: native,
    theme: () => ({}), props: () => ({ overlay: 'o1' }), home: () => '/Users/me', appHome: () => '/herdr', notify() {}, closeOverlay() {}, ...overrides } };
}

const cx = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {}, spawn: fn => fn(cx) };

test('DerivedData metadata names the project and the workspace it was built from', () => {
  assert.deepEqual(parseInfo(plist('/tmp/a &amp; b/App.xcworkspace')), { workspace: '/tmp/a & b/App.xcworkspace', lastUsed: '2026-10-11T17:27:01Z' });
  assert.deepEqual(parseInfo(''), { workspace: null, lastUsed: null });
  assert.equal(projectName('VALPRO-dspunyrarmkmmtabsylzzmtvlqxo'), 'VALPRO');
  assert.equal(projectName('My-App-dspunyrarmkmmtabsylzzmtvlqxo'), 'My-App');
});

test('simulators and runtimes keep size, last use and how many devices use each runtime', () => {
  const devices = parseDevices(JSON.stringify({ devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: 'a', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true, dataPathSize: 10, logPathSize: 2, lastUsedAt: '2026-11-04T13:04:01Z' }],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'b', name: 'Watch', state: 'Shutdown', isAvailable: false }],
  } }));
  assert.deepEqual(devices.map(d => [d.os, d.booted, d.available, d.size]), [['iOS 26.5', true, true, 12], ['watchOS 11.0', false, false, 0]]);
  const runtimes = parseRuntimes(JSON.stringify({
    x: { identifier: 'x', version: '18.6', build: '22G86', sizeBytes: 5, runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6' },
    y: { identifier: 'y', version: '26.5', build: '23F77', sizeBytes: 7, runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' },
  }), devices);
  assert.deepEqual(runtimes.map(r => [r.version, r.devices, r.size]), [['iOS 26.5', 1, 7], ['iOS 18.6', 0, 5]]);
});

test('scan flags DerivedData whose workspace no longer exists and groups folders without one as shared caches', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xcode-storage-')), dir = derivedDataDir(home);
  const kept = join(home, 'Code', 'App.xcworkspace');
  await mkdir(kept, { recursive: true });
  for (const [name, workspace] of [['App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', kept], ['App-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', join(home, 'gone', 'App.xcworkspace')], ['ModuleCache.noindex', null]]) {
    await mkdir(join(dir, name), { recursive: true });
    if (workspace) await writeFile(join(dir, name, 'info.plist'), plist(workspace));
  }
  const result = await scan(home);
  const byId = Object.fromEntries(result.derived.map(item => [item.id, item]));
  assert.equal(byId['App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'].missing, false);
  assert.equal(byId['App-bbbbbbbbbbbbbbbbbbbbbbbbbbbb'].missing, true);
  assert.equal(byId['ModuleCache.noindex'].name, 'Shared caches');
  assert.equal(result.archives.count, 0);
});

test('delete removes only named DerivedData folders and simulator UDIDs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xcode-storage-')), dir = derivedDataDir(home);
  await mkdir(join(dir, 'App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'), { recursive: true });
  await mkdir(join(home, 'Library', 'Developer', 'Xcode', 'Archives'), { recursive: true });
  const deleted = [];
  const udid = '755B5A61-2C28-469D-8A6A-11C36D60C544';
  const result = await remove(home, [
    { kind: 'derived', id: 'App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { kind: 'derived', id: '../Archives' }, { kind: 'derived', id: '..' },
    { kind: 'derived', id: '' }, { kind: 'simulator', id: udid }, { kind: 'simulator', id: '-rf' }, { kind: 'runtime', id: 'x' },
  ], async id => { deleted.push(id); });
  assert.deepEqual(result.removed.map(item => item.id), ['App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', udid]);
  assert.equal(result.errors.length, 5);
  assert.deepEqual(await readdir(dir), []);
  assert.deepEqual(await readdir(join(home, 'Library', 'Developer', 'Xcode')), ['Archives', 'DerivedData']);
  assert.deepEqual(deleted, [udid]);
});

test('workspace labels shorten home and EAS local build folders; groups put missing workspaces first', async () => {
  const { workspaceLabel, derivedGroups, bytes } = await loadDialog(fakeHost().host);
  assert.equal(workspaceLabel({ workspace: '/Users/me/Code/app/ios/App.xcworkspace' }, '/Users/me'), '~/Code/app/ios/App.xcworkspace');
  assert.equal(workspaceLabel({ workspace: '/var/folders/x/T/eas-build-local-nodejs/c40eeb91-2c18/build/ios/App.xcworkspace' }, '/Users/me'), 'EAS local build c40eeb91');
  assert.equal(workspaceLabel({ id: 'ModuleCache.noindex', workspace: null }, '/Users/me'), 'ModuleCache.noindex');
  const groups = derivedGroups([{ name: 'A', size: 5, missing: false }, { name: 'A', size: 1, missing: true }, { name: 'B', size: 9, missing: false }]);
  assert.deepEqual(groups.map(g => [g.name, g.size, g.items.map(i => i.size)]), [['B', 9, [9]], ['A', 6, [1, 5]]]);
  assert.equal(bytes(73.4e9), '73.4 GB'); assert.equal(bytes(2.5e6), '2.5 MB'); assert.equal(bytes(0), '0 B');
});

test('the dialog checks missing workspaces first, deletes only after confirming, skips booted simulators and rescans', async () => {
  const calls = [], notes = [];
  const data = { derived: [
    { id: 'App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'App', workspace: '/gone/App.xcworkspace', missing: true, size: 3e9 },
    { id: 'App-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'App', workspace: '/Users/me/App.xcworkspace', missing: false, size: 1e9 },
  ], simulators: [{ id: 'S1', name: 'iPhone', os: 'iOS 26.5', booted: true, size: 5e9 }, { id: 'S2', name: 'iPad', os: 'iOS 26.5', booted: false, size: 2e9 }],
  runtimes: [], archives: { count: 0, size: 0, oldest: null }, errors: [] };
  const exec = async (_program, args) => {
    calls.push(args.slice(1));
    if (args[1] === 'delete') return { code: 0, stdout: JSON.stringify({ removed: JSON.parse(args[2]), errors: [] }) };
    return { code: 0, stdout: JSON.stringify(data) };
  };
  const { nodes, host } = fakeHost({ exec, notify: note => notes.push(note) });
  const { XcodeStorage } = await loadDialog(host);
  const view = new XcodeStorage(); view.init(cx); await new Promise(resolve => setImmediate(resolve));
  view.render();
  assert.ok(!nodes.has('xcode-storage-simulator:S1'));
  assert.ok(nodes.has('xcode-storage-booted-S1'));
  assert.equal(nodes.get('xcode-storage-derived:App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa').checked, true);
  nodes.get('xcode-storage-derived:App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa').change(false, cx);
  view.render();
  assert.equal(nodes.get('xcode-storage-derived:App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa').checked, false);
  nodes.get('xcode-storage-select-missing').click({}, cx);
  view.render();
  assert.equal(nodes.get('xcode-storage-derived:App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa').checked, true);
  assert.equal(nodes.get('xcode-storage-derived:App-bbbbbbbbbbbbbbbbbbbbbbbbbbbb').checked, false);
  nodes.get('xcode-storage-simulator:S2').change(true, cx);
  view.render();
  assert.ok(!nodes.has('xcode-storage-delete'));
  nodes.get('xcode-storage-review').click({}, cx);
  view.render();
  assert.equal(calls.length, 1);
  nodes.get('xcode-storage-delete').click({}, cx);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(calls[1][1]).map(item => [item.kind, item.id]), [['derived', 'App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'], ['simulator', 'S2']]);
  assert.deepEqual(calls[2], ['scan']);
  assert.match(notes[0].body, /2 items · 5\.0 GB freed/);
  assert.equal(view.selected.size, 0);
});

test('simulators group into recently used, idle and never used, with relative last use', async () => {
  const { simulatorGroups, lastUsedLabel } = await loadDialog(fakeHost().host);
  const now = Date.parse('2026-11-06T12:00:00Z');
  const groups = simulatorGroups([
    { id: 'a', size: 1, lastUsed: '2026-11-04T12:00:00Z' }, { id: 'b', size: 9, lastUsed: '2026-08-02T12:00:00Z' },
    { id: 'c', size: 0, lastUsed: null }, { id: 'd', size: 3, booted: true, lastUsed: '2026-01-01T00:00:00Z' },
  ], now);
  assert.deepEqual(groups.map(g => [g.title, g.items.map(i => i.id), g.size]), [
    ['RECENTLY USED · LAST 7 DAYS', ['d', 'a'], 4], ['NOT USED FOR 7+ DAYS', ['b'], 9], ['NEVER USED', ['c'], 0]]);
  assert.equal(lastUsedLabel(null, now), 'Never used');
  assert.equal(lastUsedLabel('2026-11-06T08:00:00Z', now), 'Today');
  assert.equal(lastUsedLabel('2026-11-05T08:00:00Z', now), 'Yesterday');
  assert.equal(lastUsedLabel('2026-11-02T12:00:00Z', now), '4 days ago');
  assert.equal(lastUsedLabel('2026-08-02T12:00:00Z', now), '3 months ago');
  assert.equal(lastUsedLabel(Date.parse('2026-11-02T12:00:00Z'), now), '4 days ago');
});

