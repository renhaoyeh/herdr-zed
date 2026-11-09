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

test('an existing conversation adopts reporting with its own terminal and retains attempts across new work', async () => {
  const h = await modules(), clock = context();
  const project = h.state.projects[0];
  project.tabs = [{ id: 'chat', name: 'Existing chat' }];
  h.state.agents = [{ address: 't-chat', tab: 'chat', space: project.id, status: 'idle', program: { name: 'Codex' } }];
  h.memory['devkits.thread-profiles'] = { chat: 'codex' };
  h.runtime.init(clock.cx);
  const report = (status, message) => h.runtime.reportTask(null, { terminal: 't-chat', status, message });
  assert.throws(() => report('done', 'No attempt'), /Report doing/);
  assert.throws(() => h.runtime.reportTask(null, { terminal: 'missing', status: 'doing', message: 'Other terminal' }), /no active Herdr task/);
  report('doing', 'Starting actual work');
  const first = h.owner.boardRecords(project)['thread:chat'].execution.id;
  report('waiting', 'Which behavior?');
  h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks()[0].status, 'doing');
  assert.match(h.client.listTasks()[0].attention.message, /Which behavior/);
  report('doing', 'Answer received'); report('done', 'Validated');
  h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks()[0].status, 'done');
  h.state.agents[0].status = 'working'; h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks()[0].status, 'done', 'Native work cannot reopen a finished task');
  report('doing', 'New user request');
  const task = h.owner.boardRecords(project)['thread:chat'];
  assert.notEqual(task.execution.id, first);
  assert.equal(task.runs[0].id, first); assert.equal(task.runs[0].summary, 'Validated');
  assert.equal(task.execution.profile, 'codex'); assert.equal(task.execution.model, null);
  assert.throws(() => h.runtime.reportTask(null, { run: first, status: 'done', message: 'Late result' }), /no longer active/);
  assert.deepEqual(h.native, []);
});

test('reported work stays Doing across native idle/done, separates attention and rejects stale attempts', async () => {
  const projectKey = '["","/project"]';
  const task = { gid: 'local:report', name: 'Fix login', source: 'local', status: 'todo',
    execution: { id: 'run:one', status: 'starting', startedAt: Date.now(), profile: 'implementer', profileName: 'Implementer', model: 'saved-model' } };
  const h = await modules({ [projectKey]: { [task.gid]: task } });
  const clock = context(); h.runtime.init(clock.cx);
  const report = (status, message) => tasksMcpCall(h.runtime, 'report_task', { run: 'run:one', status, message });
  report('doing', 'Investigating login'); h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks()[0].status, 'doing');
  const project = h.state.projects[0]; project.tabs = [{ id: 'work', name: task.name }];
  h.memory['devkits.thread-tasks'] = { work: { gid: task.gid, folder: '/project', name: task.name, source: 'local' } };
  h.state.agents = [{ address: 't1', tab: 'work', app: 'pi', status: 'done', turn: 5 }];
  h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks()[0].status, 'doing', 'Finishing a CLI turn never completes reported work');
  report('waiting', 'Which redirect should expired logins use?'); h.runtime.refresh(clock.cx);
  let card = h.client.listTasks()[0]; assert.equal(card.status, 'doing'); assert.match(card.attention.message, /redirect/);
  assert.equal(card.policy.canDelete, false); assert.equal(card.policy.canArchive, false);
  report('doing', 'User confirmed the login page'); h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks()[0].attention, null);
  report('done', 'Fixed redirect; login tests passed'); h.runtime.refresh(clock.cx);
  card = h.client.listTasks()[0]; assert.equal(card.status, 'done'); assert.equal(card.execution.model, 'saved-model');
  const count = card.activity.length; report('done', 'Fixed redirect; login tests passed'); h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks()[0].activity.length, count, 'A retried final report is idempotent');
  assert.throws(() => report('doing', 'Late reply'), /already finished/);
  h.owner.setTaskArchived(project, card, true);
  assert.throws(() => report('done', 'Changed result'), /no longer active/);
  h.owner.setTaskArchived(project, card, false); h.runtime.refresh(clock.cx);
  assert.equal(h.client.listTasks()[0].status, 'done'); assert.deepEqual(h.native, []);
  assert.throws(() => tasksMcpCall(h.runtime, 'report_task', { run: 'old-run', status: 'done', message: 'Late' }), /no longer active/);
  assert.throws(() => tasksMcpCall(h.runtime, 'report_task', { status: 'done', message: 'No ID' }), /run ID/);
});

test('Board restore never launches a session; due dates and deletion preserve unrelated events and conversations', async () => {
  const key = '["","/project"]', task = { gid: 'local:dates', source: 'local', name: 'Plan', status: 'done', archived: true, archiveId: 'saved' };
  const h = await modules({ [key]: { [task.gid]: task } }), project = h.state.projects[0];
  h.memory['devkits.archived-threads'] = [{ id: 'saved', folder: project.folder, task, boardTask: task, argv: ['claude', '--resume', 'conversation'] }];
  h.memory['devkits.calendar-events'] = { meeting: { title: 'Meeting', taskLink: { id: 'kept' } } };
  h.runtime.agentBoard = { render: (_p, _a, _l, actions) => actions };
  h.runtime.boardPanel(project, context().cx).restore(task);
  assert.equal(h.owner.boardRecords(project)[task.gid].archived, false);
  assert.equal(h.memory['devkits.tasks.navigation'], undefined);
  assert.equal(h.memory['devkits.archived-threads'].length, 1);
  const current = h.owner.projectBoardTasks(project)[0];
  h.owner.setTaskDueDate(project, current, '2028-02-29');
  assert.throws(() => h.owner.setTaskDueDate(project, current, '2026-02-29'), /valid date/);
  assert.equal(h.owner.boardRecords(project)[task.gid].dueDate, '2028-02-29');
  assert.equal(h.owner.deleteLocalTask(project, task.gid), true);
  assert.deepEqual(h.memory['devkits.calendar-events'], { meeting: { title: 'Meeting', taskLink: { id: 'kept' } } });
  assert.equal(h.memory['devkits.archived-threads'][0].boardTask, null);
  assert.equal(h.memory['devkits.archived-threads'][0].argv[2], 'conversation');
  assert.equal(h.owner.projectBoardTasks(project).length, 0);
  assert.equal(h.memory['devkits.deleted-tasks'][key][task.gid].name, 'Plan');
});

test('explicit resume keeps the archive on launch failure and removes it only after a matching native tab appears', async () => {
  const key = '["","/project"]', task = { gid: 'local:resume', source: 'local', name: 'Saved', archived: true, status: 'fail', archiveId: 'archive' };
  const h = await modules({ [key]: { [task.gid]: task } });
  const entry = { id: 'archive', folder: '/project', task, boardTask: task };
  h.memory['devkits.archived-threads'] = [entry];
  h.memory['devkits.pending-profiles'] = [{ key: 'old-profile', folder: '/project', before: [], at: Date.now(), restoreArchiveId: entry.id,
    task: { gid: task.gid, name: task.name, folder: '/project', source: 'local' } }];
  h.runtime.resolveSessions();
  assert.deepEqual(h.memory['devkits.archived-threads'], [entry]);
  assert.equal(h.owner.boardRecords(h.state.projects[0])[task.gid].archived, true);
  h.state.projects[0].tabs = [{ id: 'resumed', name: 'Saved' }];
  h.runtime.resolveSessions();
  assert.deepEqual(h.memory['devkits.archived-threads'], [entry], 'Creating a tab alone does not prove the CLI started');
  h.memory['devkits.pending-resumes'][0].at -= 2001;
  h.state.agents = [{ address: 'resumed-agent', tab: 'resumed', app: 'pi', status: 'idle' }];
  h.runtime.resolveSessions(); h.runtime.refresh(context().cx);
  assert.deepEqual(h.memory['devkits.archived-threads'], []);
  assert.equal(h.memory['devkits.thread-profiles'].resumed, 'old-profile');
  assert.equal(h.memory['devkits.thread-tasks'].resumed.gid, task.gid);
  assert.equal(h.client.listTasks()[0].status, 'fail'); assert.equal(h.client.listTasks()[0].archived, false);
  assert.deepEqual(h.native, []);
});

test('a new local execution receives MCP tool discovery and a unique run while retaining prior profile results', async () => {
  const key = '["","/project"]', task = { gid: 'local:new-run', name: 'Implement login', notes: 'Keep the existing UI.', source: 'local', status: 'todo',
    runs: [{ id: 'old', profile: 'old-profile', status: 'fail', summary: 'Missing test fixture' }] };
  const h = await modules({ [key]: { [task.gid]: task } });
  await h.runtime.startThread({ key: 'codex', name: 'Implementer', run: ['codex'], installed: true },
    { space: 'p', folder: '/project', task }, { model: 'chosen-model', effort: 'high' });
  const saved = h.owner.boardRecords(h.state.projects[0])[task.gid];
  const launch = h.memory['devkits.tasks.navigation'].find(event => event.type === 'launch');
  assert.match(launch.argv.at(-1), /herdr_tasks MCP report_task/);
  assert.ok(!launch.argv.at(-1).includes('tasks-cli.cjs'));
  assert.ok(launch.argv.at(-1).includes(saved.execution.id));
  assert.equal(saved.execution.profileName, 'Implementer'); assert.equal(saved.execution.model, 'chosen-model');
  assert.equal(saved.runs[0].summary, 'Missing test fixture'); assert.deepEqual(h.native, []);
});

test('a resumed tab that exits before its agent starts never consumes the archive', async () => {
  const task = { gid: 'local:failed-start', source: 'local', name: 'Saved', archived: true, status: 'fail' };
  const h = await modules({ '["","/project"]': { [task.gid]: task } });
  const archive = { id: 'saved', folder: '/project', boardTask: task };
  h.memory['devkits.archived-threads'] = [archive];
  h.memory['devkits.pending-resumes'] = [{ id: 'saved', folder: '/project', task, tab: 'exited', at: Date.now() - 3000 }];
  h.runtime.resolveSessions();
  assert.deepEqual(h.memory['devkits.pending-resumes'], []);
  assert.deepEqual(h.memory['devkits.archived-threads'], [archive]);
  assert.equal(h.owner.boardRecords(h.state.projects[0])[task.gid].archived, true);
});

test('task rendering reads one native snapshot and releases it after each frame or error', async () => {
  const project = { folder: '/project' }, thread = { tab: { id: 'thread' } };
  let reads = 0, status = 'doing';
  const client = await evaluateNative('../mods/devkits/components/tasks.js', { ...identity, ...sessions,
    shared(key) {
      assert.equal(key, 'devkits.tasks.snapshot'); reads++;
      return { projects: { [identity.taskProjectKey(project)]: {
        tasks: [{ gid: 'task' }], threads: { thread: { status, task: { archived: false } } },
      } } };
    },
  }, 'withTaskSnapshot, projectBoardTasks, threadBoardStatus, threadVisibleInSidebar');
  client.withTaskSnapshot(() => {
    for (let i = 0; i < 50; i++) {
      assert.equal(client.projectBoardTasks(project).length, 1);
      assert.equal(client.threadBoardStatus(project, thread), 'doing');
      assert.equal(client.threadVisibleInSidebar(project, thread), true);
    }
  });
  assert.equal(reads, 1, 'All rows share a single deserialization');
  status = 'done';
  assert.throws(() => client.withTaskSnapshot(() => {
    assert.equal(client.threadBoardStatus(project, thread), 'done');
    throw new Error('render failed');
  }), /render failed/);
  status = 'todo';
  assert.equal(client.threadBoardStatus(project, thread), 'todo', 'Callbacks read fresh state after a failed render');
  assert.equal(reads, 3);
});

test('a frame refreshes task groups even when a native interruption left an empty snapshot behind', async () => {
  const project = { folder: '/project' }, thread = { tab: { id: 'thread' } };
  const client = await evaluateNative('../mods/devkits/components/tasks.js', { ...identity, ...sessions,
    shared: () => ({ projects: { [identity.taskProjectKey(project)]: { threads: { thread: { status: 'done' } } } } }),
  }, 'withTaskSnapshot, threadBoardStatus, interrupt: () => { renderSnapshot = { projects: {} }; }');
  // Simulate the state left when native execution is terminated before JS cleanup.
  client.interrupt();
  client.withTaskSnapshot(() => assert.equal(client.threadBoardStatus(project, thread), 'done'));
});

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
    'projectBoardTasks, boardRecords, taskLinkForTab, threadBoardStatus, threadBoardTask, sessionThreadTitle, rememberBoardTask, setTaskArchived, setTaskDueDate, deleteLocalTask, createLocalTask'));
  Object.assign(owner, await evaluateNative('../mods/devkits/components/source-channel.js', owner,
    'createSourceChannel, sourceChannels, consumeSourceEvents, closeSourceChannel'));
  Object.assign(owner, await evaluateNative('../mods/devkits-tasks/task-sources.js', owner, 'TaskSources'));
  Object.assign(owner, await evaluateNative('../mods/devkits-tasks/task-prompt.js', owner, 'taskPrompt'));
  owner.AgentClient = class {
    init() {} close() {} discover() { return Promise.resolve([]); }
    async prepare(agent, target, options) {
      const { prepareSession } = await evaluateNative('../mods/devkits-agents/session-preparation.js', {
        ...owner, sessionRules: async () => { const text = await owner.readTextFile('/herdr/data/devkits/AGENTS.md'); return text?.trim() ? { file: '/herdr/data/devkits/AGENTS.md', text } : null; },
      }, 'prepareSession');
      return prepareSession(agent, target, options);
    }
  };
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
  assert.equal(h.client.threadBoardStatus(project, { tab: { id: 'thread' } }), 'todo');
  h.runtime.reportTask(null, { terminal: 't1', status: 'doing', message: 'Starting the submitted work' }); h.runtime.refresh(clock.cx);
  assert.equal(h.client.threadBoardStatus(project, { tab: { id: 'thread' } }), 'doing');
  assert.equal(h.client.threadBoardStatus(project, { tab: { id: 'shell' } }), null);
  assert.equal(h.client.listTasks().find(task => task.gid === 'thread:thread').status, 'doing');
  assert.equal(h.client.projectBoardTasks(project).find(task => task.gid === 'local').policy.canStart, true);
  const count = h.writes.length; h.client.projectBoardTasks(project); h.client.listTasks(); h.client.threadBoardTask(project, { tab: { id: 'thread' } });
  assert.equal(h.writes.length, count, 'Consumers never reconcile or write task state');
  h.state.agents[0] = { ...h.state.agents[0], status: 'done', seq: 2, turn: 1 }; h.runtime.refresh(clock.cx);
  assert.equal(h.client.threadBoardStatus(project, { tab: { id: 'thread' } }), 'doing');
  h.runtime.reportTask(null, { terminal: 't1', status: 'done', message: 'Completed with validation' }); h.runtime.refresh(clock.cx);
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
  let finish, started; const reading = new Promise(resolve => { started = resolve; });
  h.owner.readTextFile = () => new Promise(resolve => { finish = resolve; started(); });
  // A fresh provider context binds the delayed native file reader.
  const { TaskRuntime } = await evaluateNative('../mods/devkits-tasks/runtime.js', h.owner, 'TaskRuntime');
  const service = new TaskRuntime(), clock = context(); service.init(clock.cx);
  h.client.requestTaskStart({ key: 'codex', name: 'Codex', run: ['codex'] }, { folder: '/project', space: 'p', task: { gid: 'one' } });
  service.poll(clock.cx); await reading; assert.equal(typeof finish, 'function');
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
  const { TasksMod } = await evaluateNative('../mods/devkits-tasks/main.js', { ...h.base, View: class {}, TaskRuntime: class { agentClient = { init() {}, close() {} }; taskAssignees() { return []; } },
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
  assert.equal(tasks.length, 1); assert.equal(tasks[0].gid, 'one'); assert.equal(tasks[0].status, 'todo');
});
