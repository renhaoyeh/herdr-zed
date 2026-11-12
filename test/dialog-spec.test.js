import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// ui-review §3.3: confirm 440 modal, form 560 modal with Cancel + Save, working panel 0.9×0.86 non-modal with a header X.
const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// Every shell and provider source file, copies of shared components included; vendored code is not ours to edit.
async function modSources(dir = new URL('../mods/', import.meta.url), found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) { if (entry.name !== 'vendor' && entry.name !== 'node_modules') await modSources(path, found); }
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

test('confirm dialogs are 440 wide and modal; destructive ones use the destructive variant', async () => {
  const deleteTask = await source('mods/herdr-zed-tasks/delete-task.js');
  assert.match(deleteTask, /kind: 'dialog', modal: true, frame: 'none', width: 440,\s*props/);
  assert.match(deleteTask, /Button\('delete-task-confirm', t, \{ variant: 'destructive' \}\)/);

  const account = await source('mods/herdr-zed-agents/account-actions.js');
  assert.match(account, /width: 440,\s*props: \{ view: 'remove-account'/);
  assert.match(account, /Button\('confirm-remove-account', t, \{ variant: 'destructive' \}\)/);
  assert.match(account, /AlertDialogCancel\('cancel-remove-account'/);
});

test('the simulator storage delete is a separate 440 modal confirm with Cancel and a destructive Delete', async () => {
  const xcode = await source('mods/herdr-zed-simulator/xcode-storage.js');
  assert.match(xcode, /openOverlay\(\{ mod: 'herdr-zed-simulator', kind: 'dialog', frame: 'none', modal: true, width: 440,\s*props: \{ view: 'simulator-storage-confirm'/);
  assert.match(xcode, /AlertDialogContent\('xcode-storage-confirm', t\)/);
  assert.match(xcode, /AlertDialogCancel\('xcode-storage-confirm-cancel', t\)/);
  assert.match(xcode, /Button\('xcode-storage-confirm-delete', t, \{ variant: 'destructive' \}\)/);
  assert.doesNotMatch(xcode, /confirming/, 'the storage panel no longer confirms inline');
});

test('no dialog closes with a Done button: the close control is the header X, and a Save page says Save', async () => {
  for (const path of await modSources()) {
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, /child\('Done'\)|-done'|action\('done'/, `${path.pathname} draws a Done button`);
  }
});

test('form dialogs are 560 wide and modal with Cancel + Save', async () => {
  const account = await source('mods/herdr-zed-agents/account-actions.js');
  assert.equal([...account.matchAll(/frame: 'none', modal: true, width: 560,/g)].length, 2, 'add login and rename are 560 wide');
  assert.match(account, /width: 560, height: 520,\s*props: \{ view: 'account-login'/);
  assert.match(account, /width: 560,\s*props: \{ view: 'rename-account'/);
  assert.doesNotMatch(account, /width: 520|width: 480/);

  const profiles = await source('mods/herdr-zed-agents/agent-profiles.js');
  assert.match(profiles, /modal: true, frame: 'none', width: 560, height: 0\.8,/);
  assert.match(profiles, /Button\('cancel-agent-profile'.*child\('Cancel'\)/);

  const calendar = await source('mods/herdr-zed-calendar/calendar.js');
  assert.match(calendar, /modal: true, width: 560, height: 480,/);
  const board = await source('mods/herdr-zed-tasks/agent-board.js');
  assert.match(board, /modal: true, width: 560, height: 480,\s*props: \{ view: 'calendar', calendarCreate: true/);

  const composer = await source('mods/herdr-zed-tasks/task-composer.js');
  assert.match(composer, /modal: true, frame: 'none', width: 760, height: 400,/);

  for (const mod of ['asana', 'mantisbt']) {
    const importTarget = await source(`mods/herdr-zed-${mod}/import-target.js`);
    assert.match(importTarget, /modal: true, width: 760, height: 400,/, 'imports open the Tasks composer size');
  }
});

test('working panels are 0.9×0.86, non-modal, and close from a header X rather than Done', async () => {
  const system = JSON.parse(await source('mods/herdr-zed-system/extension.json'));
  assert.deepEqual(system.actions, [], 'CPU metrics already open the System panel');
  const monitor = await source('mods/herdr-zed-system/monitor.js');
  assert.match(monitor, /renderDetails[\s\S]*Button\('hardware-details-close', t, \{ variant: 'ghost', size: 'icon' \}\)/);
  assert.doesNotMatch(monitor, /hardware-details-done/);
  const main = await source('mods/herdr-zed-system/main.js');
  assert.match(main, /openWorkspacePanel\(\{ mod: 'herdr-zed-system', props: \{ view: 'details', page \} \}\)/);

  const storage = await source('mods/herdr-zed-simulator/simulator.js');
  assert.match(storage, /modal: false, width: 0\.9, height: 0\.86, props: \{ view: 'simulator-storage' \}/);
  const xcode = await source('mods/herdr-zed-simulator/xcode-storage.js');
  assert.match(xcode, /Button\('xcode-storage-close', t, \{ variant: 'ghost', size: 'icon' \}\)/);
  assert.doesNotMatch(xcode, /xcode-storage-done/);

  const tasks = JSON.parse(await source('mods/herdr-zed-tasks/extension.json'));
  assert.equal(tasks.actions[0].popup.modal, false);
  assert.match(await source('mods/herdr-zed-tasks/agent-board.js'), /board-close/);
  assert.match(await source('mods/herdr-zed-tasks/agent-board.js'), /on_mouse_down\('right', \(_event, cx\) => \{ cx\.stop_propagation\(\); openMenu\(cx\); \}\)/, 'a task card opens its actions on right-click');
});

test('picker popups are 280 wide', async () => {
  const channel = await source('components/source-channel.js');
  assert.match(channel, /kind: 'popup', frame: 'none', width: 280, at,/);
  assert.match(await source('mods/herdr-zed-asana/ui.js'), /\.\.\.\), 280,\s*\(_cx, at\)|cx\.stop_propagation\(\)\), 280,/);
  assert.match(await source('mods/herdr-zed-mantisbt/ui.js'), /chevron-down', 12\)\), 280,/);
});

test('GitHub account popup is a 560 modal form', async () => {
  const github = JSON.parse(await source('mods/herdr-zed-github/extension.json'));
  assert.deepEqual(github.actions[0].popup, { view: 'account', width: 560, height: 0.8, modal: true });
});

test('Agents labels say thread for starting one; save semantics are named on explicit-save pages', async () => {
  const menu = await source('mods/herdr-zed-agents/session-menu.js');
  assert.match(menu, /'manage-column-session', 'New thread'/);
  assert.doesNotMatch(menu, /Add session/);
  assert.match(menu, /'Choose what New thread and Usage show/);
  const profiles = await source('mods/herdr-zed-agents/agent-profiles.js');
  assert.match(profiles, /Each appears in New thread\./);
  assert.doesNotMatch(profiles, /Add session/);

  const capabilities = await source('mods/herdr-zed-agents/devkits-settings.js');
  assert.match(capabilities, /Choose Rules and Skills for new local sessions, per provider\./);
  assert.match(capabilities, /'Save changes'\)/);
  const ecc = await source('mods/herdr-zed-agents/ecc-settings.js');
  assert.match(ecc, /child\('Changes are saved when you click Save\./);
  assert.match(ecc, /'Save changes'\)/);
});
