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
    source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nreturn { ProjectLayout, maximizeConversation, conversationMaximized };')(
    () => root, run, key => store[key], (key, value) => { store[key] = structuredClone(value); });
  return { Controller: Controller.ProjectLayout, maximize: Controller.maximizeConversation,
    isMaximized: Controller.conversationMaximized, root, store, calls };
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
