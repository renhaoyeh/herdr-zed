import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function host() {
  const source = await readFile(new URL('../mods/devkits/project-layout.js', import.meta.url), 'utf8');
  const root = { children: [
    { id: 'editor', hidden: false, active: 'diff', size: { weight: 2 } },
    { id: 'simulator', hidden: false, size: { px: 450 } },
  ] }, store = {}, calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    const node = root.children.find(n => n.id === (args.id || args.stack));
    if (command === 'layout.resize') node.size = args.px ? { px: args.px } : { weight: Math.fround(args.weight) };
    if (command === 'layout.select') node.active = args.child;
    if (command === 'layout.hide' || command === 'layout.show') node.hidden = command === 'layout.hide';
  };
  const Controller = new Function('layout', 'run', 'shared', 'setShared',
    source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nreturn ProjectLayout;')(
    () => root, run, key => store[key], (key, value) => { store[key] = structuredClone(value); });
  return { Controller, root, store, calls };
}
const a = { id: 'a', folder: '/a' }, b = { id: 'b', folder: '/b' };

test('projects restore open and closed panels, active editor, native sizes and inner widths', async () => {
  const { Controller, root, store, calls } = await host();
  const state = new Controller();
  store['devkits.side-panel-width'] = 320;
  state.sync(a);
  state.sync(b); state.sync(b);
  assert.equal(root.children[0].hidden, true);
  assert.equal(root.children[1].hidden, true);
  assert.equal(store['devkits.side-panel-width'], 280);
  root.children[0].hidden = false;
  root.children[0].active = 'files';
  root.children[0].size = { px: 600 };
  state.sync(b);
  state.sync(a); state.sync(a);
  assert.deepEqual(root.children.map(n => ({ ...n })), [
    { id: 'editor', hidden: false, active: 'diff', size: { weight: 2 } },
    { id: 'simulator', hidden: false, size: { px: 450 } },
  ]);
  assert.equal(store['devkits.side-panel-width'], 320);
  const before = calls.length;
  state.sync({ ...a, tabs: [{ id: 'new-thread' }] });
  assert.equal(calls.length, before);
  state.sync(b); state.sync(b);
  assert.equal(root.children[0].active, 'files');
  assert.deepEqual(root.children[0].size, { px: 600 });
  assert.equal(root.children[1].hidden, true);
});

test('saved layout survives controller reload and remains separate on remote machines', async () => {
  const { Controller, root } = await host();
  const state = new Controller();
  state.sync(a);
  root.children[0].hidden = true; state.sync(a);
  state.sync({ ...a, machine: 'remote' }); state.sync({ ...a, machine: 'remote' });
  root.children[0].hidden = false; state.sync({ ...a, machine: 'remote' });
  const reloaded = new Controller();
  reloaded.sync({ ...a, id: 'recreated' }); reloaded.sync(a);
  assert.equal(root.children[0].hidden, true);
});

test('layouts without simulator blocks never create one', async () => {
  const { Controller, root, calls } = await host();
  root.children.pop();
  const state = new Controller(); state.sync(a); state.sync(b); state.sync(b);
  assert.equal(calls.some(([, args]) => args.id === 'simulator'), false);
  assert.equal(state.restoring, null);
});
