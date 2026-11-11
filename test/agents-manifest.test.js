import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseExtensionManifest, extensionMetadata } from '../mods/herdr-zed/extension-model.js';
import { extensionSurfaceLayout } from '../mods/herdr-zed/extension-surfaces.js';

const text = await readFile(new URL('../mods/herdr-zed-agents/extension.json', import.meta.url), 'utf8');
const find = (node, id) => node?.id === id ? node : (node?.children || []).map(child => find(child, id)).find(Boolean) || null;

test('the Agents manifest declares the Usage sidebar and status bar surfaces and the shell parser accepts them', () => {
  assert.deepEqual(parseExtensionManifest('herdr-zed-agents', text), []);
  const meta = extensionMetadata('herdr-zed-agents', text);
  assert.deepEqual(meta.surfaces.map(({ id, location, view, title, icon, mod }) => ({ id, location, view, title, icon, mod })), [
    { id: 'usage', location: 'sidebar.bottom', view: 'usage-sidebar', title: 'Usage', icon: 'chart-column', mod: 'herdr-zed-agents' },
    { id: 'usage-status', location: 'status.right', view: 'usage-status', title: 'Usage', icon: 'chart-column', mod: 'herdr-zed-agents' },
  ]);
  assert.equal(existsSync(new URL('../assets/icons/chart-column.svg', import.meta.url)), true, 'surface icon exists');
});

test('the shell mounts both Usage surfaces at their locations and removes them when Agents is disabled', () => {
  const pkg = { mod: 'herdr-zed-agents', ...extensionMetadata('herdr-zed-agents', text) };
  const root = { id: 'root', type: 'row', children: [
    { id: 'sidebar', type: 'column', size: { px: 280 }, children: [{ id: 'agents', type: 'block', content: { mod: 'herdr-zed' } }] },
    { id: 'workspace-row', type: 'row', children: [{ id: 'editor', type: 'block', size: { weight: 1 }, content: { mod: 'herdr-zed', props: { view: 'editor' } } }] },
    { id: 'status', type: 'column', size: { px: 32 }, children: [{ id: 'status-content', type: 'block', content: { mod: 'herdr-zed', props: { view: 'status' } } }] },
  ] };
  const mounted = extensionSurfaceLayout(root, [pkg]);
  assert.deepEqual(find(mounted, 'zed-extension-surface-herdr-zed-agents-usage').content, { mod: 'herdr-zed-agents', props: { view: 'usage-sidebar' } });
  assert.equal(find(mounted, 'status-content').children[1].content.props.view, 'usage-status');
  const unmounted = extensionSurfaceLayout(mounted, [pkg], ['herdr-zed-agents'], [pkg]);
  assert.equal(find(unmounted, 'zed-extension-surface-herdr-zed-agents-usage'), null);
  assert.equal(find(unmounted, 'status-content').content.props.view, 'status');
});
