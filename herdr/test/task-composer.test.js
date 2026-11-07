import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { boardKey, liveVersion, taskActions } from '../mods/devkits/agent-board-model.js';

async function composer() {
  const source = await readFile(new URL('../mods/devkits/task-composer.js', import.meta.url), 'utf8');
  const memory = {}, closed = [], tasks = [], currentTasks = [];
  const state = { new: () => ({ value: () => '', set_value(value) { this.value = () => value; }, set_auto_grow() {}, on() {}, focus() {} }) };
  const host = { InputState: state, TextareaState: state, SelectState: class {}, boardKey, liveVersion, taskActions, liveAgents: () => [], projectBoardTasks: () => currentTasks,
    shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); }, closeOverlay: id => closed.push(id),
    createLocalTask: (project, name, notes, fields) => { const task = { gid: 'local:1', name, notes, ...fields }; tasks.push({ project, ...task }); return task; },
    rememberBoardTask: (project, task, fields) => tasks.push({ project, ...task, ...fields }) };
  const Composer = new Function(...Object.keys(host), source.replace(/^import .*;\n/gm, '').replace('export default class', 'class')
    .replace(/^export /gm, '') + '\nreturn TaskComposer;')(...Object.values(host));
  const view = new Composer(); view.init({ project: { id: 'p', folder: '/app', name: 'App' }, overlay: 'composer' }, { focus_handle: () => ({}) });
  return { view, memory, closed, tasks, currentTasks, Composer };
}

test('creating a task saves the real properties and never starts an agent', async () => {
  const { view, memory, closed, tasks } = await composer();
  view.title.set_value('Fix login'); view.description.set_value('Validate the form');
  view.agent = 'codex'; view.priority = 'high';
  view.submit([{ key: 'codex', name: 'Work Codex' }]);
  assert.equal(tasks[0].name, 'Fix login'); assert.equal(tasks[0].notes, 'Validate the form');
  assert.equal(tasks[0].agentKey, 'codex'); assert.equal(tasks[0].status, 'todo');
  assert.equal(tasks[0].priority, 'high');
  assert.equal(memory['devkits.board-focus'], 'local:1');
  assert.deepEqual(closed, ['composer']);
});
test('dismissed drafts survive reopening per project, and blank task titles cannot submit', async () => {
  const { view, memory, closed, tasks, Composer } = await composer();
  view.title.set_value('   '); view.submit([]); assert.equal(tasks.length, 0);
  view.title.set_value('Unfinished draft'); view.description.set_value('Keep these notes'); view.dismiss();
  assert.equal(memory['devkits.task-drafts'][boardKey(view.project)].name, 'Unfinished draft');
  const reopened = new Composer(); reopened.init(view.options, { focus_handle: () => ({}) });
  assert.equal(reopened.title.value(), 'Unfinished draft'); assert.equal(reopened.description.value(), 'Keep these notes');
  assert.deepEqual(closed, ['composer']);
});


test('edits cannot change a started task; Todo edits retain identity and never start an agent', async () => {
  const { view, tasks, currentTasks } = await composer();
  view.task = { gid: 'local:existing', source: 'local', name: 'Old', status: 'doing', agents: [{ address: 't1', status: 'working', seq: 8 }] };
  currentTasks.push(view.task);
  view.title.set_value('Revised task'); view.description.set_value('Updated instructions');
  view.submit([]); assert.equal(tasks.length, 0);
  view.task = { ...view.task, status: 'todo', agents: [] };
  currentTasks[0] = view.task;
  view.submit([]);
  assert.equal(tasks[0].gid, 'local:existing'); assert.equal(tasks[0].status, 'todo');
  assert.equal(tasks[0].name, 'Revised task'); assert.equal(tasks[0].notes, 'Updated instructions');
});

test('a stale editor cannot recreate a task deleted from the board', async () => {
  const { view, tasks } = await composer();
  view.task = { gid: 'local:deleted', source: 'local', name: 'Deleted', status: 'todo', agents: [] };
  view.title.set_value('Stale edit'); view.submit([]);
  assert.deepEqual(tasks, []);
});

test('new tasks cannot be fabricated as Doing or Done by stale column defaults or draft state', async () => {
  const { view, tasks } = await composer();
  view.title.set_value('Unstarted task'); view.status = 'doing'; view.submit([]);
  assert.equal(tasks[0].status, 'todo'); assert.equal(tasks[0].manual, false);
});
