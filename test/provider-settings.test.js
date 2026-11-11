import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateNative } from './source-harness.js';
import { parseExtensionManifest, extensionMetadata } from '../mods/herdr-zed/extension-model.js';
import * as sessions from '../components/session-model.js';

// Provider Settings pages the shell embeds: each view mounts with props { view, embedded, context, overlay }.
// Elements are recording stand-ins, so a test reads what was drawn: frames, titles, buttons and handlers.

const elements = new WeakSet();
const describe = value => elements.has(value) ? '<el>' : typeof value === 'string' ? JSON.stringify(value)
  : typeof value === 'function' ? '<fn>' : Array.isArray(value) || (value && typeof value === 'object') ? '<object>' : String(value);

// Every creation and call is logged as [element, method, ...args]. Handlers are stored under `element#id`, so a test can press them.
function kit(log, events = {}) {
  const make = (base, args) => {
    let name = typeof args[0] === 'string' ? `${base}#${args[0]}` : base;
    log.push([name, 'new']);
    const el = new Proxy({}, { get(_target, key) {
      if (typeof key !== 'string') return undefined;
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      if (key === 'then') return undefined;
      return (...values) => {
        log.push([name, key, ...values.map(describe)]);
        if (key === 'id') name = `${base}#${values[0]}`;
        if (key.startsWith('on_')) (events[name] ||= {})[key] = values[0];
        return el;
      };
    } });
    elements.add(el);
    return el;
  };
  return { make, factory: base => (...args) => make(base, args) };
}

const fakeInput = () => ({ text: '', on() {}, value() { return this.text; }, set_value(text) { this.text = text; }, release() {} });
const theme = () => ({ foreground: '#f5f5f5', muted: '#999', border: '#222', input: '#333', background: '#000', popover: '#111',
  destructive: '#f00', selected: '#222', ansi1: '#f00', solid: '#fff', solid_foreground: '#000', hover: '#181818', skeleton: '#333' });
const names = log => log.map(([name]) => name);
const ctx = pending => ({ notify() {}, spawn(fn) { pending.push(fn(ctx(pending))); }, stop_propagation() {} });
async function settle(pending) { while (pending.length) await Promise.all(pending.splice(0)); }

// Default stand-ins for the gpui-kit and gpui-base names every view uses. Overrides spread over them.
function shell(overrides = {}) {
  const log = [], events = {}, closed = [];
  const { make, factory } = kit(log, events);
  const host = {
    props: () => ({}), theme, closeOverlay: id => closed.push(id), run() {}, shared: () => null, setShared() {},
    div: factory('div'), v_flex: factory('v_flex'), h_flex: factory('h_flex'), svg: factory('svg'), glyph: factory('glyph'),
    DialogContent: factory('DialogContent'), DialogTitle: factory('DialogTitle'), DialogDescription: factory('DialogDescription'),
    DialogFooter: factory('DialogFooter'), Button: (id, ...rest) => make('Button', [id, ...rest]), Checkbox: factory('Checkbox'),
    // The shared title bar: logs its title as a DialogTitle child, and its close control as Button#<id> with the handler stored.
    DialogHeader: (_t, title, { id, label, onClose }) => {
      log.push(['DialogTitle', 'child', JSON.stringify(title)]);
      make('Button', [id]).accessibility_label(label);
      events[`Button#${id}`] = { on_click: onClose };
      return make('DialogHeader', []);
    },
    DropdownMenuTrigger: factory('DropdownMenuTrigger'), Select: factory('Select'), SelectState: class { constructor() { this.search = { release() {} }; } },
    Input: { new: state => make('Input', [state?.id || 'input']) }, InputState: { new: fakeInput }, ...overrides,
  };
  return { host, log, events, closed, make, factory };
}

const manifests = ['agents', 'github', 'asana', 'mantisbt', 'system'];
const expectedSettings = { agents: { view: 'manage-launchers', title: 'Agents' }, github: { view: 'settings', title: 'GitHub' },
  asana: { view: 'settings', title: 'Asana' }, mantisbt: { view: 'settings', title: 'MantisBT' }, system: { view: 'settings', title: 'System Monitor' } };

test('each provider manifest declares its Settings page and the shell parser accepts it', async () => {
  for (const id of manifests) {
    const text = await readFile(new URL(`../mods/herdr-zed-${id}/extension.json`, import.meta.url), 'utf8');
    assert.doesNotThrow(() => parseExtensionManifest(`herdr-zed-${id}`, text), `${id} parses`);
    assert.deepEqual(extensionMetadata(`herdr-zed-${id}`, text).settings, expectedSettings[id], `${id} settings`);
  }
});

test('Agents Settings embedded in the shell draws no frame, title or close control, and leaves Escape to the shell', async () => {
  const { host, log, events, closed, factory } = shell({ props: () => ({ view: 'manage-launchers', embedded: true, overlay: 'shell' }),
    ...sessions, availableAgents: () => [], spaces: () => [] });
  const { sessionMenu } = await evaluateNative('../mods/herdr-zed-agents/session-menu.js', host, 'sessionMenu');
  const page = factory('page')();
  sessionMenu.manageLaunchers.call({ launchers: [], manageIndex: 0, handle: { focus() {} }, settingsPage: 'agents',
    availableAgents: () => [], agentsPage: () => page }, theme(), ctx([]));
  assert.ok(!names(log).some(name => name.startsWith('DialogContent')), 'no dialog frame');
  assert.ok(names(log).includes('v_flex#manage-launchers'), 'the shell owns the frame');
  assert.ok(!log.some(([name, method, arg]) => name === 'DialogTitle' && method === 'child' && arg === '"Agents"'), 'no title of its own');
  assert.ok(!names(log).some(name => name.startsWith('Button#manage-launchers-close')), 'no close control of its own');
  let stopped = false;
  events['v_flex#manage-launchers'].on_key_down({ key: 'escape' }, { stop_propagation() { stopped = true; } });
  assert.deepEqual(closed, [], 'Escape is left to the shell');
  assert.equal(stopped, false);
});

test('Agents Settings standalone keeps its dialog frame, a header X in place of Done, and Escape close', async () => {
  const { host, log, events, closed, factory } = shell({ props: () => ({ view: 'manage-launchers', overlay: 'legacy' }),
    ...sessions, availableAgents: () => [], spaces: () => [] });
  const { sessionMenu } = await evaluateNative('../mods/herdr-zed-agents/session-menu.js', host, 'sessionMenu');
  sessionMenu.manageLaunchers.call({ launchers: [], manageIndex: 0, handle: { focus() {} }, settingsPage: 'agents',
    availableAgents: () => [], agentsPage: () => factory('page')() }, theme(), ctx([]));
  assert.ok(names(log).includes('DialogContent#manage-launchers'));
  assert.ok(log.some(([name, method, arg]) => name === 'DialogTitle' && method === 'child' && arg === '"Settings"'), 'the header names the dialog');
  assert.ok(!names(log).some(name => name.startsWith('Button#manage-launchers-done')), 'no Done footer');
  events['Button#manage-launchers-close'].on_click({}, ctx([]));
  assert.deepEqual(closed, ['legacy']);
});

test('GitHub account Settings embedded lists signed-in accounts, keeps Save and Cancel, and never closes the shell', async () => {
  const { host, log, events, closed } = shell({ props: () => ({ view: 'settings', embedded: true, overlay: 'shell',
    context: { folder: '/repo', machine: '', name: 'repo' } }) });
  const saved = [], reads = [], pending = [];
  Object.assign(host, {
    readGitAuthor: async (...args) => { reads.push(args); return { name: 'Ann', email: 'ann@example.test' }; },
    readAccountAuthor: async () => ({ name: 'Amy', email: 'amy@example.test' }),
    saveGitAuthor: async (...args) => saved.push(args), setGitAccount() {}, rememberGitAuthor() {},
    gitAccount: () => ({ host: 'github.com', login: 'amy' }),
    readGitAccounts: async () => [{ host: 'github.com', login: 'amy', available: true }, { host: 'github.com', login: 'bob', available: false }],
  });
  const { GitHubAccount } = await evaluateNative('../mods/herdr-zed-github/account.js', host, 'GitHubAccount');
  const view = new GitHubAccount(); view.init(ctx(pending)); await settle(pending);
  view.render(theme());
  assert.ok(!names(log).some(name => name.startsWith('DialogContent')), 'no dialog frame');
  assert.ok(!names(log).some(name => name.startsWith('Select')), 'signed-in accounts are listed, not a popup');
  assert.ok(!log.some(([, method, arg]) => method === 'child' && arg === '"GitHub"'), 'no page title of its own');
  for (const id of ['default', '0', '1']) assert.ok(events[`Button#git-account-${id}`], `account row ${id}`);
  assert.ok(log.some(([name, method, arg]) => name === 'Button#git-account-1' && method === 'disabled' && arg === 'true'),
    'a row that needs sign-in is disabled');
  assert.ok(events['Button#git-author-save'] && events['Button#git-author-cancel'], 'Save and Cancel stay');
  view.name.set_value('Amy'); view.email.set_value('amy@example.test');
  events['Button#git-author-save'].on_click({}, ctx(pending)); await settle(pending);
  assert.equal(saved.length, 1, 'Save writes the author');
  assert.deepEqual(closed, [], 'the shell owns closing');
  const before = reads.length;
  events['Button#git-author-cancel'].on_click({}, ctx(pending)); await settle(pending);
  assert.equal(reads.length, before + 1, 'Cancel reloads the saved author');
  assert.deepEqual(closed, []);
});

test('GitHub account standalone keeps its popup dialog and closes on Cancel', async () => {
  const { host, log, events, closed } = shell({ props: () => ({ overlay: 'popup', context: { folder: '/repo', machine: '' } }) });
  const pending = [];
  Object.assign(host, { readGitAuthor: async () => ({ name: 'Ann', email: 'a@example.test' }), readGitAccounts: async () => [],
    gitAccount: () => null });
  const { GitHubAccount } = await evaluateNative('../mods/herdr-zed-github/account.js', host, 'GitHubAccount');
  const view = new GitHubAccount(); view.init(ctx(pending)); await settle(pending);
  view.render(theme());
  assert.ok(names(log).includes('DialogContent#github-account'));
  assert.ok(names(log).includes('Select#git-account'), 'standalone keeps the account choice');
  events['Button#git-author-cancel'].on_click({}, ctx(pending));
  assert.deepEqual(closed, ['popup']);
});

// The providers' panels are stood in for here; their token logic has its own tests (asana.test.js, mantisbt.test.js).
function fakePanel() {
  return class {
    constructor() { this.needsToken = null; this.token = null; this.error = null; this.tokenBusy = false; this.tokenCopied = false;
      this.tokenInput = fakeInput(); this.serverInput = fakeInput(); this.calls = []; this.disposed = false; }
    init() {}
    open(project) { this.calls.push(['open', project.folder]); this.needsToken = false; this.token = 'saved-token'; }
    openSettings() { this.calls.push(['openSettings']); }
    syncFields() { this.calls.push(['syncFields']); }
    saveToken() { this.calls.push(['saveToken']); }
    clearToken() { this.calls.push(['clearToken']); }
    copyToken() { this.calls.push(['copyToken']); }
    fieldSettings() { return { fields: true }; }
    dispose() { this.disposed = true; }
  };
}

for (const { id, file, cls, panel, source, title, prefix } of [
  { id: 'asana', file: 'herdr-zed-asana/settings.js', cls: 'AsanaSettings', panel: 'AsanaPanel', source: { name: 'Asana', tokenHelp: 'Paste a token.' }, title: 'Asana', prefix: 'asana' },
  { id: 'mantisbt', file: 'herdr-zed-mantisbt/settings.js', cls: 'MantisSettings', panel: 'MantisPanel', source: { name: 'MantisBT', server: true }, title: 'MantisBT', prefix: 'mantis' },
]) {
  async function load(props, { host, log, events, closed }) {
    const panels = [], Base = fakePanel();
    Object.assign(host, { props: () => props, sourceModuleOptions: () => ({}), asanaSource: source, mantisSource: source,
      [panel]: class extends Base { constructor(options) { super(options); panels.push(this); } } });
    const { [cls]: Settings } = await evaluateNative(`../mods/${file}`, host, cls);
    return { view: new Settings(), panel: () => panels[0], log, events, closed };
  }

  test(`${title} Settings embedded draws its connection form without a frame, title or close control`, async () => {
    const context = { folder: '/repo', name: 'repo', machine: '' };
    const { view, panel, log, events, closed } = await load({ embedded: true, overlay: 'shell', context }, shell());
    view.init(ctx([]));
    assert.deepEqual(panel().calls[0], ['open', '/repo'], 'the token is read for the context');
    view.render(ctx([]));
    assert.equal(panel().calls.filter(([name]) => name === 'openSettings').length, 1, 'the saved connection seeds the form once');
    assert.ok(panel().calls.some(([name]) => name === 'syncFields'), 'field display loads');
    assert.ok(!names(log).some(name => name.startsWith('DialogContent')), 'no frame');
    assert.ok(!log.some(([, method, arg]) => method === 'child' && arg === `"${title}"`), 'no page title of its own');
    assert.ok(!log.some(([name]) => name.includes(`${prefix}-settings-close`)), 'no close control of its own');
    assert.deepEqual(closed, []);
    events[`Button#${prefix}-save-token`].on_click({}, ctx([]));
    assert.deepEqual(panel().calls.at(-1), ['saveToken']);
    events[`Button#${prefix}-cancel-token`].on_click({}, ctx([]));
    assert.deepEqual(panel().calls.at(-1), ['openSettings'], 'Cancel discards the draft instead of closing');
    assert.deepEqual(closed, [], 'Cancel does not close the shell');
    view.close(); assert.equal(panel().disposed, true);
  });

  test(`${title} Settings standalone keeps its frame, its title and a header X in place of Done`, async () => {
    const { view, log, events, closed } = await load({ overlay: 'standalone', context: { folder: '/repo' } }, shell());
    view.init(ctx([])); view.render(ctx([]));
    assert.ok(log.some(([, method, arg]) => method === 'child' && arg === `"${title}"`), 'the header names the page');
    assert.ok(names(log).includes(`Button#${prefix}-settings-close`), 'the header X is drawn');
    assert.ok(!names(log).some(name => name.includes('-settings-done')), 'no Done footer');
    events[`Button#${prefix}-settings-close`].on_click({}, ctx([]));
    assert.deepEqual(closed, ['standalone']);
  });
}

test('the Asana browser gear and the MantisBT My Account item deep-link to the shell Settings page', async () => {
  const runs = [];
  const { host, events } = shell({ run: (...args) => runs.push(args), TaskSourceProjectPicker: class {},
    TaskSourceController: class { constructor(options) { this.options = options; } }, asanaSource: { name: 'Asana' },
    mantisSource: { name: 'MantisBT' }, filterProjects: () => [], readMantisProjects: async () => [], saveMantisProjects: async () => {},
    readMantisIssues: async () => [], saveMantisIssues: async () => {}, DropdownMenu: () => {}, DropdownMenuState: class {},
    DropdownMenuContent: () => {}, DropdownMenuItem: () => {}, DropdownMenuLabel: () => {}, DropdownMenuSeparator: () => {},
    ToggleGroup: () => {}, ToggleGroupItem: () => {}, previewWidthAt: () => 0, statusKind: () => 'todo', avatarColor: () => '#fff',
    initials: () => 'A', dueLabel: () => '', relativeTime: () => '', sourcePathKey: () => '' });
  const asana = await evaluateNative('../mods/herdr-zed-asana/ui.js', host, 'AsanaPanel');
  const asanaPanel = Object.assign(Object.create(asana.AsanaPanel.prototype), { needsToken: false, settingsOpen: false, tokenBusy: false,
    source: { name: 'Asana' }, binding: () => null, openSettings() { assert.fail('the gear no longer opens the browser page'); } });
  asanaPanel.toolbar(theme(), () => {});
  events['Button#asana-settings'].on_click({}, { notify() {} });
  assert.deepEqual(runs.at(-1), ['herdr-zed.settings:asana']);

  const mantis = await evaluateNative('../mods/herdr-zed-mantisbt/ui.js', host, 'MantisPanel');
  const mantisPanel = Object.assign(Object.create(mantis.MantisPanel.prototype), { needsToken: false, settingsOpen: false, tokenBusy: false,
    tab: 'all', source: { name: 'MantisBT' }, binding: () => null, openSettings() { assert.fail('My Account no longer opens the browser page'); } });
  mantisPanel.sidebar();
  events['Button#mantis-account'].on_click({}, { notify() {} });
  assert.deepEqual(runs.at(-1), ['herdr-zed.settings:mantisbt']);
});

test('System Monitor Settings embedded draws no frame, title or Done, and the details entries deep-link to the shell page', async () => {
  const runs = [], closed = [];
  const { host, log, events, make } = shell({ run: (...args) => runs.push(args), closeOverlay: id => closed.push(id),
    hardwarePreferences: () => ({ order: ['cpu'], visible: { cpu: true }, interval: 1, cpuGraph: 'total', cores: null }),
    hardwareAvailable: () => true, hardwareTitle: id => id, hardwareDisplayItems: () => [], hardwareColors: () => ({}),
    selectedHardwareCores: () => [], topologyLabel: () => '', processorLabel: () => '', SystemMonitor: class {}, SystemClient: class {},
    PathBuilder: class {}, hardwareModules: [], exec() {}, appHome: () => '/home' });
  const { SystemMonitorCore } = await evaluateNative('../mods/herdr-zed-system/monitor.js', host, 'SystemMonitorCore');
  const monitor = new SystemMonitorCore({ overlay: 'shell' });
  monitor.hardwareSettings = () => make('hardware-settings', []);

  monitor.renderSettings(theme(), true);
  assert.ok(!names(log).some(name => name.startsWith('DialogContent')), 'no frame when embedded');
  assert.ok(!names(log).some(name => name.includes('system-settings-close')), 'no close control when embedded');
  assert.ok(!log.some(([name, method, arg]) => name.startsWith('DialogTitle') && method === 'child' && arg === '"System Monitor"'), 'no title when embedded');

  log.length = 0;
  monitor.renderSettings(theme(), false);
  assert.ok(names(log).includes('DialogContent#system-settings'), 'standalone keeps its frame');
  assert.ok(log.some(([name, method, arg]) => name === 'DialogTitle' && method === 'child' && arg === '"System Monitor"'), 'the header names it');
  assert.ok(!names(log).some(name => name.includes('system-settings-done')), 'no Done footer');
  events['Button#system-settings-close'].on_click({}, { notify() {} });
  assert.deepEqual(closed, ['shell']);

  log.length = 0;
  monitor.renderDetails(theme());
  events['Button#hardware-page-settings'].on_click({}, { notify() {} });
  assert.deepEqual(runs.at(-1), ['herdr-zed.settings:system']);
  assert.notEqual(monitor.hardwarePage, 'settings', 'the details dialog no longer hosts Settings');
});
