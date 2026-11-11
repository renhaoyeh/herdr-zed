import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout, gitActionPopup, resolveProviders,
  platformSupported, workspaceRect } from '../mods/herdr-zed/extension-model.js';
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

const runtime = async (readTextFile, initialLayout = null, platform = 'linux') => {
  let root = initialLayout;
  const memory = {}, opened = [], notices = [], layoutUpdates = [];
  const host = { shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); },
    appHome: () => '/herdr', readTextFile, layout: () => root, run: (command, args) => { assert.equal(command, 'layout.set'); root = args.layout; layoutUpdates.push(root); }, openOverlay: value => { opened.push(value); return 'overlay'; }, notify: value => notices.push(value),
    parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout,
    extensionSurfaceLayout, extensionSurfaceNodeId, gitActionPopup, resolveProviders,
    platformSupported, workspaceRect, window: () => ({ platform }), settings: () => ({ zoom: 1 }) };
  return { memory, opened, notices, layoutUpdates, ...await evaluateNative('../mods/herdr-zed/extensions.js', host,
    'refreshExtensions, openExtension, extensionCatalog, extensionEnabled, setExtensionEnabled, extensionActive, extensionActions, openGitAction, workspaceRectNow, recordSize, visibleSurfaceCount, WORK_WIDTH_KEY, WINDOW_HEIGHT_KEY') };
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
    { id: 'status', type: 'column', children: [{ id: 'status-content', type: 'row', children: [
      { id: 'status-main', type: 'block', size: { weight: 1 }, content: { mod: 'herdr-zed', props: { view: 'status' } } },
      { id: 'status-tools', type: 'block', size: { px: 68 }, content: { mod: 'herdr-zed', props: { view: 'status-tools' } } },
    ] }] },
  ] };
  const r = await runtime(async path => path.endsWith('extensions.json') ? registry : systemText, root);
  await r.refreshExtensions();
  assert.ok(r.layoutUpdates.length);
  registry = '{"version":1,"extensions":[]}';
  await r.refreshExtensions();
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'zed-extension-service-herdr-zed-system-service'), null);
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'zed-extension-surface-herdr-zed-system-widgets'), null);
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'zed-extension-surface-herdr-zed-system-inline'), null);
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'status-main').content.props.view, 'status');
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'status-tools').content.props.view, 'status-tools');
});

// A plain-object stand-in for gpui elements: records method calls and children so the slot's tree can be inspected.
function ui(name) {
  const node = { name, kids: [], calls: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      target.calls[key] = args;
      if (key === 'child') target.kids.push(args[0]);
      else if (key === 'children') target.kids.push(...args[0]);
      else if (key === 'when' && args[0]) args[1](proxy);
      return proxy;
    };
  } });
  return proxy;
}

test('status bar actions are icon-only: four buttons with title tooltips, the rest in one overflow menu', async () => {
  const memory = {}, opened = [];
  const action = n => ({ id: `x.a${n}`, extensionId: 'x', extensionTitle: 'X', mod: 'herdr-zed-x', title: `Action ${n}`, icon: 'globe',
    iconColor: n === 1 ? '#ff0000' : null, location: 'status.right', popup: { view: 'details', width: 400, height: 300, modal: false } });
  const publish = count => { memory['herdr-zed.extensions.catalog'] = { ready: true, loading: false, errors: [],
    actions: Array.from({ length: count }, (_, index) => action(index + 1)),
    packages: [{ mod: 'herdr-zed-x', id: 'x', title: 'X', enabled: true, provides: {}, requires: [], services: [], surfaces: [] }],
    resolved: resolveProviders([]) }; };
  const host = { shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); },
    openOverlay: value => { opened.push(value); return 'overlay'; }, notify: () => {}, layout: () => null, run: () => {},
    appHome: () => '/herdr', readTextFile: null,
    h_flex: () => ui('h_flex'), ToolbarButton: (id, t, options) => Object.assign(ui('button'), { id, options }), TOOLBAR_GLYPH: 16,
    glyph: name => Object.assign(ui('glyph'), { glyph: name }),
    DropdownMenu: (id, state, trigger, items, onSelect, t, options) => ({ id, items, onSelect, trigger, options, state }),
    STATUS_ACTION_LIMIT: 4, extensionSurfaceLayout, extensionSurfaceNodeId, extensionServiceLayout, extensionPopup, gitActionPopup,
    parseExtensionRegistry, parseExtensionManifest, extensionMetadata, resolveProviders };
  const { ExtensionSlot } = await evaluateNative('../mods/herdr-zed/extensions.js', host, 'ExtensionSlot, openExtension');

  publish(6);
  const slot = ExtensionSlot('status.right', { muted: 'muted' }, null, 'menu-state');
  const buttons = slot.kids.filter(child => child.id?.startsWith('extension-') && child.id !== 'extension-overflow');
  assert.deepEqual(buttons.map(button => button.id), ['extension-x.a1', 'extension-x.a2', 'extension-x.a3', 'extension-x.a4']);
  for (const [index, button] of buttons.entries()) {
    assert.equal(button.options.icon, true, 'icon-only button');
    assert.deepEqual(button.calls.tooltip, [`Action ${index + 1}`]);
    assert.deepEqual(button.calls.accessibility_label, [`Action ${index + 1}`]);
    assert.equal(button.kids.length, 1, 'no title text child');
  }
  const colored = buttons[0].kids[0];
  assert.equal(colored.glyph, 'globe'); assert.deepEqual(colored.calls.text_color, ['#ff0000'], 'iconColor is kept');

  const overflow = slot.kids.find(child => child.id === 'extension-overflow');
  assert.deepEqual(overflow.items, [{ key: 'x.a5', label: 'Action 5', icon: 'globe' }, { key: 'x.a6', label: 'Action 6', icon: 'globe' }]);
  assert.equal(overflow.state, 'menu-state');
  overflow.onSelect('x.a6', {});
  assert.equal(opened.length, 1, 'an overflow row opens the same popup as an icon');

  publish(4);
  const fits = ExtensionSlot('status.right', { muted: 'muted' }, null, 'menu-state');
  assert.equal(fits.kids.some(child => child.id === 'extension-overflow'), false, 'no overflow menu at four actions');
  assert.equal(fits.kids.length, 4);
});

function findLayout(node, id) {
  return node?.id === id ? node : (node?.children || []).map(child => findLayout(child, id)).find(Boolean) || null;
}

// Launcher and dependency states as the catalog publishes them. Two launchers conflict and neither is used; a package
// that requires a missing extension is unavailable and contributes no actions; disabling clears shared envelopes.
const launcherManifest = id => JSON.stringify({ version: 1, id, title: id, actions: [],
  provides: { launcher: { picker: { view: 'launcher', width: 280 } } } });
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
