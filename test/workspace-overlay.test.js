import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

// components/workspace-overlay.js: the one way a workspace panel is placed (ARCHITECTURE §3.7). Mocked herdr state only.

const load = async (shared = {}, zoom = 1) => evaluateNative('../components/workspace-overlay.js',
  { shared: key => shared[key], settings: () => ({ zoom }) }, 'workspaceOverlay, usableWorkspaceRect, WORKSPACE_RECT_KEY, WORKSPACE_FALLBACK');

const rect = { x: 280, y: 32, width: 1000, height: 636, updatedAt: 1 };

test('with a published work area the panel is a borderless popup at its top left, sized to the rectangle (numeric width and height)', async () => {
  const { workspaceOverlay, WORKSPACE_RECT_KEY } = await load({ [`herdr-zed.workspace-rect`]: rect });
  assert.equal(WORKSPACE_RECT_KEY, 'herdr-zed.workspace-rect');
  const spec = workspaceOverlay({ mod: 'herdr-zed-tasks', props: { view: 'board' }, width: 0.5, height: 0.5, modal: true });
  assert.deepEqual(spec, { mod: 'herdr-zed-tasks', kind: 'popup', frame: 'none', at: { x: 280, y: 32 }, width: 1000, height: 636, props: { view: 'board' } });
  assert.equal(typeof spec.width, 'number'); assert.equal(typeof spec.height, 'number');
  assert.equal(spec.width, rect.width, 'the declared share is ignored: the panel fills the work area');
  assert.equal(spec.height, rect.height);
  assert.equal(spec.modal, undefined, 'a popup closes on an outside click');
});

test('the point is device px at the window zoom; the size stays as published', async () => {
  const { workspaceOverlay } = await load({ 'herdr-zed.workspace-rect': rect }, 2);
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
  assert.deepEqual(usableWorkspaceRect({ ...rect, extra: 1 }), { x: 280, y: 32, width: 1000, height: 636 });
  const { workspaceOverlay } = await load({ 'herdr-zed.workspace-rect': { x: 0, y: 32, width: 0, height: 600 } });
  assert.equal(workspaceOverlay({ mod: 'herdr-zed-tasks', props: {} }).kind, 'dialog');
});
