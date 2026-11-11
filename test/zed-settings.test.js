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
    ToolbarButton: id => element(id),
    glyph: () => element(),
    AUTO_RESUME_KEY: 'herdr-zed.auto-resume', extensionCatalog: () => ({ packages, resolved: { settings, launcher } }),
    BuildRulesSettings: class { init() { this.inited = true; } close() {} render() { return element('rules'); } },
    GitAuthorSettings: class { constructor(target) { this.target = target; } init() { this.inited = true; } close() {} render() { return element('author'); } },
    ExtensionsManager: class { init() { this.inited = true; } render() { return element('extensions-body'); } controls() { return element('placement-controls'); } },
    props: () => current, openOverlay: spec => { opened.push(spec); return `overlay-${opened.length}`; },
    closeOverlay: id => { if (closeThrows.includes(id)) throw new Error('unknown overlay'); closed.push(id); return null; },
    closeWorkspacePanel: () => panelCloses.push(true),
    run: (...args) => runs.push(args), notify: notice => notices.push(notice),
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
  };
  return { memory, opened, closed, runs, notices, panelCloses, setProps: next => { current = next; },
    ready: evaluateNative('../mods/herdr-zed/settings.js', host, 'openSettings, settingsOverlay, settingsPage, settingsContext, extensionSettingsPages, settingsPageKey, SettingsNav, SettingsHeader, SettingsPage, SETTINGS_OVERLAY') };
}

const project = { id: 'p', folder: '/work', name: 'Work', machine: undefined, token: 'private' };
const context = { id: 'p', folder: '/work', name: 'Work', machine: null };
const cx = () => ({ notify() {}, stop_propagation() {}, spawn() {} });
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
  assert.equal(r.opened[0].layout.children.length, 1, 'configuration has its own dialog, without the preferences nav');
  assert.deepEqual(r.opened[0].layout.children[0].children[1], { type: 'block', content: { mod: 'herdr-zed-agents',
    props: { view: 'settings', embedded: true, page: null, context } } });
  assert.equal(r.opened[0].layout.children[0].children[0].content.props.view, 'settings-header', 'the shell title bar sits above it');
  assert.equal(r.opened[0].layout.children[0].children[0].content.props.page, 'extension:agents');
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
  assert.equal(r.opened[0].layout.children[0].children[1].content.props.context, null, 'No project means no context');
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

test('an extension opens its first declared sub-page, and its contextual tabs and back button preserve project context', async () => {
  const settings = [{ mod: 'herdr-zed-demo', id: 'demo', view: 'settings', title: 'Demo',
    pages: [{ id: 'accounts', title: 'Accounts' }, { id: 'profiles', title: 'Profiles' }] }];
  const r = settingsRuntime({ settings }); const s = await r.ready;
  s.openSettings('extension:demo', project);
  const column = r.opened[0].layout.children[0];
  assert.equal(column.children[1].content.props.page, 'accounts');
  assert.equal(column.children[0].size.px, 144);
  r.setProps({ ...column.children[0].content.props, overlay: 'overlay-1' });
  const header = new s.SettingsHeader().render(theme);
  assert.equal(find(header, 'settings-subpage-extension:demo:accounts').__attrs.bg, theme.selected);
  find(header, 'settings-subpage-extension:demo:accounts').__handlers.on_click();
  assert.equal(r.opened.length, 1, 'clicking the current tab preserves its form');
  find(header, 'settings-subpage-extension:demo:profiles').__handlers.on_click();
  assert.equal(r.opened[1].layout.children[0].children[1].content.props.page, 'profiles');
  assert.deepEqual(r.opened[1].layout.children[0].children[1].content.props.context, context);
  find(header, 'settings-back').__handlers.on_click();
  assert.equal(r.opened[2].layout.children[0].children[1].content.props.page, 'extensions');
});

test('the General page binds each preference to its shared key and defaults as before', async () => {
  const r = settingsRuntime(); const s = await r.ready;
  r.setProps({ page: 'general', context: null });
  const page = new s.SettingsPage(); page.init(cx()); const body = page.render({});
  assert.equal(find(body, 'settings-auto-resume').checked, true, 'Auto-resume defaults to on');
  assert.equal(find(body, 'settings-files-wrap-tabs').checked, false, 'Tab wrap defaults to off');
  assert.equal(find(body, 'settings-diff-wrap').checked, true, 'Diff wrap defaults to on');
  assert.equal(find(body, 'settings-diff-unified').pressed, true);
  find(body, 'settings-auto-resume').__handlers.on_change(false, cx());
  find(body, 'settings-files-wrap-tabs').__handlers.on_change(true, cx());
  find(body, 'settings-diff-wrap').__handlers.on_change(false, cx());
  find(body, 'settings-diff-split').__handlers.on_change(true, cx());
  find(body, 'settings-diff-unified').__handlers.on_change(false, cx());
  assert.deepEqual(r.memory, { 'herdr-zed.auto-resume': false, 'herdr-zed.files-wrap-tabs': true, 'herdr-zed.diff-wrap': false, 'herdr-zed.diff-layout': 'split' });
});

test('launcher configuration has a direct entry and its own dialog, without extension management controls', async () => {
  const settings = [{ mod: 'herdr-zed-workflow', id: 'workflow', view: 'settings', title: 'Workflows',
    pages: [{ id: 'accounts', title: 'Accounts' }] }];
  const packages = [{ mod: 'herdr-zed-workflow', id: 'workflow', title: 'Workflows', provides: { launcher: {} } }];
  const r = settingsRuntime({ settings, packages, launcher: { mod: 'herdr-zed-workflow' } });
  const s = await r.ready;
  s.openSettings('general', project);
  r.setProps({ page: 'general', context, overlay: 'overlay-1' });
  const nav = new s.SettingsNav().render(theme);
  assert.equal(find(nav, 'settings-nav-overlay-1-extension-workflow'), null, 'the entry belongs to the main window');
  s.openSettings('extension:workflow', project);
  assert.equal(r.opened[1].layout.children.length, 1, 'a dedicated dialog replaces preferences');
  const column = r.opened[1].layout.children[0];
  assert.equal(column.children[1].content.props.page, 'accounts');
  r.setProps({ ...column.children[0].content.props, overlay: 'overlay-2' });
  const header = new s.SettingsHeader().render(theme);
  assert.equal(find(header, 'settings-back'), null, 'no route back into extension management');
  assert.equal(find(header, 'settings-enable-herdr-zed-workflow'), null, 'the core workflow is not an optional extension');
  assert.equal(find(header, 'placement-controls'), null, 'Usage visibility is controlled from the thread menu');
  assert.equal(column.children[0].size.px, 104, 'the removed display row leaves no blank header strip');
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

test('the Extensions page embeds the manager body', async () => {
  const r = settingsRuntime(); const s = await r.ready;
  r.setProps({ page: 'extensions', context: null });
  const page = new s.SettingsPage(); page.init(cx());
  assert.ok(find(page.render({}), 'extensions-body'));
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
  assert.match(main, /key: 'agent-settings'/);
  assert.match(main, /ToolbarButton\('header-extensions'/);
  assert.doesNotMatch(main, /manage-extensions|Manage extensions|openLauncherSettings|openExtensions|Herdr settings|diff-ignore-settings/);
  assert.match(diff, /if \(key === 'filter-rules'\) openSettings\('git', this\.context\);/);
  assert.match(diff, /if \(key === 'commit-author'\) openGitAuthor\(this\.context\);/);
  assert.match(diff, /if \(key === 'list' \|\| key === 'tree'\) this\.setFileView/, 'Changes keeps List and Tree');
  assert.doesNotMatch(diff, /openBuildRules/);
});

test('opening Settings closes the open workspace panel, so no panel outlives the selection', async () => {
  const r = settingsRuntime(); const s = await r.ready;
  s.openSettings('general', project);
  assert.deepEqual(r.panelCloses, [true]);
});
