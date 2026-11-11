import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionMetadata, parseExtensionManifest } from '../mods/herdr-zed/extension-model.js';
import { extensionSurfaceLayout, extensionSurfaceNodeId, statusToolsWidth } from '../mods/herdr-zed/extension-surfaces.js';
import { systemManifest as systemText, simulatorManifest as simulatorText } from './extension-fixtures.js';

const packageFor = (mod, text) => ({ mod, ...extensionMetadata(mod, text) });
// The shipped status row: the status (left) block, then the status-tools block sized for no extensions.
const statusRow = () => ({ id: 'status-content', type: 'row', children: [
  { id: 'status-main', type: 'block', size: { weight: 1 }, content: { mod: 'herdr-zed', props: { view: 'status' } } },
  { id: 'status-tools', type: 'block', size: { px: 68 }, content: { mod: 'herdr-zed', props: { view: 'status-tools' } } },
] });
const rootLayout = () => ({ id: 'root', type: 'row', children: [
  { id: 'sidebar', type: 'column', size: { px: 280 }, children: [{ id: 'agents', type: 'block', content: { mod: 'herdr-zed' } }] },
  { id: 'workspace-row', type: 'row', children: [{ id: 'editor', type: 'block', size: { weight: 1 }, content: { mod: 'herdr-zed', props: { view: 'editor' } } }] },
  { id: 'status', type: 'column', size: { px: 32 }, children: [statusRow()] },
] });
const find = (node, id) => node?.id === id ? node : (node?.children || []).map(child => find(child, id)).find(Boolean) || null;

test('surface declarations preserve popup actions and expose validated generic native views', () => {
  const actions = parseExtensionManifest('herdr-zed-system', systemText), system = extensionMetadata('herdr-zed-system', systemText);
  assert.equal(actions[0].id, 'system.open');
  assert.deepEqual(system.surfaces.map(({ id, location, view }) => ({ id, location, view })), [
    { id: 'widgets', location: 'sidebar.bottom', view: 'widgets' },
    { id: 'inline', location: 'status.right', view: 'inline' },
  ]);
  assert.equal(packageFor('herdr-zed-simulator', simulatorText).surfaces[0].id, 'simulator');
  for (const surfaces of [[{ id: 'bad', location: 'dock.left', view: 'x', title: 'x', icon: 'x' }],
    [{ id: 'same', location: 'dock.right', view: 'x', title: 'x', icon: 'x' }, { id: 'same', location: 'dock.right', view: 'y', title: 'y', icon: 'x' }],
    Array(9).fill({ id: 'x', location: 'dock.right', view: 'x', title: 'x', icon: 'x' })])
    assert.throws(() => parseExtensionManifest('herdr-zed-system', JSON.stringify({ ...JSON.parse(systemText), surfaces })));
});

test('reconcile mounts provider views, preserves native geometry and visibility, then removes only owned mounts', () => {
  const packages = [packageFor('herdr-zed-system', systemText), packageFor('herdr-zed-simulator', simulatorText)];
  const root = rootLayout(), first = extensionSurfaceLayout(root, packages);
  assert.equal(root.children[0].children.length, 1, 'Input layout remains immutable');
  const sidebar = find(first, 'sidebar'), widgets = sidebar.children.at(-1);
  assert.deepEqual(widgets.content, { mod: 'herdr-zed-system', props: { view: 'widgets' } });
  assert.deepEqual(widgets.size, { px: 260 }); assert.equal(widgets.min, 96); assert.equal(widgets.max, 420);
  const status = find(first, 'status-content');
  assert.equal(status.type, 'row');
  assert.deepEqual(status.children.map(child => child.id), ['status-main', 'zed-extension-surface-herdr-zed-system-inline', 'status-tools']);
  assert.equal(status.children[1].content.props.view, 'inline'); assert.deepEqual(find(first, 'status').size, { px: 32 });
  const dock = find(first, 'simulator');
  assert.deepEqual(dock.size, { px: 380 }); assert.equal(dock.hidden, true); assert.equal(dock.min, 300); assert.equal(dock.max, 900);
  assert.deepEqual(dock.content, { mod: 'herdr-zed-simulator', props: { view: 'simulator' } });
  assert.equal(extensionSurfaceLayout(first, packages, [], packages), null, 'Refresh does not rewrite mounts');

  const resized = structuredClone(first), resizedDock = find(resized, 'simulator');
  resizedDock.size = { px: 460 }; resizedDock.hidden = false;
  const refreshed = extensionSurfaceLayout(resized, packages, [], packages) || resized;
  assert.equal(find(refreshed, 'simulator').size.px, 460);
  assert.equal(find(refreshed, 'simulator').hidden, false, 'Provider close or user hide is retained on refresh');

  const disabled = extensionSurfaceLayout(refreshed, packages, ['herdr-zed-system'], packages);
  assert.equal(find(disabled, 'zed-extension-surface-herdr-zed-system-widgets'), null);
  assert.deepEqual(find(disabled, 'status-content').children.map(child => child.id), ['status-main', 'status-tools'],
    'the status row keeps its shell blocks once the status.right surface is removed');
  assert.deepEqual(find(disabled, 'simulator'), resizedDock, 'Other extension mount and layout state are preserved');
});

test('status tools are sized to their icons, and a status.right surface mounts before them', () => {
  assert.equal(statusToolsWidth(), 68, 'Changes and Files only');
  assert.equal(statusToolsWidth({ actions: 1 }), 117, 'one action, divider, then Changes and Files');
  assert.equal(statusToolsWidth({ actions: 6, dock: 1 }), 285, 'four actions plus overflow, one dock toggle');
  const system = packageFor('herdr-zed-system', systemText);
  const withOne = extensionSurfaceLayout(rootLayout(), [system], [], [], { actions: 2, dock: 0 });
  assert.equal(find(withOne, 'status-tools').size.px, 149);
  assert.equal(extensionSurfaceLayout(withOne, [system], [], [system], { actions: 2, dock: 0 }), null, 'unchanged counts do not rewrite the layout');
  const grown = extensionSurfaceLayout(withOne, [system], [], [system], { actions: 6, dock: 1 });
  assert.equal(find(grown, 'status-tools').size.px, 285);
  assert.deepEqual(find(grown, 'status-content').children.map(child => child.id),
    ['status-main', 'zed-extension-surface-herdr-zed-system-inline', 'status-tools']);
});

test('surface removal keeps base status and unrelated nodes; native ID collisions fail without mutation', () => {
  const system = packageFor('herdr-zed-system', systemText), simulator = packageFor('herdr-zed-simulator', simulatorText);
  const both = extensionSurfaceLayout(rootLayout(), [system, simulator]);
  const remaining = extensionSurfaceLayout(both, [simulator], [], [system, simulator]);
  assert.deepEqual(find(remaining, 'status-content').children.map(child => child.id), ['status-main', 'status-tools']);
  assert.equal(find(remaining, 'simulator').content.mod, 'herdr-zed-simulator');

  const collision = rootLayout();
  find(collision, 'workspace-row').children.push({ id: 'simulator', type: 'block', content: { mod: 'other', props: { view: 'other' } } });
  const before = structuredClone(collision);
  assert.throws(() => extensionSurfaceLayout(collision, [simulator]), /already in use/);
  assert.deepEqual(collision, before, 'Failed reconciliation does not mutate the supplied layout');
});
