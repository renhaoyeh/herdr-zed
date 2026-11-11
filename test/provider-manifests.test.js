import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseExtensionManifest, extensionMetadata } from '../mods/herdr-zed/extension-model.js';

// Provider manifest rules: platform support, where working panels open, and the Agents Settings pages.
const load = id => readFile(new URL(`../mods/herdr-zed-${id}/extension.json`, import.meta.url), 'utf8');

test('the iOS Simulator is a macOS-only package; the other providers declare no platform limit', async () => {
  assert.deepEqual(extensionMetadata('herdr-zed-simulator', await load('simulator')).platforms, ['macos']);
  for (const id of ['agents', 'github', 'asana', 'mantisbt', 'calendar', 'tasks', 'system']) {
    assert.equal(extensionMetadata(`herdr-zed-${id}`, await load(id)).platforms, null, `${id} has no platform limit`);
  }
});

test('working panels open over the work area; Simulator uses its dock entry only', async () => {
  for (const id of ['tasks', 'calendar', 'asana', 'mantisbt']) {
    const [action] = parseExtensionManifest(`herdr-zed-${id}`, await load(id));
    assert.equal(action.popup.placement, 'workspace', `${id} popup placement`);
  }
  assert.deepEqual(parseExtensionManifest('herdr-zed-simulator', await load('simulator')), []);
  assert.deepEqual(parseExtensionManifest('herdr-zed-system', await load('system')), []);
});

test('Agents Settings declares its seven contextual tabs in order with distinct titles', async () => {
  const { settings } = extensionMetadata('herdr-zed-agents', await load('agents'));
  assert.equal(settings.view, 'manage-launchers');
  assert.deepEqual(settings.pages, [
    { id: 'accounts', title: 'Accounts' }, { id: 'agents', title: 'Launch menu' }, { id: 'profiles', title: 'Profiles' },
    { id: 'global-rules', title: 'Global Rules' }, { id: 'mcp', title: 'MCP Connections' }, { id: 'capabilities', title: 'Capabilities' }, { id: 'ecc', title: 'ECC' },
  ]);
});

test('the other provider Settings pages declare no sub-pages', async () => {
  for (const id of ['github', 'asana', 'mantisbt', 'system']) {
    assert.deepEqual(extensionMetadata(`herdr-zed-${id}`, await load(id)).settings.pages, [], id);
  }
});
