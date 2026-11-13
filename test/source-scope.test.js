import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

const a = { folder: '/app', name: 'App' }, b = { folder: '/site', name: 'Site' };
const bindingKey = project => JSON.stringify([project.machine || '', project.folder]);
async function harness({ key = 'asana', projects = [a, b], bindings, overrides = {} } = {}) {
  const memory = { [`scope.all-projects.${key}`]: true, bindings: bindings || {
    [bindingKey(a)]: { [key]: { gid: 'p1', workspace: 'w' }, mantisbt: { gid: 'not-asana' } },
    [bindingKey(b)]: { [key]: { gid: 'p2', workspace: 'w' } },
  } }, calls = [];
  const source = { key, name: key, fields: [{ id: 'section', name: 'Status', list: true }],
    projectWorkspace: async () => 'w',
    projectTasksPage: async (_credentials, project, cursor) => { calls.push({ project, cursor }); return { tasks: [{ gid: project, name: project, section: 'Custom status' }], next: null }; },
    myProjectTasks: async (_credentials, project) => [{ gid: project, name: project }],
    projectFields: async () => [], taskDetails: async (_credentials, gid, project) => { calls.push({ detail: gid, project }); return { gid, name: 'Details', section: 'Original status' }; },
    ...overrides };
  const { SourceScope } = await evaluateNative('../components/source-scope.js', { shared: key => memory[key], folderKey: value => value }, 'SourceScope');
  const target = { sourceHub: { stateKey: 'scope', bindingsKey: 'bindings' } };
  const scope = new SourceScope(source, target, () => projects);
  const options = scope.options({ getBinding: () => ({ gid: 'current' }), setBinding: () => assert.fail('aggregate bindings must never be written') });
  return { scope, options, source, memory, calls };
}

test('scope uses only its provider bindings, preserves raw statuses, and returns to the original project adapter', async () => {
  const h = await harness();
  assert.equal(h.scope.links().length, 2);
  assert.ok(h.options.getBinding().gid.startsWith('all-projects:'));
  h.options.setBinding('/all', { gid: 'do-not-save' });
  const page = await h.scope.source.projectTasksPage('token', h.options.getBinding().gid);
  assert.deepEqual(page.tasks.map(task => [task.gid, task.section, task.herdrProject]), [['p1', 'Custom status', 'App'], ['p2', 'Custom status', 'Site']]);
  assert.ok(h.scope.source.fields.some(field => field.id === 'herdrProject'));
  h.memory['scope.all-projects.asana'] = false;
  assert.equal(h.options.getBinding().gid, 'current');
  assert.deepEqual(h.scope.source.fields, h.source.fields);
  assert.equal(h.scope.context(a), a);
  await h.scope.source.projectTasksPage('token', 'current', 'c');
  assert.deepEqual(h.calls.at(-1), { project: 'current', cursor: 'c' });
});

test('same-source aggregation deduplicates remote projects and tasks, carries project labels and routes details to the original project', async () => {
  const c = { folder: '/copy', name: 'Copy' };
  const h = await harness({ projects: [a, b, c], bindings: {
    [bindingKey(a)]: { asana: { gid: 'p1' } }, [bindingKey(b)]: { asana: { gid: 'p2' } }, [bindingKey(c)]: { asana: { gid: 'p1' } },
  }, overrides: { projectTasksPage: async (_credentials, project, cursor) => ({
    tasks: [{ gid: cursor ? 'next' : 'shared', name: 'Task', section: project === 'p1' ? 'First section' : 'Second section' }],
    next: project === 'p1' && !cursor ? 'page-2' : null,
  }) } });
  assert.equal(h.scope.targets().length, 2);
  const first = await h.scope.page('token');
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0].herdrProject, 'App, Copy, Site');
  assert.equal(first.tasks[0].section, 'First section');
  const second = await h.scope.page('token', first.next);
  assert.deepEqual(second.tasks.map(task => task.gid), ['next']); assert.equal(second.next, null);
  const detail = await h.scope.source.taskDetails('token', 'shared', h.options.getBinding().gid);
  assert.equal(h.calls.at(-1).project, 'p1'); assert.equal(detail.herdrProject, 'App, Copy, Site');
  assert.equal(detail.section, 'Original status');
});

test('partial failures retain successful rows without putting failed pages into an endless pagination loop', async () => {
  const h = await harness({ overrides: { projectTasksPage: async (_credentials, project) => {
    if (project === 'p2') throw new Error('Forbidden');
    return { tasks: [{ gid: 'ok', name: 'Visible task' }], next: null };
  } } });
  const page = await h.scope.page('token');
  assert.equal(page.tasks[0].gid, 'ok'); assert.equal(page.next, null);
  assert.deepEqual([...h.scope.errors.values()], ['Site: Forbidden']);
});

test('MantisBT aggregation rejects a linked server mismatch before any request for that project', async () => {
  const requested = [];
  const h = await harness({ key: 'mantisbt', bindings: {
    [bindingKey(a)]: { mantisbt: { gid: 'one', server: 'https://current.test' } },
    [bindingKey(b)]: { mantisbt: { gid: 'two', server: 'https://other.test' } },
  }, overrides: { server: true, normalizeUrl: value => value,
    projectTasksPage: async (_credentials, project) => { requested.push(project); return { tasks: [{ gid: '1', name: 'Issue' }], next: null }; } } });
  const page = await h.scope.page({ url: 'https://current.test', token: 'private' });
  assert.deepEqual(requested, ['one']); assert.equal(page.tasks.length, 1);
  assert.match([...h.scope.errors.values()][0], /Site:.*server/);
});

test('all scope requests share a three-request limit across lists, Mine and custom fields', async () => {
  let active = 0, maximum = 0;
  const work = async value => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--; return value;
  };
  const projects = Array.from({ length: 6 }, (_, index) => ({ folder: `/p${index}`, name: `P${index}` }));
  const h = await harness({ projects, bindings: Object.fromEntries(projects.map((project, index) =>
    [bindingKey(project), { asana: { gid: String(index), workspace: 'w' } }])), overrides: {
    projectTasksPage: () => work({ tasks: [], next: null }), myProjectTasks: () => work([]), projectFields: () => work([]),
  } });
  await Promise.all([h.scope.page('token'), h.scope.mine('token'), h.scope.fields('token')]);
  assert.equal(maximum, 3); assert.equal(h.scope.active, 0);
});

test('closing a source or changing its scope discards late responses', async () => {
  let finish;
  const h = await harness({ projects: [a], overrides: { projectTasksPage: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = h.scope.page('token');
  h.scope.close(); finish({ tasks: [{ gid: 'late', name: 'Late task' }], next: null });
  assert.deepEqual((await pending).tasks, []); assert.equal(h.scope.origins.size, 0);
  assert.equal(h.scope.errors.size, 0);
});

test('Tasks host mounts local Tasks and separate source tabs without constructing a runtime in the redirect view', async () => {
  const memory = {}, mounted = [], timers = [];
  const { TasksMod } = await evaluateNative('../mods/herdr-zed-tasks/main.js', {
    View: class {}, props: () => ({ view: 'board-v2', context: a }), shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    installedSources: () => [{ key: 'asana', label: 'Asana' }, { key: 'mantisbt', label: 'MantisBT' }],
    sourceHubLayout: (hub, context, id) => ({ hub, context, id }), mountWorkspaceLayout: (...args) => mounted.push(args),
    TaskRuntime: class { constructor() { assert.fail('v1 runtime must not initialize'); } },
  }, 'TasksMod');
  const view = new TasksMod(); view.init({}, { timer: { after: (_ms, work) => timers.push(work) } });
  timers[0]();
  assert.deepEqual(mounted[0][0].hub.tabs.map(tab => tab.id), ['tasks', 'asana', 'mantisbt']);
  assert.equal(mounted[0][0].hub.selected, 'tasks');
  assert.equal(view.redirected, true);
});

for (const [key, panelName, sourceName] of [['asana', 'AsanaPanel', 'asanaSource'], ['mantisbt', 'MantisPanel', 'mantisSource']]) {
  test(`${key} original panel preserves the scope adapter and never sends a synthetic project to its single-project API`, async () => {
    const h = await harness({ key, bindings: { [bindingKey(a)]: { [key]: { gid: 'real-project', workspace: 'w' } } } });
    const classes = await evaluateNative(`../mods/herdr-zed-${key}/ui.js`, {
      TaskSourceController: class { constructor(options) { Object.assign(this, options); } },
      TaskSourceProjectPicker: class {}, [sourceName]: { projectTasksPage: () => assert.fail('native provider must not replace the injected adapter') },
    }, panelName);
    const panel = new classes[panelName](h.options);
    assert.equal(panel.source, h.scope.source);
    const page = await panel.source.projectTasksPage('token', h.options.getBinding().gid);
    assert.equal(page.tasks[0].gid, 'real-project');
    assert.deepEqual(h.calls, [{ project: 'real-project', cursor: null }]);
  });
}
