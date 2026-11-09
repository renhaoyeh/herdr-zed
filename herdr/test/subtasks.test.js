import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as board from '../mods/devkits-tasks/agent-board-model.js';
import { folderKey, threadTitle, configuredAgents } from '../mods/devkits/model.js';

async function state(memory = {}) {
  const source = await readFile(new URL('../mods/devkits-tasks/agent-board-state.js', import.meta.url), 'utf8');
  const host = { ...board, folderKey, threadTitle, configuredAgents, terminals: () => [], withTaskInputEvidence: agents => agents,
    shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); } };
  const methods = new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { createLocalTask, projectBoardTasks, deleteLocalTask, setTaskArchived, rememberBoardTask };')(...Object.values(host));
  return { ...methods, memory };
}
const project = { id: 'p', name: 'Project', folder: '/project', tabs: [] };

test('subtasks retain stable parent identity through renames, reloads, nested creation and independent progress', async () => {
  const s = await state(), parent = s.createLocalTask(project, 'Ship release', 'Parent instructions');
  const child = s.createLocalTask(project, 'Add tests', 'Test instructions', { parentId: parent.gid, agentKey: 'codex', priority: 'high' });
  const grandchild = s.createLocalTask(project, 'Test validation', '', { parentId: child.gid });
  assert.equal(child.parentId, parent.gid);
  s.rememberBoardTask(project, parent, { name: 'Renamed release', status: 'done', manual: true });
  const reopened = await state(JSON.parse(JSON.stringify(s.memory))), tasks = reopened.projectBoardTasks(project);
  const current = tasks.find(task => task.gid === child.gid);
  assert.equal(current.parentTask.name, 'Renamed release'); assert.equal(current.status, 'todo');
  assert.equal(current.agentKey, 'codex'); assert.equal(current.priority, 'high');
  assert.deepEqual(board.taskChildren(tasks, parent.gid).map(task => task.gid), [child.gid]);
  assert.deepEqual(board.taskChildren(tasks, child.gid).map(task => task.gid), [grandchild.gid]);
  reopened.rememberBoardTask(project, current, { status: 'fail', manual: true });
  assert.equal(reopened.projectBoardTasks(project).find(task => task.gid === parent.gid).status, 'done');
});

test('subtask creation rechecks parent availability, project and archive state without creating orphan tasks', async () => {
  const s = await state(), parent = s.createLocalTask(project, 'Parent'), before = structuredClone(s.memory);
  assert.throws(() => s.createLocalTask({ ...project, folder: '/other' }, 'Child', '', { parentId: parent.gid }), /parent task/);
  assert.throws(() => s.createLocalTask(project, 'Child', '', { parentId: 'missing' }), /parent task/);
  assert.deepEqual(s.memory, before);
  s.setTaskArchived(project, parent, true); const archived = structuredClone(s.memory);
  assert.throws(() => s.createLocalTask(project, 'Child', '', { parentId: parent.gid }), /archived/);
  assert.deepEqual(s.memory, archived);
});

test('agent-thread parents can have local subtasks without starting or changing the running parent', async () => {
  const s = await state(), liveProject = { ...project, tabs: [{ id: 'agent', name: 'Work on release' }] };
  const agents = [{ tab: 'agent', address: 't1', status: 'working', space: project.id }];
  const child = s.createLocalTask(liveProject, 'Investigate edge cases', '', { parentId: 'thread:agent' }, agents);
  const tasks = s.projectBoardTasks(liveProject, agents);
  assert.equal(tasks.find(task => task.gid === child.gid).status, 'todo');
  assert.equal(tasks.find(task => task.gid === 'thread:agent').status, 'todo', 'Starting an agent does not report task progress');
  assert.equal(board.canAddSubtask(tasks.find(task => task.gid === 'thread:agent')), true);
  assert.equal(board.canAddSubtask({ archived: true }), false); assert.equal(board.canAddSubtask(null), false);
});

test('deleting a parent detaches direct subtasks and archived links while preserving descendants and other projects', async () => {
  const s = await state(), parent = s.createLocalTask(project, 'Parent');
  const child = s.createLocalTask(project, 'Child', 'Keep instructions', { parentId: parent.gid, status: 'done', manual: true });
  const grandchild = s.createLocalTask(project, 'Grandchild', '', { parentId: child.gid });
  s.memory['devkits.thread-tasks'] = { childTab: { ...child, folder: project.folder }, otherTab: { ...child, folder: '/other' } };
  s.memory['devkits.archived-threads'] = [{ id: 'archive', folder: project.folder, task: { ...child }, boardTask: { ...child } },
    { id: 'other', folder: '/other', task: { ...child } }];
  assert.equal(s.deleteLocalTask(project, parent.gid), true);
  const tasks = s.projectBoardTasks(project), retained = tasks.find(task => task.gid === child.gid);
  assert.equal(retained.parentId, null); assert.equal(retained.parentTask, undefined);
  assert.equal(retained.status, 'done'); assert.equal(retained.notes, 'Keep instructions');
  assert.equal(tasks.find(task => task.gid === grandchild.gid).parentId, child.gid);
  assert.equal(s.memory['devkits.thread-tasks'].childTab.parentId, null);
  assert.equal(s.memory['devkits.thread-tasks'].otherTab.parentId, parent.gid);
  assert.equal(s.memory['devkits.archived-threads'][0].task.parentId, null);
  assert.equal(s.memory['devkits.archived-threads'][0].boardTask.parentId, null);
  assert.equal(s.memory['devkits.archived-threads'][1].task.parentId, parent.gid);
  assert.equal(tasks.some(task => task.gid === parent.gid), false);
});

test('local parent relationships remain separate from imported source parents and tolerate a missing parent', () => {
  const records = {
    parent: { gid: 'parent', source: 'local', name: 'Release', status: 'todo' },
    child: { gid: 'child', source: 'local', name: 'Imported', parentId: 'parent', asana: { parent: { name: 'External parent' } } },
    orphan: { gid: 'orphan', source: 'local', name: 'Still visible', parentId: 'missing', parentTask: { name: 'Stale snapshot' } },
  };
  const tasks = board.boardTasks(project, [], records);
  assert.equal(tasks.find(task => task.gid === 'child').parentTask.name, 'Release');
  assert.equal(tasks.find(task => task.gid === 'child').asana.parent.name, 'External parent');
  assert.equal(tasks.find(task => task.gid === 'orphan').parentTask, null);
  assert.equal(records.orphan.parentTask.name, 'Stale snapshot', 'resolution never mutates stored records');
});
