import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function host() {
  const source = await readFile(new URL('../mods/devkits/project-layout.js', import.meta.url), 'utf8');
  const root = { children: [
    { id: 'editor', hidden: false, size: { weight: 2 } },
    { id: 'simulator', hidden: false, size: { px: 450 } },
    { id: 'workspace-view', hidden: true, size: { weight: 1 } },
  ] }, store = {}, calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    const node = root.children.find(n => n.id === (args.id || args.stack));
    if (command === 'layout.resize') node.size = args.px ? { px: args.px } : { weight: Math.fround(args.weight) };
    if (command === 'layout.hide' || command === 'layout.show') node.hidden = command === 'layout.hide';
  };
  const Controller = new Function('layout', 'run', 'shared', 'setShared',
    source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nreturn { ProjectLayout, maximizeConversation, conversationMaximized, openTaskBoard, closeTaskBoard, enforceTaskBoard, taskMode };')(
    () => root, run, key => store[key], (key, value) => { store[key] = structuredClone(value); });
  return { Controller: Controller.ProjectLayout, maximize: Controller.maximizeConversation,
    isMaximized: Controller.conversationMaximized, openTasks: Controller.openTaskBoard, closeTasks: Controller.closeTaskBoard, enforceTasks: Controller.enforceTaskBoard, taskMode: Controller.taskMode, root, store, calls };
}
const a = { id: 'a', folder: '/a' }, b = { id: 'b', folder: '/b' };

test('projects independently restore dock, document kind, panel widths and conversation size', async () => {
  const { Controller, root, store, calls } = await host();
  store['devkits.editor-kind'] = 'diff'; store['devkits.right-panel'] = null;
  store['devkits.side-panel-width'] = 320;
  const state = new Controller();
  store['devkits.project-layouts'] = { '["","/a"]': state.snapshot() };
  state.sync(a); state.sync(a); state.sync(b); state.sync(b);
  assert.equal(store['devkits.right-panel'], 'files');
  assert.equal(store['devkits.editor-kind'], 'files');
  assert.equal(root.children[1].hidden, true);
  root.children[0].size = { px: 600 }; root.children[2].size = { px: 420 };
  store['devkits.right-panel'] = 'diff'; store['devkits.editor-kind'] = 'files'; state.sync(b);
  state.sync(a); state.sync(a);
  assert.equal(store['devkits.right-panel'], null);
  assert.equal(store['devkits.editor-kind'], 'diff');
  assert.equal(store['devkits.side-panel-width'], 320);
  assert.deepEqual(root.children[2].size, { weight: 1 });
  const before = calls.length; state.sync({ ...a, tabs: [{ id: 'new' }] });
  assert.equal(calls.length, before);
  state.sync(b); state.sync(b);
  assert.equal(store['devkits.right-panel'], 'diff');
  assert.equal(store['devkits.editor-kind'], 'files');
  assert.deepEqual(root.children[0].size, { px: 600 });
  assert.deepEqual(root.children[2].size, { px: 420 });
});

test('a closed dock survives reload without hiding the central editor and stays separate remotely', async () => {
  const { Controller, root, store } = await host();
  const state = new Controller(); state.sync(a); state.sync(a);
  store['devkits.right-panel'] = null; state.sync(a);
  state.sync({ ...a, machine: 'remote' }); state.sync({ ...a, machine: 'remote' });
  assert.equal(store['devkits.right-panel'], 'files');
  const reload = new Controller(); reload.sync({ ...a, id: 'recreated' }); reload.sync(a);
  assert.equal(store['devkits.right-panel'], null);
  assert.equal(root.children[0].hidden, false);
});

test('layouts without simulator blocks never create one', async () => {
  const { Controller, root, calls } = await host();
  root.children = root.children.filter(node => node.id !== 'simulator');
  const state = new Controller(); state.sync(a); state.sync(a);
  assert.equal(calls.some(([, args]) => args.id === 'simulator'), false);
  assert.equal(state.restoring, null);
});

test('legacy hidden editor migrates to a closed dock with the document still visible', async () => {
  const { Controller, root, store } = await host();
  store['devkits.project-layouts'] = { '["","/a"]': {
    editor: { hidden: true, active: 'diff', size: { px: 650 } }, widths: [310, null],
  } };
  const state = new Controller(); state.sync(a); state.sync(a);
  assert.equal(root.children[0].hidden, false);
  assert.equal(store['devkits.editor-kind'], 'diff');
  assert.equal(store['devkits.right-panel'], null);
  assert.deepEqual(root.children[0].size, { px: 650 });
});

test('maximizing preserves normal visibility, widths and content through layout persistence', async () => {
  const { Controller, maximize, isMaximized, root, store, calls } = await host();
  const state = new Controller(); state.sync(a); state.sync(a);
  root.children[0].size = { px: 610 };
  root.children[1].hidden = false;
  store['devkits.editor-kind'] = 'diff'; store['devkits.right-panel'] = 'diff';
  state.sync(a);
  const before = structuredClone(store['devkits.project-layouts']);
  maximize(a, true); state.sync(a);
  assert.equal(isMaximized(a), true);
  assert.equal(isMaximized({ ...a, machine: 'remote' }), false);
  assert.ok(root.children.slice(0, 2).every(node => node.hidden));
  assert.deepEqual(store['devkits.project-layouts'], before);
  maximize(a, false); state.sync(a);
  assert.equal(root.children[0].hidden, false);
  assert.equal(root.children[1].hidden, false);
  assert.deepEqual(root.children[0].size, { px: 610 });
  assert.equal(store['devkits.editor-kind'], 'diff');
  assert.equal(store['devkits.right-panel'], 'diff');
  assert.ok(calls.every(([name]) => name.startsWith('layout.')));
});

test('project switches and reloads leave maximization without persisting hidden panels', async () => {
  const { Controller, maximize, isMaximized, root, store } = await host();
  const state = new Controller(); state.sync(a); state.sync(a);
  maximize(a, true); state.sync(a);
  state.sync(b); state.sync(b);
  assert.equal(isMaximized(a), false);
  assert.equal(root.children[0].hidden, false);
  assert.equal(root.children[1].hidden, true);
  state.sync(a); state.sync(a); maximize(a, true); state.sync(a);
  const reload = new Controller(); reload.sync(a); reload.sync(a);
  assert.equal(isMaximized(a), false);
  assert.equal(root.children[0].hidden, false);
  assert.equal(root.children[1].hidden, true);
  assert.equal(store['devkits.right-panel'], 'files');
});


test('Tasks covers the work area and restores panel visibility without saving its temporary layout', async () => {
  const { Controller, openTasks, closeTasks, enforceTasks, root, store, calls } = await host();
  root.children.find(node => node.id === 'workspace-view').hidden = false;
  const controller = new Controller();
  store['devkits.right-panel'] = 'diff';
  const normal = controller.snapshot();
  const visibility = root.children.map(node => node.hidden);
  openTasks(a);
  assert.equal(store['devkits.board-project'], 'a');
  assert.deepEqual(root.children.map(node => node.hidden), [false, true, true]);
  assert.deepEqual(controller.snapshot(), normal);
  openTasks(a); // Reopening cannot replace the underlying snapshot with the covered layout.
  root.children.find(node => node.id === 'simulator').hidden = false;
  enforceTasks();
  assert.equal(root.children.find(node => node.id === 'simulator').hidden, true);
  closeTasks();
  assert.deepEqual(root.children.map(node => node.hidden), visibility);
  assert.equal(store['devkits.right-panel'], 'diff');
  assert.equal(store['devkits.board-project'], null);
  assert.deepEqual(controller.snapshot(), normal);
  assert.ok(!calls.some(([name]) => ['tab.new', 'space.new', 'tab.close', 'terminal.kill'].includes(name)));
});

test('Tasks also works without a Simulator and does not create missing layout blocks', async () => {
  const { openTasks, closeTasks, root, calls } = await host();
  root.children = root.children.filter(node => node.id !== 'simulator');
  openTasks(a); closeTasks();
  assert.ok(!calls.some(([, args]) => args.id === 'simulator'));
});


test('Tasks remains the workspace mode across projects and restores the destination layout on exit', async () => {
  const { Controller, openTasks, closeTasks, taskMode, root, store } = await host();
  const controller = new Controller(); controller.sync(a); controller.sync(a);
  const saved = structuredClone(controller.snapshot());
  store['devkits.project-layouts']['["","/b"]'] = { ...saved, simulator: { hidden: false, size: { px: 520 } } };
  openTasks(a); assert.equal(taskMode(), true);
  closeTasks(true); // Selecting another project suspends only the temporary cover.
  controller.sync(b); controller.sync(b);
  openTasks(b);
  assert.equal(taskMode(), true); assert.equal(store['devkits.board-project'], 'b');
  assert.equal(root.children.find(node => node.id === 'simulator').hidden, true);
  assert.equal(controller.snapshot().simulator.hidden, false);
  closeTasks();
  assert.equal(taskMode(), false);
  assert.equal(root.children.find(node => node.id === 'simulator').hidden, false);
});

test('switching projects in Tasks never restores normal panels or resizes the work area between boards', async () => {
  const { Controller, openTasks, closeTasks, taskMode, root, store, calls } = await host();
  const controller = new Controller(); controller.sync(a); controller.sync(a);
  const originalA = structuredClone(store['devkits.project-layouts']['["","/a"]']);
  const targetB = { editor: { hidden: false, active: 'diff', size: { weight: 3 } },
    simulator: { hidden: false, size: { px: 520 } }, 'workspace-view': { size: { weight: 2 } },
    dock: 'diff', widths: [360, 680] };
  store['devkits.project-layouts']['["","/b"]'] = structuredClone(targetB);
  store['devkits.conversation-visible'] = { '["","/b"]': true };
  openTasks(a);
  const dimensions = root.children.map(node => structuredClone(node.size));
  calls.length = 0;
  closeTasks(true); // Existing project-switch callers must leave the cover intact too.
  controller.sync(b); controller.sync(b); openTasks(b);
  assert.equal(taskMode(), true); assert.equal(store['devkits.board-project'], 'b');
  assert.deepEqual(root.children.map(node => node.hidden), [false, true, true]);
  assert.deepEqual(root.children.map(node => node.size), dimensions);
  assert.ok(!calls.some(([command, args]) => command === 'layout.resize'
    || (command === 'layout.show' && ['workspace-view', 'simulator'].includes(args.id))
    || (command === 'layout.hide' && args.id === 'editor')));
  assert.deepEqual(store['devkits.project-layouts']['["","/a"]'], originalA);
  assert.deepEqual(store['devkits.project-layouts']['["","/b"]'], targetB);
  closeTasks(); controller.sync(b); controller.sync(b);
  assert.equal(taskMode(), false);
  assert.equal(root.children.find(node => node.id === 'simulator').hidden, false);
  assert.equal(root.children.find(node => node.id === 'simulator').size.px, 520);
  assert.equal(root.children.find(node => node.id === 'editor').size.weight, 3);
  assert.equal(store['devkits.right-panel'], 'diff');
});
