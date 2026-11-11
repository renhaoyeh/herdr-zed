import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout, gitActionPopup, resolveProviders } from '../mods/herdr-zed/extension-model.js';
import { extensionSurfaceLayout, extensionSurfaceNodeId } from '../mods/herdr-zed/extension-surfaces.js';
import { evaluateNative } from './source-harness.js';
import { asanaManifest as manifestText, systemManifest as systemText } from './extension-fixtures.js';

const manifest = JSON.parse(manifestText);

test('service mounts follow enable/remove and preserve workspace geometry and unrelated children', () => {
  const marker = { id: 'custom', type: 'row', children: [] };
  const root = { id: 'workspace', children: [{ id: 'editor', size: { weight: 1.6 } },
    { id: 'status-separator', type: 'row', size: { px: 1 }, background: 'border', children: [marker] }] };
  const packages = [{ mod: 'herdr-zed-system', services: [{ view: 'service' }] }];
  const mounted = extensionServiceLayout(root, packages);
  assert.deepEqual(root.children[1].children, [marker], 'Input is immutable');
  assert.deepEqual(mounted.children[0], root.children[0]);
  assert.equal(mounted.children[1].size.px, 1);
  assert.deepEqual(mounted.children[1].children[0], marker);
  assert.equal(mounted.children[1].children[1].content.mod, 'herdr-zed-system');
  assert.equal(extensionServiceLayout(mounted, packages), null, 'Repeated refresh does not remount sampler');
  assert.deepEqual(extensionServiceLayout(mounted, packages, ['herdr-zed-system']), root);
  assert.deepEqual(extensionServiceLayout(mounted, []), root);
  assert.equal(extensionServiceLayout({ children: [] }, packages), null, 'Other layouts remain untouched');
  const existing = { ...root, children: [...root.children, { content: { mod: 'herdr-zed-system', props: { view: 'service' } } }] };
  assert.equal(extensionServiceLayout(existing, packages), null, 'Existing owner is never duplicated');
});

test('popup declarations have stable IDs and capture only public originating project fields', () => {
  const [action] = parseExtensionManifest('herdr-zed-asana', manifestText);
  assert.equal(action.id, 'asana.open'); assert.equal(action.location, 'status.right');
  const project = { id: 'project', name: 'Project', folder: '/workspace', machine: 'remote', token: 'private' };
  const popup = extensionPopup(action, project);
  assert.deepEqual(popup, { mod: 'herdr-zed-asana', kind: 'dialog', frame: 'none', modal: false, width: 0.9, height: 0.86,
    props: { view: 'browser', context: { id: 'project', name: 'Project', folder: '/workspace', machine: 'remote' },
      stateKey: 'herdr-zed.extension.asana.["remote","/workspace"]' } });
  project.folder = '/elsewhere'; assert.equal(popup.props.context.folder, '/workspace');
  assert.equal(JSON.stringify(popup).includes('private'), false);
  assert.notEqual(extensionPopup(action, { ...project, folder: '/other' }).props.stateKey, popup.props.stateKey);
  assert.equal(extensionPopup(action, null).props.context, undefined);
});

test('registry and manifest validation reject unsupported versions, paths and contributions', () => {
  assert.deepEqual(parseExtensionRegistry(null), []);
  for (const value of [{ version: 2, extensions: [] }, { version: 1, extensions: ['../escape'] },
    { version: 1, extensions: ['same', 'same'] }, { version: 1, extensions: [], extra: true }])
    assert.throws(() => parseExtensionRegistry(JSON.stringify(value)));
  for (const patch of [{ location: 'right' }, { icon: '../file' }, { popup: { ...manifest.actions[0].popup, width: -1 } }])
    assert.throws(() => parseExtensionManifest('herdr-zed-asana', JSON.stringify({ ...manifest, actions: [{ ...manifest.actions[0], ...patch }] })));
  assert.throws(() => parseExtensionManifest('../escape', manifestText));
  assert.throws(() => parseExtensionManifest('herdr-zed-asana', JSON.stringify({ ...manifest, actions: [manifest.actions[0], manifest.actions[0]] })));
});

const runtime = async (readTextFile, initialLayout = null) => {
  let root = initialLayout;
  const memory = {}, opened = [], notices = [], layoutUpdates = [];
  const host = { shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); },
    appHome: () => '/herdr', readTextFile, layout: () => root, run: (command, args) => { assert.equal(command, 'layout.set'); root = args.layout; layoutUpdates.push(root); }, openOverlay: value => { opened.push(value); return 'overlay'; }, notify: value => notices.push(value),
    parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout,
    extensionSurfaceLayout, extensionSurfaceNodeId, gitActionPopup, resolveProviders };
  return { memory, opened, notices, layoutUpdates, ...await evaluateNative('../mods/herdr-zed/extensions.js', host,
    'refreshExtensions, openExtension, extensionCatalog, extensionEnabled, setExtensionEnabled, extensionActive, extensionActions, openGitAction') };
};

test('discovery reads declarations only; activation alone opens the existing provider popup', async () => {
  const reads = [];
  const r = await runtime(async path => { reads.push(path); return path.endsWith('extensions.json')
    ? '{"version":1,"extensions":["herdr-zed-asana"]}' : manifestText; });
  r.openExtension('asana.open', null); assert.equal(r.opened.length, 0);
  await r.refreshExtensions(); assert.equal(r.opened.length, 0);
  assert.deepEqual(reads, ['/herdr/data/herdr-zed/extensions.json', '/herdr/mods/herdr-zed-asana/extension.json']);
  r.openExtension('asana.open', { id: 'p', folder: '/project', name: 'Project' });
  assert.equal(r.opened.length, 1); assert.equal(r.opened[0].mod, 'herdr-zed-asana');
  assert.equal(r.opened[0].props.channel, undefined, 'No Tasks import channel or service dependency');
  assert.equal(r.notices.length, 0);
});

test('a late discovery cannot restore removed entries; malformed packages leave valid ones available', async () => {
  let resolveOld, calls = 0;
  const r = await runtime(path => {
    if (!path.endsWith('extensions.json')) return Promise.resolve(manifestText);
    if (++calls === 1) return new Promise(resolve => { resolveOld = resolve; });
    return Promise.resolve(null);
  });
  const old = r.refreshExtensions(); await r.refreshExtensions();
  resolveOld('{"version":1,"extensions":["herdr-zed-asana"]}'); await old;
  assert.deepEqual(r.extensionCatalog().actions, []);
  r.openExtension('asana.open', null); assert.equal(r.opened.length, 0);
  const mixed = await runtime(async path => path.endsWith('extensions.json')
    ? '{"version":1,"extensions":["broken","herdr-zed-asana"]}' : path.includes('/broken/') ? 'invalid' : manifestText);
  await mixed.refreshExtensions();
  assert.equal(mixed.extensionCatalog().actions[0].id, 'asana.open');
  assert.equal(mixed.extensionCatalog().errors.length, 1);
});

test('disabled extensions retain declarations, block activation and restore without touching provider data', async () => {
  const r = await runtime(async path => path.endsWith('extensions.json')
    ? '{"version":1,"extensions":["herdr-zed-asana"]}' : manifestText);
  await r.refreshExtensions();
  assert.equal(r.extensionCatalog().packages[0].title, 'Asana');
  r.setExtensionEnabled('other-mod', false);
  r.setExtensionEnabled('herdr-zed-asana', false);
  r.openExtension('asana.open', null);
  assert.equal(r.opened.length, 0);
  await r.refreshExtensions();
  assert.equal(r.extensionEnabled('herdr-zed-asana'), false);
  assert.equal(r.extensionCatalog().actions.length, 1);
  r.setExtensionEnabled('herdr-zed-asana', true);
  assert.equal(r.extensionEnabled('other-mod'), false);
  r.openExtension('asana.open', null);
  assert.equal(r.opened.length, 1);
});

test('service and dependency metadata reject paths, duplicates and arbitrary service props', () => {
  for (const patch of [{ dependencies: ['../escape'] }, { dependencies: ['herdr-zed-asana'] },
    { dependencies: ['same', 'same'] }, { services: [{ view: '../service' }] },
    { services: [{ view: 'service', mod: 'other' }] }, { services: [{ view: 'service' }, { view: 'service' }] }])
    assert.throws(() => parseExtensionManifest('herdr-zed-asana', JSON.stringify({ ...manifest, ...patch })));
});

test('runtime refresh mounts one enabled service and disabling removes it without remounting on refresh', async () => {
  const root = { children: [{ id: 'status-separator', type: 'row', children: [], size: { px: 1 } }] };
  const r = await runtime(async path => path.endsWith('extensions.json')
    ? '{"version":1,"extensions":["herdr-zed-system"]}' : systemText, root);
  await r.refreshExtensions();
  assert.equal(r.layoutUpdates.length, 1);
  assert.equal(r.layoutUpdates[0].children[0].children[0].content.props.view, 'service');
  await r.refreshExtensions();
  assert.equal(r.layoutUpdates.length, 1);
  r.setExtensionEnabled('herdr-zed-system', false);
  assert.deepEqual(r.layoutUpdates.at(-1), root);
  r.openExtension('system.open', null);
  assert.equal(r.opened.length, 0);
  await r.refreshExtensions();
  assert.equal(r.layoutUpdates.length, 2);
  r.setExtensionEnabled('herdr-zed-system', true);
  assert.equal(r.layoutUpdates.length, 3);
});

test('registry removal unmounts old service and surfaces while retaining shell layout blocks', async () => {
  let registry = '{"version":1,"extensions":["herdr-zed-system"]}';
  const root = { id: 'root', children: [
    { id: 'sidebar', type: 'column', children: [{ id: 'agents', type: 'block', content: { mod: 'herdr-zed' } }] },
    { id: 'workspace-row', type: 'row', children: [{ id: 'editor', type: 'block', content: { mod: 'herdr-zed' } }] },
    { id: 'status-separator', type: 'row', children: [] },
    { id: 'status', type: 'column', children: [{ id: 'status-content', type: 'block', content: { mod: 'herdr-zed', props: { view: 'status' } } }] },
  ] };
  const r = await runtime(async path => path.endsWith('extensions.json') ? registry : systemText, root);
  await r.refreshExtensions();
  assert.ok(r.layoutUpdates.length);
  registry = '{"version":1,"extensions":[]}';
  await r.refreshExtensions();
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'zed-extension-service-herdr-zed-system-service'), null);
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'zed-extension-surface-herdr-zed-system-widgets'), null);
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'zed-extension-surface-herdr-zed-system-inline'), null);
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'status-content').content.props.view, 'status');
});

function findLayout(node, id) {
  return node?.id === id ? node : (node?.children || []).map(child => findLayout(child, id)).find(Boolean) || null;
}

// Launcher and dependency states as the catalog publishes them. Two launchers conflict and neither is used; a package
// that requires a missing extension is unavailable and contributes no actions; disabling clears shared envelopes.
const launcherManifest = id => JSON.stringify({ version: 1, id, title: id, actions: [],
  provides: { launcher: { picker: { view: 'launcher', width: 280 }, settings: { view: 'settings', width: 1040, height: 0.86 } } } });
const dependentManifest = JSON.stringify({ version: 1, id: 'calendar', title: 'Calendar', requires: ['tasks'],
  actions: [{ id: 'open', title: 'Calendar', icon: 'calendar', location: 'status.right', popup: { view: 'calendar', width: 1000, height: 700, modal: false } }] });
const gitManifest = JSON.stringify({ version: 1, id: 'github', title: 'GitHub', provides: { gitCredentials: {} },
  actions: [{ id: 'account', title: 'GitHub account…', icon: 'github', location: 'git.actions', popup: { view: 'account', width: 480, height: 600, modal: true } }] });
const catalogFiles = {
  '/herdr/data/herdr-zed/extensions.json': '{"version":1,"extensions":["herdr-zed-alpha","herdr-zed-beta","herdr-zed-calendar","herdr-zed-github"]}',
  '/herdr/mods/herdr-zed-alpha/extension.json': launcherManifest('alpha'),
  '/herdr/mods/herdr-zed-beta/extension.json': launcherManifest('beta'),
  '/herdr/mods/herdr-zed-calendar/extension.json': dependentManifest,
  '/herdr/mods/herdr-zed-github/extension.json': gitManifest,
};

test('two enabled launchers conflict, unavailable packages are reported, and disabling one restores the other', async () => {
  const r = await runtime(async path => catalogFiles[path] ?? (() => { throw new Error('missing ' + path); })());
  await r.refreshExtensions();
  const catalog = r.extensionCatalog();
  assert.equal(catalog.resolved.launcher, null, 'no launcher is used while two are enabled');
  assert.deepEqual(catalog.resolved.conflicts.map(item => [item.provider, item.mods]), [['launcher', ['herdr-zed-alpha', 'herdr-zed-beta']]]);
  assert.deepEqual(catalog.resolved.unavailable, [{ mod: 'herdr-zed-calendar', id: 'calendar', missing: ['tasks'] }]);
  assert.equal(r.extensionActive('herdr-zed-calendar'), false);
  assert.equal(catalog.packages.find(entry => entry.mod === 'herdr-zed-alpha').enabled, true);
  assert.deepEqual(catalog.packages.find(entry => entry.mod === 'herdr-zed-github').provides, { gitCredentials: {} });
  assert.deepEqual(r.extensionActions('status.right'), [], 'unavailable packages contribute no status actions');
  r.setExtensionEnabled('herdr-zed-alpha', false);
  assert.equal(r.extensionCatalog().resolved.launcher.mod, 'herdr-zed-beta');
  assert.deepEqual(r.extensionCatalog().resolved.conflicts, []);
  assert.equal(r.extensionCatalog().packages.find(entry => entry.mod === 'herdr-zed-alpha').enabled, false);
});

test('git.actions lists only enabled, active providers; disabling a provider clears its credential and decoration keys', async () => {
  const r = await runtime(async path => catalogFiles[path]);
  await r.refreshExtensions();
  assert.deepEqual(r.extensionActions('git.actions').map(action => [action.id, action.mod]), [['github.account', 'herdr-zed-github']]);
  assert.equal(r.extensionCatalog().resolved.gitCredentials.id, 'github');
  r.openGitAction('github.account', { machine: 'box', folder: '/repo' });
  assert.equal(r.opened.at(-1).mod, 'herdr-zed-github');
  assert.deepEqual(r.opened.at(-1).props, { view: 'account', context: { machine: 'box', folder: '/repo' } });
  r.memory['herdr-zed.git-credentials.github'] = { updatedAt: 1, repositories: {} };
  r.memory['herdr-zed.decorations.github'] = { updatedAt: 1, threads: {} };
  r.setExtensionEnabled('herdr-zed-github', false);
  assert.equal(r.memory['herdr-zed.git-credentials.github'], null);
  assert.equal(r.memory['herdr-zed.decorations.github'], null);
  assert.deepEqual(r.extensionActions('git.actions'), []);
  r.openGitAction('github.account', { machine: null, folder: '/repo' });
  assert.equal(r.opened.length, 1, 'a disabled provider action does not open');
});
