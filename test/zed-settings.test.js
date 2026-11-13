import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseExtensionManifest, extensionMetadata, resolveProviders } from '../mods/herdr-zed/extension-model.js';
import * as model from '../components/session-model.js';
import * as contract from '../components/extension-contract.js';
import { evaluateNative } from './source-harness.js';

const base = { version: 1, id: 'demo', title: 'Demo', actions: [] };
const manifestWith = settings => JSON.stringify({ ...base, ...(settings === undefined ? {} : { settings }) });

test('manifest settings: optional {view,title} with exactly those keys, parsed into metadata', () => {
  assert.equal(extensionMetadata('herdr-zed-demo', manifestWith()).settings, null, 'Absent settings means no Settings page');
  assert.deepEqual(extensionMetadata('herdr-zed-demo', manifestWith({ view: 'settings', title: 'Demo' })).settings,
    { view: 'settings', title: 'Demo', pages: [] });
  assert.equal(parseExtensionManifest('herdr-zed-demo', manifestWith({ view: 'settings', title: 'Demo' })).length, 0);
  for (const bad of [{ view: 'settings' }, { title: 'Demo' }, { view: 'settings', title: '  ' }, { view: 'settings', title: 7 },
    { view: 'settings', title: 'Demo', width: 1040 }, { view: '../escape', title: 'Demo' }, { view: 'Settings', title: 'Demo' },
    'settings', [], null])
    assert.throws(() => parseExtensionManifest('herdr-zed-demo', manifestWith(bad)), /Invalid extension settings/, JSON.stringify(bad));
});

test('resolveProviders lists settings only for enabled, error-free, available packages', () => {
  const pkg = (id, extra = {}) => ({ mod: `herdr-zed-${id}`, id, title: id, provides: {}, requires: [], services: [], surfaces: [],
    settings: { view: 'settings', title: `${id} settings` }, ...extra });
  const packages = [pkg('agents'), pkg('github', { error: 'Invalid manifest.' }), pkg('asana'),
    pkg('calendar', { requires: ['missing'] }), pkg('tasks'), pkg('plain', { settings: null })];
  const resolved = resolveProviders(packages, ['herdr-zed-asana']);
  assert.deepEqual(resolved.settings, [
    { mod: 'herdr-zed-agents', id: 'agents', view: 'settings', title: 'agents settings', pages: [] },
    { mod: 'herdr-zed-tasks', id: 'tasks', view: 'settings', title: 'tasks settings', pages: [] },
  ]);
  assert.deepEqual(resolved.unavailable.map(entry => entry.id), ['calendar']);
  assert.deepEqual(resolveProviders([]).settings, []);
});

// Settings module evaluated against fake Herdr functions and recording element builders.
const element = (id = null, extra = {}) => {
  const node = { __id: id, __attrs: {}, __nodes: [], __handlers: {}, ...extra };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child') { assert.ok(args[0] !== null && args[0] !== undefined, 'child rejects empty values'); target.__nodes.push(args[0]); }
      else if (key === 'children') { for (const item of args[0]) assert.ok(item !== null && item !== undefined, 'children rejects empty values'); target.__nodes.push(...args[0]); }
      else if (key === 'when') { if (args[0]) args[1](proxy); }
      else if (key.startsWith('on_')) target.__handlers[key] = args[0];
      else if (key !== 'hover') target.__attrs[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
};
const find = (root, id) => root && root.__id === id ? root : (root?.__nodes || []).map(node => find(node, id)).find(Boolean) || null;
const text = root => typeof root === 'string' ? root : root && root.__nodes ? root.__nodes.map(text).join(' ') : '';

function settingsRuntime({ settings = [], memory = {}, closeThrows = [], launcher = null, packages = [] } = {}) {
  let current = {};
  const opened = [], closed = [], runs = [], notices = [], panelCloses = [];
  const host = {
    div: element, v_flex: element, h_flex: element, Button: id => element(id), DialogTitle: () => element(), DialogDescription: () => element(),
    Switch: (id, checked) => element(id, { checked }), ToggleGroup: id => element(id), ToggleGroupItem: (id, pressed) => element(id, { pressed }),
    ToolbarButton: id => element(id), Checkbox: (id, checked) => element(id, { checked }), window: () => ({ platform: 'macos' }),
    glyph: name => element(`icon-${name}`),
    AUTO_RESUME_KEY: 'herdr-zed.auto-resume', unsavedKey: overlay => `herdr-zed.unsaved.${overlay}`, AlertDialogContent: () => element(), AlertDialogTitle: () => element(), AlertDialogDescription: () => element(), AlertDialogFooter: () => element(), AlertDialogCancel: id => element(id), extensionCatalog: () => ({ packages, resolved: { settings, launcher } }),
    BuildRulesSettings: class { init() { this.inited = true; } close() {} render() { return element('rules'); } },
    GitAuthorSettings: class { constructor(target) { this.target = target; } init() { this.inited = true; } close() {} render() { return element('author'); } },
    managedExtensions: () => packages.filter(entry => !entry.provides?.launcher && entry.mod !== launcher?.mod), extensionKeyOf: entry => entry.id || entry.mod,
    packageStatus: () => null, packageAbout: entry => entry.description || '', placeSwitches: () => element('placement-controls'), placeSurfaces: entry => entry.surfaces || [],
    extensionEnabled: () => true, extensionActive: () => true, setExtensionEnabled() {}, ExtensionsNav: class {},
    props: () => current, openOverlay: spec => { opened.push(spec); return `overlay-${opened.length}`; },
    closeOverlay: id => { if (closeThrows.includes(id)) throw new Error('unknown overlay'); closed.push(id); return null; },
    closeWorkspacePanel: () => panelCloses.push(true),
    run: (...args) => runs.push(args), notify: notice => notices.push(notice),
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
  };
  return { memory, opened, closed, runs, notices, panelCloses, setProps: next => { current = next; },
    ready: evaluateNative('../mods/herdr-zed/settings.js', host, 'openSettings, settingsOverlay, settingsPage, settingsContext, extensionSettingsPages, settingsPageKey, SettingsNav, SettingsHeader, SettingsPage, SETTINGS_OVERLAY, closeOnEscape, requestSettingsClose, navigateSettings, DiscardChanges, WorkflowNav') };
}

const project = { id: 'p', folder: '/work', name: 'Work', machine: undefined, token: 'private' };
const context = { id: 'p', folder: '/work', name: 'Work', machine: null };
const cx = () => ({ notify() {}, stop_propagation() {}, spawn() {}, timer: { every() {} } });
const theme = { selected: 'SELECTED', chrome: 'CHROME', popover: 'POPOVER', muted: 'MUTED', foreground: 'FOREGROUND', hover: 'HOVER', border: 'BORDER' };

test('a shell page opens the one dialog layout: nav beside the page, Sera size, no provider props', async () => {
  const r = settingsRuntime(); const s = await r.ready;
  const id = s.openSettings('general', project);
  assert.equal(id, 'overlay-1'); assert.equal(r.memory['herdr-zed.settings.overlay'], 'overlay-1');
  assert.deepEqual(r.opened[0], { kind: 'dialog', modal: true, frame: 'none', width: 1040, height: 0.86, layout: { type: 'row', resizable: false, background: 'border', padding: 1, children: [
    { type: 'block', size: { px: 220 }, content: { mod: 'herdr-zed', props: { view: 'settings-nav', page: 'general', context } } },
    { type: 'column', resizable: false, background: 'popover', children: [
      { type: 'block', size: { px: 64 }, content: { mod: 'herdr-zed', props: { view: 'settings-header', page: 'general', context } } },
      { type: 'block', content: { mod: 'herdr-zed', props: { view: 'settings-page', page: 'general', context } } },
    ] },
  ] } });
  assert.equal(JSON.stringify(r.opened[0]).includes('private'), false, 'The project token is never handed to a page');
});

test('an extension page embeds its own view with the current project as context', async () => {
  const settings = [{ mod: 'herdr-zed-agents', id: 'agents', view: 'settings', title: 'Agents' }];
  const r = settingsRuntime({ settings }); const s = await r.ready;
  s.openSettings('extension:agents', project);
  assert.equal(r.opened[0].layout.children.length, 2, 'an optional extension opens in the Extensions dialog');
  assert.equal(r.opened[0].layout.children[0].content.props.view, 'extensions-nav', 'with the extensions nav on the left');
  assert.deepEqual(r.opened[0].layout.children[1].children[1], { type: 'block', content: { mod: 'herdr-zed-agents',
    props: { view: 'settings', embedded: true, page: null, context } } });
  assert.equal(r.opened[0].layout.children[1].children[0].content.props.view, 'settings-header', 'the shell title bar sits above it');
  assert.equal(r.opened[0].layout.children[1].children[0].content.props.page, 'extension:agents');
});

test('switching pages closes the open dialog and reopens with the new layout', async () => {
  const r = settingsRuntime(); const s = await r.ready;
  s.openSettings('general', project); s.openSettings('git', project);
  assert.deepEqual(r.closed, ['overlay-1']); assert.equal(r.opened.length, 2);
  assert.equal(r.opened[1].layout.children[1].children[1].content.props.page, 'git');
  assert.equal(r.memory['herdr-zed.settings.overlay'], 'overlay-2');
});

test('an already-closed dialog is not an error, and an ineligible page opens nothing', async () => {
  const r = settingsRuntime({ memory: { 'herdr-zed.settings.overlay': 'gone' }, closeThrows: ['gone'] }); const s = await r.ready;
  assert.equal(s.openSettings('extensions', null), 'overlay-1');
  assert.equal(r.opened[0].layout.children[1].children[1].content.props.context, null, 'No project means no context');
  const before = r.opened.length;
  assert.equal(s.openSettings('extension:missing', project), null);
  assert.equal(r.opened.length, before); assert.deepEqual(r.closed, []);
  assert.equal(r.notices[0].title, 'Settings unavailable');
  assert.equal(s.settingsPage('extension:missing'), null);
  assert.equal(s.settingsPage('general').shell, true);
});

test('preferences nav keeps General and Git, with separate workflows absent', async () => {
  const settings = [{ mod: 'herdr-zed-agents', id: 'agents', view: 'settings', title: 'Agents' }];
  const r = settingsRuntime({ settings }); const s = await r.ready;
  s.openSettings('general', project);
  r.setProps({ page: 'general', context, overlay: 'overlay-1' });
  const nav = new s.SettingsNav().render(theme);
  const labels = text(nav);
  for (const label of ['Settings', 'General', 'Git', 'App settings…']) assert.match(labels, new RegExp(label));
  assert.doesNotMatch(labels, /Agents|Workspace|Extensions|Tools/);
  assert.equal(find(nav, 'settings-nav-overlay-1-extensions'), null);
  assert.equal(find(nav, 'settings-done'), null, 'the nav has no Done');
  assert.equal(find(nav, 'settings-nav-overlay-1-general').__attrs.bg, theme.selected);
  assert.equal(find(nav, 'settings-nav-overlay-1-git').__attrs.bg, theme.chrome);
  assert.equal(nav.__attrs.bg, theme.chrome, 'the nav is distinct from the page');
  assert.equal(find(nav, 'settings-nav-overlay-1-extension-missing'), null);
  find(nav, 'settings-nav-overlay-1-git').__handlers.on_click(undefined, cx());
  assert.deepEqual(r.closed, ['overlay-1']); assert.equal(r.opened[1].layout.children[1].children[1].content.props.page, 'git');
  r.setProps({ page: 'git', context, overlay: 'overlay-2' });
  const again = new s.SettingsNav().render(theme);
  find(again, 'settings-herdr').__handlers.on_click(undefined, cx());
  assert.deepEqual(r.runs, [['app.settings']]); assert.deepEqual(r.closed, ['overlay-1', 'overlay-2']);
  assert.equal(r.memory['herdr-zed.settings.overlay'], null);
  r.setProps({ page: 'general', context, overlay: 'overlay-3' });
  find(new s.SettingsHeader().render(theme), 'settings-close').__handlers.on_click(undefined, cx());
  assert.deepEqual(r.closed.at(-1), 'overlay-3');
  assert.equal(r.memory['herdr-zed.settings.overlay'], null);
});

test('every Settings page gets one title bar naming it, with the close X; the page draws no title of its own', async () => {
  const settings = [{ mod: 'herdr-zed-agents', id: 'agents', view: 'settings', title: 'Agents' }];
  const r = settingsRuntime({ settings }); const s = await r.ready;
  r.setProps({ page: 'git', context, overlay: 'overlay-9' });
  const header = new s.SettingsHeader().render(theme);
  assert.match(text(header), /Git/);
  assert.equal(find(header, 'settings-close').__attrs.accessibility_label, 'Close settings');
  r.setProps({ page: 'extension:agents', context, overlay: 'overlay-9' });
  assert.match(text(new s.SettingsHeader().render(theme)), /Agents/, 'extension pages are named by their Settings title');
  r.setProps({ page: 'general', context: null, overlay: 'overlay-9' });
  const page = new s.SettingsPage(); page.init(cx());
  assert.doesNotMatch(text(page.render(theme)), /\bGeneral\b/, 'the header names the page, not the page body');
});

test('an extension opens its first declared sub-page, and its contextual tabs preserve project context', async () => {
  const settings = [{ mod: 'herdr-zed-demo', id: 'demo', view: 'settings', title: 'Demo',
    pages: [{ id: 'accounts', title: 'Accounts' }, { id: 'profiles', title: 'Profiles' }] }];
  const r = settingsRuntime({ settings }); const s = await r.ready;
  s.openSettings('extension:demo', project);
  const column = r.opened[0].layout.children[1];
  assert.equal(column.children[1].content.props.page, 'accounts');
  assert.equal(column.children[0].size.px, 64, 'every title bar is 64px');
  r.setProps({ ...column.children[0].content.props, overlay: 'overlay-1' });
  const header = new s.SettingsHeader().render(theme);
  assert.equal(find(header, 'settings-subpage-extension:demo:accounts').__attrs.bg, theme.selected);
  find(header, 'settings-subpage-extension:demo:accounts').__handlers.on_click();
  assert.equal(r.opened.length, 1, 'clicking the current tab preserves its form');
  find(header, 'settings-subpage-extension:demo:profiles').__handlers.on_click();
  assert.equal(r.opened[1].layout.children[1].children[1].content.props.page, 'profiles');
  assert.deepEqual(r.opened[1].layout.children[1].children[1].content.props.context, context);
  assert.equal(find(header, 'settings-back'), null, 'the extensions nav replaces the back button');
});

test('General keeps thread preferences; display options live in the Files and Changes toolbars', async () => {
  const r = settingsRuntime(); const s = await r.ready;
  r.setProps({ page: 'general', context: null });
  const page = new s.SettingsPage(); page.init(cx()); const body = page.render({});
  assert.equal(find(body, 'settings-auto-resume').checked, true, 'Auto-resume defaults to on');
  for (const id of ['settings-files-wrap-tabs', 'settings-diff-wrap', 'settings-diff-layout']) assert.equal(find(body, id), null, id);
  find(body, 'settings-auto-resume').__handlers.on_change(false, cx());
  assert.deepEqual(r.memory, { 'herdr-zed.auto-resume': false });
  assert.equal(find(body, 'settings-ctrl-enter-submit').checked, true, 'Ctrl/Enter submission defaults to checked');
  find(body, 'settings-ctrl-enter-submit').__handlers.on_change(false, cx());
  assert.equal(r.memory['herdr-zed.ctrl-enter-submit'], false);
  assert.equal(find(page.render({}), 'settings-ctrl-enter-submit').checked, false, 'explicit off survives rerender');
});

test('launcher configuration has a direct entry and its own dialog, without extension management controls', async () => {
  const settings = [{ mod: 'herdr-zed-workflow', id: 'workflow', view: 'settings', title: 'Workflows',
    pages: [{ id: 'accounts', title: 'Accounts', icon: 'user-round' }] }];
  const packages = [{ mod: 'herdr-zed-workflow', id: 'workflow', title: 'Workflows', provides: { launcher: {} } }];
  const r = settingsRuntime({ settings, packages, launcher: { mod: 'herdr-zed-workflow' } });
  const s = await r.ready;
  s.openSettings('general', project);
  r.setProps({ page: 'general', context, overlay: 'overlay-1' });
  const nav = new s.SettingsNav().render(theme);
  assert.equal(find(nav, 'settings-nav-overlay-1-extension-workflow'), null, 'the entry belongs to the main window');
  s.openSettings('extension:workflow', project);
  assert.equal(r.opened[1].layout.children.length, 2, 'a dedicated dialog replaces preferences');
  assert.equal(r.opened[1].layout.children[0].content.props.view, 'workflow-nav', 'its pages are in a left nav');
  const column = r.opened[1].layout.children[1];
  assert.equal(column.children[1].content.props.page, 'accounts');
  r.setProps({ ...column.children[0].content.props, overlay: 'overlay-2' });
  const header = new s.SettingsHeader().render(theme);
  assert.equal(find(header, 'settings-back'), null, 'no route back into extension management');
  assert.equal(find(header, 'settings-enable-herdr-zed-workflow'), null, 'the core workflow is not an optional extension');
  assert.equal(find(header, 'placement-controls'), null, 'Usage visibility is controlled from the thread menu');
  assert.equal(column.children[0].size.px, 64, 'the standard title bar, with no tab row');
  assert.ok(String(JSON.stringify(header)).includes('Accounts'), 'the title bar names the open page');
  assert.equal(find(header, 'settings-subpage-extension:workflow:accounts'), null, 'no tabs: the nav lists the pages');
  r.setProps({ page: 'extension:workflow:accounts', context, overlay: 'overlay-2' });
  const workflowNav = new s.WorkflowNav(); workflowNav.init({ focus_handle: () => ({ focus() {} }) });
  assert.equal(find(workflowNav.render(theme), 'workflow-nav-overlay-2-accounts').__attrs.bg, theme.selected);
  assert.ok(find(workflowNav.render(theme), 'icon-user-round'), 'the workflow nav renders the declared page icon');
});

test('the Git preferences page contains display filters only; repository identity belongs to Changes', async () => {
  const r = settingsRuntime(); const s = await r.ready;
  r.setProps({ page: 'git', context: { id: 'p', folder: '/repo', name: 'Work', machine: 'box' } });
  const page = new s.SettingsPage(); page.init(cx()); const body = page.render({});
  assert.ok(find(body, 'rules'));
  assert.equal(find(body, 'author'), null);
  assert.equal(page.rules.inited, true);
  r.setProps({ page: 'git', context: null });
  const bare = new s.SettingsPage(); bare.init(cx());
  assert.equal(bare.author, undefined);
  assert.equal(find(bare.render({}), 'author'), null);
});

test('settings:<key> resolves a shell page key before an extension ID; unknown keys stay unavailable', async () => {
  const settings = [{ mod: 'herdr-zed-agents', id: 'agents', view: 'settings', title: 'Agents' }];
  const r = settingsRuntime({ settings }); const s = await r.ready;
  assert.equal(s.settingsPageKey('git'), 'git');
  assert.equal(s.settingsPageKey('extensions'), 'extensions');
  assert.equal(s.settingsPageKey('agents'), 'extension:agents');
  assert.equal(s.openSettings(s.settingsPageKey('git'), project), 'overlay-1');
  assert.equal(r.opened[0].layout.children[1].children[1].content.props.page, 'git');
  assert.equal(s.openSettings(s.settingsPageKey('missing'), project), null);
  assert.equal(r.notices[0].title, 'Settings unavailable');
});

test('the header command loop routes herdr-zed.settings, settings:<id> and extensions to Settings pages', async () => {
  const queue = [], opened = [], jobs = [];
  const host = { ...model, ...contract, View: class {}, startPanel: {}, threadArchive: {}, isProjectPlaceholder: () => false, historyEligible: () => false,
    props: () => ({ view: 'header' }), shared: () => undefined, setShared() {},
    spaces: () => [{ id: 's', name: 'Work', folder: '/work', active: true, tabs: [] }],
    refreshExtensions: async () => {}, startThreadResume: () => ({}), pollLaunchIntake() {}, activeLauncher: () => null,
    nextCommand: async () => queue.length ? queue.shift() : new Promise(() => {}),
    openSettings: (key, target) => opened.push([key, target?.id ?? null]), openExtension() {}, notify() {}, run() {},
    settingsPageKey: id => ['general', 'git', 'extensions'].includes(id) ? id : `extension:${id}`,
    theme: () => ({}), window: () => ({}), settings: () => ({ zoom: 1 }), layout: () => null, layoutNode: () => null,
    extensionCatalog: () => ({ resolved: {} }) };
  Object.assign(host, { IMAGE_PREVIEW_VIEW: 'image-preview', ImagePreview: () => null });
  const { HerdrZed } = await evaluateNative('../mods/herdr-zed/main.js', host, 'HerdrZed');
  const view = new HerdrZed();
  view.init(null, { notify() {}, spawn: fn => jobs.push(fn), timer: { every() {} } });
  queue.push('settings', 'settings:agents', 'settings:git', 'settings:extensions', 'settings:general', 'extensions');
  jobs[1]({ notify() {}, spawn() {} });
  for (let i = 0; i < 20 && opened.length < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [['general', 's'], ['extension:agents', 's'], ['git', 's'], ['extensions', 's'], ['general', 's'], ['extensions', 's']]);
});

test('header destinations are independent; Changes opens its own repository author editor', async () => {
  const main = await readFile(new URL('../mods/herdr-zed/main.js', import.meta.url), 'utf8');
  const diff = await readFile(new URL('../mods/herdr-zed/diff.js', import.meta.url), 'utf8');
  assert.match(main, /accessibility_label\('Settings'\)\s*\.on_click\(\(\) => openSettings\('general'/);
  assert.doesNotMatch(main, /ToolbarButton\('header-agents'/);
  assert.match(main, /'composer-agent-settings'/);
  assert.match(main, /ToolbarButton\('header-extensions'/);
  assert.doesNotMatch(main, /manage-extensions|Manage extensions|openLauncherSettings|openExtensions|Herdr settings|diff-ignore-settings/);
  assert.match(diff, /if \(key === 'filter-rules'\) openSettings\('git', this\.context\);/);
  assert.match(diff, /action \? openGitAction\(action\.id, this\.context\) : openGitAuthor\(this\.context\)/, 'the identity row opens the provider account or the shell author form');
  assert.match(diff, /if \(key === 'list' \|\| key === 'tree'\) this\.setFileView/, 'Changes keeps List and Tree');
  assert.doesNotMatch(diff, /openBuildRules/);
});

test('opening Settings closes the open workspace panel, so no panel outlives the selection', async () => {
  const r = settingsRuntime(); const s = await r.ready;
  s.openSettings('general', project);
  assert.deepEqual(r.panelCloses, [true]);
});

test('Esc closes Settings, Extensions and Agents from any shell block: layout dialogs do not get Herdr\'s own Esc', async () => {
  const r = settingsRuntime({ memory: { 'herdr-zed.settings.overlay': 'dlg' } }); const s = await r.ready;
  const stopped = [];
  const key = (el, name) => el.__handlers.on_key_down({ key: name }, { stop_propagation: () => stopped.push(name) });
  key(s.closeOnEscape(element(), 'dlg'), 'enter');
  assert.deepEqual(r.closed, [], 'other keys pass through');
  key(s.closeOnEscape(element(), 'dlg'), 'escape');
  assert.deepEqual(r.closed, ['dlg']); assert.deepEqual(stopped, ['escape']);
  r.setProps({ page: 'general', context: null, overlay: 'dlg' });
  const page = new s.SettingsPage(); page.init(cx());
  key(page.render({}), 'escape');
  assert.deepEqual(r.closed, ['dlg', 'dlg'], 'the page closes it too');
});

test('unsaved changes: closing or leaving asks first; Keep editing returns, Discard drops them and goes on', async () => {
  const r = settingsRuntime({ memory: { 'herdr-zed.settings.overlay': 'dlg', 'herdr-zed.unsaved.dlg': true } }); const s = await r.ready;
  s.requestSettingsClose('dlg');
  assert.deepEqual(r.closed, [], 'nothing closes while edits are unsaved');
  assert.equal(r.opened.at(-1).props.view, 'discard-changes');
  assert.deepEqual([r.opened.at(-1).props.target, r.opened.at(-1).props.next], ['dlg', null]);
  // Keep editing closes only the question.
  r.setProps({ overlay: 'ask', target: 'dlg', next: null });
  let ask = new s.DiscardChanges(); ask.init({ focus_handle: () => ({ focus() {} }) });
  find(ask.render({}), 'discard-changes-keep').__handlers.on_click();
  assert.deepEqual(r.closed, ['ask']); assert.equal(r.memory['herdr-zed.unsaved.dlg'], true);
  // Discard drops the edits and closes the dialog.
  find(ask.render({}), 'discard-changes-confirm').__handlers.on_click();
  assert.deepEqual(r.closed, ['ask', 'ask', 'dlg']); assert.equal(r.memory['herdr-zed.unsaved.dlg'], null);
  // Leaving for another page asks the same way, then opens that page.
  r.memory['herdr-zed.settings.overlay'] = 'dlg'; r.memory['herdr-zed.unsaved.dlg'] = true;
  s.navigateSettings('git', null, 'dlg');
  const next = r.opened.at(-1).props.next;
  assert.deepEqual(next, { key: 'git', project: null });
  r.setProps({ overlay: 'ask2', target: 'dlg', next });
  ask = new s.DiscardChanges(); ask.init({ focus_handle: () => ({ focus() {} }) });
  find(ask.render({}), 'discard-changes-confirm').__handlers.on_click();
  assert.equal(r.opened.at(-1).layout.children[1].children[1].content.props.page, 'git');
  // Without edits nothing is asked.
  const before = r.opened.length;
  s.requestSettingsClose(r.memory['herdr-zed.settings.overlay']);
  assert.equal(r.opened.length, before);
});
