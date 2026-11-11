import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

async function fixture(tabs, paneList = [{ pane: 'p', tab: 'work' }]) {
  const commands = [], spaces = [{ id: 'space', tabs: tabs.map(id => ({ id })) }];
  const api = await evaluateNative('../mods/herdr-zed/thread-close.js', {
    spaces: () => spaces, panes: () => paneList,
    run: (command, args) => { commands.push([command, args]);
      if (command === 'tab.new') spaces[0].tabs.push({ id: 'empty', name: args.name });
      if (command === 'tab.close') spaces[0].tabs = spaces[0].tabs.filter(tab => tab.id !== args.id);
    },
  }, 'closeThreadTab, closeThreadPane, isProjectPlaceholder');
  return { ...api, commands, spaces };
}

test('closing the final thread preserves its space with an empty mod tab and no new terminal', async () => {
  const h = await fixture(['work']); h.closeThreadTab('work');
  assert.deepEqual(h.commands, [
    ['tab.new', { space: 'space', name: '__herdr_zed_empty_project__', mod: 'herdr-zed', props: { view: 'project-empty' } }],
    ['tab.close', { id: 'work' }],
  ]);
  assert.equal(h.spaces[0].tabs.length, 1);
  assert.equal(h.isProjectPlaceholder(h.spaces[0].tabs[0]), true);
  assert.equal(h.commands.some(([name]) => name === 'space.close' || name === 'terminal.open'), false);
});

test('closing a thread beside another tab does not add a placeholder', async () => {
  const h = await fixture(['work', 'other']); h.closeThreadTab('work');
  assert.deepEqual(h.commands, [['tab.close', { id: 'work' }]]);
});

test('closing the final pane also preserves the space while a split closes only its pane', async () => {
  const single = await fixture(['work']); single.closeThreadPane('p');
  assert.equal(single.commands[0][0], 'tab.new');
  assert.equal(single.commands[1][0], 'tab.close');
  const split = await fixture(['work'], [{ pane: 'p', tab: 'work' }, { pane: 'q', tab: 'work' }]);
  split.closeThreadPane('p');
  assert.deepEqual(split.commands, [['pane.close', { pane: 'p' }]]);
});

test('stale thread and pane close events leave all spaces unchanged', async () => {
  const h = await fixture(['work']); h.closeThreadTab('missing'); h.closeThreadPane('missing');
  assert.deepEqual(h.commands, []);
});
