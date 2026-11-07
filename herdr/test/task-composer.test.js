import { test } from 'node:test';
import { launcherOption } from '../mods/devkits/model.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { boardKey, liveVersion, taskActions } from '../mods/devkits/agent-board-model.js';

async function composer(options = {}) {
  const source = await readFile(new URL('../mods/devkits/task-composer.js', import.meta.url), 'utf8');
  const memory = {}, closed = [], tasks = [], currentTasks = [];
  const state = { new: () => ({ value: () => '', set_value(value) { this.value = () => value; }, set_auto_grow() {}, on() {}, focus() {} }) };
  const host = { InputState: state, TextareaState: state, SelectState: class {}, launcherOption, boardKey, liveVersion, taskActions, liveAgents: () => [], projectBoardTasks: () => currentTasks,
    shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); }, closeOverlay: id => closed.push(id),
    createLocalTask: (project, name, notes, fields) => { const task = { gid: 'local:1', name, notes, ...fields }; tasks.push({ project, ...task }); return task; },
    rememberBoardTask: (project, task, fields) => tasks.push({ project, ...task, ...fields }) };
  const Composer = new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace('export default class', 'class')
    .replace(/^export /gm, '') + '\nreturn TaskComposer;')(...Object.values(host));
  const view = new Composer(); view.init({ project: { id: 'p', folder: '/app', name: 'App' }, overlay: 'composer', ...options }, { focus_handle: () => ({}) });
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

test('Asana import opens an editable local draft, preserves source context, and creates Todo only on confirmation', async () => {
  const source = { gid: 'a1', name: 'Source title', notes: 'Original description', url: 'https://app.asana.com/0/p/a1',
    parent: { name: 'Parent', url: 'https://app.asana.com/0/p/parent' }, comments: [{ author: 'Amy', text: 'Use v2' }] };
  const { view, tasks, memory } = await composer({ importTask: source });
  assert.equal(view.title.value(), source.name); assert.equal(view.description.value(), source.notes);
  assert.deepEqual(tasks, []);
  view.title.set_value('Revised title'); view.description.set_value('Original description\n\nAlso add regression coverage.');
  view.agent = 'rick'; view.priority = 'high'; view.submit([{ key: 'rick', name: 'Rick' }]);
  view.submit([]);
  assert.equal(tasks.length, 1); assert.equal(tasks[0].name, 'Revised title');
  assert.match(tasks[0].notes, /Also add regression coverage/);
  assert.equal(tasks[0].status, 'todo'); assert.equal(tasks[0].agentKey, 'rick');
  assert.deepEqual(tasks[0].asana, { gid: source.gid, name: source.name, url: source.url, parent: source.parent, comments: source.comments });
  assert.equal(source.notes, 'Original description');
  assert.equal(memory['devkits.board-focus'], 'local:1');
});

test('canceled Asana import drafts preserve extra instructions separately from manual and other source drafts', async () => {
  const { view, tasks, memory, Composer } = await composer({ importTask: { gid: 'a1', name: 'First', notes: 'Original' } });
  const key = boardKey(view.project);
  memory['devkits.task-drafts'] = { [key]: { name: 'Manual draft', notes: 'Manual notes' } };
  view.description.set_value('Original\nExtra instructions'); view.dismiss();
  assert.deepEqual(tasks, []); assert.equal(memory['devkits.task-drafts'][key].name, 'Manual draft');
  const reopened = new Composer(); reopened.init(view.options, { focus_handle: () => ({}) });
  assert.equal(reopened.description.value(), 'Original\nExtra instructions');
  const second = new Composer(); second.init({ ...view.options, importTask: { gid: 'a2', name: 'Second', notes: 'Other source' } }, { focus_handle: () => ({}) });
  assert.equal(second.description.value(), 'Other source');
  const manual = new Composer(); manual.init({ ...view.options, importTask: null }, { focus_handle: () => ({}) });
  assert.equal(manual.title.value(), 'Manual draft');
  reopened.submit([]);
  assert.equal(memory['devkits.task-drafts'][key].name, 'Manual draft');
});
