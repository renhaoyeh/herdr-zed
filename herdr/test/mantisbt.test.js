import { evaluateNative, sourceOptions } from './source-harness.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as model from '../mods/devkits/model.js';

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const connection = { url: 'https://tracker.test/mantis', token: 'secret' };
const issue = (id, extra = {}) => ({ id, summary: `Issue ${id}`, project: { id: 1 }, status: { id: 10, name: 'new', label: 'New' }, ...extra });
const config = threshold => reply(200, { configs: [{ option: 'bug_resolved_status_threshold', value: threshold }] });
const element = () => new Proxy(() => {}, { get: (_target, key) => key === 'when'
  ? (condition, render) => condition ? render(element()) : element() : () => element() });
const input = () => {
  let value = '';
  return { on() {}, value: () => value, set_value: next => { value = next; }, set_masked(masked) { this.masked = masked; }, focus() {} };
};
const ui = { div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
  InputState: { new: input }, SelectState: class {}, TextView: { markdown: element },
  theme: () => ({}), Button: element, DialogDescription: element, DropdownMenuTrigger: element,
  DropdownMenuContent: element, DropdownMenuItem: element, DropdownMenuLabel: element };

async function load(options = {}) {
  const memory = {}, files = {}, writes = [], closed = [];
  const host = { ...model, ...ui, appHome: () => '/herdr', home: () => '/home', settings: () => ({}),
    shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); },
    closeOverlay: id => closed.push(id), openOverlay() {},
    fetch: () => assert.fail('Unexpected network request'),
    readTextFile: async path => files[path] ?? null,
    writeTextFile: async (path, text, expected) => { writes.push({ path, expected }); files[path] = text; }, ...options };
  Object.assign(host, await evaluateNative('../mods/devkits-mantisbt/api.js', host, 'normalizeUrl, searchProjects, projectTasksPage, myProjectTasks, taskDetails, taskComments, openSubtasks, validateConnection'));
  Object.assign(host, await evaluateNative('../mods/devkits-mantisbt/connection.js', host, 'readMantisConnection, saveMantisConnection'));
  Object.assign(host, await evaluateNative('../mods/devkits-mantisbt/source.js', host, 'mantisSource'));
  Object.assign(host, await evaluateNative('../mods/devkits/components/task-source-model.js', host, 'filterTasks, sourceTaskSnapshot'));
  Object.assign(host, await evaluateNative('../mods/devkits/components/task-source.js', host, 'TaskSourceController, TaskSourceProjectPicker'));
  Object.assign(host, await evaluateNative('../mods/devkits-tasks/task-prompt.js', host, 'taskPrompt'));
  Object.assign(host, await evaluateNative('../mods/devkits-mantisbt/ui.js', host, 'MantisPanel, MantisProjectPicker, mantisTheme, issueNumber, statusColor'));
  return { ...host, taskSourceOptions: (_source, target) => sourceOptions(host, 'mantisbt', target), memory, files, writes, closed };

}
const harness = () => {
  const pending = [], cx = { notify() {}, focus_handle: () => ({ focus() {} }), spawn: work => { pending.push(work(cx)); } };
  return { cx, settle: async () => { while (pending.length) await pending.shift(); } };
};

test('server URLs preserve installation paths and accept an API URL without credentials, query or fragments', async () => {
  const { normalizeUrl } = await load();
  for (const url of [' https://tracker.test/mantis/ ', 'https://tracker.test/mantis/api/rest/', 'https://tracker.test/mantis/api/rest/index.php'])
    assert.equal(normalizeUrl(url), connection.url);
  assert.equal(normalizeUrl('http://127.0.0.1:18080'), 'http://127.0.0.1:18080');
  for (const url of ['', 'tracker.test', 'file:///test', 'https://user:pass@tracker.test', 'https://tracker.test?token=secret', 'https://tracker.test/#x'])
    assert.throws(() => normalizeUrl(url), /server URL/);
});

test('Token authentication uses bare tokens first for older servers', async () => {
  const headers = [];
  const { validateConnection, searchProjects } = await load();
  const request = async (url, options) => {
    headers.push(options.headers.Authorization);
    assert.ok(!url.includes('secret')); assert.equal(options.method, undefined);
    if (options.headers.Authorization.startsWith('Bearer ')) return reply(401, null);
    return reply(200, url.endsWith('/users/me') ? { id: 7, name: 'developer' } : { projects: [] });
  };
  await validateConnection(connection, request); await searchProjects(connection, '', request);
  assert.deepEqual(headers, ['secret', 'secret']);
});

for (const status of [401, 403]) test(`Token authentication retries Bearer after ${status} and remembers success`, async () => {
  const headers = [], { validateConnection, searchProjects } = await load();
  const request = async (url, options) => {
    headers.push(options.headers.Authorization);
    if (options.headers.Authorization === 'secret') return reply(status, null);
    return reply(200, url.endsWith('/users/me') ? { id: 7 } : { projects: [] });
  };
  await validateConnection(connection, request);
  await searchProjects(connection, '', request);
  assert.deepEqual(headers, ['secret', 'Bearer secret', 'Bearer secret']);
});

test('a forbidden resource after successful authentication does not retry or invalidate the token', async () => {
  const headers = [], { validateConnection, searchProjects } = await load();
  const request = async (url, options) => {
    headers.push(options.headers.Authorization);
    return url.endsWith('/users/me') ? reply(200, { id: 7 }) : reply(403, {});
  };
  await validateConnection(connection, request);
  await assert.rejects(searchProjects(connection, '', request), error =>
    error.status === 403 && !error.unauthorized && /permission to read/.test(error.message));
  await validateConnection(connection, request);
  assert.deepEqual(headers, ['secret', 'secret', 'secret']);
});

test('invalid tokens, denied permissions and HTML responses have actionable errors', async () => {
  const { validateConnection } = await load();
  await assert.rejects(validateConnection(connection, async () => reply(401, null)), error => error.unauthorized && /rejected/.test(error.message));
  await assert.rejects(validateConnection(connection, async () => reply(403, {})), error =>
    !error.unauthorized && error.status === 403 && /token.*or denied access/.test(error.message));
  await assert.rejects(validateConnection(connection, async () => ({ ...reply(200, null), json: async () => { throw new Error('HTML'); } })), /server URL/);
  await assert.rejects(validateConnection(connection, async () => reply(200, {})), /MantisBT user/);
});

test('project search flattens subprojects once and searches names and their parent project', async () => {
  const { searchProjects } = await load();
  const projects = await searchProjects(connection, 'product api', async () => reply(200, { projects: [
    { id: 1, name: 'Product', subProjects: [{ id: 2, name: 'API' }] }, { id: 2, name: 'API' },
  ] }));
  assert.deepEqual(projects, [{ gid: '2', name: 'API', workspace: 'Product', workspaceGid: '2', server: connection.url }]);
});

test('All skips raw pages of resolved issues and honors the project’s configured resolved threshold', async () => {
  const urls = [], { projectTasksPage } = await load();
  const result = await projectTasksPage(connection, '1', null, async url => {
    urls.push(url);
    if (url.includes('/config?')) return config(100);
    if (url.includes('page=1')) return reply(200, { issues: Array.from({ length: 100 }, (_, i) => issue(i, { status: { id: 100 } })) });
    return reply(200, { issues: [issue(101, { status: { id: 80, name: 'testing' } }), issue(102, { project: { id: 2 } })] });
  });
  assert.deepEqual(result.tasks.map(task => task.gid), ['101']); assert.equal(result.next, null);
  assert.equal(urls.filter(url => url.includes('/config?')).length, 1);
  assert.ok(urls.some(url => url.includes('page=2')));
});

test('All exposes the next page; Mine uses the assigned server filter across every page', async () => {
  const urls = [], { projectTasksPage, myProjectTasks } = await load();
  const request = async url => {
    urls.push(url);
    if (url.includes('/config?')) return config(80);
    return reply(200, { issues: url.includes('page=1') ? Array.from({ length: 100 }, (_, i) => issue(i + 1)) : [issue(101)] });
  };
  const page = await projectTasksPage(connection, '1', null, request);
  assert.equal(page.tasks.length, 100); assert.equal(page.next, 2);
  const mine = await myProjectTasks(connection, '1', null, request);
  assert.equal(mine.length, 101);
  assert.equal(urls.filter(url => url.includes('filter_id=assigned')).length, 2);
});

test('details preserve descriptions, reproduction steps, parent links, assignee, dates and chronological notes', async () => {
  const { taskDetails, openSubtasks } = await load();
  const request = async url => {
    if (url.includes('/config?')) return config(80);
    const gid = Number(url.match(/issues\/(\d+)/)[1]);
    return reply(200, { issues: [issue(gid, gid === 1 ? {
      description: 'Fix the form', steps_to_reproduce: 'Submit empty', additional_information: 'Desktop only',
      due_date: '2026-12-01T00:00:00+08:00', handler: { id: 7, name: 'dev', real_name: 'Developer' },
      relationships: [{ type: { name: 'child-of' }, issue: { id: 9, summary: 'Parent' } },
        { type: { name: 'parent-of' }, issue: { id: 2 } }, { type: { name: 'parent-of' }, issue: { id: 3 } }],
      notes: [{ id: 2, reporter: { id: 7, name: 'dev' }, text: 'Latest', created_at: '2026-11-08T01:00:00Z' },
        { id: 1, reporter: { real_name: 'Amy' }, text: ' First ', created_at: '2026-11-07T01:00:00Z' }],
    } : { status: { id: gid === 3 ? 80 : 10 } })] });
  };
  const detail = await taskDetails(connection, '1', null, request);
  assert.equal(detail.assignee, 'Developer'); assert.equal(detail.assigneeGid, '7'); assert.equal(detail.due, '2026-12-01');
  assert.equal(detail.parent.url, `${connection.url}/view.php?id=9`); assert.equal(detail.subtasks, 2);
  assert.match(detail.notes, /Steps to reproduce:\nSubmit empty/); assert.match(detail.notes, /Additional information:\nDesktop only/);
  assert.deepEqual(detail.comments.map(comment => comment.text), ['First', 'Latest']);
  assert.deepEqual((await openSubtasks(connection, '1', request)).map(task => task.gid), ['2']);
  assert.equal(await taskDetails(connection, '404', null, async () => reply(404, {})), null);
});

test('connection storage is separate from Asana and uses version checked file writes', async () => {
  const { readMantisConnection, saveMantisConnection, files, writes } = await load();
  files['/herdr/data/devkits/asana.json'] = '{"token":"asana-secret"}';
  assert.equal(await readMantisConnection(), null);
  await saveMantisConnection(connection); assert.deepEqual(await readMantisConnection(), connection);
  await saveMantisConnection({ ...connection, token: '' }); assert.equal(await readMantisConnection(), null);
  assert.equal(writes[0].expected, null); assert.equal(JSON.parse(writes[1].expected).token, 'secret');
  assert.equal(files['/herdr/data/devkits/asana.json'], '{"token":"asana-secret"}');
});

test('MantisBT retains connection and import behavior while using its own issue views', async () => {
  const urls = [], context = await load({ fetch: async url => {
    urls.push(url);
    if (url.includes('/config?')) return config(80);
    if (url.endsWith('/projects')) return reply(200, { projects: [{ id: 1, name: 'Demo' }] });
    return reply(200, { issues: [issue(1, { description: 'Read-only import', notes: [{ id: 1, text: 'Keep this comment' }] })] });
  } });
  const { MantisPanel, TaskSourceController, MantisProjectPicker, memory, files, writes, taskPrompt, taskSourceOptions } = context;
  files['/herdr/data/devkits/mantisbt.json'] = JSON.stringify(connection);
  memory['devkits.asana-projects'] = { other: { gid: '1', name: 'Asana' } };
  const { cx, settle } = harness(), panel = new MantisPanel(taskSourceOptions('mantisbt')); panel.init(cx);
  assert.ok(panel instanceof TaskSourceController); assert.equal(panel.tokenInput.masked, true);
  const project = { folder: '/app' }, render = () => panel.render(project, cx);
  render(); await settle(); render(); assert.equal(urls.length, 0);
  const picker = new MantisProjectPicker(taskSourceOptions('mantisbt', { folder: '/app', overlay: 'picker' })); picker.init({ folder: '/app', overlay: 'picker' }, cx); await settle();
  picker.choose(picker.projects[0]); render(); await settle();
  assert.equal(panel.rows()[0].task.name, 'Issue 1');
  assert.ok(urls.some(url => url.includes('filter_id=assigned')));
  panel.show(panel.mine[0], cx); await settle();
  const selected = panel.detail, reads = urls.length; panel.show(panel.mine[0], cx); await settle();
  assert.equal(panel.detail, selected); assert.equal(urls.length, reads);
  assert.equal(selected.source, 'mantisbt'); assert.equal(selected.comments[0].text, 'Keep this comment');
  assert.match(taskPrompt({ source: 'local', name: selected.name, notes: 'Edited instructions', mantisbt: selected }), /Work on this MantisBT task/);
  assert.equal(writes.length, 0); assert.equal(memory['devkits.asana-projects'].other.name, 'Asana');
  assert.ok(!JSON.stringify(memory).includes('secret'));
  panel.server = 'https://another.test'; assert.equal(panel.binding(), null);
});

test('MantisBT searches issue numbers and metadata, combines status filtering, and invalidates a detail read when returning to the list', async () => {
  const { MantisPanel, memory, taskSourceOptions } = await load(), { cx } = harness();
  const panel = new MantisPanel(taskSourceOptions('mantisbt')); panel.init(cx);
  panel.mine = [
    { gid: '1', name: 'Email form', category: 'Accounts', section: 'confirmed', assignee: 'Amy' },
    { gid: '2', name: 'Search API', category: 'Backend', section: 'new', assignee: 'Rick' },
  ];
  panel.issueSearch.set_value('0000002 backend');
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['2']);
  panel.statusFilter = 'confirmed'; assert.deepEqual(panel.rows(), []);
  panel.issueSearch.set_value('Amy'); assert.deepEqual(panel.rows().map(row => row.task.gid), ['1']);
  panel.selected = '1'; panel.detail = { gid: '1' }; panel.detailRequest = { gid: '1' };
  panel.back(cx);
  assert.equal(panel.selected, null); assert.equal(panel.detail, null); assert.equal(panel.detailRequest, null);
  panel.all = { tasks: [{ gid: '3', name: 'Unassigned', section: 'new' }], loaded: true, next: null };
  panel.chooseView('all', cx);
  assert.equal(memory['devkits.mantisbt-tab'], 'all');
  panel.issueSearch.set_value(''); panel.statusFilter = null;
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['3']);
  assert.equal(panel.view(), 'list'); // Legacy Board preferences cannot restore the Asana UI.
});

test('MantisBT table and detail metadata use the values supplied by the tracker', async () => {
  const { taskDetails } = await load();
  const detail = await taskDetails(connection, '1', null, async url => url.includes('/config?') ? config(80) : reply(200, { issues: [issue(1, {
    project: { id: 1, name: 'Demo' }, status: { id: 40, name: 'confirmed', label: 'Confirmed' },
    category: { name: 'Accounts' }, severity: { name: 'major' }, priority: { id: 40, name: 'high' },
    resolution: { name: 'open' }, reproducibility: { name: 'always' }, view_state: { name: 'public' },
    reporter: { name: 'reporter' }, created_at: '2026-11-08T10:00:00Z', updated_at: '2026-11-08T11:00:00Z',
    notes: [{ id: 1, text: 'Note' }], attachments: [{ id: 1 }],
  })] }));
  assert.equal(detail.projectName, 'Demo'); assert.equal(detail.category, 'Accounts'); assert.equal(detail.priority, 'high');
  assert.equal(detail.severity, 'major'); assert.equal(detail.reporter, 'reporter'); assert.equal(detail.statusId, 40);
  assert.equal(detail.statusName, 'confirmed'); assert.equal(detail.resolution, 'open'); assert.equal(detail.reproducibility, 'always');
  assert.equal(detail.viewStatus, 'public'); assert.equal(detail.updatedAt, '2026-11-08T11:00:00Z');
  assert.equal(detail.noteCount, 1); assert.equal(detail.attachmentCount, 1);
});

test('connection validation failures retain the previous credentials and project bindings', async () => {
  const { MantisPanel, files, writes, memory, taskSourceOptions } = await load({ fetch: async () => reply(401, null) });
  files['/herdr/data/devkits/mantisbt.json'] = JSON.stringify(connection);
  memory['devkits.mantisbt-projects'] = { saved: { gid: '1', name: 'Demo', server: connection.url } };
  const { cx, settle } = harness(), panel = new MantisPanel(taskSourceOptions('mantisbt')); panel.init(cx); panel.open({ folder: '/app' }, cx); await settle();
  panel.openSettings(cx); panel.serverInput.set_value('https://another.test'); panel.tokenInput.set_value('invalid');
  panel.saveToken(cx); await settle();
  assert.equal(panel.token, 'secret'); assert.equal(panel.server, connection.url); assert.equal(panel.tokenBusy, false);
  assert.match(panel.error, /rejected/); assert.equal(writes.length, 0); assert.equal(memory['devkits.mantisbt-projects'].saved.name, 'Demo');
});
