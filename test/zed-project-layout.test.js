import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../mods/herdr-zed/project-layout.js', import.meta.url), 'utf8');
const project = { id: 'project', folder: '/project' };

test('thread maximize hides declared extension docks and restores each prior visibility', () => {
  const root = { children: [
    { id: 'editor', hidden: false },
    { id: 'simulator', hidden: false, size: { px: 420 } },
    { id: 'other-dock', hidden: true, size: { px: 320 } },
    { id: 'sidebar', hidden: false },
  ] };
  const memory = { 'herdr-zed.extensions.catalog': { packages: [
    { mod: 'herdr-zed-simulator', surfaces: [{ id: 'simulator', location: 'dock.right' }] },
    { mod: 'other-provider', surfaces: [{ id: 'other-dock', location: 'dock.right' },
      { id: 'status-metric', location: 'status.right' }] },
    { mod: 'broken', error: 'unavailable', surfaces: [{ id: 'broken-dock', location: 'dock.right' }] },
  ] } };
  const calls = [], node = id => root.children.find(item => item.id === id);
  const run = (command, { id }) => {
    calls.push([command, id]);
    if (command === 'layout.hide' || command === 'layout.show') node(id).hidden = command === 'layout.hide';
  };
  const api = new Function('layout', 'run', 'shared', 'setShared', source
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { maximizeConversation, conversationMaximized };')(
    () => root, run, key => memory[key], (key, value) => { memory[key] = structuredClone(value); });

  api.maximizeConversation(project, true);
  assert.equal(api.conversationMaximized(project), true);
  assert.deepEqual(memory['herdr-zed.conversation-maximized'].hidden,
    { editor: false, simulator: false, 'other-dock': true });
  assert.equal(node('editor').hidden, true);
  assert.equal(node('simulator').hidden, true);
  assert.equal(node('other-dock').hidden, true);
  assert.equal(node('sidebar').hidden, false);
  assert.equal(node('simulator').size.px, 420);
  assert.equal(calls.some(([, id]) => id === 'status-metric' || id === 'broken-dock'), false);

  api.maximizeConversation(project, false);
  assert.equal(api.conversationMaximized(project), false);
  assert.equal(node('editor').hidden, false);
  assert.equal(node('simulator').hidden, false);
  assert.equal(node('other-dock').hidden, true, 'a dock hidden before maximize stays hidden');
  assert.equal(node('simulator').size.px, 420);
});
