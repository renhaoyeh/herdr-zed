import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sessions from '../mods/devkits/components/session-model.js';
import * as identity from '../mods/devkits/components/tasks-model.js';
import * as policy from '../mods/devkits-tasks/agent-board-model.js';
import { evaluateNative } from './source-harness.js';
import { tasksMcpCall } from '../mods/devkits-tasks/mcp-api.js';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const input = { new: () => { let value = ''; return { value: () => value, set_value(next) { value = next; }, on() {}, focus() {}, set_auto_grow() {} }; } };
const context = () => {
  const pending = [], timers = [];
  const cx = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {},
    timer: { every(ms, tick) { timers.push({ ms, tick }); } }, spawn(fn) { const promise = fn(cx); pending.push(promise); return promise; } };
  return { cx, timers, async settle() { while (pending.length) await Promise.all(pending.splice(0)); } };
};

test('MCP creates persisted Todos and children through the authoritative Tasks owner', async () => {
  const h = await modules(), clock = context(); h.runtime.init(clock.cx);
  const project = tasksMcpCall(h.runtime, 'list_projects').projects[0].key;
  const parent = tasksMcpCall(h.runtime, 'create_task', { project, name: ' 規劃 ', notes: '說明', priority: 'high' }).task;
  const child = tasksMcpCall(h.runtime, 'create_task', { project, name: '子任務', parentId: parent.gid }).task;
  h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks().length, 2);
  assert.equal(h.client.listTasks().find(task => task.gid === parent.gid).priority, 'high');
  assert.equal(h.client.listTasks().find(task => task.gid === child.gid).parentId, parent.gid);
  assert.equal(parent.name, '規劃'); assert.equal(parent.status, 'todo');
  assert.equal(h.memory['devkits.agent-board'][project][parent.gid].notes, '說明');
  assert.throws(() => tasksMcpCall(h.runtime, 'create_task', { project, name: 'Invalid child', parentId: 'missing' }), /parent task/);
  h.owner.setTaskArchived(h.state.projects[0], parent, true);
  assert.throws(() => tasksMcpCall(h.runtime, 'create_task', { project, name: 'Invalid child', parentId: parent.gid }), /parent task/);
  assert.equal(h.memory['devkits.tasks.navigation'], undefined);
  assert.deepEqual(h.native, []);
});
async function modules(records = {}, projects = [{ id: 'p', folder: '/project', name: 'Project', active: true, tabs: [] }]) {
  const memory = { 'devkits.agent-board': clone(records), 'devkits.agent-cache': { null: [] } }, writes = [], overlays = [], native = [], closed = [];
  const state = { projects, agents: [] };
  const base = { ...sessions, ...identity,
    sessionMcpArgv: async (_agent, argv) => argv,
    globalThis: { window: { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } } },
    shared: key => clone(memory[key]), setShared: (key, value) => { memory[key] = clone(value); writes.push(key); },
    agents: () => state.agents, spaces: () => state.projects, terminals: () => [], appHome: () => '/herdr', home: () => '/home',
    props: () => ({ overlay: 'calendar' }), knownAgents: async () => [], readTextFile: async () => null,
    exec: async (...args) => { native.push(args); return { code: 0, stdout: '{}' }; },
    notify: message => assert.fail(message.body), openOverlay: spec => overlays.push(spec), closeOverlay: id => closed.push(id),
  };
  const client = await evaluateNative('../mods/devkits/components/tasks.js', base,
    'tasksSnapshot, listTasks, projectBoardTasks, boardRecords, taskLinkForTab, threadBoardStatus, threadBoardTask, threadTaskArchived, threadVisibleInSidebar, taskActions, sessionThreadTitle, taskRequest, requestTaskOpen, requestTaskStart, taskRequestResult, cancelTaskRequest, publishTaskNavigation, TaskHost, openTaskComposer');
  const owner = { ...base, ...policy, ...client };
  // Policy and mutations are loaded only into the Tasks context, never into the consumer context.
  Object.assign(owner, policy);
  Object.assign(owner, await evaluateNative('../mods/devkits-tasks/agent-task-evidence.js', owner, 'observeTaskInput, withTaskInputEvidence'));
  Object.assign(owner, await evaluateNative('../mods/devkits-tasks/agent-board-state.js', owner,
    'projectBoardTasks, boardRecords, taskLinkForTab, threadBoardStatus, threadBoardTask, sessionThreadTitle, rememberBoardTask, setTaskArchived, deleteLocalTask, createLocalTask'));
  Object.assign(owner, await evaluateNative('../mods/devkits/components/source-channel.js', owner,
    'createSourceChannel, sourceChannels, consumeSourceEvents, closeSourceChannel'));
  Object.assign(owner, await evaluateNative('../mods/devkits-tasks/task-sources.js', owner, 'TaskSources'));
  Object.assign(owner, await evaluateNative('../mods/devkits-tasks/task-prompt.js', owner, 'taskPrompt'));
  const { TaskRuntime } = await evaluateNative('../mods/devkits-tasks/runtime.js', owner, 'TaskRuntime');
  const runtime = new TaskRuntime();
  return { base, owner, client, runtime, state, memory, writes, overlays, closed, native };
}

test('Tasks service publishes one authoritative Sidebar/Calendar projection while its board is closed', async () => {
  const project = { id: 'p', folder: '/project', name: 'Project', active: true, tabs: [{ id: 'thread', name: 'Run task' }, { id: 'shell', name: 'Terminal' }] };
  const h = await modules({ '["","/project"]': { local: { gid: 'local', name: 'Local task', source: 'local', status: 'todo' } } }, [project]);
  h.state.agents = [{ address: 't1', space: 'p', tab: 'thread', app: 'pi', status: 'working', seq: 1 }];
  assert.deepEqual(h.client.projectBoardTasks(project), []); assert.deepEqual(h.writes, []);
  const clock = context(); h.runtime.init(clock.cx);
  assert.equal(h.runtime.agentBoard, undefined, 'The service tracks work without constructing a board UI');
  assert.equal(h.client.threadBoardStatus(project, { tab: { id: 'thread' } }), 'doing');
  assert.equal(h.client.threadBoardStatus(project, { tab: { id: 'shell' } }), null);
  assert.equal(h.client.listTasks().find(task => task.gid === 'thread:thread').status, 'doing');
  assert.equal(h.client.projectBoardTasks(project).find(task => task.gid === 'local').policy.canStart, true);
  const count = h.writes.length; h.client.projectBoardTasks(project); h.client.listTasks(); h.client.threadBoardTask(project, { tab: { id: 'thread' } });
  assert.equal(h.writes.length, count, 'Consumers never reconcile or write task state');
  h.state.agents[0] = { ...h.state.agents[0], status: 'done', seq: 2, turn: 1 }; h.runtime.refresh(clock.cx);
  assert.equal(h.client.threadBoardStatus(project, { tab: { id: 'thread' } }), 'done');
  h.state.agents[0].status = 'idle'; h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks().find(task => task.gid === 'thread:thread').status, 'done');
  const settled = h.writes.length; h.runtime.refresh(clock.cx); assert.equal(h.writes.length, settled, 'Unchanged projections are not rewritten');
  assert.deepEqual(h.native, []);
});

test('Calendar uses the public Tasks index, waits for validation and leaves panel routing to the host', async () => {
  const projects = [{ id: 'a', name: 'A', folder: '/a', tabs: [] }, { id: 'b', name: 'B', folder: '/b', tabs: [] }];
  const h = await modules({ '["","/a"]': { same: { gid: 'same', name: 'Same name', source: 'local', status: 'todo' } },
    '["","/b"]': { same: { gid: 'same', name: 'Same name', source: 'local', status: 'done', archived: true } } }, projects);
  const clock = context(); h.runtime.init(clock.cx);
  class Calendar { constructor(options) { this.options = options; } init() {} close() {} }
  const { CalendarMod } = await evaluateNative('../mods/devkits-calendar/main.js', { ...h.base, ...h.client, View: class {}, LocalCalendar: Calendar }, 'CalendarMod');
  const calendar = new CalendarMod(), calendarClock = context(); calendar.init(null, calendarClock.cx);
  const tasks = calendar.calendar.options.tasks(); assert.equal(tasks.length, 2); assert.notEqual(tasks[0].id, tasks[1].id);
  const selected = tasks.find(task => task.project.id === 'b');
  assert.equal(calendar.calendar.options.openTask(selected.id), null); assert.deepEqual(h.closed, []);
  h.runtime.poll(clock.cx);
  const events = [], host = new h.client.TaskHost(event => events.push(event)); host.init(context().cx);
  assert.equal(events.length, 1); assert.equal(events[0].project.id, 'b'); assert.equal(events[0].gid, 'same');
  calendarClock.timers[0].tick(calendarClock.cx); assert.deepEqual(h.closed, ['calendar']);
  assert.deepEqual(h.native, []); assert.equal(h.memory['devkits.tasks.requests'].length, 0);
  assert.deepEqual(h.memory['devkits.tasks.results'], {});
});

test('Calendar retains its dialog and reports a task deleted after reading the public index', async () => {
  const h = await modules({ '["","/project"]': { one: { gid: 'one', name: 'Task', source: 'local', status: 'todo' } } });
  const clock = context(); h.runtime.init(clock.cx);
  class Calendar { constructor(options) { this.options = options; } init() {} close() {} }
  const { CalendarMod } = await evaluateNative('../mods/devkits-calendar/main.js', { ...h.base, ...h.client, View: class {}, LocalCalendar: Calendar }, 'CalendarMod');
  const calendar = new CalendarMod(), calendarClock = context(); calendar.init(null, calendarClock.cx);
  const task = h.client.listTasks()[0]; assert.equal(calendar.calendar.options.openTask(task.id), null);
  assert.equal(h.owner.deleteLocalTask(h.state.projects[0], 'one', []), true);
  h.runtime.poll(clock.cx); calendarClock.timers[0].tick(calendarClock.cx);
  assert.match(calendar.calendar.error, /no longer available/); assert.deepEqual(h.closed, []);
  assert.equal(h.memory['devkits.tasks.navigation'], undefined);
});

test('a canceled Calendar navigation drops its queued request and cannot open Tasks later', async () => {
  const h = await modules({ '["","/project"]': { one: { gid: 'one', name: 'Task', source: 'local', status: 'todo' } } });
  const clock = context(); h.runtime.init(clock.cx);
  const id = h.client.requestTaskOpen(h.state.projects[0], 'one', { reply: true });
  h.client.cancelTaskRequest(id); h.runtime.poll(clock.cx);
  assert.equal(h.memory['devkits.tasks.navigation'], undefined); assert.equal(h.client.taskRequestResult(id), null);
});

test('task execution validates in Tasks and a deletion during asynchronous rule loading prevents launching', async () => {
  const h = await modules({ '["","/project"]': { one: { gid: 'one', name: 'Task', source: 'local', status: 'todo' } } });
  let finish; h.owner.readTextFile = () => new Promise(resolve => { finish = resolve; });
  // A fresh provider context binds the delayed native file reader.
  const { TaskRuntime } = await evaluateNative('../mods/devkits-tasks/runtime.js', h.owner, 'TaskRuntime');
  const service = new TaskRuntime(), clock = context(); service.init(clock.cx);
  h.client.requestTaskStart({ key: 'codex', name: 'Codex', run: ['codex'] }, { folder: '/project', space: 'p', task: { gid: 'one' } });
  service.poll(clock.cx); assert.equal(typeof finish, 'function');
  assert.equal(h.owner.deleteLocalTask(h.state.projects[0], 'one', []), true);
  finish('Use project rules'); await clock.settle();
  assert.equal(h.memory['devkits.tasks.navigation'], undefined); assert.deepEqual(h.native, []);
  h.client.requestTaskStart({ key: 'codex', run: ['codex'] }, { folder: '/project', task: { gid: 'one' } }); service.poll(clock.cx);
  assert.equal(h.memory['devkits.tasks.navigation'], undefined, 'A missing task never becomes a generic agent launch');
});

test('closing the independent Tasks composer preserves its project-scoped unsaved draft', async () => {
  const h = await modules(), clock = context();
  Object.assign(h.owner, { InputState: input, TextareaState: input, SelectState: class {}, liveAgents: () => [] });
  const { TaskComposer } = await evaluateNative('../mods/devkits-tasks/task-composer.js', h.owner, 'TaskComposer');
  const target = { view: 'task-composer', project: h.state.projects[0], overlay: 'draft' };
  const { TasksMod } = await evaluateNative('../mods/devkits-tasks/main.js', { ...h.base, View: class {}, TaskRuntime: class { taskAssignees() { return []; } },
    TaskComposer, props: () => target }, 'TasksMod');
  const view = new TasksMod(); view.init(null, clock.cx); view.composer.title.set_value('Unfinished'); view.close();
  assert.equal(h.memory['devkits.task-drafts']['["","/project"]'].name, 'Unfinished');
  assert.equal(h.memory['devkits.agent-board']['["","/project"]'], undefined);
});

test('Tasks resolves native session handoffs before projecting their task and thread relationship', async () => {
  const h = await modules({ '["","/project"]': { one: { gid: 'one', name: 'Task', source: 'local', status: 'todo' } } });
  h.state.projects[0].tabs = [{ id: 'tab', name: 'Task' }];
  h.state.agents = [{ address: 't1', tab: 'tab', space: 'p', app: 'pi', status: 'working' }];
  const task = { gid: 'one', name: 'Task', folder: '/project', source: 'local' };
  h.memory['devkits.pending-profiles'] = [{ key: 'codex', space: 'p', folder: '/project', before: [], at: Date.now(), task }];
  h.runtime.init(context().cx);
  assert.deepEqual(h.memory['devkits.pending-profiles'], []);
  assert.equal(h.memory['devkits.thread-profiles'].tab, 'codex');
  assert.deepEqual(h.client.taskLinkForTab('tab', h.state.projects[0]), task);
  const tasks = h.client.projectBoardTasks(h.state.projects[0]);
  assert.equal(tasks.length, 1); assert.equal(tasks[0].gid, 'one'); assert.equal(tasks[0].status, 'doing');
});
