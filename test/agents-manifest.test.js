import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseExtensionManifest, extensionMetadata } from '../mods/herdr-zed/extension-model.js';
import { extensionSurfaceLayout } from '../mods/herdr-zed/extension-surfaces.js';

const text = await readFile(new URL('../mods/herdr-zed-agents/extension.json', import.meta.url), 'utf8');
const find = (node, id) => node?.id === id ? node : (node?.children || []).map(child => find(child, id)).find(Boolean) || null;

test('the Agents manifest declares only the Usage sidebar surface and the shell parser accepts it', () => {
  assert.deepEqual(parseExtensionManifest('herdr-zed-agents', text), []);
  const meta = extensionMetadata('herdr-zed-agents', text);
  assert.deepEqual(meta.surfaces.map(({ id, location, view, title, icon, mod }) => ({ id, location, view, title, icon, mod })), [
    { id: 'usage', location: 'sidebar.bottom', view: 'usage-sidebar', title: 'Usage', icon: 'chart-column', mod: 'herdr-zed-agents' },
  ]);
  assert.equal(existsSync(new URL('../assets/icons/chart-column.svg', import.meta.url)), true, 'surface icon exists');
});

test('the shell mounts sidebar Usage, removes the former status contribution, and unmounts on disable', () => {
  const pkg = { mod: 'herdr-zed-agents', ...extensionMetadata('herdr-zed-agents', text) };
  const root = { id: 'root', type: 'row', children: [
    { id: 'sidebar', type: 'column', size: { px: 280 }, children: [{ id: 'agents', type: 'block', content: { mod: 'herdr-zed' } },
      { id: 'sidebar-history', type: 'block', size: { px: 32 }, content: { mod: 'herdr-zed', props: { view: 'sidebar-history' } } }] },
    { id: 'workspace-row', type: 'row', children: [{ id: 'editor', type: 'block', size: { weight: 1 }, content: { mod: 'herdr-zed', props: { view: 'editor' } } }] },
    { id: 'status', type: 'column', size: { px: 32 }, children: [{ id: 'status-content', type: 'row', children: [
      { id: 'status-main', type: 'block', size: { weight: 1 }, content: { mod: 'herdr-zed', props: { view: 'status' } } },
      { id: 'status-tools', type: 'block', size: { px: 68 }, content: { mod: 'herdr-zed', props: { view: 'status-tools' } } },
    ] }] },
  ] };
  const mounted = extensionSurfaceLayout(root, [pkg]);
  assert.deepEqual(find(mounted, 'zed-extension-surface-herdr-zed-agents-usage').content, { mod: 'herdr-zed-agents', props: { view: 'usage-sidebar' } });
  assert.deepEqual(find(mounted, 'sidebar').children.map(child => child.id).slice(-2),
    ['zed-extension-surface-herdr-zed-agents-usage', 'sidebar-history'], 'the usage sidebar surface sits above the history row');
  assert.deepEqual(find(mounted, 'status-content').children.map(child => child.id), ['status-main', 'status-tools']);
  const previous = { ...pkg, surfaces: [...pkg.surfaces,
    { id: 'usage-status', location: 'status.right', view: 'usage-status', title: 'Usage', icon: 'chart-column', mod: 'herdr-zed-agents' }] };
  const updated = extensionSurfaceLayout(extensionSurfaceLayout(root, [previous]), [pkg], [], [previous]);
  assert.deepEqual(find(updated, 'status-content').children.map(child => child.id), ['status-main', 'status-tools']);
  const unmounted = extensionSurfaceLayout(mounted, [pkg], ['herdr-zed-agents'], [pkg]);
  assert.equal(find(unmounted, 'zed-extension-surface-herdr-zed-agents-usage'), null);
  assert.deepEqual(find(unmounted, 'status-content').children.map(child => child.id), ['status-main', 'status-tools']);
});
