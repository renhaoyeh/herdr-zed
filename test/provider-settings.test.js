import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateNative } from './source-harness.js';
import { parseExtensionManifest, extensionMetadata } from '../mods/herdr-zed/extension-model.js';
import * as sessions from '../components/session-model.js';
import { Autosave } from '../components/autosave.js';

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
const ctx = pending => ({ notify() {}, spawn(fn) { pending.push(fn(ctx(pending))); }, stop_propagation() {}, timer: { every() {} } });
async function settle(pending) { while (pending.length) await Promise.all(pending.splice(0)); }

// Default stand-ins for the gpui-kit and gpui-base names every view uses. Overrides spread over them.
function shell(overrides = {}) {
  const log = [], events = {}, closed = [];
  const { make, factory } = kit(log, events);
  const host = {
    props: () => ({}), theme, closeOverlay: id => closed.push(id), run() {}, shared: () => null, setShared() {},
    unsavedKey: overlay => `herdr-zed.unsaved.${overlay}`, SETTINGS_CLOSE_COMMAND: 'settings-close', Autosave,
    div: factory('div'), v_flex: factory('v_flex'), h_flex: factory('h_flex'), svg: factory('svg'), glyph: factory('glyph'), AgentIcon: factory('AgentIcon'),
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

test('account-card menu saves profile defaults independently and closes on Escape', async () => {
  const account = { key: 'codex', name: 'Codex', installed: true };
  const profile = { ...account, key: 'herdr-zed-preset-work', profileKey: 'codex', name: 'Work' };
  const state = { 'herdr-zed.profile-sessions': { codex: { model: 'other' } } };
  const { host, log, events, closed, factory } = shell({ ...sessions, availableAgents: items => items,
    props: () => ({ account: profile.key, overlay: 'popup' }),
    shared: key => state[key], setShared: (key, value) => { state[key] = value; } });
  host.DropdownMenuContent = factory('DropdownMenuContent'); host.DropdownMenuLabel = factory('DropdownMenuLabel');
  const { sessionMenu } = await evaluateNative('../mods/herdr-zed-agents/session-menu.js', host, 'sessionMenu');
  const view = { ...sessionMenu, launchers: [account, profile], availableAgents: items => items,
    profileModels: () => [{ key: 'gpt-test', label: 'Test model', efforts: ['low', 'high'] }], handle: {},
    configurationFields: agent => { assert.equal(agent.key, profile.key); return host.div(); } };
  view.profileDefaults(theme());
  assert.equal(log.some(([, method, text]) => method === 'child' && text === JSON.stringify('Models in menu')), false);
  const fields = view.providerDefaults(profile);
  fields.find(field => field.id === 'model').items.find(item => item.key === 'gpt-test').choose();
  fields.find(field => field.id === 'effort').items.find(item => item.key === 'high').choose();
  const permission = fields.find(field => field.id === 'permissions').items.find(item => item.key !== 'default');
  permission.choose();
  assert.equal(state['herdr-zed.profile-sessions'][profile.key].model, 'gpt-test');
  assert.equal(state['herdr-zed.profile-sessions'][profile.key].effort, 'high');
  assert.equal(state['herdr-zed.codex-permissions'][profile.key], permission.key);
  assert.equal(state['herdr-zed.profile-sessions'].codex.model, 'other');
  events['DropdownMenuContent#profile-defaults-menu'].on_key_down({ key: 'escape' }, ctx([]));
  assert.deepEqual(closed, ['popup']);
  view.launchers = [account];
  view.profileDefaults(theme());
  assert.ok(log.some(([, method, text]) => method === 'child' && text === JSON.stringify('This profile is no longer available.')));
});
// The Agents extension's pages, as its manifest lists them. The shell mounts one per id with `page` in props.
test('root model-menu switches apply to every Codex profile and Custom exposes none', async () => {
  const work = { key: 'herdr-zed-codex-work', name: 'Work' };
  const other = { key: 'herdr-zed-codex-other', name: 'Other' };
  const state = { 'herdr-zed.profile-sessions': { [work.key]: { model: 'mini' }, [other.key]: { model: 'mini' } } };
  const { host, events, factory } = shell({ ...sessions, availableAgents: items => items,
    shared: key => state[key], setShared: (key, value) => { state[key] = value; } });
  host.Switch = factory('Switch'); host.ToggleGroup = factory('ToggleGroup'); host.ToggleGroupItem = factory('ToggleGroupItem');
  const { sessionMenu } = await evaluateNative('../mods/herdr-zed-agents/session-menu.js', host, 'sessionMenu');
  const view = { ...sessionMenu, launchers: [work, other], codexModelList: [
    { key: 'gpt', label: 'GPT', efforts: ['low', 'high'] }, { key: 'mini', label: 'Mini', efforts: ['low'] }] };
  view.sessionOptions(['codex'], theme());
  events['Switch#session-codex-models-mini'].on_change(false, ctx([]));
  assert.deepEqual(state['herdr-zed.session-options'].codex.models, ['mini']);
  assert.equal(state['herdr-zed.session-options'][work.key], undefined);
  assert.equal(state['herdr-zed.profile-sessions'][work.key].model, null);
  assert.equal(state['herdr-zed.profile-sessions'][other.key].model, null);
  assert.deepEqual(view.sessionOptions(['custom'], theme()), []);
});

const agentsPages = [{ id: 'accounts', title: 'Accounts', group: 'Accounts', icon: 'user-round' }, { id: 'profiles', title: 'Profiles', icon: 'tag' }, { id: 'agents', title: 'Launch menu', group: 'New thread', icon: 'list-tree' },
  { id: 'models', title: 'Models', icon: 'agent' },
  { id: 'capabilities', title: 'Capabilities', group: 'Sessions', icon: 'extensions' }, { id: 'ecc', title: 'ECC', icon: 'zap' }, { id: 'mcp', title: 'MCP Connections', icon: 'server' }, { id: 'global-rules', title: 'Global Rules', icon: 'book-open' }];

const expectedSettings = { agents: { view: 'manage-launchers', title: 'Agents', pages: agentsPages }, github: { view: 'settings', title: 'GitHub', pages: [] },
  asana: { view: 'settings', title: 'Asana', pages: [] }, mantisbt: { view: 'settings', title: 'MantisBT', pages: [] },
  system: { view: 'settings', title: 'System Monitor', pages: [] } };

test('each provider manifest declares its Settings page and the shell parser accepts it', async () => {
  for (const id of manifests) {
    const text = await readFile(new URL(`../mods/herdr-zed-${id}/extension.json`, import.meta.url), 'utf8');
    assert.doesNotThrow(() => parseExtensionManifest(`herdr-zed-${id}`, text), `${id} parses`);
    assert.deepEqual(extensionMetadata(`herdr-zed-${id}`, text).settings, expectedSettings[id], `${id} settings`);
  }
});

// The Agents view with the page methods the session menu mixes in, so `this` resolves as it does in the mod.
function agentsView(sessionMenu, overrides = {}) {
  return { launchers: [], manageIndex: 0, handle: { focus() {} }, availableAgents: () => [], settingsPageBody: sessionMenu.settingsPageBody,
    withSideNav: sessionMenu.withSideNav, accountName: sessionMenu.accountName, pickerName: sessionMenu.pickerName, ...overrides };
}

test('Agents Settings embedded draws only its page: padded, with no frame, title, page list or close control, and Esc asks the shell to close', async () => {
  const runs = [];
  const { host, log, events, closed, factory } = shell({ props: () => ({ view: 'manage-launchers', embedded: true, overlay: 'shell', page: 'agents' }),
    ...sessions, availableAgents: () => [], spaces: () => [], run: (...args) => runs.push(args) });
  const { sessionMenu } = await evaluateNative('../mods/herdr-zed-agents/session-menu.js', host, 'sessionMenu');
  const page = factory('page')();
  const view = agentsView(sessionMenu, { settingsPage: 'agents', agentsPage: () => page, settingsUnsaved: sessionMenu.settingsUnsaved });
  sessionMenu.manageLaunchers.call(view, theme(), ctx([]));
  assert.ok(!names(log).some(name => name.startsWith('DialogContent')), 'no dialog frame');
  assert.ok(names(log).includes('v_flex#manage-launchers'), 'the shell owns the frame');
  assert.ok(log.some(([name, method, arg]) => name === 'v_flex#manage-launchers' && method === 'p' && arg === '24'), 'the page has 24px padding');
  assert.ok(!log.some(([name, method, arg]) => name === 'DialogTitle' && method === 'child'), 'no title of its own');
  assert.ok(!names(log).some(name => name.startsWith('Button#settings-page-') || name.startsWith('v_flex#settings-section-')), 'no page list');
  assert.ok(!names(log).some(name => name.startsWith('Button#manage-launchers-close')), 'no close control of its own');
  const escape = () => events['v_flex#manage-launchers'].on_key_down({ key: 'escape' }, { stop_propagation() {}, notify() {} });
  view.capDirty = true; escape();
  assert.deepEqual(closed, [], 'the page never closes the dialog itself');
  assert.deepEqual(runs, [['herdr-zed.settings-close']], 'it asks the shell, which asks about unsaved edits first');
});

test('Agents Settings mounts exactly the page its props name, and remote projects only get Agents', async () => {
  const { host, log, factory } = shell({ props: () => ({ view: 'manage-launchers', embedded: true, overlay: 'shell' }),
    ...sessions, availableAgents: () => [], spaces: () => [] });
  const { sessionMenu } = await evaluateNative('../mods/herdr-zed-agents/session-menu.js', host, 'sessionMenu');
  const stubs = { accountsPage: 'accounts', agentProfilesPage: 'profiles', modelsPage: 'models', globalRulesNavigation: 'rules-nav', globalRulesPage: 'global-rules', devkitsNavigation: 'cap-nav',
    devkitsPage: 'capabilities', eccNavigation: 'ecc-nav', eccPage: 'ecc' };
  const view = agentsView(sessionMenu, Object.fromEntries(Object.entries(stubs).map(([method, id]) => [method, () => factory(id)()])));
  // Each page draws its own content; the two pages with sub-navigation draw it beside the page.
  const expected = { accounts: ['accounts'], profiles: ['profiles'], models: ['models'], 'global-rules': ['rules-nav', 'global-rules'],
    capabilities: ['cap-nav', 'capabilities'], mcp: ['capabilities'], ecc: ['ecc-nav', 'ecc'] };
  for (const [page, drawnNames] of Object.entries(expected)) {
    log.length = 0;
    sessionMenu.manageLaunchers.call({ ...view, settingsPage: page }, theme(), ctx([]));
    const drawn = names(log);
    for (const name of drawnNames) assert.ok(drawn.includes(name), `${page} draws ${name}`);
    assert.ok(!drawn.some(name => name.startsWith('Button#settings-page-')), `${page} has no page list of its own`);
    assert.ok(!drawn.includes('agents'), `${page} draws no Agents list`);
  }
  log.length = 0;
  sessionMenu.manageLaunchers.call({ ...view, settingsPage: 'remote-unavailable' }, theme(), ctx([]));
  assert.ok(log.some(([, method, arg]) => method === 'child' && String(arg).includes('on this computer')), 'a remote project is told where these pages live');
  assert.ok(!names(log).includes('accounts'), 'and draws no account page');
});

test('New thread and Agents rows name the program and account, and never show a bare No account', async () => {
  const identities = { claude: { email: 'work@example.test' } };
  const { host } = shell({ shared: key => key === 'herdr-zed.account-identities' ? identities : null, ...sessions, availableAgents: () => [], spaces: () => [] });
  const { sessionMenu } = await evaluateNative('../mods/herdr-zed-agents/session-menu.js', host, 'sessionMenu');
  const view = agentsView(sessionMenu);
  const claude = { key: 'claude', name: 'Claude Code' }, codex = { key: 'codex', name: 'Codex' }, named = { key: 'herdr-zed-claude-team', name: 'Claude Code · team' };
  // A Default account is named by its address when one is known.
  assert.equal(view.pickerName(claude, 'Default account'), 'Claude Code · work@example.test');
  assert.equal(view.accountName(claude, 'Default account'), 'work@example.test');
  // Without an address the program names the row, not "No account".
  assert.equal(view.pickerName(codex, 'Default account'), 'Codex CLI');
  assert.equal(view.accountName(codex, 'Default account'), 'Codex CLI');
  // Named accounts keep their own name after the program.
  assert.equal(view.pickerName(named, 'team'), 'Claude Code · team');
  // Terminal and profiles keep their own labels.
  assert.equal(view.pickerName(null, 'Terminal'), 'Terminal');
  assert.equal(view.pickerName({ key: 'herdr-zed-claude-team', profileKey: 'claude', name: 'Work profile' }, 'Work profile'), 'Work profile');
  for (const agent of [claude, codex, named]) {
    for (const label of ['Default account', 'team']) assert.doesNotMatch(view.pickerName(agent, label), /No account/);
  }
  // With no identities at all, the rule still holds.
  identities.claude = undefined;
  assert.equal(view.pickerName(claude, 'Default account'), 'Claude Code');
});

test('GitHub account is a dialog with the account choice that closes from its X', async () => {
  const { host, log, events, closed } = shell({ props: () => ({ overlay: 'popup', context: { folder: '/repo', machine: '' } }) });
  const pending = [];
  Object.assign(host, { readGitAuthor: async () => ({ name: 'Ann', email: 'a@example.test' }), readGitAccounts: async () => [],
    gitAccount: () => null });
  const { GitHubAccount } = await evaluateNative('../mods/herdr-zed-github/account.js', host, 'GitHubAccount');
  const view = new GitHubAccount(); view.init(ctx(pending)); await settle(pending);
  view.render(theme());
  assert.ok(names(log).includes('DialogContent#github-account'));
  assert.ok(names(log).includes('Select#git-account'), 'standalone keeps the account choice');
  assert.ok(!events['Button#git-author-cancel'] && !events['Button#git-author-save'], 'no Cancel or Save: it saves itself');
  events['Button#github-account-close'].on_click({}, ctx(pending));
  await new Promise(resolve => setTimeout(resolve));
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
    seedSettings() { this.calls.push(['seedSettings']); }
    syncFields() { this.calls.push(['syncFields']); }
    writeConnection() { this.calls.push(['writeConnection']); }
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
      connectionStatus: id => host.div().id(`${id}-status`),
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
    assert.equal(panel().calls.filter(([name]) => name === 'seedSettings').length, 1, 'the saved connection seeds the form once');
    assert.ok(panel().calls.some(([name]) => name === 'syncFields'), 'field display loads');
    assert.ok(!names(log).some(name => name.startsWith('DialogContent')), 'no frame');
    assert.ok(log.some(([name, method, arg]) => name === `v_flex#${prefix}-settings` && method === 'p' && arg === '24'), 'the page has 24px padding');
    assert.ok(!log.some(([, method, arg]) => method === 'child' && arg === `"${title}"`), 'no page title of its own');
    assert.ok(!log.some(([name]) => name.includes(`${prefix}-settings-close`)), 'no close control of its own');
    assert.deepEqual(closed, []);
    assert.ok(!events[`Button#${prefix}-save-token`] && !events[`Button#${prefix}-cancel-token`], 'no Save or Cancel: it saves itself');
    panel().tokenInput.set_value('new-token');
    await view.auto.flush(ctx([]));
    assert.deepEqual(panel().calls.at(-1), ['writeConnection'], 'an edited token is checked and saved');
    assert.deepEqual(closed, []);
    view.close(); await new Promise(resolve => setTimeout(resolve)); assert.equal(panel().disposed, true);
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
  assert.ok(log.some(([name, method, arg]) => name === 'v_flex#system-settings' && method === 'p' && arg === '24'), 'the page has 24px padding');
  assert.ok(!log.some(([, method, arg]) => method === 'child' && arg === '"System monitor"'), 'the page body has no title of its own');
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

// Render is a read of state: a cx.notify() during render is refused by the host ("not allowed during the render phase").
// The render context records every notify and holds spawned work until a test runs it, so only synchronous notifies count.
function renderContext() {
  const notified = [];
  const cx = { focus_handle: () => ({ focus() {} }), notify() { notified.push(true); }, spawn() {}, stop_propagation() {},
    write_to_clipboard() {}, open_url() {} };
  return { cx, notified };
}
// Work the views start (connection reads, field loads) runs to completion on a normal context, as the host would run it.
const asyncContext = () => ({ focus_handle: () => ({ focus() {} }), notify() {}, spawn(work) { return work(asyncContext()); }, stop_propagation() {}, timer: { every() {} } });
const flush = () => new Promise(done => setImmediate(done));
const stateInput = () => ({ text: '', on() {}, value() { return this.text; }, set_value(text) { this.text = String(text); }, set_masked() {}, focus() {}, release() {} });
const sourceFor = (id, token) => {
  const asana = id === 'asana';
  return { key: id, name: asana ? 'Asana' : 'MantisBT', server: !asana, tokenHelp: 'Paste a token.', normalizeUrl: url => url,
    readConnection: async () => token ? { url: 'https://mantis.example.test', token: 'saved' } : null,
    saveConnection: async () => {}, projectFields: async () => [], fields: [{ id: 'name', name: 'Name', width: 100, detail: true }] };
};

// The real panel class of a provider and its shared controller, evaluated against the recording stand-ins in `host`.
async function loadPanel(id, host) {
  const dir = id === 'asana' ? 'herdr-zed-asana' : 'herdr-zed-mantisbt';
  Object.assign(host, { folderKey: value => value, sourcePathKey: value => value, filterProjects: () => [], readMantisProjects: async () => [],
    saveMantisProjects: async () => {}, readMantisIssues: async () => [], saveMantisIssues: async () => {}, DropdownMenu: host.factory('DropdownMenu'),
    DropdownMenuState: class {}, DropdownMenuContent: host.factory('DropdownMenuContent'), DropdownMenuItem: host.factory('DropdownMenuItem'),
    DropdownMenuLabel: host.factory('DropdownMenuLabel'), DropdownMenuSeparator: host.factory('DropdownMenuSeparator'), TextView: host.factory('TextView') });
  Object.assign(host, await evaluateNative(`../mods/${dir}/components/task-source-model.js`, host,
    'filterTasks, sourceTaskSnapshot, relativeTime, previewWidthAt, statusKind, avatarColor, initials, dueLabel, sourcePathKey'));
  Object.assign(host, await evaluateNative(`../mods/${dir}/components/task-source.js`, host, 'TaskSourceController, TaskSourceProjectPicker, connectionStatus'));
  return (await evaluateNative(`../mods/${dir}/ui.js`, host, id === 'asana' ? 'AsanaPanel' : 'MantisPanel'))[id === 'asana' ? 'AsanaPanel' : 'MantisPanel'];
}

for (const { id, token } of [
  { id: 'asana', token: true }, { id: 'asana', token: false },
  { id: 'mantisbt', token: true }, { id: 'mantisbt', token: false },
]) {
  test(`${id} embedded Settings renders without calling cx.notify (token ${token ? 'saved' : 'missing'})`, async () => {
    const context = { folder: '/repo', name: 'repo', machine: '' };
    const { host, log, factory } = shell({ props: () => ({ view: 'settings', embedded: true, overlay: 'shell', context }), InputState: { new: stateInput } });
    const asana = id === 'asana', source = sourceFor(id, token);
    Object.assign(host, { factory, asanaSource: source, mantisSource: source, sourceModuleOptions: () => ({
      getBinding: () => ({ gid: 'p1', name: 'Project', workspace: 'w', server: 'https://mantis.example.test' }),
      state: { get: () => undefined, set() {} }, setBinding() {}, source }) });
    host.AsanaPanel = asana ? await loadPanel(id, host) : undefined;
    host.MantisPanel = asana ? undefined : await loadPanel(id, host);
    const { [asana ? 'AsanaSettings' : 'MantisSettings']: Settings } = await evaluateNative(
      `../mods/${asana ? 'herdr-zed-asana/settings.js' : 'herdr-zed-mantisbt/settings.js'}`, host, asana ? 'AsanaSettings' : 'MantisSettings');
    const view = new Settings();
    view.init(asyncContext());
    await flush(); // the connection read and the field load finish, so the page renders in its loaded state
    const { cx, notified } = renderContext();
    view.render(cx);
    assert.deepEqual(notified, [], 'render never requests a re-render');
    assert.ok(names(log).includes(`v_flex#${asana ? 'asana' : 'mantis'}-settings`), 'the page is drawn');
    view.close();
  });
}

for (const { id, token } of [{ id: 'asana', token: false }, { id: 'mantisbt', token: false }]) {
  test(`${id} browser without a token says how to connect and leaves the token form to Settings`, async () => {
    const runs = [];
    const { host, log, events, factory } = shell({ props: () => ({ overlay: 'browser' }), run: (...args) => runs.push(args), InputState: { new: stateInput } });
    const asana = id === 'asana', source = sourceFor(id, token), memory = {};
    Object.assign(host, { factory, asanaSource: source, mantisSource: source });
    const Panel = await loadPanel(id, host);
    const panel = new Panel({ source, getBinding: () => null, state: { get: key => memory[key], set: (key, value) => { memory[key] = value; } } });
    panel.init(asyncContext());
    panel.open({ folder: '/repo' }, asyncContext());
    await flush();
    const { cx, notified } = renderContext();
    panel.panel({ folder: '/repo' }, () => {}, () => {}, cx);
    assert.deepEqual(notified, []);
    const shown = log.filter(([, method]) => method === 'child').map(([, , arg]) => arg);
    const name = asana ? 'Asana' : 'MantisBT';
    assert.ok(shown.includes(`"Connect ${name}"`), 'the page titles the connection');
    assert.ok(!shown.includes(`"Choose ${name} project"`), 'no project picker label over the connect state');
    assert.ok(!names(log).some(entry => entry.includes(`${id === 'asana' ? 'asana' : 'mantis'}-token`)), 'no token form in the browser');
    assert.ok(!names(log).some(entry => entry.includes('save-token')), 'no Save control in the browser');
    events[`Button#${asana ? 'asana-connect' : 'mantis-connect'}`].on_click({}, asyncContext());
    assert.deepEqual(runs.at(-1), [`herdr-zed.settings:${asana ? 'asana' : 'mantisbt'}`], 'the button opens the provider Settings page');
  });
}

test('Global Rules lists the injected sections in order per provider and ends with the Custom editor', async () => {
  const { host, log, factory } = shell({ Editor: { new: () => factory('editor')() }, TextView: { markdown: (id, text) => factory('markdown')(id, text) },
    AgentIcon: (...args) => factory('AgentIcon')(...args) });
  const { globalRulesSettings } = await evaluateNative('../mods/herdr-zed-agents/global-rules-settings.js',
    { ...host, rulesPath: () => '/guide', providerDevkits: async () => null, defaultRules: '' }, 'globalRulesSettings');
  const view = { ...globalRulesSettings, rulesCustom: { value: () => 'Mine' }, rulesAuto: { status: () => '', error: null }, rulesLoaded: true, rulesOriginal: '', rulesProvider: 'codex', rulesOpen: 'core',
    rulesKits: { codex: { items: [{ id: 'core', name: 'Herdr Core', kind: 'rule', source: 'built-in', description: 'Use hc.', body: 'Read hc.' },
      { id: 'mine:rules:team', name: 'Team', kind: 'rule', source: 'mine', description: 'Ours.', body: 'Be kind.' }] } } };
  view.globalRulesNavigation(theme());
  view.globalRulesPage(theme());
  const drawn = names(log);
  assert.ok(drawn.includes('Button#global-rules-provider-claude') && drawn.includes('Button#global-rules-provider-codex'));
  const rows = drawn.filter(name => name.startsWith('v_flex#global-rules-row-'));
  assert.deepEqual([...new Set(rows)], ['v_flex#global-rules-row-core', 'v_flex#global-rules-row-mine:rules:team', 'v_flex#global-rules-row-ecc', 'v_flex#global-rules-row-profile']);
  assert.ok(drawn.includes('markdown#global-rules-body-core'), 'the open section shows its text');
  assert.ok(drawn.includes('editor') && !drawn.includes('Button#save-global-rules') && !drawn.includes('Button#discard-global-rules'), 'Custom saves itself');
  assert.ok(!drawn.some(name => name.startsWith('Checkbox') || name.startsWith('Switch')));
});

test('adding either provider opens a visible login viewport above Accounts', async () => {
  const opened = [];
  const { accountActions } = await evaluateNative('../mods/herdr-zed-agents/account-actions.js', {
    openOverlay: spec => opened.push(spec),
  }, 'accountActions');
  for (const provider of ['codex', 'claude']) accountActions.addAccount(provider);
  assert.deepEqual(opened.map(spec => spec.props), [
    { view: 'account-login', provider: 'codex' }, { view: 'account-login', provider: 'claude' },
  ]);
  for (const spec of opened) {
    assert.equal(spec.mod, 'herdr-zed-agents');
    assert.equal(spec.kind, 'dialog'); assert.equal(spec.modal, true);
    assert.ok(spec.height > 0, 'size_full login content needs a bounded viewport');
  }
});

test('Usage controls and Auto exclude unsupported programs and derived profiles', async () => {
  let autoChoices; const checkboxStates = new Map();
  const { host, log, factory } = shell({ ...sessions, availableAgents: () => [], shared: () => undefined, spaces: () => [], props: () => ({}) });
  host.Checkbox = (id, checked, _t, options) => { checkboxStates.set(id, { checked, ...options }); return factory('Checkbox')(id); };
  for (const name of ['DropdownMenuLabel', 'DropdownMenuSeparator', 'AgentIcon']) host[name] = factory(name);
  const { sessionMenu } = await evaluateNative('../mods/herdr-zed-agents/session-menu.js', host, 'sessionMenu');
  const choices = [
    { key: 'terminal', name: 'Terminal', group: 0 },
    { key: 'agent:codex', name: 'Codex', group: 1, agent: { key: 'codex', run: ['codex'] } },
    { key: 'agent:claude', name: 'Claude', group: 1, agent: { key: 'claude', run: ['claude'] } },
    { key: 'agent:other', name: 'Other', group: 1, agent: { key: 'other', run: ['other'] } },
    { key: 'agent:config', name: 'Profile', group: 3, agent: { key: 'config', profileKey: 'codex', run: ['codex'] } },
    { key: 'agent:missing', name: 'Missing', group: 1, agent: { key: 'missing', installed: false, run: ['codex'] } },
  ];
  sessionMenu.agentsPage.call({ pickerName: (_agent, name) => name,
    autoAccountsSection: choices => { autoChoices = choices; return factory('auto')(); },
  }, choices, [], () => {}, () => {}, () => {}, theme());
  assert.ok(names(log).includes('Checkbox#usage-profile-codex'));
  assert.ok(names(log).includes('Checkbox#usage-profile-claude'));
  for (const key of ['terminal', 'other', 'config', 'missing']) {
    assert.ok(names(log).includes(`Checkbox#usage-profile-${key}`));
    assert.deepEqual(checkboxStates.get(`usage-profile-${key}`), { checked: false, indeterminate: true, disabled: true });
  }
  assert.deepEqual(autoChoices.map(choice => choice.agent.key), ['codex', 'claude']);
  assert.ok(names(log).includes('Checkbox#show-agent:other'), 'New thread availability is independent of quota support');
});

test('GitHub Settings is global: signed-in accounts with their remembered author and use, and every bound repository', async () => {
  const pending = [], unbound = [];
  const { host, log, events } = shell({ props: () => ({ view: 'settings', embedded: true, context: { folder: '/somewhere', machine: '' } }) });
  Object.assign(host, {
    readGitAccounts: async on => { assert.equal(on, null, 'this computer'); return [{ host: 'github.com', login: 'amy', available: true }, { host: 'github.com', login: 'bob', available: true }]; },
    gitBindings: () => [{ machine: null, folder: '/code/app', account: { host: 'github.com', login: 'amy' } },
      { machine: null, folder: '/code/site', account: { host: 'github.com', login: 'cat' } }],
    rememberedAuthor: account => account.login === 'amy' ? { name: 'Amy', email: 'amy@example.test' } : null,
    setGitAccount: (project, account) => unbound.push([project, account]),
  });
  const { GitHubSettings } = await evaluateNative('../mods/herdr-zed-github/settings-page.js', host, 'GitHubSettings');
  const view = new GitHubSettings(); view.init(ctx(pending)); await settle(pending);
  view.render(theme());
  const shown = log.filter(([, method]) => method === 'child').map(([, , text]) => text);
  assert.ok(shown.includes('"Commits as Amy <amy@example.test>"') && shown.includes('"No commit author saved yet"'));
  assert.ok(shown.includes('"1 repository"') && shown.includes('"0 repositories"'), 'how many repositories use each account');
  assert.ok(shown.includes('"Sign in with gh auth login"'), 'a bound account gh no longer lists still appears');
  assert.ok(shown.includes('"app"') && shown.includes('"/code/app"'), 'repositories by folder name and path');
  assert.ok(!shown.some(text => String(text).includes('/somewhere')), 'never about the project it was opened from');
  assert.ok(!names(log).some(name => name.startsWith('Input') || name.includes('git-author-save')), 'no per-repository author form');
  events['Button#github-unbind-/code/app'].on_click({}, ctx(pending));
  assert.deepEqual(unbound, [[{ machine: null, folder: '/code/app' }, null]]);
});
