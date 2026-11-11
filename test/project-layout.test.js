import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function host() {
  const source = await readFile(new URL('../mods/herdr-zed/project-layout.js', import.meta.url), 'utf8');
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
    source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn { ProjectLayout, maximizeConversation, conversationMaximized };')(
    () => root, run, key => store[key], (key, value) => { store[key] = structuredClone(value); });
  return { Controller: Controller.ProjectLayout, maximize: Controller.maximizeConversation,
    isMaximized: Controller.conversationMaximized, root, store, calls };
}
const a = { id: 'a', folder: '/a' }, b = { id: 'b', folder: '/b' };

test('a closed dock survives reload without hiding the central editor and stays separate remotely', async () => {
  const { Controller, root, store } = await host();
  const state = new Controller(); state.sync(a); state.sync(a);
  store['herdr-zed.right-panel'] = null; state.sync(a);
  state.sync({ ...a, machine: 'remote' }); state.sync({ ...a, machine: 'remote' });
  assert.equal(store['herdr-zed.right-panel'], 'files');
  const reload = new Controller(); reload.sync({ ...a, id: 'recreated' }); reload.sync(a);
  assert.equal(store['herdr-zed.right-panel'], null);
  assert.equal(root.children[0].hidden, false);
});

test('layouts without simulator blocks never create one', async () => {
  const { Controller, root, calls } = await host();
  root.children = root.children.filter(node => node.id !== 'simulator');
  const state = new Controller(); state.sync(a); state.sync(a);
  assert.equal(calls.some(([, args]) => args.id === 'simulator'), false);
  assert.equal(state.restoring, null);
});

