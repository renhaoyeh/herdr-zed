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
  theme: () => ({}), Button: element, DialogDescription: element, DropdownMenuTrigger: element, DropdownMenu: element, DropdownMenuState: class {},
  DropdownMenuContent: element, DropdownMenuItem: element, DropdownMenuLabel: element };

async function load(options = {}) {
  const memory = {}, files = {}, writes = [], closed = [];
  const host = { ...model, ...ui, appHome: () => '/herdr', home: () => '/home', settings: () => ({}),
    shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); },
    closeOverlay: id => closed.push(id), openOverlay() {},
    fetch: () => assert.fail('Unexpected network request'),
    readTextFile: async path => files[path] ?? null,
    writeTextFile: async (path, text, expected) => { writes.push({ path, expected }); files[path] = text; }, ...options };
  Object.assign(host, await evaluateNative('../mods/devkits-mantisbt/api.js', host, 'normalizeUrl, filterProjects, searchProjects, projectTasksPage, myProjectTasks, taskDetails, taskComments, openSubtasks, validateConnection, projectFields'));
  Object.assign(host, await evaluateNative('../mods/devkits-mantisbt/connection.js', host, 'readMantisConnection, saveMantisConnection, readMantisProjects, saveMantisProjects, readMantisIssues, saveMantisIssues'));
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

test('MantisBT applies custom field choices to its table and details independently', async () => {
  const texts = [];
  const node = () => new Proxy({}, { get: (_target, key) => key === 'when'
    ? (condition, render) => condition ? render(node()) : node()
    : (...args) => { if (key === 'child' && typeof args[0] === 'string') texts.push(args[0]); return node(); } });
  const { MantisPanel, taskSourceOptions } = await load({ div: node, h_flex: node, v_flex: node });
  const panel = new MantisPanel(taskSourceOptions('mantisbt'));
  const { cx } = harness(); panel.init(cx);
  panel.server = connection.url;
  const task = { gid: '1', name: 'Issue', notes: '', comments: [], customFields: [
    { gid: 'f', name: 'RD Note', type: 'textarea', value: 'Investigate', displayValue: 'Investigate' },
  ] };
  panel.all = { tasks: [task], loaded: true, next: null }; panel.detail = task;
  panel.issueList(cx); assert.ok(!texts.includes('RD Note'));
  panel.changeField('list', 'custom:f', 0, cx); texts.length = 0; panel.issueList(cx);
  assert.ok(texts.includes('RD Note')); assert.ok(texts.includes('Investigate'));
  texts.length = 0; panel.detailPage(() => {}); assert.ok(texts.includes('Investigate'));
  panel.changeField('detail', 'custom:f', 0, cx); texts.length = 0; panel.detailPage(() => {});
  assert.ok(!texts.includes('Investigate')); assert.equal(panel.snapshot().customFields[0].value, 'Investigate');
});

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

test('project searches share in-flight requests and cache by server and token, with failed requests retried', async () => {
  const { searchProjects } = await load();
  let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const request = async () => { calls++; return pending; };
  const first = searchProjects(connection, 'demo', request), second = searchProjects(connection, 'other', request);
  assert.equal(calls, 1);
  release(reply(200, { projects: [{ id: 1, name: 'Demo' }, { id: 2, name: 'Other' }] }));
  assert.deepEqual((await first).map(p => p.gid), ['1']);
  assert.deepEqual((await second).map(p => p.gid), ['2']);
  assert.equal((await searchProjects(connection, '', request)).length, 2); assert.equal(calls, 1);
  await searchProjects({ ...connection, token: 'another' }, '', request);
  await searchProjects({ ...connection, url: 'https://other.test' }, '', request);
  assert.equal(calls, 3);
  const failed = { ...connection, token: 'failed' };
  await assert.rejects(searchProjects(failed, '', async () => { throw new Error('Offline'); }), /Offline/);
  await assert.rejects(searchProjects(failed, '', async () => reply(200, {})), /MantisBT projects/);
  assert.equal((await searchProjects(failed, '', request)).length, 2); assert.equal(calls, 4);
});

test('issue lists show loading until the active view finishes, then show an appropriate empty state', async () => {
  const text = [];
  const tracked = () => new Proxy(() => {}, { get: (_target, key) => key === 'when'
    ? (condition, render) => condition ? render(tracked()) : tracked()
    : key === 'child' ? value => { if (typeof value === 'string') text.push(value); return tracked(); } : () => tracked() });
  const { MantisPanel, taskSourceOptions } = await load({ div: tracked, v_flex: tracked, h_flex: tracked });
  const { cx } = harness(), panel = new MantisPanel(taskSourceOptions('mantisbt')); panel.init(cx);
  panel.loading = false; panel.loadingMore = true; panel.issueList(cx);
  assert.ok(text.includes('Loading issues…')); assert.ok(!text.some(t => t.startsWith('No ')));
  text.length = 0; panel.loadingMore = false; panel.all.loaded = true; panel.all.next = 2; panel.issueList(cx);
  assert.ok(text.includes('No open issues on the loaded pages. Load more issues to continue.'));
  text.length = 0; panel.all.next = null; panel.issueList(cx);
  assert.ok(text.includes('No open issues in this project.'));
  text.length = 0; panel.error = 'Offline'; panel.issueList(cx);
  assert.ok(!text.some(t => t.startsWith('No ')));
  text.length = 0; panel.error = null; panel.chooseView('mine', cx); panel.mine = null; panel.loading = true; panel.issueList(cx);
  assert.ok(text.includes('Loading issues assigned to you…')); assert.ok(!text.some(t => t.startsWith('No ')));
});

test('All returns one small page at a time even when it contains only resolved issues', async () => {
  const urls = [], { projectTasksPage } = await load();
  const result = await projectTasksPage(connection, '1', null, async url => {
    urls.push(url);
    if (url.includes('/config?')) return config(100);
    if (url.includes('page=1')) return reply(200, { issues: Array.from({ length: 20 }, (_, i) => issue(i, { status: { id: 100 } })) });
    return reply(200, { issues: [issue(101, { status: { id: 80, name: 'testing' } }), issue(102, { project: { id: 2 } })] });
  });
  assert.deepEqual(result.tasks, []); assert.equal(result.next, 2);
  assert.equal(urls.filter(url => url.includes('/issues?')).length, 1);
  const next = await projectTasksPage(connection, '1', result.next, async url => {
    urls.push(url);
    assert.ok(url.includes('page=2')); assert.ok(url.includes('page_size=20'));
    return reply(200, { issues: [issue(101, { status: { id: 80, name: 'testing' } }), issue(102, { project: { id: 2 } })] });
  });
  assert.deepEqual(next.tasks.map(task => task.gid), ['101']); assert.equal(next.next, null);
  assert.equal(urls.filter(url => url.includes('/config?')).length, 1);
  assert.ok(urls.some(url => url.includes('page=2')));
});

test('All exposes the next page; Mine uses the assigned server filter across every page', async () => {
  const urls = [], { projectTasksPage, myProjectTasks } = await load();
  const request = async url => {
    urls.push(url);
    if (url.includes('/config?')) return config(80);
    assert.ok(url.includes('page_size=20'));
    return reply(200, { issues: url.includes('page=1') ? Array.from({ length: 20 }, (_, i) => issue(i + 1)) : [issue(101)] });
  };
  const page = await projectTasksPage(connection, '1', null, request);
  assert.equal(page.tasks.length, 20); assert.equal(page.next, 2);
  const mine = await myProjectTasks(connection, '1', null, request);
  assert.equal(mine.length, 21);
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

const cachedProject = (gid, name) => ({ gid, name, workspace: '', workspaceGid: gid, server: connection.url });

test('project snapshots persist compact rows only and are isolated to the saved connection', async () => {
  const { files, saveMantisConnection, readMantisConnection, saveMantisProjects, readMantisProjects } = await load();
  await saveMantisConnection(connection);
  const projects = [cachedProject('1', 'Demo')], fetchedAt = Date.now();
  await saveMantisProjects(connection, [{ ...projects[0], custom_fields: ['unneeded'] }], fetchedAt);
  assert.deepEqual(await readMantisProjects(connection), { projects, fetchedAt });
  assert.deepEqual(await readMantisConnection(), connection);
  assert.ok(!files['/herdr/data/devkits/mantisbt.json'].includes('custom_fields'));
  assert.equal(await readMantisProjects({ ...connection, token: 'other' }), null);
  await saveMantisConnection({ ...connection, token: 'new-token' });
  await saveMantisProjects(connection, projects, fetchedAt);
  assert.equal(await readMantisProjects({ ...connection, token: 'new-token' }), null);
  assert.equal((await readMantisConnection()).token, 'new-token');
  files['/herdr/data/devkits/mantisbt.json'] = JSON.stringify({ ...connection, projectCache: { fetchedAt, projects: [{}] } });
  assert.equal(await readMantisProjects(connection), null);
});

test('the project picker opens a fresh disk snapshot without a network request', async () => {
  const { MantisProjectPicker, files, taskSourceOptions } = await load();
  files['/herdr/data/devkits/mantisbt.json'] = JSON.stringify({ ...connection,
    projectCache: { fetchedAt: Date.now(), projects: [cachedProject('1', 'Demo'), cachedProject('2', 'Other')] } });
  const { cx, settle } = harness(), picker = new MantisProjectPicker(taskSourceOptions('mantisbt'));
  picker.init({}, cx); await settle();
  assert.equal(picker.projects.length, 2); assert.equal(picker.loading, false);
  picker.search.set_value('other'); picker.find(cx); await settle();
  assert.deepEqual(picker.projects.map(p => p.gid), ['2']); assert.equal(picker.error, null);
});

test('the project picker displays stale projects during refresh and applies the latest search to new data', async () => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const { MantisProjectPicker, files, taskSourceOptions, readMantisProjects } = await load({ fetch: async () => { calls++; return pending; } });
  files['/herdr/data/devkits/mantisbt.json'] = JSON.stringify({ ...connection,
    projectCache: { fetchedAt: Date.now() - 300_001, projects: [cachedProject('1', 'Saved')] } });
  const { cx, settle } = harness(), picker = new MantisProjectPicker(taskSourceOptions('mantisbt'));
  picker.init({}, cx); await new Promise(setImmediate);
  assert.equal(picker.projects[0].name, 'Saved'); assert.equal(picker.loading, false); assert.equal(picker.refreshing, true);
  picker.search.set_value('new'); picker.find(cx);
  assert.deepEqual(picker.projects, []); assert.equal(calls, 1);
  release(reply(200, { projects: [{ id: 1, name: 'Saved' }, { id: 2, name: 'New' }] }));
  await settle();
  assert.deepEqual(picker.projects.map(p => p.name), ['New']); assert.equal(picker.refreshing, false);
  assert.equal((await readMantisProjects(connection)).projects.length, 2);
});

test('failed background project refreshes retain searchable saved projects', async () => {
  const { MantisProjectPicker, files, taskSourceOptions } = await load({ fetch: async () => { throw new Error('Offline'); } });
  files['/herdr/data/devkits/mantisbt.json'] = JSON.stringify({ ...connection,
    projectCache: { fetchedAt: Date.now() - 300_001, projects: [cachedProject('1', 'Saved')] } });
  const { cx, settle } = harness(), picker = new MantisProjectPicker(taskSourceOptions('mantisbt'));
  picker.init({}, cx); await settle();
  assert.equal(picker.projects[0].name, 'Saved'); assert.match(picker.error, /Showing saved projects.*Offline/);
  picker.search.set_value('saved'); picker.find(cx);
  assert.equal(picker.projects.length, 1); assert.equal(picker.loading, false);
});

test('closing a project picker ignores a late refresh response', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { MantisProjectPicker, files, writes, taskSourceOptions } = await load({ fetch: async () => pending });
  files['/herdr/data/devkits/mantisbt.json'] = JSON.stringify(connection);
  const { cx, settle } = harness(), picker = new MantisProjectPicker(taskSourceOptions('mantisbt'));
  picker.init({}, cx); await new Promise(setImmediate); picker.close();
  release(reply(200, { projects: [{ id: 1, name: 'Late' }] })); await settle();
  assert.deepEqual(picker.projects, []); assert.equal(writes.length, 0);
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
  memory['devkits.mantisbt-tab'] = 'mine';
  const { cx, settle } = harness(), panel = new MantisPanel(taskSourceOptions('mantisbt')); panel.init(cx);
  assert.equal(panel.tab, 'all');
  assert.ok(panel instanceof TaskSourceController); assert.equal(panel.tokenInput.masked, true);
  const project = { folder: '/app' }, render = () => panel.render(project, cx);
  render(); await settle(); render(); assert.equal(urls.length, 0);
  const picker = new MantisProjectPicker(taskSourceOptions('mantisbt', { folder: '/app', overlay: 'picker' })); picker.init({ folder: '/app', overlay: 'picker' }, cx); await settle();
  picker.choose(picker.projects[0]); render(); await settle();
  assert.equal(panel.rows()[0].task.name, 'Issue 1');
  assert.ok(urls.some(url => url.includes('/issues?') && !url.includes('filter_id=')));
  assert.ok(urls.some(url => url.includes('filter_id=assigned')));
  panel.show(panel.mine[0], cx); await settle();
  const selected = panel.detail, reads = urls.length; panel.show(panel.mine[0], cx); await settle();
  assert.equal(panel.detail, selected); assert.equal(urls.length, reads);
  assert.equal(selected.source, 'mantisbt'); assert.equal(selected.comments[0].text, 'Keep this comment');
  assert.match(taskPrompt({ source: 'local', name: selected.name, notes: 'Edited instructions', mantisbt: selected }), /Work on this MantisBT task/);
  assert.equal(writes.length, 1); assert.equal(memory['devkits.asana-projects'].other.name, 'Asana');
  assert.ok(!JSON.stringify(memory).includes('secret'));
  panel.server = 'https://another.test'; assert.equal(panel.binding(), null);
});

test('MantisBT searches issue numbers and metadata, combines status filtering, and invalidates a detail read when returning to the list', async () => {
  const { MantisPanel, memory, taskSourceOptions } = await load(), { cx } = harness();
  const panel = new MantisPanel(taskSourceOptions('mantisbt')); panel.init(cx);
  panel.chooseView('mine', cx);
  panel.mine = [
    { gid: '1', name: 'Email form', category: 'Accounts', section: 'confirmed', assignee: 'Amy' },
    { gid: '2', name: 'Search API', category: 'Backend', section: 'new', assignee: 'Rick' },
  ];
  panel.issueSearch.set_value('0000002 backend');
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['2']);
  panel.toggleFilter('section', 'confirmed', cx); assert.deepEqual(panel.rows(), []);
  panel.issueSearch.set_value('Amy'); assert.deepEqual(panel.rows().map(row => row.task.gid), ['1']);
  panel.selected = '1'; panel.detail = { gid: '1' }; panel.detailRequest = { gid: '1' };
  panel.back(cx);
  assert.equal(panel.selected, null); assert.equal(panel.detail, null); assert.equal(panel.detailRequest, null);
  panel.all = { tasks: [{ gid: '3', name: 'Unassigned', section: 'new' }], loaded: true, next: null };
  panel.chooseView('all', cx);
  assert.equal(memory['devkits.mantisbt-tab'], 'all');
  panel.issueSearch.set_value(''); panel.filter = {};
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

test('MantisBT saves credentials without network validation and retains them after a failed read', async () => {
  let requests = 0;
  const { MantisPanel, files, writes, memory, taskSourceOptions, searchProjects, readMantisConnection } = await load({ fetch: async () => {
    requests++; return reply(401, null);
  } });
  files['/herdr/data/devkits/mantisbt.json'] = JSON.stringify(connection);
  memory['devkits.mantisbt-projects'] = { saved: { gid: '1', name: 'Demo', server: connection.url } };
  const { cx, settle } = harness(), panel = new MantisPanel(taskSourceOptions('mantisbt')); panel.init(cx); panel.open({ folder: '/app' }, cx); await settle();
  panel.openSettings(cx); panel.serverInput.set_value('https://another.test'); panel.tokenInput.set_value('invalid');
  panel.saveToken(cx); await settle();
  assert.equal(panel.token, 'invalid'); assert.equal(panel.server, 'https://another.test'); assert.equal(panel.tokenBusy, false);
  assert.equal(requests, 0); assert.equal(panel.settingsOpen, false); assert.equal(writes.length, 1);
  const saved = { url: 'https://another.test', token: 'invalid' };
  assert.deepEqual(await readMantisConnection(), saved);
  await assert.rejects(searchProjects(saved, ''), /rejected/);
  assert.deepEqual(await readMantisConnection(), saved);
  panel.openSettings(cx);
  assert.equal(panel.tokenInput.value(), saved.token); assert.equal(panel.serverInput.value(), saved.url);
  assert.equal(memory['devkits.mantisbt-projects'].saved.name, 'Demo');
});

test('MantisBT still validates the URL before saving credentials', async () => {
  const { MantisPanel, writes, taskSourceOptions } = await load();
  const { cx, settle } = harness(), panel = new MantisPanel(taskSourceOptions('mantisbt')); panel.init(cx);
  panel.serverInput.set_value('invalid-url'); panel.tokenInput.set_value('secret');
  panel.saveToken(cx); await settle();
  assert.match(panel.error, /server URL/); assert.equal(writes.length, 0);
  assert.equal(panel.tokenInput.value(), 'secret');
});


test('MantisBT custom fields remain individual full-width rows after Description, including short values', async () => {
  const ids = new Map();
  const node = () => {
    const data = { children: [] };
    const proxy = new Proxy(data, { get: (target, key) => {
      if (key === 'childrenData') return target.children;
      if (key === 'when') return (condition, render) => { if (condition) render(proxy); return proxy; };
      return (...args) => {
        if (key === 'id') ids.set(args[0], proxy);
        if (key === 'child') target.children.push(args[0]);
        if (key === 'children') target.children.push(...args[0]);
        return proxy;
      };
    } });
    return proxy;
  };
  const { MantisPanel, taskSourceOptions } = await load({ div: node, h_flex: node, v_flex: node });
  const panel = new MantisPanel(taskSourceOptions('mantisbt'));
  panel.init(harness().cx); panel.server = connection.url;
  panel.detail = { gid: '1', name: 'Issue', notes: 'Description body', comments: [], customFields: [
    { gid: 'a', name: 'For PM', displayValue: '='.repeat(152) },
    { gid: 'b', name: 'Priority', displayValue: 'Normal' },
  ] };
  panel.detailPage(() => {});
  const detailRows = ids.get('mantis-detail').childrenData;
  const customA = ids.get('mantis-custom-detail-custom:a'), customB = ids.get('mantis-custom-detail-custom:b');
  assert.ok(detailRows.includes(customA)); assert.ok(detailRows.includes(customB));
  assert.equal(detailRows.indexOf(customA) + 1, detailRows.indexOf(customB));
  assert.equal(customA.childrenData.length, 2); assert.equal(customB.childrenData.length, 2);
  const text = item => typeof item === 'string' ? item : (item?.childrenData || []).map(text).filter(Boolean).join(' ');
  assert.ok(text(detailRows[detailRows.indexOf(customA) - 1]).includes('Description body'));
  assert.equal(text(customB), 'Priority Normal');
});

test('fetched issue lists persist per server and project, and are dropped when the token changes', async () => {
  const { files, readMantisIssues, saveMantisIssues } = await load();
  assert.equal(await readMantisIssues(connection, '7'), null);
  const tasks = [{ gid: '1', name: 'One' }], fetchedAt = 1700000000000;
  await saveMantisIssues(connection, '7', tasks, fetchedAt);
  assert.deepEqual(await readMantisIssues(connection, '7'), { fetchedAt, tasks });
  assert.equal(await readMantisIssues(connection, '8'), null);
  assert.equal(await readMantisIssues({ ...connection, token: 'other' }, '7'), null);
  assert.ok(!files['/herdr/data/devkits/mantisbt-issues.json'].includes(connection.token));
  for (let project = 20; project < 27; project++) await saveMantisIssues(connection, String(project), tasks, fetchedAt + project);
  assert.equal(await readMantisIssues(connection, '7'), null);
  assert.ok(await readMantisIssues(connection, '26'));
});

test('Fetch all reads every page, saves the list, and sorting works on the loaded issues', async () => {
  const { MantisPanel, taskSourceOptions, readMantisIssues } = await load();
  const { cx, settle } = harness(), panel = new MantisPanel(taskSourceOptions('mantisbt'));
  panel.init(cx); panel.token = connection.token; panel.server = connection.url; panel.loadedGid = '7'; panel.tab = 'all';
  const pages = { null: { tasks: [{ gid: '3', name: 'b', section: 'new' }], next: 2 }, 2: { tasks: [{ gid: '9', name: 'a', section: 'assigned' }], next: null } };
  panel.source = { ...panel.source, projectTasksPage: async (_credentials, _gid, next) => pages[next] };
  panel.fetchAll(cx); assert.ok(panel.fetchingAll); await settle();
  assert.ok(!panel.fetchingAll && !panel.loadingMore);
  assert.deepEqual(panel.all.tasks.map(task => task.gid), ['3', '9']); assert.equal(panel.all.next, null);
  assert.deepEqual((await readMantisIssues(panel.credentials(), '7')).tasks.map(task => task.gid), ['3', '9']);
  panel.sortBy('gid', cx); assert.deepEqual(panel.issueTasks().map(task => task.gid), ['9', '3']);
  panel.sortBy('gid', cx); assert.deepEqual(panel.issueTasks().map(task => task.gid), ['3', '9']);
  panel.sortBy('summary', cx); assert.deepEqual(panel.issueTasks().map(task => task.name), ['a', 'b']);
  // Refresh keeps the current list until the new read finishes.
  pages.null = { tasks: [{ gid: '5', name: 'c', section: 'new' }], next: null };
  panel.fetchAll(cx, true); assert.equal(panel.all.tasks.length, 2); await settle();
  assert.deepEqual(panel.all.tasks.map(task => task.gid), ['5']);
});

test('filters combine several values per field and across fields, and Reset clears them', async () => {
  const { MantisPanel, taskSourceOptions } = await load();
  const { cx } = harness(), panel = new MantisPanel(taskSourceOptions('mantisbt')); panel.init(cx);
  panel.tab = 'all';
  panel.all = { loaded: true, next: null, tasks: [
    { gid: '1', name: 'a', assignee: 'Molly', section: 'new', category: 'UI' },
    { gid: '2', name: 'b', assignee: 'Luke', section: 'new', category: 'API' },
    { gid: '3', name: 'c', assignee: null, section: 'assigned', category: 'UI' },
  ] };
  const ids = () => panel.rows().map(row => row.task.gid);
  panel.toggleFilter('assignee', 'Molly', cx); panel.toggleFilter('assignee', 'Luke', cx);
  assert.deepEqual(ids(), ['1', '2']);
  panel.toggleFilter('category', 'UI', cx); assert.deepEqual(ids(), ['1']);
  panel.toggleFilter('assignee', 'Molly', cx); panel.toggleFilter('assignee', 'Luke', cx); panel.toggleFilter('assignee', '[none]', cx);
  assert.deepEqual(ids(), ['3']); assert.equal(panel.activeFilters(), 2);
  panel.toggleFilter('assignee', null, cx); panel.toggleFilter('category', null, cx);
  assert.equal(panel.activeFilters(), 0); assert.deepEqual(ids(), ['1', '2', '3']);
});

test('status colors come from the server so custom statuses are not gray', async () => {
  const { projectTasksPage, statusColor } = await load({ fetch: async url => url.includes('/config') ? config(90) : reply(200, { issues: [
    issue(1, { status: { id: 75, name: 'hold', label: 'Hold', color: '#95CACA' } }),
    issue(2, { status: { id: 82, name: 'releasetotest', label: 'Release to test' } }),
  ] }) });
  const { tasks } = await projectTasksPage(connection, '1');
  assert.equal(statusColor(tasks[0]), '#95CACA');
  assert.equal(statusColor(tasks[1]), '#e4e4e4');
  assert.equal(statusColor({ statusName: 'resolved' }), '#d2f5b0');
});
