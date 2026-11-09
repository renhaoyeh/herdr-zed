import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskStatus, liveVersion, boardTasks, boardKey, agentsWithTurns, reconcileBoardRecords } from '../mods/devkits-tasks/agent-board-model.js';

const live = (status, seq = 1) => [{ address: 't1', status, seq, tab: 'tab1' }];
test('native terminal activity and turn counts never invent task progress', () => {
  assert.equal(taskStatus({}, []), 'todo');
  assert.equal(taskStatus({}, live('working')), 'todo');
  assert.equal(taskStatus({}, live('blocked')), 'todo');
  assert.equal(taskStatus({}, live('done')), 'todo');
  assert.equal(taskStatus({}, live('idle')), 'todo');
  assert.equal(taskStatus({}, [], true), 'todo');
  assert.equal(taskStatus({}, [{ ...live('idle')[0], turn: 1 }]), 'todo');
  assert.equal(taskStatus({ seenWorking: true }, live('idle')), 'todo');
  assert.equal(taskStatus({}, [...live('working'), { address: 't2', status: 'blocked' }]), 'todo');
});
test('stored progress is independent of native activity while action permissions still protect busy sessions', () => {
  for (const status of ['todo', 'done', 'fail']) {
    const record = { status, manual: true };
    assert.equal(taskStatus(record, live('working')), status);
    assert.equal(taskStatus(record, live('blocked')), status);
    assert.equal(taskStatus(record, live('idle')), status);
  }
  assert.equal(taskStatus({ status: 'doing' }, []), 'doing');
  assert.equal(taskStatus({ status: 'invalid' }, []), 'todo');
});
test('Saved and launched tasks share one card and project links remain isolated', () => {
  const project = { folder: '/app/', tabs: [] };
  const records = { a: { gid: 'a', name: 'Old', status: 'doing' }, done: { gid: 'done', name: 'Finished', status: 'done', manual: true } };
  const links = { tab1: { gid: 'a', folder: '/app', name: 'Started' }, other: { gid: 'b', folder: '/other', name: 'Unrelated' } };
  const cards = boardTasks(project, [{ gid: 'a', name: 'Renamed' }, { gid: 'new', name: 'New' }], records, links,
    [{ id: 'tab1' }], live('blocked'));
  assert.equal(cards.length, 3);
  assert.equal(cards.find(t => t.gid === 'a').name, 'Renamed');
  assert.equal(cards.find(t => t.gid === 'a').status, 'doing');
  assert.equal(cards.find(t => t.gid === 'a').attention.kind, 'native');
  assert.equal(cards.find(t => t.gid === 'a').tabs[0].id, 'tab1');
  assert.equal(cards.find(t => t.gid === 'done').status, 'done');
  assert.equal(cards.find(t => t.gid === 'new').status, 'todo');
  assert.equal(boardTasks(project, [], records, links, [], []).length, 2);
  assert.equal(boardKey({ folder: '/app/' }), boardKey({ folder: '/app' }));
  assert.notEqual(boardKey({ folder: '/app' }), boardKey({ folder: '/app', machine: 'remote' }));
});

test('unlinked agent threads appear on the board while plain terminals do not', () => {
  const tabs = [{ id: 'tab1', name: 'Fix login', named: true }, { id: 'shell', name: 'bun run ios' }];
  const project = { id: 'p', folder: '/app', tabs };
  const cards = boardTasks(project, [], {}, {}, tabs, live('working'));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].gid, 'thread:tab1');
  assert.equal(cards[0].name, 'Fix login');
  assert.equal(cards[0].source, 'thread');
  assert.equal(cards[0].status, 'todo');
  assert.equal(cards[0].tabs[0].id, 'tab1');
  const records = { 'thread:tab1': { ...cards[0], status: 'done', manual: true, liveVersion: liveVersion(live('working')) } };
  assert.equal(boardTasks(project, [], records, {}, tabs, live('idle'))[0].status, 'done');
});

test('local task creation needs no Asana connection and survives storage roundtrips', async () => {
  const { readFile } = await import('node:fs/promises');
  const { threadTaskId } = await import('../mods/devkits-tasks/agent-board-model.js');
  const memory = {};
  const source = await readFile(new URL('../mods/devkits-tasks/agent-board-state.js', import.meta.url), 'utf8');
  const state = new Function('shared', 'setShared', 'savedTasks', 'boardKey', 'boardTasks', 'taskStatus', 'threadTaskId', 'terminals', 'agentsWithTurns', 'reconcileBoardRecords', 'withTaskInputEvidence',
    source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn { createLocalTask, projectBoardTasks, threadBoardStatus, setTaskArchived };')(
      key => memory[key], (key, value) => { memory[key] = JSON.parse(JSON.stringify(value)); }, () => [], boardKey, boardTasks, taskStatus, threadTaskId, () => [], agentsWithTurns, reconcileBoardRecords, agents => agents);
  const project = { folder: '/app', tabs: [] };
  assert.equal(state.createLocalTask(project, '   '), null);
  const task = state.createLocalTask(project, ' Fix login ', ' Add validation ');
  const cards = state.projectBoardTasks(project);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].gid, task.gid);
  assert.equal(cards[0].name, 'Fix login');
  assert.equal(cards[0].notes, 'Add validation');
  assert.equal(cards[0].source, 'local');
  assert.equal(cards[0].status, 'todo');
  state.setTaskArchived(project, { ...cards[0], status: 'fail' }, true);
  let archivedCard = state.projectBoardTasks(project)[0];
  assert.equal(archivedCard.archived, true);
  assert.equal(archivedCard.status, 'todo'); // Archiving never changes progress.
  state.setTaskArchived(project, archivedCard, false);
  assert.equal(state.projectBoardTasks(project)[0].archived, false);
  assert.equal(state.threadBoardStatus(project, { tab: { id: 'shell' }, agents: [] }), null);
  assert.equal(state.threadBoardStatus(project, { tab: { id: 'tab1' }, agents: live('working') }), 'todo');
  assert.equal(state.threadBoardStatus(project, { tab: { id: 'tab1' }, agents: live('blocked') }), 'todo');
});


test('reported progress survives reads and restarts without following native turn endings', () => {
  let record = {};
  const task = agents => ({ gid: 'thread:tab1', source: 'thread', threadId: 'tab1', name: 'Fix login',
    agents, status: taskStatus(record, agents, true) });
  const observe = agents => {
    const next = task(agents);
    record = JSON.parse(JSON.stringify(reconcileBoardRecords({ [next.gid]: record }, [next])[next.gid]));
    return next.status;
  };
  assert.equal(observe(live('idle')), 'todo');
  assert.equal(observe(live('working', 2)), 'todo');
  record.status = 'doing';
  assert.equal(observe(live('done', 3)), 'doing');
  assert.equal(observe(live('idle', 4)), 'doing');
  assert.equal(observe(live('working', 5)), 'doing');
  assert.equal(observe(live('blocked', 6)), 'doing');
  assert.equal(observe(live('working', 7)), 'doing');
  assert.equal(observe(live('idle', 8)), 'doing');
  record.status = 'done';
  assert.equal(observe(live('working', 9)), 'done');
});

test('core turn history is activity metadata, never completion evidence', () => {
  const neverRan = agentsWithTurns(live('idle'), [{ address: 't1', turn: 0 }]);
  const finished = agentsWithTurns(live('idle'), [{ address: 't1', turn: 3 }]);
  assert.equal(taskStatus({}, neverRan, true), 'todo');
  assert.equal(taskStatus({}, finished, true), 'todo');
  assert.equal(taskStatus({}, agentsWithTurns(live('blocked'), [{ address: 't1', turn: 3 }]), true), 'todo');
  assert.equal(taskStatus({}, agentsWithTurns(live('working'), [{ address: 't1', turn: 3 }]), true), 'todo');
});

test('only unstarted active Todo tasks can expose execution controls', async () => {
  const { canStartTask } = await import('../mods/devkits-tasks/agent-board-model.js');
  assert.equal(canStartTask({ status: 'todo', tabs: [] }), true);
  for (const status of ['doing', 'waiting', 'done', 'fail']) assert.equal(canStartTask({ status, tabs: [] }), false);
  assert.equal(canStartTask({ status: 'todo', tabs: [{ id: 'existing' }] }), false);
  assert.equal(canStartTask({ status: 'todo', tabs: [], archived: true }), false);
});

test('input evidence controls empty-thread cleanup without changing stored task progress', () => {
  const record = { source: 'thread', status: 'done', seenWorking: true, manual: false };
  for (const status of ['working', 'idle', 'done']) {
    const agents = [{ ...live(status)[0], inputTracked: true, hasInput: false, turn: 1 }];
    assert.equal(taskStatus(record, agents), 'done');
    const updated = reconcileBoardRecords({ t: record }, [{ ...record, gid: 't', agents, status: 'todo' }]).t;
    assert.equal(updated.hasInput, false);
  }
  const real = [{ ...live('working')[0], inputTracked: true, hasInput: true, turn: 1 }];
  assert.equal(taskStatus(record, real), 'done');
  assert.equal(taskStatus(record, [{ ...real[0], status: 'idle' }]), 'done');
  assert.equal(taskStatus({ source: 'local' }, [{ ...real[0], hasInput: false }]), 'todo');
});

test('closing an empty thread removes its Todo card across reloads without hiding real tasks or archives', () => {
  const tab = { id: 'tab1', name: 'Empty session' }, project = { folder: '/app' };
  const agents = [{ ...live('idle')[0], inputTracked: true, hasInput: false, turn: 1 }];
  const initial = boardTasks(project, [], {}, {}, [tab], agents);
  const records = JSON.parse(JSON.stringify(reconcileBoardRecords({}, initial)));
  assert.equal(initial[0].status, 'todo');
  assert.equal(records['thread:tab1'].hasInput, false);
  assert.equal(boardTasks(project, [], records, {}, [tab], []).length, 1);
  assert.deepEqual(boardTasks(project, [], records, {}, [], []), []);
  assert.deepEqual(boardTasks(project, [], JSON.parse(JSON.stringify(records)), {}, [], []), []);

  const others = {
    ...records,
    local: { gid: 'local', source: 'local', name: 'Manual task', status: 'todo', hasInput: false },
    asana: { gid: 'asana', source: 'asana', name: 'Saved task', status: 'todo', hasInput: false },
    used: { gid: 'used', source: 'thread', threadId: 'used-tab', status: 'done', hasInput: true },
    archived: { gid: 'archived', source: 'thread', threadId: 'archived-tab', status: 'todo', hasInput: false, archived: true },
    legacy: { gid: 'legacy', source: 'thread', threadId: 'legacy-tab', status: 'done' },
  };
  assert.deepEqual(boardTasks(project, [], others).map(task => task.gid), ['local', 'asana', 'used', 'archived', 'legacy']);
  assert.equal(records['thread:tab1'].hasInput, false); // Visibility never destroys stored history.
});

test('all task action permissions agree with progress, archive visibility and live busy state', async () => {
  const { taskActions } = await import('../mods/devkits-tasks/agent-board-model.js');
  assert.deepEqual(taskActions({ status: 'todo', agents: [], tabs: [] }),
    { canStart: true, canEdit: true, canSetStatus: true, canArchive: true, canRestore: false, canDelete: false, canSchedule: true });
  assert.deepEqual(taskActions({ status: 'doing', agents: [], tabs: [] }),
    { canStart: false, canEdit: false, canSetStatus: true, canArchive: true, canRestore: false, canDelete: false, canSchedule: true });
  for (const status of ['done', 'fail']) assert.deepEqual(taskActions({ status, agents: [], tabs: [] }),
    { canStart: false, canEdit: false, canSetStatus: true, canArchive: true, canRestore: false, canDelete: false, canSchedule: true });
  for (const status of ['todo', 'done', 'fail']) for (const running of ['working', 'blocked']) {
    const permissions = taskActions({ status, agents: live(running), tabs: [] });
    assert.equal(permissions.canStart, false); assert.equal(permissions.canArchive, false);
    assert.equal(permissions.canEdit, false); assert.equal(permissions.canSetStatus, false);
  }
  assert.deepEqual(taskActions({ status: 'done', archived: true, agents: [], tabs: [] }),
    { canStart: false, canEdit: false, canSetStatus: false, canArchive: false, canRestore: true, canDelete: false, canSchedule: false });
});
