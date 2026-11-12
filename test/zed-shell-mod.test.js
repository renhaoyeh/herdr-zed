import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateNative } from './source-harness.js';
import * as model from '../components/session-model.js';
import * as contract from '../components/extension-contract.js';
import { terminalArgv } from '../components/session-shell.js';

const layoutSource = new URL('../layouts/herdr-zed.json', import.meta.url);
const objects = value => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(objects)];
const ui = (id = null) => {
  const data = { nodes: [], attributes: { id }, click: null };
  const proxy = new Proxy(data, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child') { assert.notEqual(args[0], null, 'Native child rejects null'); assert.notEqual(args[0], undefined, 'Native child rejects undefined'); target.nodes.push(args[0]); }
      else if (key === 'children') { for (const child of args[0]) assert.ok(child !== null && child !== undefined, 'Native children rejects empty values'); target.nodes.push(...args[0]); }
      else if (key === 'when') { if (args[0]) args[1](proxy); }
      else if (key === 'on_click') target.click = args[0];
      else target.attributes[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
};
const elements = root => root && typeof root === 'object' && root.nodes ? [root, ...root.nodes.flatMap(elements)] : [];
const text = root => root && typeof root === 'object' && root.nodes ? root.nodes.map(text).join(' ') : String(root ?? '');

test('shell keeps original geometry and routes every view, including nested pane headers, to itself', async () => {
  const shell = JSON.parse(await readFile(layoutSource, 'utf8'));
  for (const id of ['sidebar', 'header', 'editor', 'status']) {
    const after = objects(shell).find(node => node.id === id);
    assert.ok(after, `${id} exists in the shell layout`); assert.ok(after.size, `${id} has native size`);
  }
  assert.deepEqual([...new Set(objects(shell).map(node => node.content?.mod).filter(Boolean))], ['herdr-zed']);
  for (const node of objects(shell).filter(node => node.type === 'block')) assert.ok(node.content, `${node.id} needs native block content`);
  assert.equal(objects(shell).some(node => ['tasks', 'simulator', 'agents-service', 'system-service', 'tasks-service', 'usage-service'].includes(node.id)), false);
  const main = await readFile(new URL('../mods/herdr-zed/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /AgentClient|TaskHost|UsageClient|SystemMonitor|openAgentSettings|openCalendar|taskMode/);
});

test('native thread creation preserves the program command and remote target without provider state', async () => {
  const calls = [], memory = {}, current = [{ id: 'remote/s', machine: 'remote', tabs: [] }];
  const host = { spaces: () => current, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    run: (...args) => calls.push(args), closeOverlay: id => calls.push(['close', id]), window: () => ({ platform: 'windows' }), terminalArgv };
  const { createNativeThread } = await evaluateNative('../mods/herdr-zed/native-threads.js', host, 'createNativeThread');
  const command = ['codex', '--no-daemon'], agent = { key: 'codex', name: 'Codex', run: command };
  createNativeThread(agent, { space: 'remote/s', folder: '/workspace', machine: 'remote', overlay: 'picker' });
  assert.deepEqual(calls.find(([name]) => name === 'tab.new'), ['tab.new', { space: 'remote/s', folder: '/workspace', name: 'Codex', argv: command }]);
  assert.equal(Object.keys(memory).some(key => /tasks|profiles|agent-config|mcp|rules/.test(key)), false);
  assert.deepEqual(agent.run, command);
  const before = structuredClone(memory); const count = calls.length;
  assert.throws(() => createNativeThread({ name: 'Broken', run: [] }, { folder: '/workspace' }), /no launch command/);
  assert.deepEqual(memory, before); assert.equal(calls.length, count);
  createNativeThread(null, { folder: '/new', projectName: 'new', machine: 'remote' });
  assert.deepEqual(calls.at(-1), ['space.new', { name: 'new', folder: '/new', machine: 'remote' }]);
});

test('native picker retains Terminal on discovery failure and gives the program list visible height', async () => {
  const jobs = [], started = [];
  const { NativeLauncher } = await evaluateNative('../mods/herdr-zed/native-launcher.js', {
    div: ui, v_flex: ui, props: () => ({ folder: '/workspace', machine: 'remote' }),
    knownAgents: async () => { throw new Error('offline'); }, closeOverlay() {}, notify() {},
    createNativeThread: (...args) => started.push(args),
    DropdownMenuContent: ui, DropdownMenuItem: ui, DropdownMenuLabel: ui, AgentIcon: ui,
  }, 'NativeLauncher');
  const picker = new NativeLauncher();
  picker.init({ focus_handle: () => ({ focus() {} }), spawn: fn => jobs.push(fn({ notify() {} })) });
  await Promise.all(jobs);
  const root = picker.render({});
  assert.match(text(root), /Terminal/); assert.match(text(root), /Could not discover/);
  assert.ok(elements(root).find(element => element.attributes.id === 'native-programs').attributes.h > 0);
  elements(root).find(element => element.attributes.id === 'native-program-terminal').click();
  assert.equal(started[0][0], null);
  assert.equal(started[0][1].machine, 'remote');
});

test('native sidebar, pane menu, dock controls and empty editor render without extra feature clients', async () => {
  let target = {}, status = 'blocked', usageVisible = false; const commands = [], memory = {}, jobs = [];
  const root = JSON.parse(await readFile(layoutSource, 'utf8'));
  const program = { key: 'codex', name: 'Codex', run: ['codex'], icon: 'icons/codex.svg', tint: true };
  const nativeSpaces = [{ id: 's', name: 'workspace', folder: '/workspace', active: true, tabs: [{ id: 't', name: 'Native thread', named: true, active: true }] }];
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn: fn => { jobs.push(fn); } };
  const host = { ...model, ...contract, View: class {}, div: ui, svg: ui, image: ui, h_flex: ui, v_flex: ui, activeLauncher: () => null,
    props: () => target, theme: () => ({}), window: () => ({ platform: 'macos' }), settings: () => ({ zoom: 1 }),
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, layout: () => root,
    spaces: () => nativeSpaces,
    agents: () => [{ address: 'a', tab: 't', space: 's', app: 'codex', title: 'Native thread', status, program }],
    panes: () => [{ pane: 'p', terminal: 'a', tab: 't', space: 's', focused: true, status, program }],
    terminals: () => [{ address: 'a', tab: 't', status, argv: ['codex'], program }],
    setAgentOrder() {}, run: (...args) => commands.push(args), hc: async args => { commands.push(['hc', args]); return { code: 0 }; },
    knownAgents: async () => [program], notify: message => assert.fail(message.body), openOverlay: spec => commands.push(['overlay', spec]), closeOverlay() {},
    DropdownMenuState: class {}, ProjectLayout: class { sync() {} },
    layoutNode: (node, id) => objects(node).find(value => value.id === id), conversationMaximized: () => false, maximizeConversation() {},
    WorkspaceEditor: class { init() {} render(_project, context, options) { return options.compose(); } },
    NativeLauncher: class {}, createNativeThread() {},
    GitAuthorSettings: class { init() {} render() { return ui(); } close() {} },
    ExtensionSurfaceSlot: () => null,
    openSettings: (...args) => commands.push(['open-settings', ...args]), settingsPageKey: id => `extension:${id}`, ExtensionSlot: () => null,
    TOOLBAR_GLYPH: 16, ROW_GLYPH: 14, workspaceRectNow: () => null, publishWorkspaceRect() {}, recordSize() {}, WORK_WIDTH_KEY: 'herdr-zed.work-width',
    SIDEBAR_HEIGHT_KEY: 'herdr-zed.sidebar-height', closeWorkspacePanel() { commands.push(['close-workspace-panel']); }, visibleSurfaceCount: () => 0, syncExtensionLayout() {},
    extensionSurfaceVisible: () => usageVisible, setExtensionSurfaceVisible: (_surface, value) => { usageVisible = value; },
    extensionCatalog: () => ({ ready: true, actions: [], packages: [{ mod: 'herdr-zed-workflow', surfaces: [
      { id: 'usage', mod: 'herdr-zed-workflow', location: 'sidebar.bottom', title: 'Usage', icon: 'chart-column' }] }], errors: [], resolved: { decorators: [],
      launcher: { mod: 'herdr-zed-workflow' }, settings: [{ mod: 'herdr-zed-workflow', id: 'workflow', title: 'Workflow' }] } }), openGitAction() {},
  };
  for (const name of ['Button', 'ToolbarButton', 'Sidebar', 'SidebarContent', 'SidebarGroup', 'SidebarGroupLabel', 'SidebarMenuButton', 'SidebarTreeMenuButton', 'SidebarFooter',
    'DropdownMenu', 'DropdownMenuTrigger', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuLabel', 'DropdownMenuSeparator',
    'AlertDialogContent', 'AlertDialogTitle', 'AlertDialogDescription', 'AlertDialogFooter', 'AlertDialogCancel', 'AlertDialogAction',
    'Empty', 'EmptyTitle', 'EmptyDescription', 'AgentIcon', 'glyph', 'GitResultToast']) host[name] = (...args) => ui(typeof args[0] === 'string' ? args[0] : null);
  const triggerAnchor = { x: 252, y: 80 };
  host.DropdownMenuTrigger = (trigger, _width, open) => trigger.on_click((_event, context) => open(context, triggerAnchor));
  host.DropdownMenu = (id, _state, trigger, items, choose) => Object.assign(ui(id).child(trigger), { items, choose });
  Object.assign(host, { TextareaState: { new: () => ({ on() {}, set_auto_grow() {}, value: () => '', set_value() {}, release() {} }) },
    Textarea: { new: () => ui('textarea') }, Select: id => ui(id), SelectState: class {} });
  host.activeLauncher ||= () => null; host.Popup ||= { new: (id) => ui(id) }; host.exec ||= async () => ({ code: 1, stdout: '', stderr: '' });
  Object.assign(host, { withAttachments: text => text, AttachmentStrip: () => null, pasteClipboardImage: async () => null });
  Object.assign(host, await evaluateNative('../mods/herdr-zed/decorations.js', host, 'threadDecorations, decorationTone'));
  Object.assign(host, await evaluateNative('../mods/herdr-zed/start-panel.js', host, 'startPanel, COMPOSE_KEY, startProjectKey'));
  Object.assign(host, await evaluateNative('../mods/herdr-zed/thread-close.js', host, 'closeThreadTab, closeThreadPane, isProjectPlaceholder'));
  Object.assign(host, { threadArchive: { threadBusy: () => false, archiveThread() {}, restoreThread() {}, historyList: () => ui() }, historyEligible: () => false });
  Object.assign(host, { IMAGE_PREVIEW_VIEW: 'image-preview', ImagePreview: () => null });
  const { HerdrZed } = await evaluateNative('../mods/herdr-zed/main.js', host, 'HerdrZed');
  const view = new HerdrZed(); view.init(null, cx);
  const sidebar = view.render(cx);
  const launches = [];
  view.newThread = (_cx, project) => { launches.push(project); };
  elements(sidebar).find(element => element.attributes.id === 'new-thread-s').click({ stop_propagation() {} }, cx);
  assert.deepEqual(launches, ['s'], 'sidebar + opens New thread directly');
  target = { view: 'project-menu', project: nativeSpaces[0], overlay: 'project-menu' };
  view.init(null, cx);
  assert.equal(elements(view.render(cx)).some(element => element.attributes.id === 'menu-new-terminal'), false, 'the project menu has no New terminal');
  target = {};

  const panelCloses = () => commands.filter(([name]) => name === 'close-workspace-panel').length;
  for (const show of [() => view.showConversation(true), () => view.openEditorFile('/workspace/a.js')]) {
    const before = panelCloses(); show();
    assert.equal(panelCloses(), before + 1, 'showing other work closes the workspace panel that covers it');
  }
  assert.match(text(sidebar), /Native thread/);
  assert.ok(elements(sidebar).some(element => element.attributes.accessibility_label === 'Blocked'));
  for (status of ['working', 'done', 'idle']) assert.doesNotThrow(() => view.render(cx));
  target = { view: 'pane', pane: 'p' }; view.init(null, cx); const pane = view.render(cx);
  assert.equal(elements(pane).some(element => element.attributes.id === 'thread-actions-p'), false, 'thread options live in the New thread panel');
  const panelAction = id => view.composerActions(view.projects().find(project => project.id === 's'), {})
    .flatMap(element => elements(element)).find(element => element.attributes.id === id);
  assert.equal(panelAction('composer-show-usage'), undefined);
  assert.equal(panelAction('composer-close-thread'), undefined);
  panelAction('composer-agent-settings').click({}, cx);
  assert.equal(commands.at(-1)[1], 'extension:workflow', 'the composer opens the declared workflow configuration');
  target = { view: 'header' }; const header = view.render(cx);
  assert.equal(elements(header).some(element => element.attributes.id === 'header-agents'), false);
  elements(header).find(element => element.attributes.id === 'header-extensions').click();
  assert.deepEqual(commands.at(-1).slice(0, 2), ['open-settings', 'extensions']);
  target = { view: 'project-menu', project: nativeSpaces[0], overlay: 'project-menu' };
  const projectMenu = view.render(cx);
  for (const id of ['menu-agent-settings', 'menu-show-usage'])
    assert.equal(elements(projectMenu).some(element => element.attributes.id === id), false, 'the project menu holds only project actions');
  target = { view: 'status' }; const left = view.render(cx);
  assert.ok(elements(left).some(element => element.attributes.id === 'open-conversation'), 'a real thread offers its toggle');
  const savedTabs = nativeSpaces[0].tabs;
  nativeSpaces[0].tabs = [];
  assert.ok(!elements(view.render(cx)).some(element => element.attributes.id === 'open-conversation'), 'a project without a thread shows no toggle');
  nativeSpaces[0].tabs = savedTabs;
  nativeSpaces[0].pending = true;
  assert.ok(!elements(view.render(cx)).some(element => element.attributes.id === 'open-conversation'), 'a pending project shows no toggle');
  delete nativeSpaces[0].pending;
  assert.ok(!elements(left).some(element => element.attributes.id === 'open-files'), 'Changes and Files live in the status-tools block');
  target = { view: 'status-tools' }; const bottom = view.render(cx);
  assert.ok(elements(bottom).some(element => element.attributes.id === 'open-files'));
  assert.ok(!elements(bottom).some(element => element.attributes.id === 'manage-extensions'), 'The status bar has no Extensions icon; Settings owns extensions');
  assert.ok(!elements(sidebar).some(element => element.attributes.id === 'manage-extensions'));
  target = { view: 'editor' }; view.init(null, cx); const editor = view.render(cx);
  assert.match(text(editor), /New thread/);
  assert.doesNotMatch(text(editor), /RECENT|View all/, 'history stays in the sidebar');
  const choice = { key: 'codex', label: 'Codex', detail: '5h 20%', tone: 'muted', fields: [
    { id: 'model', label: 'Model', type: 'select', value: 'default', options: [{ key: 'default', label: 'Default model' }] },
    { id: 'effort', label: 'Effort', type: 'select', value: 'high', options: [{ key: 'default', label: 'Default effort' }, { key: 'high', label: 'High' }] },
    { id: 'fast', label: 'Fast', type: 'toggle', value: true }] };
  view.startSession = () => ({ launcher: 'agents', choices: [choice], choice, values: view.startValues(choice), ready: true });
  let composer = view.projectStartView(nativeSpaces[0], {}, cx);
  view.startGitView = () => ui('branch-context').child('main');
  composer = view.projectStartView(nativeSpaces[0], {}, cx);
  const heading = elements(composer).find(element => element.attributes.id === 'project-start-heading');
  assert.match(text(heading), /New thread.*workspace.*main/, 'project and branch share the heading');
  assert.equal(elements(heading).some(element => element.attributes.id === 'composer-agent-settings'), false);
  const toolbar = elements(composer).find(element => element.attributes.id === 'project-start-toolbar');
  assert.deepEqual(toolbar.nodes.slice(-2).map(element => element.attributes.id), ['composer-agent-settings', 'project-start-submit'], 'settings sits immediately before send');
  const has = (root, id) => elements(root).some(element => element.attributes.id === id);
  assert.ok(has(composer, 'project-start-model-popup'));
  assert.ok(has(composer, 'project-start-effort-popup'), 'Effort is directly accessible');
  assert.ok(has(composer, 'project-start-fast'), 'Fast is directly accessible');
  assert.equal(has(composer, 'project-start-options'), false, 'no extra options menu');
  assert.doesNotMatch(text(composer), /5h 20%|Ctrl\+Enter|⌘ Enter|Start task/, 'quota, keyboard hints and button text stay out of the composer');
  const submit = elements(composer).find(element => element.attributes.id === 'project-start-submit');
  assert.equal(submit.attributes.accessibility_label, 'Start task');
  assert.equal(submit.attributes.tooltip, 'Start task');
  choice.tone = 'warning';
  assert.match(text(view.projectStartView(nativeSpaces[0], {}, cx)), /5h 20%/, 'quota warnings remain visible');
  assert.doesNotMatch([sidebar, pane, header, bottom, editor].map(text).join(' '), /Agent settings|Calendar|MantisBT|Asana|SYSTEM|USAGE|Interface settings/);
  assert.equal(commands.some(([name, args]) => name === 'space.new' || name === 'tab.new' && args?.props?.view !== 'project-empty'), false, 'Rendering never starts a thread');
});


test('Close project asks in a modal dialog whose confirm action is destructive', async () => {
  const main = await readFile(new URL('../mods/herdr-zed/main.js', import.meta.url), 'utf8');
  assert.match(main, /openOverlay\(\{ mod: 'herdr-zed', kind: 'dialog', frame: 'none', modal: true, width: 440, height: 220,\s*props: \{ view: 'close-project'/);
  assert.match(main, /Button\('confirm-close-project', t, \{ variant: 'destructive' \}\)/);
});
