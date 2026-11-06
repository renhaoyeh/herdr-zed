import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function load(host = {}) {
  const source = await readFile(new URL('../mods/devkits/asana.js', import.meta.url), 'utf8');
  host = { fetch: () => assert.fail('unexpected request'), Button: () => {}, ...host };
  return new Function(...Object.keys(host), source.replace(/^import .*;\n/gm, '')
    .replace('export default class', 'class').replace(/^export /gm, '')
    + '\nreturn { AsanaTasks, assignedTasks, filterTasks, taskPrompt, readAsanaToken, saveAsanaToken };')(...Object.values(host));
}
const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });

test('assigned tasks are read from every workspace, open only, sorted by due date', async () => {
  const urls = [];
  const request = async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer secret');
    if (url.includes('/users/me')) return reply(200, { data: { workspaces: [{ gid: '1', name: 'Team' }, { gid: '2', name: 'Other' }] } });
    return reply(200, { data: url.includes('workspace=1')
      ? [{ gid: 'a', name: 'Later', due_on: '2026-12-01', projects: [{ name: 'App' }], permalink_url: 'https://app.asana.com/a' },
        { gid: 'b', name: 'No date', notes: 'Details' }]
      : [{ gid: 'c', name: 'Soon', due_on: '2026-11-10', projects: [] }] });
  };
  const { assignedTasks } = await load();
  const tasks = await assignedTasks('secret', request);
  assert.deepEqual(tasks.map(task => task.gid), ['c', 'a', 'b']);
  assert.equal(tasks[0].project, 'Other');
  assert.equal(tasks[1].project, 'App');
  assert.ok(urls.slice(1).every(url => url.includes('assignee=me') && url.includes('completed_since=now')));
});

test('a rejected token asks for a new one; other errors keep the Asana message', async () => {
  const { assignedTasks } = await load();
  await assert.rejects(assignedTasks('bad', async () => reply(401, {})), error => error.unauthorized === true);
  await assert.rejects(assignedTasks('ok', async () => reply(500, { errors: [{ message: 'Server down' }] })), /Server down/);
});

test('search matches every word in the task name or project; prompt carries name, link and trimmed notes', async () => {
  const { filterTasks, taskPrompt } = await load();
  const tasks = [{ name: 'Fix login', project: 'Web' }, { name: 'Fix export', project: 'Desktop' }];
  assert.deepEqual(filterTasks(tasks, 'fix web').map(task => task.name), ['Fix login']);
  assert.equal(filterTasks(tasks, '  ').length, 2);
  assert.equal(taskPrompt({ name: 'Fix login', url: 'https://x', notes: '  Steps  ' }),
    'Work on this Asana task: Fix login\n\nhttps://x\n\nDescription:\nSteps');
  assert.equal(taskPrompt({ name: 'Short', url: '', notes: '' }), 'Work on this Asana task: Short');
  assert.ok(taskPrompt({ name: 'Long', url: '', notes: 'x'.repeat(5000) }).length < 4100);
});

test('the token is stored locally and only replaced against the file it was read from', async () => {
  const files = {}, writes = [];
  const { readAsanaToken, saveAsanaToken } = await load({ appHome: () => '/herdr',
    readTextFile: async path => files[path] ?? null,
    writeTextFile: async (path, text, expected) => { writes.push(expected); files[path] = text; } });
  assert.equal(await readAsanaToken(), null);
  await saveAsanaToken('one'); await saveAsanaToken('two');
  assert.equal(await readAsanaToken(), 'two');
  assert.deepEqual(writes, [null, '{\n  "token": "one"\n}\n']);
});
