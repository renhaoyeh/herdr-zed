import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { tasksMcpCall } from '../mods/devkits-tasks/mcp-api.js';
import { sessionArgv } from '../mods/devkits/components/session-model.js';
import { evaluateNative } from './source-harness.js';
const { start } = createRequire(import.meta.url)('../mods/devkits-tasks/mcp-server.cjs');
const { main: tasksCli } = createRequire(import.meta.url)('../mods/devkits-tasks/tasks-cli.cjs');

test('the reporting CLI explains lifecycle rules and passes a literal Unicode message to the owner', async () => {
  assert.match(await tasksCli(['--skill']), /Finishing a reply is not task completion/);
  const calls = [];
  const result = await tasksCli(['report', '--run', 'run:one', '--status', 'waiting', '--message', '請選擇登入頁\n保留修改'], async (name, args) => { calls.push({ name, args }); return { ok: true }; });
  assert.deepEqual(JSON.parse(result), { ok: true });
  assert.deepEqual(calls, [{ name: 'report_task', args: { run: 'run:one', status: 'waiting', message: '請選擇登入頁\n保留修改' } }]);
  await assert.rejects(tasksCli(['report', '--run', 'one', '--run', 'two']), /repeated/);
  await assert.rejects(tasksCli(['report', '--message']), /--skill/);
});

test('ordinary conversation reports use only their inherited HC terminal identity', async () => {
  const previous = process.env.HC_TERMINAL_ID, calls = [];
  try {
    process.env.HC_TERMINAL_ID = 't-own';
    await tasksCli(['report', '--status', 'doing', '--message', 'Working'], async (_name, args) => { calls.push(args); return {}; });
    assert.deepEqual(calls, [{ terminal: 't-own', status: 'doing', message: 'Working' }]);
    await assert.rejects(tasksCli(['report', '--terminal', 't-other', '--status', 'doing', '--message', 'Working']), /Unknown/);
    delete process.env.HC_TERMINAL_ID;
    await assert.rejects(tasksCli(['report', '--status', 'doing', '--message', 'Working']), /inside the task/);
  } finally {
    if (previous === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = previous;
  }
});

test('MCP uses exact project identity and validates creation fields before calling the owner', () => {
  const calls = [], runtime = { snapshot: () => ({ projects: { local: { project: { folder: '/repo' }, tasks: [] }, remote: { project: { folder: '/repo', machine: 'remote' }, tasks: [] } } }),
    createTask(project, args) { calls.push({ project, args }); return { gid: 'created', status: 'todo' }; } };
  assert.equal(tasksMcpCall(runtime, 'list_projects').projects.length, 2);
  assert.deepEqual(tasksMcpCall(runtime, 'list_tasks', { project: 'local' }), { tasks: [] });
  assert.throws(() => tasksMcpCall(runtime, 'create_task', { project: '/repo', name: 'A' }), /Unknown project/);
  for (const extra of [{ name: '  ' }, { notes: 1 }, { status: 'done' }, { parentId: '' }, { priority: 'invalid' }])
    assert.throws(() => tasksMcpCall(runtime, 'create_task', { project: 'local', name: 'A', ...extra }));
  assert.equal(calls.length, 0);
  tasksMcpCall(runtime, 'create_task', { project: 'remote', name: '子任務', parentId: 'parent', priority: 'high' });
  assert.equal(calls[0].project.machine, 'remote');
  assert.equal(calls[0].args.parentId, 'parent');
});

test('stdio handshake, discovery, Unicode calls and errors remain valid JSON-RPC', async () => {
  const input = new PassThrough(), output = new PassThrough(), messages = [], calls = [];
  let raw = ''; output.on('data', chunk => { raw += chunk; });
  const server = start(input, output, async (name, args) => { calls.push(name); if (args.name === 'fail') throw new Error('Parent unavailable'); return { task: { name: args.name } }; });
  input.write('{broken\n');
  const send = (id, method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) + '\n');
  send(0, 'tools/list'); send(1, 'initialize', { protocolVersion: '2025-06-18' }); send(undefined, 'notifications/initialized');
  send(2, 'tools/list'); send(3, 'tools/call', { name: 'create_task', arguments: { name: '繁體中文\nDescription' } });
  send(4, 'tools/call', { name: 'create_task', arguments: { name: 'fail' } }); send(5, 'tools/call', { name: 'delete_task' }); send(6, 'ping');
  await server.drained(); server.lines.close();
  messages.push(...raw.trim().split('\n').map(line => JSON.parse(line)));
  assert.equal(messages.length, 8);
  assert.equal(messages[0].error.code, -32700); assert.equal(messages[1].error.code, -32000);
  assert.equal(messages[2].result.serverInfo.name, 'herdr-tasks');
  assert.equal(messages[3].result.tools.length, 3);
  assert.equal(messages[4].result.structuredContent.task.name, '繁體中文\nDescription');
  assert.equal(messages[5].result.isError, true); assert.equal(messages[6].error.code, -32602);
  assert.deepEqual(messages[7].result, {}); assert.equal(calls.length, 2);
});

test('bridge rejects expired and unsafe commands and deduplicates deliveries', async () => {
  const id = '12345678-1234-1234-1234-123456789abc', commands = ['mcp:../../escape', `mcp:${id}`, `mcp:${id}`, `mcp:${id}`];
  const writes = [], calls = [], stop = new Error('stop'); let reads = 0;
  const { TasksMcpBridge } = await evaluateNative('../mods/devkits-tasks/mcp-bridge.js', {
    nextCommand: async () => { if (!commands.length) throw stop; return commands.shift(); }, appHome: () => '/herdr',
    readTextFile: async () => JSON.stringify({ id, until: ++reads === 1 ? Date.now() - 100 : Date.now() + 5000, name: 'create_task', args: {} }),
    writeTextFile: async (path, text) => writes.push({ path, result: JSON.parse(text) }),
    tasksMcpCall: () => { calls.push(1); return { task: { gid: 'one' } }; },
  }, 'TasksMcpBridge');
  let pending; new TasksMcpBridge().init({ refresh() {} }, { spawn(fn) { pending = fn({ notify() {} }); } });
  await assert.rejects(pending, error => error === stop);
  assert.equal(reads, 3); assert.equal(calls.length, 1); assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].result, writes[1].result);
  assert.equal(writes[0].path, `/herdr/data/devkits/tasks-mcp/${id}.json`);
});

test('local launch configuration preserves account environment and existing flags', () => {
  const home = 'C:\\Users\\A B\\herdr', codex = { key: 'codex' }, claude = { key: 'claude' };
  const original = ['env', 'CODEX_HOME=/private', 'codex', '--', 'prompt'];
  const argv = sessionArgv(codex, original, { tasksMcpHome: home });
  assert.deepEqual(argv.slice(0, 3), original.slice(0, 3)); assert.deepEqual(argv.slice(-2), ['--', 'prompt']);
  assert.match(argv[4], /mcp_servers.herdr_tasks/); assert.match(argv[4], /C:\/Users\/A B\/herdr\/mods/);
  const flags = sessionArgv(claude, ['claude', '--mcp-config', 'existing.json'], { tasksMcpHome: home });
  assert.equal(JSON.parse(flags[2]).mcpServers.herdr_tasks.env.HERDR_APP_HOME, home);
  assert.deepEqual(flags.slice(3), ['--mcp-config', 'existing.json']);
  assert.deepEqual(sessionArgv(codex, ['codex']), ['codex']);
});
