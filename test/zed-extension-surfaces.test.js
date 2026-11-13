import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionMetadata, parseExtensionManifest } from '../mods/herdr-zed/extension-model.js';
import { extensionSurfaceLayout, extensionSurfaceNodeId, statusToolsWidth, surfaceEmptyKey, emptyStatusSurfaces } from '../mods/herdr-zed/extension-surfaces.js';
import { systemManifest as systemText, simulatorManifest as simulatorText } from './extension-fixtures.js';

const packageFor = (mod, text) => ({ mod, ...extensionMetadata(mod, text) });
// The shipped status row: the status (left) block, then the status-tools block sized for no extensions.
const statusRow = () => ({ id: 'status-content', type: 'row', children: [
  { id: 'status-main', type: 'block', size: { weight: 1 }, content: { mod: 'herdr-zed', props: { view: 'status' } } },
  { id: 'status-tools', type: 'block', size: { px: 68 }, content: { mod: 'herdr-zed', props: { view: 'status-tools' } } },
] });
const rootLayout = () => ({ id: 'root', type: 'row', children: [
  { id: 'sidebar', type: 'column', size: { px: 280 }, children: [{ id: 'agents', type: 'block', content: { mod: 'herdr-zed' } },
    { id: 'sidebar-history', type: 'block', size: { px: 32 }, content: { mod: 'herdr-zed', props: { view: 'sidebar-history' } } }] },
  { id: 'workspace-row', type: 'row', children: [{ id: 'editor', type: 'block', size: { weight: 1 }, content: { mod: 'herdr-zed', props: { view: 'editor' } } }] },
  { id: 'status', type: 'column', size: { px: 32 }, children: [statusRow()] },
] });
const find = (node, id) => node?.id === id ? node : (node?.children || []).map(child => find(child, id)).find(Boolean) || null;

test('surface-only extensions expose validated native views without duplicate actions', () => {
  const actions = parseExtensionManifest('herdr-zed-system', systemText), system = extensionMetadata('herdr-zed-system', systemText);
  assert.deepEqual(actions, []);
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
  assert.equal(root.children[0].children.length, 2, 'Input layout remains immutable');
  const sidebar = find(first, 'sidebar'), widgets = sidebar.children.find(child => child.id === 'zed-extension-surface-herdr-zed-system-widgets');
  assert.deepEqual(sidebar.children.map(child => child.id), ['agents', 'zed-extension-surface-herdr-zed-system-widgets', 'sidebar-history'],
    'sidebar surfaces mount above the history row, which stays last');
  assert.deepEqual(widgets.content, { mod: 'herdr-zed-system', props: { view: 'widgets' } });
  assert.deepEqual(widgets.size, { px: 260 }); assert.equal(widgets.min, 96); assert.equal(widgets.max, 420);
  assert.equal(widgets.hidden, true, 'a sidebar surface is hidden the first time it mounts');
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

test('status tools fit every icon with spacing only, and a status.right surface mounts before them', () => {
  assert.equal(statusToolsWidth(), 72, 'Changes and Files only: two 28px buttons and padding');
  assert.equal(statusToolsWidth({ actions: 1 }), 112, 'one action, spacing, then Changes and Files');
  assert.equal(statusToolsWidth({ actions: 1, dock: 1 }), 152, 'icons, dock toggle, Changes and Files with spacing');
  assert.equal(statusToolsWidth({ actions: 6, dock: 1 }), 292, 'six directly visible actions and one dock toggle');
  const system = packageFor('herdr-zed-system', systemText);
  const withOne = extensionSurfaceLayout(rootLayout(), [system], [], [], { actions: 2, dock: 0 });
  assert.equal(find(withOne, 'status-tools').size.px, 140);
  assert.equal(extensionSurfaceLayout(withOne, [system], [], [system], { actions: 2, dock: 0 }), null, 'unchanged counts do not rewrite the layout');
  const grown = extensionSurfaceLayout(withOne, [system], [], [system], { actions: 6, dock: 1 });
  assert.equal(find(grown, 'status-tools').size.px, 292);
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

test('a status.right reading a provider reports empty is hidden, takes no width, and shows again when the key clears', () => {
  const system = packageFor('herdr-zed-system', systemText);
  const nodeId = 'zed-extension-surface-herdr-zed-system-inline';
  assert.equal(surfaceEmptyKey('system', 'inline'), 'herdr-zed.surface-empty.system.inline');
  const memory = { [surfaceEmptyKey('system', 'inline')]: true };
  const read = key => memory[key];
  const empty = emptyStatusSurfaces([system], read);
  assert.deepEqual([...empty], [nodeId]);
  assert.deepEqual(emptyStatusSurfaces([system], () => false), new Set(), 'false or absent keys are shown');

  const hidden = extensionSurfaceLayout(rootLayout(), [system], [], [], { actions: 2, dock: 0 }, empty);
  assert.equal(find(hidden, nodeId).hidden, true, 'mounted hidden when reported empty');
  assert.equal(find(hidden, 'status-tools').size.px, 140, 'actions reserve no divider space');
  assert.equal(extensionSurfaceLayout(hidden, [system], [], [system], { actions: 2, dock: 0 }, empty), null,
    'unchanged emptiness does not rewrite the layout');

  const shown = extensionSurfaceLayout(hidden, [system], [], [system], { actions: 2, dock: 0 }, new Set());
  assert.equal(find(shown, nodeId).hidden, false, 'shown again when the key clears');
  assert.equal(find(shown, 'status-tools').size.px, 140, 'showing readings does not add divider space');
  assert.deepEqual(find(shown, 'status-content').children.map(child => child.id), ['status-main', nodeId, 'status-tools']);

  memory[surfaceEmptyKey('system', 'inline')] = null;
  assert.equal(emptyStatusSurfaces([system], read).size, 0, 'a cleared (null) key is shown');
  const bare = extensionSurfaceLayout(rootLayout(), [system], [], [], null, new Set([nodeId]));
  assert.equal(find(bare, nodeId).hidden, true, 'an empty reading mounts hidden without a status argument');
});

test('only status.right surfaces are governed by emptiness; sidebar and dock state keeps its own rules', () => {
  const system = packageFor('herdr-zed-system', systemText), simulator = packageFor('herdr-zed-simulator', simulatorText);
  const empty = emptyStatusSurfaces([system, simulator], key => key.startsWith('herdr-zed.surface-empty.') ? true : undefined);
  assert.deepEqual([...empty], ['zed-extension-surface-herdr-zed-system-inline'], 'widgets and the dock surface are not governed');
  const mounted = extensionSurfaceLayout(rootLayout(), [system, simulator], [], [], null, empty);
  assert.equal(find(mounted, 'zed-extension-surface-herdr-zed-system-widgets').hidden, true, 'sidebar keeps its first-mount hidden');
  assert.equal(find(mounted, 'simulator').hidden, true, 'dock keeps its first-mount hidden');
  assert.equal(find(mounted, 'zed-extension-surface-herdr-zed-system-inline').hidden, true);
});

test('a sidebar surface the user showed mounts shown again after the layout is rebuilt', () => {
  const packages = [packageFor('herdr-zed-system', systemText)];
  const id = 'zed-extension-surface-herdr-zed-system-widgets';
  assert.equal(find(extensionSurfaceLayout(rootLayout(), packages), id).hidden, true, 'hidden by default');
  assert.equal(find(extensionSurfaceLayout(rootLayout(), packages, [], [], null, new Set(), { [id]: true }), id).hidden, false);
  assert.equal(find(extensionSurfaceLayout(rootLayout(), packages, [], [], null, new Set(), { [id]: false }), id).hidden, true);
});
