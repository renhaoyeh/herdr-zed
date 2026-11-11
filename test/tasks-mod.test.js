import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sessions from '../components/session-model.js';
import * as identity from '../components/tasks-model.js';
import * as policy from '../mods/herdr-zed-tasks/agent-board-model.js';
import { evaluateNative } from './source-harness.js';
import { tasksMcpCall } from '../mods/herdr-zed-tasks/mcp-api.js';
import { readFile } from 'node:fs/promises';
import { parseExtensionManifest, extensionMetadata } from '../mods/herdr-zed/extension-model.js';

test('the Tasks and Calendar manifests parse with the shell model: importer, decorator, popup board and Calendar requirement', async () => {
  const read = mod => readFile(new URL(`../mods/${mod}/extension.json`, import.meta.url), 'utf8');
  const tasks = await read('herdr-zed-tasks'), calendar = await read('herdr-zed-calendar');
  const tasksActions = parseExtensionManifest('herdr-zed-tasks', tasks);
  assert.deepEqual(tasksActions.map(action => [action.id, action.location, action.popup.view, action.popup.modal]),
    [['tasks.open', 'status.right', 'board', false]]);
  const tasksMeta = extensionMetadata('herdr-zed-tasks', tasks);
  assert.deepEqual(tasksMeta.provides, { importer: { accepts: ['task-snapshot'], view: 'import-draft' }, threadDecorator: { fields: ['subtitle', 'tone'] } });
  assert.deepEqual(tasksMeta.services, [{ view: 'service' }]); assert.deepEqual(tasksMeta.requires, []);
  const calendarActions = parseExtensionManifest('herdr-zed-calendar', calendar);
  assert.deepEqual(calendarActions.map(action => [action.id, action.location, action.popup.view]), [['calendar.open', 'status.right', 'calendar']]);
  assert.deepEqual(extensionMetadata('herdr-zed-calendar', calendar).requires, ['tasks']);
  // Calendar reads the Tasks read model only; it never declares a provider contract of its own.
  assert.deepEqual(extensionMetadata('herdr-zed-calendar', calendar).provides, {});
});

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
  h.memory['herdr-zed.thread-profiles'] = { chat: 'codex' };
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
  h.memory['herdr-zed.thread-tasks'] = { work: { gid: task.gid, folder: '/project', name: task.name, source: 'local' } };
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
  h.memory['herdr-zed.archived-threads'] = [{ id: 'saved', folder: project.folder, task, boardTask: task, argv: ['claude', '--resume', 'conversation'] }];
  h.memory['herdr-zed.calendar-events'] = { meeting: { title: 'Meeting', taskLink: { id: 'kept' } } };
  h.runtime.agentBoard = { render: (_p, _a, _l, actions) => actions };
  h.runtime.boardPanel(project, context().cx).restore(task);
  assert.equal(h.owner.boardRecords(project)[task.gid].archived, false);
  assert.deepEqual(h.launches, []);
  assert.equal(h.memory['herdr-zed.archived-threads'].length, 1);
  const current = h.owner.projectBoardTasks(project)[0];
  h.owner.setTaskDueDate(project, current, '2028-02-29');
  assert.throws(() => h.owner.setTaskDueDate(project, current, '2026-02-29'), /valid date/);
  assert.equal(h.owner.boardRecords(project)[task.gid].dueDate, '2028-02-29');
  assert.equal(h.owner.deleteLocalTask(project, task.gid), true);
  assert.deepEqual(h.memory['herdr-zed.calendar-events'], { meeting: { title: 'Meeting', taskLink: { id: 'kept' } } });
  assert.equal(h.memory['herdr-zed.archived-threads'][0].boardTask, null);
  assert.equal(h.memory['herdr-zed.archived-threads'][0].argv[2], 'conversation');
  assert.equal(h.owner.projectBoardTasks(project).length, 0);
  assert.equal(h.memory['herdr-zed.deleted-tasks'][key][task.gid].name, 'Plan');
});

test('explicit resume keeps the archive on launch failure and removes it only after a matching native tab appears', async () => {
  const key = '["","/project"]', task = { gid: 'local:resume', source: 'local', name: 'Saved', archived: true, status: 'fail', archiveId: 'archive' };
  const h = await modules({ [key]: { [task.gid]: task } });
  const entry = { id: 'archive', folder: '/project', task, boardTask: task };
  h.memory['herdr-zed.archived-threads'] = [entry];
  h.memory['herdr-zed.pending-profiles'] = [{ key: 'old-profile', folder: '/project', before: [], at: Date.now(), restoreArchiveId: entry.id,
    task: { gid: task.gid, name: task.name, folder: '/project', source: 'local' } }];
  h.runtime.resolveSessions();
  assert.deepEqual(h.memory['herdr-zed.archived-threads'], [entry]);
  assert.equal(h.owner.boardRecords(h.state.projects[0])[task.gid].archived, true);
  h.state.projects[0].tabs = [{ id: 'resumed', name: 'Saved' }];
  h.runtime.resolveSessions();
  assert.deepEqual(h.memory['herdr-zed.archived-threads'], [entry], 'Creating a tab alone does not prove the CLI started');
  h.memory['herdr-zed.pending-resumes'][0].at -= 2001;
  h.state.agents = [{ address: 'resumed-agent', tab: 'resumed', app: 'pi', status: 'idle' }];
  h.runtime.resolveSessions(); h.runtime.refresh(context().cx);
  assert.deepEqual(h.memory['herdr-zed.archived-threads'], []);
  assert.equal(h.memory['herdr-zed.thread-profiles'].resumed, 'old-profile');
  assert.equal(h.memory['herdr-zed.thread-tasks'].resumed.gid, task.gid);
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
  assert.equal(h.launches.length, 1);
  const { agent, options, target } = h.launches[0];
  assert.equal(agent.key, 'codex'); assert.equal(target.task.gid, task.gid);
  // Agents forwards the prompt and run ID to prepare; Tasks owns the origin link on the launch request.
  assert.match(options.prompt, /herdr_tasks MCP report_task/);
  assert.ok(options.prompt.includes(saved.execution.id));
  assert.deepEqual(options.origin, { extension: 'tasks', ref: task.gid });
  assert.equal(options.model, 'chosen-model'); assert.equal(options.effort, 'high');
  // The record keeps what prepare decided, not what was requested.
  assert.equal(saved.execution.profileName, 'Implementer');
  assert.equal(saved.execution.model, 'prepared-model'); assert.equal(saved.execution.effort, 'low');
  assert.equal(saved.execution.profile, 'prepared-profile');
  assert.equal(saved.runs[0].summary, 'Missing test fixture'); assert.deepEqual(h.native, []);
});

test('a refused launch restores the task and rethrows so the board can show the error inline', async () => {
  const task = { gid: 'local:refused', name: 'Refuse me', source: 'local', status: 'todo' };
  const h = await modules({ '["","/project"]': { [task.gid]: task } });
  h.owner.launchError = new Error('Agents service is unavailable in this layout.');
  await assert.rejects(h.runtime.startThread({ key: 'codex', name: 'Codex', run: ['codex'] },
    { space: 'p', folder: '/project', task }, {}), /Agents service is unavailable/);
  const saved = h.owner.boardRecords(h.state.projects[0])[task.gid];
  assert.equal(saved.execution, null); assert.equal(saved.status, 'todo'); assert.equal(saved.agentKey, null);
  assert.equal(h.launches.length, 1); assert.deepEqual(h.native, []);
});

test('a resumed tab that exits before its agent starts never consumes the archive', async () => {
  const task = { gid: 'local:failed-start', source: 'local', name: 'Saved', archived: true, status: 'fail' };
  const h = await modules({ '["","/project"]': { [task.gid]: task } });
  const archive = { id: 'saved', folder: '/project', boardTask: task };
  h.memory['herdr-zed.archived-threads'] = [archive];
  h.memory['herdr-zed.pending-resumes'] = [{ id: 'saved', folder: '/project', task, tab: 'exited', at: Date.now() - 3000 }];
  h.runtime.resolveSessions();
  assert.deepEqual(h.memory['herdr-zed.pending-resumes'], []);
  assert.deepEqual(h.memory['herdr-zed.archived-threads'], [archive]);
  assert.equal(h.owner.boardRecords(h.state.projects[0])[task.gid].archived, true);
});

test('task rendering reads one native snapshot and releases it after each frame or error', async () => {
  const project = { folder: '/project' }, thread = { tab: { id: 'thread' } };
  let reads = 0, status = 'doing';
  const client = await evaluateNative('../components/tasks.js', { ...identity, ...sessions,
    shared(key) {
      assert.equal(key, 'herdr-zed.tasks.snapshot'); reads++;
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
  const client = await evaluateNative('../components/tasks.js', { ...identity, ...sessions,
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
  assert.equal(h.memory['herdr-zed.agent-board'][project][parent.gid].notes, '說明');
  assert.throws(() => tasksMcpCall(h.runtime, 'create_task', { project, name: 'Invalid child', parentId: 'missing' }), /parent task/);
  h.owner.setTaskArchived(h.state.projects[0], parent, true);
  assert.throws(() => tasksMcpCall(h.runtime, 'create_task', { project, name: 'Invalid child', parentId: parent.gid }), /parent task/);
  assert.equal(h.memory['herdr-zed.tasks.navigation'], undefined);
  assert.deepEqual(h.native, []);
});
async function modules(records = {}, projects = [{ id: 'p', folder: '/project', name: 'Project', active: true, tabs: [] }]) {
  const memory = { 'herdr-zed.agent-board': clone(records), 'herdr-zed.agent-cache': { null: [] } }, writes = [], overlays = [], native = [], closed = [];
  const state = { projects, agents: [] };
  const base = { ...sessions, ...identity,
    sessionDevkits: async () => '',
    sessionMcpArgv: async (_agent, argv) => argv,
    prepareEcc: async (_agent, argv) => ({ argv, instructions: '' }),
    globalThis: { window: { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } } },
    shared: key => clone(memory[key]), setShared: (key, value) => { memory[key] = clone(value); writes.push(key); },
    agents: () => state.agents, spaces: () => state.projects, terminals: () => [], appHome: () => '/herdr', home: () => '/home',
    props: () => ({ overlay: 'calendar' }), knownAgents: async () => [], readTextFile: async () => null,
    exec: async (...args) => { native.push(args); return { code: 0, stdout: '{}' }; },
    notify: message => assert.fail(message.body), openOverlay: spec => overlays.push(spec), closeOverlay: id => closed.push(id),
  };
  const client = await evaluateNative('../components/tasks.js', base,
    'tasksSnapshot, listTasks, projectBoardTasks, boardRecords, taskLinkForTab, threadBoardStatus, threadBoardTask, threadTaskArchived, threadVisibleInSidebar, taskActions, sessionThreadTitle, openTaskBoard');
  const owner = { ...base, ...policy, ...client };
  // Policy and mutations are loaded only into the Tasks context, never into the consumer context.
  Object.assign(owner, policy);
  Object.assign(owner, await evaluateNative('../mods/herdr-zed-tasks/agent-task-evidence.js', owner, 'observeTaskInput, withTaskInputEvidence'));
  Object.assign(owner, await evaluateNative('../mods/herdr-zed-tasks/agent-board-state.js', owner,
    'projectBoardTasks, boardRecords, taskLinkForTab, threadBoardStatus, threadBoardTask, sessionThreadTitle, rememberBoardTask, setTaskArchived, setTaskDueDate, deleteLocalTask, createLocalTask'));
  Object.assign(owner, await evaluateNative('../components/source-channel.js', owner,
    'createSourceChannel, sourceChannels, consumeSourceEvents, closeSourceChannel'));
  Object.assign(owner, await evaluateNative('../mods/herdr-zed-tasks/task-sources.js', owner, 'TaskSources, resolveTaskImport, findProject, installedSources'));
  Object.assign(owner, await evaluateNative('../mods/herdr-zed-tasks/task-prompt.js', owner, 'taskPrompt'));
  // Stand-in for the Agents public client: records each launch and resolves with the prepare metadata it chose.
  const launches = [];
  owner.AgentClient = class {
    init() {} close() {} discover() { return Promise.resolve([]); }
    launch(agent, target, options) {
      launches.push({ agent, target, options });
      if (owner.launchError) return Promise.reject(owner.launchError);
      return Promise.resolve(owner.launchResult);
    }
  };
  owner.launchResult = { model: 'prepared-model', effort: 'low', profile: 'prepared-profile' };
  const { TaskRuntime } = await evaluateNative('../mods/herdr-zed-tasks/runtime.js', owner, 'TaskRuntime');
  const runtime = new TaskRuntime();
  return { base, owner, client, runtime, state, memory, writes, overlays, closed, native, launches };
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

test('Calendar reads the public Tasks index and opens the Tasks board popup for the selected task', async () => {
  const projects = [{ id: 'a', name: 'A', folder: '/a', tabs: [] }, { id: 'b', name: 'B', folder: '/b', tabs: [] }];
  const h = await modules({ '["","/a"]': { same: { gid: 'same', name: 'Same name', source: 'local', status: 'todo' } },
    '["","/b"]': { same: { gid: 'same', name: 'Same name', source: 'local', status: 'done', archived: true } } }, projects);
  const clock = context(); h.runtime.init(clock.cx);
  class Calendar { constructor(options) { this.options = options; } init() {} close() {} }
  const { CalendarMod } = await evaluateNative('../mods/herdr-zed-calendar/main.js', { ...h.base, ...h.client, View: class {}, LocalCalendar: Calendar }, 'CalendarMod');
  const calendar = new CalendarMod(); calendar.init(null, context().cx);
  const tasks = calendar.calendar.options.tasks(); assert.equal(tasks.length, 2); assert.notEqual(tasks[0].id, tasks[1].id);
  const selected = tasks.find(task => task.project.id === 'b');
  assert.equal(calendar.calendar.options.openTask(selected.id), true, 'Calendar closes itself only when the board has opened');
  assert.deepEqual(h.overlays.at(-1), { mod: 'herdr-zed-tasks', kind: 'dialog', frame: 'none', modal: false, width: 0.9, height: 0.86,
    props: { view: 'board', context: selected.project, focus: 'same' } });
  assert.equal(calendar.calendar.options.openTask('missing'), false);
  assert.deepEqual(h.closed, []); assert.deepEqual(h.native, []);
});

test('Calendar refuses a task that left the Tasks read model and opens nothing', async () => {
  const h = await modules({ '["","/project"]': { one: { gid: 'one', name: 'Task', source: 'local', status: 'todo' } } });
  const clock = context(); h.runtime.init(clock.cx);
  class Calendar { constructor(options) { this.options = options; } init() {} close() {} }
  const { CalendarMod } = await evaluateNative('../mods/herdr-zed-calendar/main.js', { ...h.base, ...h.client, View: class {}, LocalCalendar: Calendar }, 'CalendarMod');
  const calendar = new CalendarMod(); calendar.init(null, context().cx);
  const task = h.client.listTasks()[0], opened = h.overlays.length;
  assert.equal(calendar.calendar.options.openTask(task.id), true);
  assert.equal(h.owner.deleteLocalTask(h.state.projects[0], 'one', []), true);
  h.runtime.refresh(clock.cx);
  assert.equal(calendar.calendar.options.openTask(task.id), false);
  assert.equal(h.overlays.length, opened + 1, 'Only the first, valid request opened the board');
});

test('a task that is deleted or unknown never reaches the Agents launch', async () => {
  const h = await modules({ '["","/project"]': { one: { gid: 'one', name: 'Task', source: 'local', status: 'todo' } } });
  const clock = context(); h.runtime.init(clock.cx);
  const target = { space: 'p', folder: '/project' };
  assert.equal(h.owner.deleteLocalTask(h.state.projects[0], 'one', []), true);
  await assert.rejects(h.runtime.startThread({ key: 'codex', name: 'Codex', run: ['codex'] }, { ...target, task: { gid: 'one' } }), /no longer available/);
  await assert.rejects(h.runtime.startThread({ key: 'codex', run: ['codex'] }, { ...target, task: { gid: 'missing' } }), /no longer available/);
  assert.deepEqual(h.launches, []); assert.deepEqual(h.native, []);
});

test('a launched conversation binds to its task through the shell read model origin and records its profile', async () => {
  const task = { gid: 'local:bound', name: 'Bound task', source: 'local', status: 'todo' };
  const h = await modules({ '["","/project"]': { [task.gid]: task } });
  h.state.projects[0].tabs = [{ id: 'new-tab', name: 'Codex' }];
  h.memory['herdr-zed.threads'] = { 'new-tab': { profile: 'codex', source: 'tasks', origin: { extension: 'tasks', ref: task.gid } },
    other: { profile: 'claude', source: 'herdr', origin: undefined } };
  const clock = context(); h.runtime.init(clock.cx);
  assert.deepEqual(h.memory['herdr-zed.thread-tasks']['new-tab'], { gid: task.gid, name: task.name, folder: '/project', source: 'local' });
  assert.equal(h.memory['herdr-zed.thread-profiles']['new-tab'], 'codex');
  assert.equal(h.memory['herdr-zed.thread-tasks'].other, undefined, 'Threads without a Tasks origin are never linked');
});

test('the Tasks decoration names each linked thread once, and republishes only when its projection changes', async () => {
  const long = 'A very long task title that certainly exceeds the forty character decoration limit';
  const task = { gid: 'local:deco', name: long, source: 'local', status: 'todo' };
  const h = await modules({ '["","/project"]': { [task.gid]: task } });
  h.state.projects[0].tabs = [{ id: 'linked', name: 'Run' }, { id: 'free', name: 'Scratch' }];
  h.state.agents = [{ address: 't1', space: 'p', tab: 'linked', app: 'pi', status: 'working', seq: 1 }];
  h.memory['herdr-zed.thread-tasks'] = { linked: { gid: task.gid, name: long, folder: '/project', source: 'local' } };
  const clock = context(); h.runtime.init(clock.cx);
  const decorations = h.memory['herdr-zed.decorations.tasks'];
  assert.deepEqual(Object.keys(decorations.threads), ['linked'], 'Only tabs linked to tasks are decorated');
  const entry = decorations.threads.linked;
  assert.ok(entry.subtitle.length <= 40); assert.match(entry.subtitle, /^A very long task title/);
  assert.ok(['muted', 'accent', 'warning', 'error'].includes(entry.tone));
  const writes = h.writes.filter(key => key === 'herdr-zed.decorations.tasks').length;
  h.runtime.refresh(clock.cx);
  assert.equal(h.writes.filter(key => key === 'herdr-zed.decorations.tasks').length, writes, 'An unchanged projection is not republished');
  h.memory['herdr-zed.thread-tasks'] = { linked: { gid: task.gid, name: 'Renamed task', folder: '/project', source: 'local' } };
  h.runtime.refresh(clock.cx);
  assert.equal(h.writes.filter(key => key === 'herdr-zed.decorations.tasks').length, writes + 1, 'A changed projection is published once');
  assert.equal(h.memory['herdr-zed.decorations.tasks'].threads.linked.subtitle, 'Renamed task');
  assert.equal(h.memory['herdr-zed.decorations.tasks'].threads.free, undefined);
});

test('closing the independent Tasks composer preserves its project-scoped unsaved draft', async () => {
  const h = await modules(), clock = context();
  Object.assign(h.owner, { InputState: input, TextareaState: input, SelectState: class {}, liveAgents: () => [] });
  const { TaskComposer } = await evaluateNative('../mods/herdr-zed-tasks/task-composer.js', h.owner, 'TaskComposer');
  const target = { view: 'task-composer', project: h.state.projects[0], overlay: 'draft' };
  const { TasksMod } = await evaluateNative('../mods/herdr-zed-tasks/main.js', { ...h.base, View: class {}, TaskRuntime: class { agentClient = { init() {}, close() {} }; taskAssignees() { return []; } },
    TaskComposer, props: () => target }, 'TasksMod');
  const view = new TasksMod(); view.init(null, clock.cx); view.composer.title.set_value('Unfinished'); view.close();
  assert.equal(h.memory['herdr-zed.task-drafts']['["","/project"]'].name, 'Unfinished');
  assert.equal(h.memory['herdr-zed.agent-board']['["","/project"]'], undefined);
});

test('an integration import reopens as a revalidated Tasks draft; a stale or foreign snapshot never reaches the composer', async () => {
  const h = await modules(), clock = context();
  class Composer { init(options) { this.options = options; } render() { return 'composer'; } }
  const snapshot = { source: 'asana', gid: '42', name: 'Imported', notes: 'Body' };
  const load = async target => {
    const { TasksMod } = await evaluateNative('../mods/herdr-zed-tasks/main.js', { ...h.base, View: class {}, TaskRuntime: function TaskRuntime() { return h.runtime; },
      TaskComposer: Composer, TasksMcpBridge: class {}, AgentBoard: class {}, DeleteTask: class {}, props: () => target }, 'TasksMod');
    const view = new TasksMod(); view.init(null, clock.cx); return view;
  };
  const valid = await load({ view: 'import-draft', kind: 'task-snapshot', source: 'asana', context: { machine: null, folder: '/project', name: 'Project' }, snapshot, overlay: 'import' });
  assert.equal(valid.composer.options.project.id, 'p'); assert.deepEqual(valid.composer.options.importTask, snapshot);
  assert.equal(valid.composer.options.task, null); assert.equal(valid.composer.options.overlay, 'import');
  assert.equal(h.memory['herdr-zed.task-drafts'], undefined, 'Opening the draft creates nothing until confirmation');
  const stale = await load({ view: 'import-draft', kind: 'task-snapshot', source: 'asana', context: { folder: '/project' }, snapshot: { ...snapshot, source: 'mantisbt' }, overlay: 'import' });
  assert.equal(stale.composer, undefined); assert.match(stale.importError, /no longer valid/);
  const foreign = await load({ view: 'import-draft', kind: 'task-snapshot', source: 'asana', context: { folder: '/elsewhere' }, snapshot, overlay: 'import' });
  assert.equal(foreign.composer, undefined); assert.match(foreign.importError, /no longer open/);
  const unknown = await load({ view: 'import-draft', kind: 'task-snapshot', source: 'jira', context: { folder: '/project' }, snapshot, overlay: 'import' });
  assert.match(unknown.importError, /Unknown import source/);
  const wrongKind = await load({ view: 'import-draft', kind: 'other', source: 'asana', context: { folder: '/project' }, snapshot, overlay: 'import' });
  assert.match(wrongKind.importError, /Unsupported import kind/);
  assert.deepEqual(h.native, []);
});

test('Tasks resolves native session handoffs before projecting their task and thread relationship', async () => {
  const h = await modules({ '["","/project"]': { one: { gid: 'one', name: 'Task', source: 'local', status: 'todo' } } });
  h.state.projects[0].tabs = [{ id: 'tab', name: 'Task' }];
  h.state.agents = [{ address: 't1', tab: 'tab', space: 'p', app: 'pi', status: 'working' }];
  const task = { gid: 'one', name: 'Task', folder: '/project', source: 'local' };
  h.memory['herdr-zed.pending-profiles'] = [{ key: 'codex', space: 'p', folder: '/project', before: [], at: Date.now(), task }];
  h.runtime.init(context().cx);
  assert.deepEqual(h.memory['herdr-zed.pending-profiles'], []);
  assert.equal(h.memory['herdr-zed.thread-profiles'].tab, 'codex');
  assert.deepEqual(h.client.taskLinkForTab('tab', h.state.projects[0]), task);
  const tasks = h.client.projectBoardTasks(h.state.projects[0]);
  assert.equal(tasks.length, 1); assert.equal(tasks[0].gid, 'one'); assert.equal(tasks[0].status, 'todo');
});


test('Restore conversation is not started by Tasks: the board shows an inline error and no run or archive changes', async () => {
  const key = '["","/project"]', task = { gid: 'thread:closed', source: 'thread', name: 'Closed work', status: 'done',
    conversation: { id: 'codex:exact-session', profile: 'work', argv: ['env', 'CODEX_HOME=/work', 'codex', 'resume', '--no-daemon', 'exact-session'] } };
  const h = await modules({ [key]: { [task.gid]: task } }), project = h.state.projects[0];
  const shown = {};
  h.runtime.agentBoard = { render: (_p, _a, _l, actions) => actions, setTaskError: (gid, message) => { shown.gid = gid; shown.message = message; } };
  const actions = h.runtime.boardPanel(project, context().cx);
  actions.resume(task);
  assert.deepEqual(shown, { gid: task.gid, message: 'Restore conversation is not available from Tasks yet. Use the thread history.' });
  assert.equal(h.memory['herdr-zed.archived-threads'], undefined);
  assert.equal(h.owner.boardRecords(project)[task.gid].status, 'done');
  assert.deepEqual(h.launches, []); assert.deepEqual(h.native, []);
});

test('Import from offers only enabled source browsers that loaded without error', async () => {
  const h = await modules();
  const catalog = (packages, unavailable = []) => ({ packages, resolved: { unavailable: unavailable.map(mod => ({ mod })) } });
  assert.deepEqual(h.owner.installedSources(null), []);
  assert.deepEqual(h.owner.installedSources(catalog([
    { mod: 'herdr-zed-asana', enabled: true }, { mod: 'herdr-zed-mantisbt', enabled: false },
  ])), [{ key: 'asana', label: 'Asana' }]);
  assert.deepEqual(h.owner.installedSources(catalog([
    { mod: 'herdr-zed-asana', enabled: true, error: 'bad manifest' }, { mod: 'herdr-zed-mantisbt', enabled: true },
  ])), [{ key: 'mantisbt', label: 'MantisBT' }]);
  assert.deepEqual(h.owner.installedSources(catalog([
    { mod: 'herdr-zed-asana', enabled: true }, { mod: 'herdr-zed-mantisbt', enabled: true },
  ], ['herdr-zed-mantisbt'])), [{ key: 'asana', label: 'Asana' }]);
  assert.deepEqual(h.owner.installedSources(catalog([{ mod: 'herdr-zed-simulator', enabled: true }])), []);
});

test('Import from opens the chosen source browser for the board project through the existing source channel', async () => {
  const h = await modules();
  const project = h.state.projects[0];
  h.runtime.agentBoard = { render: (_p, _a, _l, actions) => actions };
  const actions = h.runtime.boardPanel(project, context().cx);
  actions.importSource('mantisbt');
  const overlay = h.overlays.at(-1);
  assert.equal(overlay.mod, 'herdr-zed-mantisbt');
  assert.equal(overlay.props.importLabel, 'Import into Tasks');
  assert.equal(overlay.props.context.folder, '/project');
  assert.equal(overlay.props.stateKey, 'herdr-zed.mantisbt');
});

test('the board header has a Close Tasks control bound to its own overlay, and Import from only appears with sources', async () => {
  const source = await readFile(new URL('../mods/herdr-zed-tasks/agent-board.js', import.meta.url), 'utf8');
  assert.match(source, /button\('board-close', t, \{ size: 'icon' \}\)\.accessibility_label\('Close Tasks'\)\s*\.on_click\(\(\) => closeOverlay\(props\(\)\.overlay\)\)/);
  assert.match(source, /\.when\(sources\.length > 0, el => el\.child\(DropdownMenu\('board-import-menu'/);
});
