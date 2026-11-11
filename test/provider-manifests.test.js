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

test('working panels open anchored over the work area; the Simulator popup stays centered', async () => {
  for (const id of ['tasks', 'calendar', 'asana', 'mantisbt', 'system']) {
    const [action] = parseExtensionManifest(`herdr-zed-${id}`, await load(id));
    assert.equal(action.popup.placement, 'workspace', `${id} popup placement`);
  }
  const [simulator] = parseExtensionManifest('herdr-zed-simulator', await load('simulator'));
  assert.equal(simulator.popup.placement, 'center');
});

test('Agents Settings declares its six pages in the order the Settings nav lists them, each with a title', async () => {
  const { settings } = extensionMetadata('herdr-zed-agents', await load('agents'));
  assert.equal(settings.view, 'manage-launchers');
  assert.deepEqual(settings.pages, [
    { id: 'accounts', title: 'Accounts' }, { id: 'agents', title: 'Agents' }, { id: 'profiles', title: 'Profiles' },
    { id: 'global-rules', title: 'Global Rules' }, { id: 'capabilities', title: 'Capabilities' }, { id: 'ecc', title: 'ECC' },
  ]);
});

test('the other provider Settings pages declare no sub-pages', async () => {
  for (const id of ['github', 'asana', 'mantisbt', 'system']) {
    assert.deepEqual(extensionMetadata(`herdr-zed-${id}`, await load(id)).settings.pages, [], id);
  }
});
