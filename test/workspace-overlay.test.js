import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

// components/workspace-overlay.js: the one way a workspace panel is placed and behaves (ARCHITECTURE §3.7). Mocked herdr
// state and a recording element chain only.

const load = async (shared = {}, zoom = 1, extra = {}) => evaluateNative('../components/workspace-overlay.js',
  { shared: key => shared[key], settings: () => ({ zoom }), openOverlay: extra.openOverlay ?? (() => 'overlay-1'),
    setShared: extra.setShared ?? (() => null), closeOverlay: extra.closeOverlay ?? (() => null), props: extra.props ?? (() => ({})),
    div: extra.div ?? (() => { throw new Error('no div'); }) },
  'workspaceOverlay, openWorkspacePanel, releaseWorkspacePanel, workspacePanel, usableWorkspaceRect, WORKSPACE_RECT_KEY, WORKSPACE_PANEL_KEY, WORKSPACE_PANEL_OVERLAY, WORKSPACE_PANEL_ACTIVE, WORKSPACE_FALLBACK, followWorkspaceProject, workspaceFollowsProject, WORKSPACE_FOLLOW_PROJECT');

const rect = { x: 280, y: 32, width: 1000, height: 968, updatedAt: 1 };

// A recording element: every builder call is kept in order on __calls, and each returns the same element.
const recorder = () => {
  const calls = [];
  const node = new Proxy({}, { get: (_target, name) => name === '__calls' ? calls : (...args) => { calls.push([name, ...args]); return node; } });
  return node;
};
const callOf = (node, name) => node.__calls.find(([called]) => called === name);

test('a following panel survives project selection only while its own overlay is active', async () => {
  const memory = {}; let target = { overlay: 'v2' };
  const r = await load(memory, 1, { props: () => target, setShared: (key, value) => { memory[key] = value; } });
  memory[r.WORKSPACE_PANEL_ACTIVE] = { overlay: 'v2', action: 'example.open' };
  assert.equal(r.workspaceFollowsProject(), false);
  r.followWorkspaceProject(); assert.equal(r.workspaceFollowsProject(), true);
  memory[r.WORKSPACE_PANEL_ACTIVE] = { overlay: 'other' };
  assert.equal(r.workspaceFollowsProject(), false);
  target = { overlay: 'v2' }; r.releaseWorkspacePanel();
  assert.equal(memory[r.WORKSPACE_FOLLOW_PROJECT], null);
  assert.equal(memory[r.WORKSPACE_PANEL_ACTIVE].overlay, 'other');
});

test('shell project selection preserves an opted-in panel and still selects the outer folder', async () => {
  const memory = {}, commands = []; let following = true, closes = 0;
  const { HerdrZed } = await evaluateNative('../mods/herdr-zed/main.js', {
    View: class {}, startPanel: {}, threadArchive: {}, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    workspaceFollowsProject: () => following, closeWorkspacePanel: () => { closes++; }, run: (...args) => commands.push(args),
  }, 'HerdrZed');
  const shell = new HerdrZed();
  shell.selectProject({ id: 'first', folder: '/first' });
  assert.equal(closes, 0); assert.equal(memory['herdr-zed.selected-project'], 'first');
  assert.deepEqual(commands[0], ['space.select', { id: 'first' }]);
  following = false; shell.selectProject({ id: 'second', folder: '/second' });
  assert.equal(closes, 1);
});

test('with a published work area the panel is a borderless window named for workspace panels, at its top left, sized to the rectangle', async () => {
  const { workspaceOverlay, WORKSPACE_RECT_KEY, WORKSPACE_PANEL_KEY } = await load({ 'herdr-zed.workspace-rect': rect });
  assert.equal(WORKSPACE_RECT_KEY, 'herdr-zed.workspace-rect');
  assert.equal(WORKSPACE_PANEL_KEY, 'herdr-zed.workspace-panel');
  const spec = workspaceOverlay({ mod: 'herdr-zed-tasks', props: { view: 'board' }, width: 0.5, height: 0.5, modal: true });
  assert.deepEqual(spec, { mod: 'herdr-zed-tasks', kind: 'window', key: 'herdr-zed.workspace-panel', frame: 'none',
    at: { x: 280, y: 32 }, width: 1000, height: 968, props: { view: 'board', docked: true } });
  assert.equal(spec.modal, undefined, 'a window never dims or closes on a click beside it');
});

test('the point is device px at the window zoom; the size stays as published', async () => {
  const { workspaceOverlay, WORKSPACE_RECT_KEY } = await load({ 'herdr-zed.workspace-rect': rect }, 2);
  assert.deepEqual(workspaceOverlay({ mod: 'herdr-zed-system', props: {} }).at, { x: 560, y: 64 });
});

test('without a published work area the panel is a centered dialog, 0.9 by 0.86 unless the caller declares a size', async () => {
  const { workspaceOverlay, WORKSPACE_FALLBACK } = await load({});
  assert.deepEqual(WORKSPACE_FALLBACK, { width: 0.9, height: 0.86 });
  assert.deepEqual(workspaceOverlay({ mod: 'herdr-zed-system', props: { view: 'details', page: 'cpu' } }),
    { mod: 'herdr-zed-system', kind: 'dialog', frame: 'none', modal: false, width: 0.9, height: 0.86, props: { view: 'details', page: 'cpu' } });
  const declared = workspaceOverlay({ mod: 'herdr-zed-demo', props: {}, width: 400, height: 300, modal: true });
  assert.deepEqual([declared.kind, declared.width, declared.height, declared.modal], ['dialog', 400, 300, true]);
});

test('an unusable published rectangle (missing, non-finite or empty) is treated as unmeasured', async () => {
  const { usableWorkspaceRect } = await load({});
  assert.equal(usableWorkspaceRect(undefined), null);
  assert.equal(usableWorkspaceRect(null), null);
  assert.equal(usableWorkspaceRect({ x: 0, y: 32, width: 0, height: 600 }), null);
  assert.equal(usableWorkspaceRect({ x: Number.NaN, y: 32, width: 100, height: 600 }), null);
  assert.equal(usableWorkspaceRect({ x: 0, y: 32, width: 100, height: -1 }), null);
  assert.deepEqual(usableWorkspaceRect({ ...rect, extra: 1 }), { x: 280, y: 32, width: 1000, height: 968 });
  const { workspaceOverlay, WORKSPACE_RECT_KEY } = await load({ 'herdr-zed.workspace-rect': { x: 0, y: 32, width: 0, height: 600 } });
  assert.equal(workspaceOverlay({ mod: 'herdr-zed-tasks', props: {} }).kind, 'dialog');
});

test('openWorkspacePanel opens the spec and records its id, which the shell closes on a project switch or Settings', async () => {
  const opened = [], stored = {};
  const { openWorkspacePanel, WORKSPACE_PANEL_OVERLAY, WORKSPACE_RECT_KEY } = await load({ 'herdr-zed.workspace-rect': rect }, 1, {
    openOverlay: spec => { opened.push(spec); return 'overlay-7'; }, setShared: (key, value) => { stored[key] = value; } });
  assert.equal(WORKSPACE_PANEL_OVERLAY, 'herdr-zed.workspace-panel.overlay');
  assert.equal(openWorkspacePanel({ mod: 'herdr-zed-asana', props: { view: 'browser' } }), 'overlay-7');
  assert.equal(opened[0].kind, 'window');
  assert.equal(stored[WORKSPACE_PANEL_OVERLAY], 'overlay-7');
});

test('workspacePanel wraps the panel: a press inside it is stopped (no window drag), and Escape closes its overlay', async () => {
  const closed = [];
  const { workspacePanel } = await load({}, 1, { div: recorder, props: () => ({ overlay: 'overlay-7', view: 'board' }),
    closeOverlay: id => { closed.push(id); return null; } });
  const panel = recorder();
  const root = workspacePanel(panel);
  assert.equal(callOf(root, 'child')[1], panel, 'the panel is the only child');
  let stopped = 0;
  const cx = { stop_propagation: () => { stopped += 1; } };
  const presses = root.__calls.filter(([name]) => name === 'on_mouse_down');
  assert.deepEqual(presses.map(([, button]) => button), ['left', 'right', 'middle'], 'every button is stopped');
  for (const [, , handler] of presses) handler({}, cx);
  assert.equal(stopped, 3, 'a press in the panel does not reach the window, whatever the button');
  const onKey = callOf(root, 'on_key_down')[1];
  onKey({ key: 'enter' }, cx);
  onKey({ key: 'a' }, cx);
  assert.deepEqual(closed, [], 'other keys do not close it');
  onKey({ key: 'escape' }, cx);
  assert.deepEqual(closed, ['overlay-7']);
});

test('active action follows the open panel, clears on close, and survives a replaced panel closing late', async () => {
  const memory = {}, opened = [];
  let target = {};
  const r = await load(memory, 1, { props: () => target,
    openOverlay: spec => { opened.push(spec); return `panel-${opened.length}`; },
    setShared: (key, value) => { memory[key] = value; } });
  r.openWorkspacePanel({ mod: 'herdr-zed-calendar', props: { workspaceAction: 'calendar.open' } });
  assert.deepEqual(memory[r.WORKSPACE_PANEL_ACTIVE], { overlay: 'panel-1', action: 'calendar.open' });
  r.openWorkspacePanel({ mod: 'herdr-zed-tasks', props: { workspaceAction: 'tasks.open' } });
  target = { overlay: 'panel-1' }; r.releaseWorkspacePanel();
  assert.equal(memory[r.WORKSPACE_PANEL_ACTIVE].action, 'tasks.open');
  target = { overlay: 'panel-2' }; r.releaseWorkspacePanel();
  assert.equal(memory[r.WORKSPACE_PANEL_ACTIVE], null);
  assert.equal(memory[r.WORKSPACE_PANEL_OVERLAY], null);
});

test('workspacePanel without an overlay id does not close anything on Escape', async () => {
  const closed = [];
  const { workspacePanel } = await load({}, 1, { div: recorder, props: () => ({}), closeOverlay: id => { closed.push(id); return null; } });
  const root = workspacePanel(recorder());
  callOf(root, 'on_key_down')[1]({ key: 'escape' }, { stop_propagation() {} });
  assert.deepEqual(closed, []);
});
