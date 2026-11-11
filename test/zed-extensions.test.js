import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionServiceLayout } from '../mods/herdr-zed/extension-model.js';

test('service mounts follow enable/remove and preserve workspace geometry and unrelated children', () => {
  const marker = { id: 'custom', type: 'row', children: [] };
  const root = { id: 'workspace', children: [{ id: 'editor', size: { weight: 1.6 } },
    { id: 'status-separator', type: 'row', size: { px: 1 }, background: 'border', children: [marker] }] };
  const packages = [{ mod: 'herdr-zed-system', services: [{ view: 'service' }] }];
  const mounted = extensionServiceLayout(root, packages);
  assert.deepEqual(root.children[1].children, [marker], 'Input is immutable');
  assert.deepEqual(mounted.children[0], root.children[0]);
  assert.equal(mounted.children[1].size.px, 1);
  assert.deepEqual(mounted.children[1].children[0], marker);
  assert.equal(mounted.children[1].children[1].content.mod, 'herdr-zed-system');
  assert.equal(extensionServiceLayout(mounted, packages), null, 'Repeated refresh does not remount sampler');
  assert.deepEqual(extensionServiceLayout(mounted, packages, ['herdr-zed-system']), root);
  assert.deepEqual(extensionServiceLayout(mounted, []), root);
  assert.equal(extensionServiceLayout({ children: [] }, packages), null, 'Other layouts remain untouched');
  const existing = { ...root, children: [...root.children, { content: { mod: 'herdr-zed-system', props: { view: 'service' } } }] };
  assert.equal(extensionServiceLayout(existing, packages), null, 'Existing owner is never duplicated');
});
