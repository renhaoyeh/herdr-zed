import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateNative } from './source-harness.js';
import * as model from '../components/session-model.js';
import * as contract from '../components/extension-contract.js';

const layoutSource = new URL('../layouts/herdr-zed.json', import.meta.url);
const ui = (id = null) => {
  const data = { nodes: [], attributes: { id }, click: null };
  const proxy = new Proxy(data, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child') { assert.notEqual(args[0], null, 'Native child rejects null'); target.nodes.push(args[0]); }
      else if (key === 'children') { for (const child of args[0]) assert.ok(child !== null && child !== undefined); target.nodes.push(...args[0]); }
      else if (key === 'when') { if (args[0]) args[1](proxy); }
      else if (key === 'on_click') target.click = args[0];
      else target.attributes[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
};
const elements = root => root && typeof root === 'object' && root.nodes ? [root, ...root.nodes.flatMap(elements)] : [];
const byId = (root, id) => elements(root).find(element => element.attributes.id === id);
const labels = root => elements(root).map(element => element.attributes.accessibility_label).filter(Boolean);

const program = { key: 'codex', name: 'Codex', run: ['codex'], icon: 'icons/codex.svg', tint: true };

// A HerdrZed view over fake native state. Call `.render()` synchronously: the ui proxies are not promises.
async function sidebar({ tabs, agents = [], panes = [], terminals = [] }) {
  const root = JSON.parse(await readFile(layoutSource, 'utf8'));
  const memory = {}, jobs = [];
  const spaces = [{ id: 's', name: 'workspace', folder: '/workspace', active: true, tabs }];
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn: fn => jobs.push(fn) };
  const host = { ...model, ...contract, View: class {}, div: ui, svg: ui, image: ui, h_flex: ui, v_flex: ui, activeLauncher: () => null,
    props: () => ({}), theme: () => ({}), window: () => ({ platform: 'macos' }), settings: () => ({ zoom: 1 }),
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, layout: () => root,
    spaces: () => spaces, agents: () => agents, panes: () => panes, terminals: () => terminals,
    setAgentOrder() {}, run() {}, hc: async () => ({ code: 0 }), knownAgents: async () => [], notify() {}, openOverlay() {}, closeOverlay() {},
    DropdownMenuState: class {}, ProjectLayout: class { sync() {} },
    layoutNode: (node, id) => (function find(value) { return !value || typeof value !== 'object' ? null
      : value.id === id ? value : Object.values(value).map(find).find(Boolean) || null; })(node),
    conversationMaximized: () => false, maximizeConversation() {},
    WorkspaceEditor: class { init() {} render() { return ui(); } }, NativeLauncher: class {}, createNativeThread() {},
    GitAuthorSettings: class { init() {} render() { return ui(); } close() {} },
    ExtensionSurfaceSlot: () => null, openSettings() {}, ExtensionSlot: () => null,
    TOOLBAR_GLYPH: 16, ROW_GLYPH: 14, workspaceRectNow: () => null, publishWorkspaceRect() {}, recordSize() {}, WORK_WIDTH_KEY: 'herdr-zed.work-width',
    SIDEBAR_HEIGHT_KEY: 'herdr-zed.sidebar-height', closeWorkspacePanel() {}, visibleSurfaceCount: () => 0, syncExtensionLayout() {},
    extensionCatalog: () => ({ ready: true, actions: [], packages: [], errors: [], resolved: { decorators: [] } }), openGitAction() {},
  };
  for (const name of ['Button', 'ToolbarButton', 'Sidebar', 'SidebarContent', 'SidebarGroup', 'SidebarGroupLabel', 'SidebarMenuButton', 'SidebarTreeMenuButton', 'SidebarFooter',
    'DropdownMenu', 'DropdownMenuTrigger', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuLabel', 'DropdownMenuSeparator',
    'AlertDialogContent', 'AlertDialogTitle', 'AlertDialogDescription', 'AlertDialogFooter', 'AlertDialogCancel', 'AlertDialogAction',
    'Empty', 'EmptyTitle', 'EmptyDescription', 'AgentIcon', 'glyph', 'GitResultToast']) host[name] = (...args) => ui(typeof args[0] === 'string' ? args[0] : null);
  Object.assign(host, { TextareaState: { new: () => ({ on() {}, set_auto_grow() {}, value: () => '', set_value() {}, release() {} }) },
    Textarea: { new: () => ui('textarea') }, Select: id => ui(id), SelectState: class {} });
  host.activeLauncher ||= () => null; host.Popup ||= { new: (id) => ui(id) }; host.projectHistory ||= () => []; host.archivedAge ||= () => ''; host.exec ||= async () => ({ code: 1, stdout: '', stderr: '' });
  Object.assign(host, { withAttachments: text => text, AttachmentStrip: () => null, pasteClipboardImage: async () => null });
  Object.assign(host, await evaluateNative('../mods/herdr-zed/start-panel.js', host, 'startPanel, COMPOSE_KEY, startProjectKey'));
  Object.assign(host, await evaluateNative('../mods/herdr-zed/decorations.js', host, 'threadDecorations, decorationTone'));
  Object.assign(host, { threadArchive: { threadBusy: thread => thread.agents.some(agent => ['working', 'blocked'].includes(agent.status)), archiveThread() {}, restoreThread() {}, historyList: () => ui() }, historyEligible: () => false });
  Object.assign(host, await evaluateNative('../mods/herdr-zed/thread-close.js', host, 'closeThreadTab, closeThreadPane, isProjectPlaceholder'));
  Object.assign(host, { IMAGE_PREVIEW_VIEW: 'image-preview', ImagePreview: () => null });
  const { HerdrZed } = await evaluateNative('../mods/herdr-zed/main.js', host, 'HerdrZed');
  const view = new HerdrZed(); view.init(null, cx);
  return { render: () => view.render(cx) };
}

const shellTab = { id: 't', name: 'Shell', named: false, active: true };
const agentTab = { id: 't', name: 'Native thread', named: true, active: true };

test('a plain terminal without an agent shows the terminal icon, never the working spinner', async () => {
  const tabs = [{ ...shellTab, status: 'working' }];
  const busy = (await sidebar({ tabs, terminals: [{ address: 'a', tab: 't', state: 'live', status: 'working', argv: ['npm', 'run', 'dev'] }] })).render();
  assert.equal(labels(byId(busy, 'thread-t')).includes('Working'), false, 'a tab status or a live status does not spin a terminal row');
  assert.equal(labels(byId(busy, 'thread-t')).includes('Stop generation'), false, 'a plain terminal offers no stop');
  const foreground = (await sidebar({ tabs: [shellTab], terminals: [{ address: 'a', tab: 't', state: 'live', argv: ['/bin/zsh', '-l'],
    foreground: { pid: 42, name: 'node', argv: ['node', 'server.js'] } }] })).render();
  assert.equal(labels(byId(foreground, 'thread-t')).includes('Working'), false, 'a foreground command does not spin a terminal row');
  assert.ok(elements(byId(foreground, 'thread-t')).some(element => element.attributes.id === 'terminal'), 'the terminal icon is drawn');
});

test('thread status uses distinct shapes after the title and stays visible on hover', async () => {
  const agent = (status) => ({ address: 'a', tab: 't', space: 's', app: 'codex', title: 'Native thread', status, program });
  const pane = [{ pane: 'p', terminal: 'a', tab: 't', space: 's', focused: true, program }];
  const workingView = await sidebar({ tabs: [agentTab], agents: [agent('working')], panes: pane,
    terminals: [{ address: 'a', tab: 't', state: 'live', status: 'working', argv: ['codex'], program }] });
  const working = workingView.render();
  assert.ok(labels(byId(working, 'thread-t')).includes('Working'));
  const blocked = (await sidebar({ tabs: [agentTab], agents: [agent('blocked')], terminals: [{ address: 'a', tab: 't', state: 'live', argv: ['codex'], program }] })).render();
  assert.ok(labels(byId(blocked, 'thread-t')).includes('Blocked'));
  assert.equal(labels(byId(blocked, 'thread-t')).includes('Working'), false);
  // The agent is idle while a foreground process runs in its terminal: the agent's report wins, no spinner.
  const idle = (await sidebar({ tabs: [agentTab], agents: [agent('idle')], terminals: [{ address: 'a', tab: 't', state: 'live', argv: ['codex'], program,
    foreground: { pid: 7, name: 'node', argv: ['node'] } }] })).render();
  assert.equal(labels(byId(idle, 'thread-t')).includes('Working'), false);
  const done = (await sidebar({ tabs: [agentTab], agents: [agent('done')], terminals: [{ address: 'a', tab: 't', state: 'live', argv: ['codex'], program }] })).render();
  assert.ok(labels(byId(done, 'thread-t')).includes('Done'));
  for (const [root, label, glyph] of [[working, 'Working', 'loader'], [blocked, 'Blocked', 'circle-alert'], [done, 'Done', 'circle-check'], [idle, null, null]]) {
    const row = byId(root, 'thread-t'), status = byId(row, 'thread-status-t');
    assert.ok(elements(row.nodes[0]).some(element => element.attributes.id === program.icon), 'the program icon stays on the left in every state');
    if (label) {
      assert.deepEqual(labels(status), [label], 'the symbol names the reported state');
      assert.ok(elements(status).some(element => element.attributes.id === glyph), 'each status has a recognizable shape');
      assert.equal(row.nodes[1].nodes[1], status, 'status sits immediately after the title');
    } else assert.equal(status, undefined, 'idle has no status symbol');
    assert.equal(row.nodes.at(-1).attributes.size, 24, 'the action keeps a fixed slot');
    assert.equal(labels(status).includes('Stop generation'), false, 'the action is hidden until hover');
  }
  byId(working, 'thread-t').attributes.on_hover(true, { notify() {} });
  const hovered = workingView.render(), hoveredSlot = byId(hovered, 'thread-status-t');
  assert.deepEqual(labels(hoveredSlot), ['Working'], 'status stays visible on hover');
  const hoveredRow = byId(hovered, 'thread-t');
  assert.equal(hoveredRow.nodes[1].nodes[1], hoveredSlot, 'status stays beside the title on hover');
  assert.ok(elements(hoveredRow.nodes.at(-1)).includes(byId(hoveredRow, 'stop-thread-t')), 'Stop appears at the far right');
  assert.deepEqual(hoveredSlot.attributes, byId(working, 'thread-status-t').attributes, 'hover never moves or hides status');
  assert.ok(byId(hoveredRow, 'stop-thread-t').click, 'Stop remains interactive');
  byId(hovered, 'thread-t').attributes.on_hover(false, { notify() {} });
  const unhovered = byId(workingView.render(), 'thread-t');
  assert.equal(byId(unhovered, 'stop-thread-t'), undefined, 'leaving hides the action');
  assert.equal(unhovered.nodes.at(-1).attributes.size, 24, 'the action slot stays fixed');
  assert.deepEqual(labels(byId(unhovered, 'thread-status-t')), ['Working']);
});

test('a split pane is named by its program or title, and a raw terminal id is never its label', async () => {
  const agent = { address: 'a', tab: 't', space: 's', app: 'codex', title: 'Native thread', status: 'idle', program };
  const panes = [
    { pane: 'p1', terminal: 'a', tab: 't', space: 's', focused: true, program },
    { pane: 'p2', terminal: 't3', tab: 't', space: 's', title: 't3', program: null },
    { pane: 'p3', terminal: 't4', tab: 't', space: 's', title: '', program: { key: 'shell', name: 'Terminal', run: ['pwsh'] } },
    { pane: 'p4', terminal: 't5', tab: 't', space: 's', title: 'Build watcher' },
  ];
  const terminals = [{ address: 'a', tab: 't', state: 'live', argv: ['codex'], program },
    { address: 't3', tab: 't', state: 'live', argv: [] }, { address: 't4', tab: 't', state: 'live', argv: [] },
    { address: 't5', tab: 't', state: 'live', argv: [] }];
  const root = (await sidebar({ tabs: [agentTab], agents: [agent], panes, terminals })).render();
  const row = pane => byId(root, `thread-pane-${pane}`);
  assert.equal(row('p2').attributes.accessibility_label, 'Parallel pane: Terminal', 'a bare terminal id falls back to Terminal');
  assert.equal(row('p3').attributes.accessibility_label, 'Parallel pane: Terminal', 'the program names the pane');
  assert.equal(row('p4').attributes.accessibility_label, 'Parallel pane: Build watcher', 'the pane title names the pane');
  assert.doesNotMatch(labels(root).join(' | '), /\bt[345]\b/, 'no raw terminal id appears as a label');
});

test('a child terminal with a command is named by the command, not its id', async () => {
  const agent = { address: 'a', tab: 't', space: 's', app: 'codex', title: 'Native thread', status: 'idle', program };
  const terminals = [{ address: 'a', tab: 't', state: 'live', argv: ['codex'], program },
    { address: 'c1', tab: 't', parent: 'a', state: 'live', argv: ['npm', 'test'] }, { address: 'c2', tab: 't', parent: 'a', state: 'live', argv: [] }];
  const root = (await sidebar({ tabs: [agentTab], agents: [agent], terminals })).render();
  assert.equal(byId(root, 'child-c1').attributes.accessibility_label, 'Child task: npm test');
  assert.equal(byId(root, 'child-c2').attributes.accessibility_label, 'Child task: Terminal');
});
