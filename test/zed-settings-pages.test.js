import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtensionManifest, extensionMetadata, resolveProviders } from '../mods/herdr-zed/extension-model.js';
import * as model from '../components/session-model.js';
import * as contract from '../components/extension-contract.js';
import { evaluateNative } from './source-harness.js';

// Settings pages (ARCHITECTURE §2.1 settings.pages), the nav's sub-items and dividers, and the Manage extensions rows.

const base = { version: 1, id: 'demo', title: 'Demo', actions: [] };
const manifestWith = settings => JSON.stringify({ ...base, settings });
const pages = [{ id: 'accounts', title: 'Accounts' }, { id: 'profiles', title: 'Profiles' }];

test('settings.pages: optional sub-items with unique ids, 1 to 12 of them, {id,title} and an optional group label', () => {
  assert.deepEqual(extensionMetadata('herdr-zed-demo', manifestWith({ view: 'settings', title: 'Demo', pages })).settings,
    { view: 'settings', title: 'Demo', pages });
  const grouped = [{ id: 'a', title: 'A', group: 'First', icon: 'agent' }, { id: 'b', title: 'B', icon: 'server' }];
  assert.deepEqual(extensionMetadata('herdr-zed-demo', manifestWith({ view: 'settings', title: 'Demo', pages: grouped })).settings.pages, grouped);
  assert.deepEqual(extensionMetadata('herdr-zed-demo', manifestWith({ view: 'settings', title: 'Demo' })).settings,
    { view: 'settings', title: 'Demo', pages: [] });
  const tooMany = Array.from({ length: 13 }, (_, index) => ({ id: `p${index}`, title: 'Page' }));
  for (const bad of [[], tooMany, [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }], [{ id: 'a' }], [{ id: 'a', title: 'A', extra: 1 }],
    [{ id: 'Bad', title: 'A' }], [{ id: 'a', title: '  ' }], [{ id: 'a', title: 'A', group: ' ' }], [{ id: 'a', title: 'A', group: 3 }],
    [{ id: 'a', title: 'A', icon: '../x' }], [{ id: 'a', title: 'A', icon: 3 }], 'pages', null])
    assert.throws(() => parseExtensionManifest('herdr-zed-demo', manifestWith({ view: 'settings', title: 'Demo', pages: bad })),
      /Invalid extension settings/, JSON.stringify(bad));
  assert.equal(parseExtensionManifest('herdr-zed-demo', manifestWith({ view: 'settings', title: 'Demo', pages: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, title: 'x' })) })).length, 0,
    'twelve pages are the maximum');
});

test('resolveProviders carries the sub-pages of each enabled Settings entry', () => {
  const pkg = (id, extra = {}) => ({ mod: `herdr-zed-${id}`, id, title: id, provides: {}, requires: [], services: [], surfaces: [],
    settings: { view: 'settings', title: id, pages }, ...extra });
  const resolved = resolveProviders([pkg('agents'), pkg('tasks', { unsupported: true })], []);
  assert.deepEqual(resolved.settings, [{ mod: 'herdr-zed-agents', id: 'agents', view: 'settings', title: 'agents', pages }]);
});

// Element stub that records what a view sets, and walks children, for the Settings nav and the Manage page.
const element = (id = null, extra = {}) => {
  const node = { __id: id, __attrs: {}, __nodes: [], __handlers: {}, ...extra };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child') target.__nodes.push(args[0]);
      else if (key === 'children') target.__nodes.push(...args[0]);
      else if (key === 'when') { if (args[0]) args[1](proxy); }
      else if (key.startsWith('on_')) target.__handlers[key] = args[0];
      else if (key !== 'hover') target.__attrs[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
};
const all = node => node && node.__nodes ? [node, ...node.__nodes.flatMap(all)] : [];
const byId = (root, id) => all(root).find(node => node.__id === id) || null;
const strings = root => typeof root === 'string' ? [root] : root && root.__nodes ? root.__nodes.flatMap(strings) : [];
const theme = { selected: 'SELECTED', chrome: 'CHROME', popover: 'POPOVER', muted: 'MUTED', foreground: 'FOREGROUND', hover: 'HOVER', border: 'BORDER' };
const project = { id: 'p', folder: '/work', name: 'Work', machine: undefined };

async function settingsHost(settings, { page = null } = {}) {
  let current = { page, context: null };
  const host = { div: element, v_flex: element, h_flex: element, Button: id => element(id), DialogTitle: () => element(), DialogDescription: () => element(),
    Switch: (id, checked) => element(id, { checked }), ToggleGroup: id => element(id), ToggleGroupItem: id => element(id), ToolbarButton: id => element(id),
    glyph: () => element(), AUTO_RESUME_KEY: 'herdr-zed.auto-resume', unsavedKey: overlay => `herdr-zed.unsaved.${overlay}`, AlertDialogContent: () => element(), AlertDialogTitle: () => element(), AlertDialogDescription: () => element(), AlertDialogFooter: () => element(), AlertDialogCancel: id => element(id), extensionCatalog: () => ({ resolved: { settings } }),
    BuildRulesSettings: class {}, GitAuthorSettings: class {}, props: () => current,
    managedExtensions: () => [], extensionKeyOf: entry => entry.id, packageStatus: () => null, packageAbout: () => '', placeSwitches: () => null, placeSurfaces: () => [], ExtensionsNav: class {},
    openOverlay: () => 'overlay', closeOverlay() {}, run() {}, notify() {}, shared: () => undefined, setShared() {} };
  const exported = await evaluateNative('../mods/herdr-zed/settings.js', host,
    'settingsPageKey, extensionSettingsPages, settingsOverlay, SettingsNav');
  return { ...exported, setProps: next => { current = next; } };
}

test('a sub-page is keyed <extension>:<page> and deep-linkable, and the nav lists it indented under its entry', async () => {
  const settings = [{ mod: 'herdr-zed-agents', id: 'agents', view: 'manage', title: 'Agents', pages }];
  const s = await settingsHost(settings);
  assert.equal(s.settingsPageKey('agents'), 'extension:agents');
  assert.equal(s.settingsPageKey('agents:profiles'), 'extension:agents:profiles', 'herdr-zed.settings:<extension>:<page>');
  assert.equal(s.settingsPageKey('git'), 'git', 'shell pages keep their keys');
  assert.deepEqual(s.extensionSettingsPages().map(page => [page.key, page.indent, page.page]), [
    ['extension:agents', false, null], ['extension:agents:accounts', true, 'accounts'], ['extension:agents:profiles', true, 'profiles']]);
  const overlay = s.settingsOverlay('extension:agents:profiles', null);
  assert.deepEqual(overlay.layout.children[1].children[1].content, { mod: 'herdr-zed-agents',
    props: { view: 'manage', embedded: true, page: 'profiles', context: null } });
});

test('extension destinations and sub-pages stay out of the preferences nav', async () => {
  const settings = [{ mod: 'herdr-zed-agents', id: 'agents', view: 'manage', title: 'Agents', pages }];
  const s = await settingsHost(settings, { page: 'extension:agents:profiles' });
  const nav = new s.SettingsNav().render(theme);
  assert.equal(byId(nav, 'settings-nav-extension-agents'), null);
  assert.equal(byId(nav, 'settings-nav-extension-agents-profiles'), null);
  assert.equal(byId(nav, 'settings-nav-extensions'), null);
  const dividers = all(nav).filter(node => node.__attrs.h === 1 && node.__attrs.bg === theme.border);
  assert.equal(dividers.length, 1, 'preferences are separated from app settings');
  assert.ok(strings(nav).includes('App settings…'));
});

test('without Settings pages the nav keeps Workspace and Herdr settings, divided once', async () => {
  const s = await settingsHost([]);
  const nav = new s.SettingsNav().render(theme);
  assert.equal(all(nav).filter(node => node.__attrs.h === 1 && node.__attrs.bg === theme.border).length, 1);
  assert.equal(all(nav).filter(node => node.__id?.startsWith('settings-nav-extension-')).length, 0);
});

// ---- Extensions dialog: nav on the left, the selected extension on the right ----

async function managerHost(catalog, { enabled = () => true, active = () => true, visible = () => true, page = null, overlay = null } = {}) {
  const changes = [];
  const host = { div: element, h_flex: element, v_flex: element, Button: id => element(id), Switch: (id, checked) => element(id, { checked }),
    props: () => ({ page, context: null, overlay }),
    extensionCatalog: () => catalog, refreshExtensions: async () => {}, extensionEnabled: enabled, extensionActive: active,
    extensionSurfaceVisible: visible, setExtensionSurfaceVisible: (surface, value) => changes.push(['surface', surface.id, value]),
    extensionCategories: ['work', 'sources', 'git', 'tools'] };
  const exported = await evaluateNative('../mods/herdr-zed/extensions-manager.js', host,
    'ExtensionsNav, packageStatus, packagePlaces, packageAbout, placeSwitches, managedExtensions');
  return { ...exported, changes };
}

const catalogWith = (packages, resolved = { unavailable: [], conflicts: [] }, errors = [], actions = []) => ({ ready: true, loading: false, packages, resolved, errors, actions });

test('an installed extension that is off keeps its settings page; one that failed to load or is for another platform has none', async () => {
  const off = { mod: 'herdr-zed-asana', id: 'asana', title: 'Asana', surfaces: [], settings: { view: 'settings', title: 'Asana', pages: [] } };
  const host = { div: element, v_flex: element, h_flex: element, Button: id => element(id), DialogTitle: () => element(), DialogDescription: () => element(),
    Switch: (id, checked) => element(id, { checked }), ToolbarButton: id => element(id), glyph: () => element(), AUTO_RESUME_KEY: 'x', unsavedKey: overlay => `herdr-zed.unsaved.${overlay}`, AlertDialogContent: () => element(), AlertDialogTitle: () => element(), AlertDialogDescription: () => element(), AlertDialogFooter: () => element(), AlertDialogCancel: id => element(id),
    BuildRulesSettings: class {}, GitAuthorSettings: class {}, ExtensionsNav: class {}, extensionKeyOf: entry => entry.id || entry.mod,
    managedExtensions: () => [off, { ...off, mod: 'herdr-zed-mac', id: 'mac', unsupported: true }, { ...off, mod: 'herdr-zed-bad', id: 'bad', error: 'x' }],
    extensionCatalog: () => ({ resolved: { settings: [] } }), packageStatus: () => null, packageAbout: () => '', placeSwitches: () => null, placeSurfaces: () => [],
    extensionEnabled: () => false, setExtensionEnabled() {}, props: () => ({}), openOverlay: () => 'o', closeOverlay() {}, run() {}, notify() {},
    shared: () => undefined, setShared() {} };
  const { extensionSettingsPages } = await evaluateNative('../mods/herdr-zed/settings.js', host, 'extensionSettingsPages');
  assert.deepEqual(extensionSettingsPages().map(page => [page.key, page.view]), [['extension:asana', 'settings']]);
});

test('extension helpers: problems only, fixed places, and the launcher stays out of the list', async () => {
  const packages = [
    { mod: 'herdr-zed-tasks', id: 'tasks', title: 'Tasks', category: 'work', description: 'A task board.', surfaces: [] },
    { mod: 'herdr-zed-calendar', id: 'calendar', title: 'Calendar', category: 'work', requires: ['tasks'], surfaces: [] },
    { mod: 'herdr-zed-mac', id: 'mac', title: 'Mac only', unsupported: true, surfaces: [] },
    { mod: 'herdr-zed-workflow', id: 'workflow', title: 'Workflows', provides: { launcher: {} }, surfaces: [] },
  ];
  const resolved = { unavailable: [{ mod: 'herdr-zed-calendar', id: 'calendar', missing: ['tasks'] }], conflicts: [] };
  const catalog = catalogWith(packages, resolved, [], [{ mod: 'herdr-zed-tasks', location: 'status.right' }, { mod: 'herdr-zed-github', location: 'git.actions' }]);
  const m = await managerHost(catalog);
  assert.equal(m.packageStatus(packages[0], catalog), null, 'On/Off is the switch, not a status line');
  assert.equal(m.packageStatus(packages[1], catalog), 'Turn on Tasks to use it');
  assert.equal(m.packageStatus(packages[2], catalog), 'Not available on this platform');
  assert.equal(m.packageStatus({ ...packages[0], error: 'Invalid manifest.' }, catalog), 'Invalid manifest.');
  assert.deepEqual(m.packagePlaces(packages[0], catalog), ['Status bar button']);
  assert.deepEqual(m.packagePlaces({ mod: 'herdr-zed-github', provides: { gitCredentials: {} } }, catalog), ['Changes and Git commands']);
  assert.equal(m.packageAbout(packages[0], catalog), 'A task board. Status bar button.');
  assert.deepEqual(m.managedExtensions(catalog).map(entry => entry.id), ['tasks', 'calendar', 'mac'], 'category order, no launcher');
});

test('the Extensions nav groups extensions, marks the open one, and opens another on click', async () => {
  const packages = [
    { mod: 'herdr-zed-system', id: 'system', title: 'System', surfaces: [] },
    { mod: 'herdr-zed-tasks', id: 'tasks', title: 'Tasks', category: 'work', surfaces: [] },
    { mod: 'herdr-zed-asana', id: 'asana', title: 'Asana', category: 'sources', surfaces: [] }];
  const m = await managerHost(catalogWith(packages), { page: 'extension:tasks', overlay: 'o1', active: mod => mod !== 'herdr-zed-asana' });
  const opened = [];
  const nav = new m.ExtensionsNav({ openSettings: (key, context) => opened.push([key, context]), pageKey: id => `extension:${id}`, closeOnEscape: el => el }).render(theme);
  const text = strings(nav);
  assert.ok(['WORK', 'TASK SOURCES', 'TOOLS'].every(label => text.includes(label)), 'category labels');
  assert.ok(text.indexOf('Tasks') < text.indexOf('Asana') && text.indexOf('Asana') < text.indexOf('System'), 'category order');
  assert.equal(byId(nav, 'extensions-nav-o1-herdr-zed-tasks').__attrs.bg, theme.selected, 'the open extension is selected');
  assert.equal(byId(nav, 'extensions-nav-o1-herdr-zed-asana').__attrs.accessibility_label, 'Asana, off');
  byId(nav, 'extensions-nav-o1-herdr-zed-tasks').__handlers.on_click();
  assert.deepEqual(opened, [], 'the open one does not reopen');
  byId(nav, 'extensions-nav-o1-herdr-zed-asana').__handlers.on_click();
  assert.deepEqual(opened, [['extension:asana', null]]);
  assert.ok(byId(nav, 'extensions-refresh'));
});

test('place switches stay while an extension is off, and go through the shell while it is on', async () => {
  const system = { mod: 'herdr-zed-system', id: 'system', title: 'System', surfaces: [
    { id: 'widgets', location: 'sidebar.bottom', view: 'widgets', title: 'Widgets', icon: 'globe', mod: 'herdr-zed-system' },
    { id: 'inline', location: 'status.right', view: 'inline', title: 'Inline', icon: 'globe', mod: 'herdr-zed-system' }] };
  const on = await managerHost(catalogWith([system]), { visible: surface => surface.id === 'widgets' });
  const card = on.placeSwitches(system, theme);
  assert.ok(strings(card).includes('Show Widgets in sidebar') && strings(card).includes('Show Inline in status bar'));
  assert.equal(byId(card, 'extension-surface-toggle-widgets').checked, true);
  byId(card, 'extension-surface-toggle-inline').__handlers.on_change(true, { notify() {} });
  assert.deepEqual(on.changes, [['surface', 'inline', true]]);
  const off = await managerHost(catalogWith([system]), { active: () => false });
  const dimmed = off.placeSwitches(system, theme);
  assert.ok(byId(dimmed, 'extension-surface-toggle-widgets'), 'rows stay while off');
  byId(dimmed, 'extension-surface-toggle-widgets').__handlers.on_change(true, { notify() {} });
  assert.deepEqual(off.changes, [], 'and are inert');
  assert.equal(on.placeSwitches({ ...system, surfaces: [] }, theme), null);
});

test('an extension page: a plain title bar, then a card with description and On/Off, its problem, and a toggle that keeps the page in place', async () => {
  const packages = [{ mod: 'herdr-zed-calendar', id: 'calendar', title: 'Calendar', category: 'work', requires: ['tasks'], description: 'Schedules.', surfaces: [] },
    { mod: 'herdr-zed-tasks', id: 'tasks', title: 'Tasks', surfaces: [] }];
  const catalog = catalogWith(packages, { unavailable: [{ mod: 'herdr-zed-calendar', missing: ['tasks'] }], conflicts: [] });
  const m = await managerHost(catalog);
  const opened = [], toggled = [];
  const host = { div: element, v_flex: element, h_flex: element, Button: id => element(id), DialogTitle: () => element(), DialogDescription: () => element(),
    Switch: (id, checked) => element(id, { checked }), ToggleGroup: id => element(id), ToggleGroupItem: id => element(id), ToolbarButton: id => element(id),
    glyph: () => element(), AUTO_RESUME_KEY: 'herdr-zed.auto-resume', unsavedKey: overlay => `herdr-zed.unsaved.${overlay}`, AlertDialogContent: () => element(), AlertDialogTitle: () => element(), AlertDialogDescription: () => element(), AlertDialogFooter: () => element(), AlertDialogCancel: id => element(id), BuildRulesSettings: class {}, GitAuthorSettings: class {}, ExtensionsNav: class {},
    extensionCatalog: () => catalog, extensionEnabled: () => true, extensionActive: () => false,
    setExtensionEnabled: (mod, value) => toggled.push([mod, value]),
    managedExtensions: m.managedExtensions, extensionKeyOf: entry => entry.id || entry.mod, packageStatus: m.packageStatus,
    packageAbout: m.packageAbout, placeSwitches: () => null, placeSurfaces: () => [],
    props: () => current,
    openOverlay: spec => { opened.push(spec); return 'overlay'; }, closeOverlay() {}, run() {}, notify() {}, closeWorkspacePanel() {},
    shared: () => undefined, setShared() {} };
  let current = { page: 'extension:calendar', overlay: 'o', context: null };
  const { SettingsHeader } = await evaluateNative('../mods/herdr-zed/settings.js', host, 'SettingsHeader');
  const header = new SettingsHeader().render(theme);
  assert.deepEqual(strings(header).filter(Boolean), ['Calendar'], 'the title bar holds only the title (and the close control)');
  assert.equal(byId(header, 'settings-enable-herdr-zed-calendar'), null);
  current = { ...current, part: 'about' };
  const about = new SettingsHeader().render(theme);
  const text = strings(about);
  assert.ok(text.includes('Schedules.') && text.includes('Turn on Tasks to use it'), 'the card: description, then the problem');
  assert.equal(byId(about, 'settings-back'), null, 'no back button: the nav is beside it');
  byId(about, 'settings-enable-herdr-zed-calendar').__handlers.on_change(false, { notify() {} });
  assert.deepEqual(toggled, [['herdr-zed-calendar', false]]);
  assert.equal(opened.length, 0, 'toggling leaves the page in place');
});

test('only the open page is selected in the nav, whichever sub-page or extension is open', async () => {
  const settings = [{ mod: 'herdr-zed-agents', id: 'agents', view: 'manage', title: 'Agents', pages }, { mod: 'herdr-zed-github', id: 'github', view: 'settings', title: 'GitHub' }];
  for (const page of ['general', 'git']) {
    const s = await settingsHost(settings, { page });
    const nav = new s.SettingsNav().render(theme);
    const selected = all(nav).filter(node => node.__attrs.bg === 'SELECTED' && node.__id?.startsWith('settings-nav-'));
    assert.equal(selected.length, 1, `one selected row for ${page}`);
    assert.equal(selected[0].__attrs.accessibility_label, page === 'git' ? 'Git' : 'General');
    for (const node of all(nav).filter(node => node.__id?.startsWith('settings-nav-') && node !== selected[0]))
      assert.notEqual(node.__attrs.bg, 'SELECTED', node.__id);
  }
});

test('a nav row is drawn in the overlay it belongs to, so a reopened nav starts with no carried-over hover', async () => {
  const settings = [{ mod: 'herdr-zed-github', id: 'github', view: 'settings', title: 'GitHub' }];
  const s = await settingsHost(settings, { page: 'git' });
  const first = all(new s.SettingsNav().render({ ...theme })).map(node => node.__id).filter(id => id?.startsWith('settings-nav-'));
  s.setProps({ page: 'git', context: null, overlay: 'overlay-9' });
  const second = all(new s.SettingsNav().render(theme)).map(node => node.__id).filter(id => id?.startsWith('settings-nav-'));
  assert.equal(first.length, second.length);
  assert.ok(second.every(id => id.startsWith('settings-nav-overlay-9-')));
  assert.ok(first.every(id => !id.includes('overlay-')));
});

