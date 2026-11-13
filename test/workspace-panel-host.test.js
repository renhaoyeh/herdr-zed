import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

test('retained workspace mounts enabled provider blocks without replacing the original work area and restores it on close', async () => {
  const original = { id: 'workspace-row', type: 'row', hidden: false, children: [{ id: 'editor', type: 'stack', active: 'files', children: [] }] };
  let root = { id: 'root', type: 'column', children: [original] };
  const commands = [], memory = {
    'herdr-zed.extensions.catalog': { packages: [{ mod: 'provider', enabled: true }], resolved: {} },
    request: { id: 'host-1', action: 'provider.open', layout: { type: 'stack', children: [
      { type: 'block', content: { mod: 'provider', props: { view: 'browser' } } },
    ] } },
    overlay: 'old-overlay', active: { overlay: 'old-overlay' },
  };
  const { mountWorkspaceLayoutRequest, closeWorkspacePanel } = await evaluateNative('../mods/herdr-zed/extensions.js', {
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, layout: () => root,
    run: (name, args) => { commands.push({ name, args }); if (name === 'layout.set') root = args.layout; },
    WORKSPACE_LAYOUT_REQUEST: 'request', WORKSPACE_PANEL_OVERLAY: 'overlay', WORKSPACE_PANEL_ACTIVE: 'active', WORKSPACE_FOLLOW_PROJECT: 'follow',
    notify() {},
  }, 'mountWorkspaceLayoutRequest, closeWorkspacePanel');
  mountWorkspaceLayoutRequest();
  assert.equal(memory.request, null);
  assert.deepEqual(root.children[0], { ...original, hidden: true });
  const host = root.children[1];
  assert.equal(host.type, 'stack');
  assert.equal(host.children[0].content.mod, 'provider');
  assert.equal(memory.active.hosted, true); assert.equal(memory.follow, 'host-1');
  assert.ok(commands.some(command => command.name === 'overlay.close' && command.args.id === 'old-overlay'));
  closeWorkspacePanel(); assert.deepEqual(root.children[0], original);
  assert.equal(memory.active, null); assert.equal(memory.follow, null);
  memory.request = { id: 'bad', action: 'provider.open', layout: { type: 'block', content: { mod: 'disabled' } } };
  mountWorkspaceLayoutRequest(); assert.deepEqual(root.children[0], original);
});
