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

test('settings.pages: optional sub-items with unique ids, 1 to 12 of them, exactly {id,title}', () => {
  assert.deepEqual(extensionMetadata('herdr-zed-demo', manifestWith({ view: 'settings', title: 'Demo', pages })).settings,
    { view: 'settings', title: 'Demo', pages });
  assert.deepEqual(extensionMetadata('herdr-zed-demo', manifestWith({ view: 'settings', title: 'Demo' })).settings,
    { view: 'settings', title: 'Demo', pages: [] });
  const tooMany = Array.from({ length: 13 }, (_, index) => ({ id: `p${index}`, title: 'Page' }));
  for (const bad of [[], tooMany, [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }], [{ id: 'a' }], [{ id: 'a', title: 'A', extra: 1 }],
    [{ id: 'Bad', title: 'A' }], [{ id: 'a', title: '  ' }], 'pages', null])
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
    glyph: () => element(), AUTO_RESUME_KEY: 'herdr-zed.auto-resume', extensionCatalog: () => ({ resolved: { settings } }),
    BuildRulesSettings: class {}, GitAuthorSettings: class {}, ExtensionsManager: class {}, props: () => current,
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
  assert.deepEqual(overlay.layout.children[0].children[1].content, { mod: 'herdr-zed-agents',
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

// ---- Manage extensions (L9) ----

async function managerHost(catalog, { enabled = () => true, active = () => true, visible = () => true } = {}) {
  const changes = [];
  const host = { div: element, h_flex: element, v_flex: element, Button: id => element(id), Switch: (id, checked) => element(id, { checked }),
    extensionCatalog: () => catalog, refreshExtensions: async () => {}, extensionEnabled: enabled, extensionActive: active,
    setExtensionEnabled: (mod, value) => changes.push(['enabled', mod, value]), extensionSurfaceVisible: visible,
    setExtensionSurfaceVisible: (surface, value) => changes.push(['surface', surface.id, value]) };
  const { ExtensionsManager, packageStatus } = await evaluateNative('../mods/herdr-zed/extensions-manager.js', host,
    'ExtensionsManager, packageStatus');
  return { ExtensionsManager, packageStatus, changes };
}

const catalogWith = (packages, resolved = { unavailable: [], conflicts: [] }, errors = []) => ({ ready: true, loading: false, packages, resolved, errors });

test('Manage extensions: plain status lines, an On/Off switch per package, and a switch per surface labelled by where it shows', async () => {
  const packages = [
    { mod: 'herdr-zed-tasks', id: 'tasks', title: 'Tasks', surfaces: [] },
    { mod: 'herdr-zed-calendar', id: 'calendar', title: 'Calendar', requires: ['tasks'], surfaces: [] },
    { mod: 'herdr-zed-mac', id: 'mac', title: 'Mac only', unsupported: true, surfaces: [] },
    { mod: 'herdr-zed-system', id: 'system', title: 'System', surfaces: [
      { id: 'widgets', location: 'sidebar.bottom', view: 'widgets', title: 'Widgets', icon: 'globe', mod: 'herdr-zed-system' },
      { id: 'inline', location: 'status.right', view: 'inline', title: 'Inline', icon: 'globe', mod: 'herdr-zed-system' },
      { id: 'dock', location: 'dock.right', view: 'dock', title: 'Dock', icon: 'globe', mod: 'herdr-zed-system' }] },
  ];
  const resolved = { unavailable: [{ mod: 'herdr-zed-calendar', id: 'calendar', missing: ['tasks'] }], conflicts: [] };
  const m = await managerHost(catalogWith(packages, resolved), { enabled: mod => mod !== 'herdr-zed-tasks',
    active: mod => mod !== 'herdr-zed-tasks', visible: surface => surface.id !== 'dock' });
  assert.equal(m.packageStatus(packages[0], catalogWith(packages, resolved)), 'Off');
  assert.equal(m.packageStatus(packages[1], catalogWith(packages, resolved)), 'Needs Tasks');
  assert.equal(m.packageStatus(packages[2], catalogWith(packages, resolved)), 'Not available on this platform');
  assert.equal(m.packageStatus(packages[3], catalogWith(packages, resolved)), 'On');
  assert.equal(m.packageStatus({ ...packages[0], error: 'Invalid manifest.' }, catalogWith(packages, resolved)), 'Invalid manifest.');

  const page = new m.ExtensionsManager().render(theme);
  assert.ok(byId(page, 'extensions-refresh'), 'Refresh is in the page header area');
  assert.equal(byId(page, 'extension-toggle-herdr-zed-tasks').checked, false);
  assert.equal(byId(page, 'extension-toggle-herdr-zed-system').checked, true);
  assert.equal(byId(page, 'extension-toggle-herdr-zed-mac'), null, 'a package for another platform has no enable switch');
  const text = strings(page).join(' ');
  assert.ok(text.includes('Show in sidebar') && text.includes('Show in status bar') && text.includes('Show in right dock'));
  assert.equal(/Popup|surfaces|Hide Sidebar|Disable/.test(text), false, 'no internal terms and no text toggles');
  assert.equal(byId(page, 'extension-surface-toggle-widgets').checked, true);
  assert.equal(byId(page, 'extension-surface-toggle-dock').checked, false);
  assert.equal(byId(page, 'extension-surface-toggle-widgets').__handlers.on_change !== undefined, true);
});

test('a switch change goes through the shell, and an unsupported package has no surface rows', async () => {
  const packages = [{ mod: 'herdr-zed-system', id: 'system', title: 'System', surfaces: [
    { id: 'widgets', location: 'sidebar.bottom', view: 'widgets', title: 'Widgets', icon: 'globe', mod: 'herdr-zed-system' }] }];
  const m = await managerHost(catalogWith(packages));
  const page = new m.ExtensionsManager().render(theme);
  byId(page, 'extension-toggle-herdr-zed-system').__handlers.on_change(false, { notify() {} });
  byId(page, 'extension-surface-toggle-widgets').__handlers.on_change(false, { notify() {} });
  assert.deepEqual(m.changes, [['enabled', 'herdr-zed-system', false], ['surface', 'widgets', false]]);
});

test('the extension overview opens configuration only for an available settings contribution', async () => {
  const packages = [{ mod: 'herdr-zed-demo', id: 'demo', title: 'Demo', surfaces: [] },
    { mod: 'herdr-zed-plain', id: 'plain', title: 'Plain', surfaces: [] }];
  const catalog = catalogWith(packages, { settings: [{ mod: 'herdr-zed-demo', id: 'demo' }] });
  const m = await managerHost(catalog), opened = [];
  const page = new m.ExtensionsManager({ openSettings: id => opened.push(id) }).render(theme);
  byId(page, 'extension-settings-demo').__handlers.on_click();
  assert.deepEqual(opened, ['demo']);
  assert.equal(byId(page, 'extension-settings-plain'), null);
});

test('launcher workflows are managed separately from the optional extensions list', async () => {
  const packages = [{ mod: 'herdr-zed-workflow', id: 'workflow', title: 'Workflows', provides: { launcher: {} }, surfaces: [] },
    { mod: 'herdr-zed-calendar', id: 'calendar', title: 'Calendar', surfaces: [] }];
  const m = await managerHost(catalogWith(packages));
  const page = new m.ExtensionsManager().render(theme);
  assert.equal(byId(page, 'extension-toggle-herdr-zed-workflow'), null);
  assert.ok(byId(page, 'extension-toggle-herdr-zed-calendar'));
  assert.ok(strings(page).some(text => text.startsWith('1 installed')));
  assert.ok(!strings(page).includes('Workflows'));
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

test('Manage extensions: a package that is not available on this platform says so in the muted colour, not as an error', async () => {
  const packages = [{ mod: 'herdr-zed-mac', id: 'mac', title: 'Mac only', unsupported: true, surfaces: [] },
    { mod: 'herdr-zed-tasks', id: 'tasks', title: 'Tasks', error: 'Invalid manifest.', surfaces: [] }];
  const m = await managerHost(catalogWith(packages));
  const colours = { ...theme, ansi1: 'ERROR' };
  const page = new m.ExtensionsManager().render(colours);
  const statusNode = text => all(page).find(node => (node.__nodes || []).includes(text));
  assert.equal(statusNode('Not available on this platform').__attrs.text_color, colours.muted, 'not an error');
  assert.equal(statusNode('Invalid manifest.').__attrs.text_color, 'ERROR', 'a real error stays in the error colour');
});
