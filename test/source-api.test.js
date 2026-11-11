import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as asana from '../mods/herdr-zed-asana/api.js';
import * as mantis from '../mods/herdr-zed-mantisbt/api.js';

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const connection = { url: 'https://mantis.test/tracker/api/rest/', token: 'raw-api-test' };

test('raw Asana queries retain completed tasks, parent objects and page metadata without source policies', async () => {
  const body = { data: [{ gid: 't', completed: true, parent: { gid: 'parent', name: 'Parent' }, custom_fields: [{ number_value: 0 }] }],
    next_page: { offset: 'next & cursor', uri: 'opaque metadata' } };
  const options = { limit: 2, offset: 'first & cursor', opt_fields: 'completed,parent.name&limit=99' };
  let calls = 0;
  const result = await asana.listProjectTasks('token', 'project/with space', options, async (url, init) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/api/1.0/projects/project%2Fwith%20space/tasks');
    assert.equal(parsed.searchParams.get('offset'), options.offset);
    assert.equal(parsed.searchParams.get('opt_fields'), options.opt_fields);
    assert.equal(parsed.searchParams.get('limit'), '2');
    assert.equal(parsed.searchParams.has('completed_since'), false);
    assert.equal(init.headers.Authorization, 'Bearer token');
    return response(body);
  });
  assert.equal(result, body);
  assert.equal(calls, 1);
});

test('raw Asana endpoints encode resource IDs and leave field selection and filtering to callers', async () => {
  const cases = [
    [request => asana.getUser('token', 'a/b', {}, request), '/users/a%2Fb'],
    [request => asana.getProject('token', 'a/b', {}, request), '/projects/a%2Fb'],
    [request => asana.searchWorkspaceProjects('token', 'a/b', 'query & text', { count: 5 }, request), '/workspaces/a%2Fb/typeahead'],
    [request => asana.listTasks('token', { completed_since: '2020-01-01' }, request), '/tasks'],
    [request => asana.listSubtasks('token', 'a/b', {}, request), '/tasks/a%2Fb/subtasks'],
    [request => asana.getTask('token', 'a/b', {}, request), '/tasks/a%2Fb'],
    [request => asana.listStories('token', 'a/b', {}, request), '/tasks/a%2Fb/stories'],
  ];
  for (const [call, path] of cases) {
    const body = { data: [{ resource_subtype: 'system_event', completed: true }] };
    assert.equal(await call(async url => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, `/api/1.0${path}`);
      assert.equal(parsed.searchParams.has('opt_fields'), false);
      if (path.endsWith('/typeahead')) assert.equal(parsed.searchParams.get('query'), 'query & text');
      return response(body);
    }), body);
  }
});

test('raw MantisBT queries preserve resolved issues and raw notes without config reads or automatic pagination', async () => {
  const body = { issues: [{ id: 1, status: { id: 90 }, notes: [{ text: ' raw text ' }], relationships: [{ issue: { id: 2 } }] }],
    total_count: 42 };
  let calls = 0;
  const result = await mantis.listIssues(connection, { project_id: 7, page: 2, page_size: 3, filter_id: 'saved & filter' }, async (url, init) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/tracker/api/rest/issues');
    assert.equal(parsed.searchParams.get('project_id'), '7');
    assert.equal(parsed.searchParams.get('page'), '2');
    assert.equal(parsed.searchParams.get('page_size'), '3');
    assert.equal(parsed.searchParams.get('filter_id'), 'saved & filter');
    assert.equal(init.headers.Authorization, connection.token);
    return response(body);
  });
  assert.equal(result, body);
  assert.equal(calls, 1);
});

test('raw MantisBT endpoints preserve nested projects and encode resource IDs and config options', async () => {
  const cases = [
    [request => mantis.getUser(connection, 'a/b', request), '/users/a%2Fb'],
    [request => mantis.listProjects(connection, request), '/projects'],
    [request => mantis.getProject(connection, 'a/b', request), '/projects/a%2Fb'],
    [request => mantis.getConfig(connection, 'option & name', 0, request), '/config'],
    [request => mantis.getIssue(connection, 'a/b', request), '/issues/a%2Fb'],
    [request => mantis.listIssues(connection, {}, request), '/issues'],
  ];
  const body = { projects: [{ id: 1, subProjects: [{ id: 2 }] }], extra: 'preserved' };
  for (const [call, path] of cases) assert.equal(await call(async url => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, `/tracker/api/rest${path}`);
    if (path === '/config') {
      assert.equal(parsed.searchParams.get('option'), 'option & name');
      assert.equal(parsed.searchParams.get('project_id'), '0');
    } else assert.equal(parsed.search, '');
    return response(body);
  }), body);
});

test('raw APIs keep error status instead of applying the source adapter’s deleted-task fallback', async () => {
  await assert.rejects(asana.getTask('token', 'gone', {}, async () => response({}, 404)), error => error.status === 404);
  await assert.rejects(mantis.getIssue(connection, 'gone', async () => response({}, 404)), error => error.status === 404);
  await assert.rejects(asana.getUser('bad', 'me', {}, async () => response({}, 401)), error => error.unauthorized === true);
});
