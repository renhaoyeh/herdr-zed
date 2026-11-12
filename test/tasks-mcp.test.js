import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { tasksMcpCall } from '../mods/herdr-zed-tasks/mcp-api.js';
import { sessionArgv, tasksMcpServer } from '../components/session-model.js';
import { evaluateNative } from './source-harness.js';
const { start } = createRequire(import.meta.url)('../mods/herdr-zed-tasks/mcp-server.cjs');

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
  send(4, 'tools/call', { name: 'create_task', arguments: { name: 'fail' } }); send(5, 'tools/call', { name: 'rename_task' }); send(6, 'ping');
  await server.drained(); server.lines.close();
  messages.push(...raw.trim().split('\n').map(line => JSON.parse(line)));
  assert.equal(messages.length, 8);
  assert.equal(messages[0].error.code, -32700); assert.equal(messages[1].error.code, -32000);
  assert.equal(messages[2].result.serverInfo.name, 'herdr-tasks');
  assert.equal(messages[3].result.tools.length, 5);
  assert.equal(messages[4].result.structuredContent.task.name, '繁體中文\nDescription');
  assert.equal(messages[5].result.isError, true); assert.equal(messages[6].error.code, -32602);
  assert.deepEqual(messages[7].result, {}); assert.equal(calls.length, 2);
});

test('MCP discovers reporting and binds ordinary reports to the server terminal without exposing a script path', async () => {
  const input = new PassThrough(), output = new PassThrough(), calls = [];
  let raw = '';
  output.on('data', chunk => { raw += chunk; });
  const runtime = { snapshot: () => ({ projects: {} }), reportTask(_project, args) {
    calls.push(args); return { gid: 'own-task', status: args.status, execution: { id: args.run || 'bound-run', summary: args.message } };
  } };
  const server = start(input, output, (name, args) => tasksMcpCall(runtime, name, args));
  const send = (id, method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const report = (id, args) => send(id, 'tools/call', { name: 'report_task', arguments: args });
  const previous = process.env.HC_TERMINAL_ID;
  try {
    process.env.HC_TERMINAL_ID = 't-own';
    send(1, 'initialize', {}); send(2, 'tools/list');
    report(3, { status: 'doing', message: '開始工作' });
    report(4, { status: 'doing', message: 'Spoof', terminal: 't-other' });
    await server.drained();
    delete process.env.HC_TERMINAL_ID;
    report(5, { status: 'done', message: 'Missing identity' });
    report(6, { run: 'explicit-run', status: 'done', message: 'Validated' });
    await server.drained();
    const messages = raw.trim().split('\n').map(line => JSON.parse(line));
    const tool = messages[1].result.tools.find(tool => tool.name === 'report_task');
    assert.deepEqual(tool.inputSchema.required, ['status', 'message']);
    assert.deepEqual(tool.inputSchema.properties.status.enum, ['doing', 'waiting', 'done', 'fail']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(!JSON.stringify(tool).includes('tasks-cli.cjs'));
    assert.deepEqual(calls, [{ status: 'doing', message: '開始工作', terminal: 't-own' }, { run: 'explicit-run', status: 'done', message: 'Validated' }]);
    assert.equal(messages[2].result.structuredContent.task.run, 'bound-run');
    assert.equal(messages[3].result.isError, true); assert.equal(messages[4].result.isError, true);
  } finally {
    server.lines.close();
    if (previous === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = previous;
  }
});

test('bridge rejects expired and unsafe commands and deduplicates deliveries', async () => {
  const id = '12345678-1234-1234-1234-123456789abc', commands = ['mcp:../../escape', `mcp:${id}`, `mcp:${id}`, `mcp:${id}`];
  const writes = [], calls = [], stop = new Error('stop'); let reads = 0;
  const { TasksMcpBridge } = await evaluateNative('../mods/herdr-zed-tasks/mcp-bridge.js', {
    nextCommand: async () => { if (!commands.length) throw stop; return commands.shift(); }, appHome: () => '/herdr',
    readTextFile: async () => JSON.stringify({ id, until: ++reads === 1 ? Date.now() - 100 : Date.now() + 5000, name: 'create_task', args: {} }),
    writeTextFile: async (path, text) => writes.push({ path, result: JSON.parse(text) }),
    tasksMcpCall: () => { calls.push(1); return { task: { gid: 'one' } }; },
  }, 'TasksMcpBridge');
  let pending; new TasksMcpBridge().init({ refresh() {} }, { spawn(fn) { pending = fn({ notify() {} }); } });
  await assert.rejects(pending, error => error === stop);
  assert.equal(reads, 3); assert.equal(calls.length, 1); assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].result, writes[1].result);
  assert.equal(writes[0].path, `/herdr/data/herdr-zed/tasks-mcp/${id}.json`);
});

test('local launch configuration preserves account environment and existing flags', () => {
  const home = 'C:\\Users\\A B\\herdr', codex = { key: 'codex' }, claude = { key: 'claude' };
  const original = ['env', 'CODEX_HOME=/private', 'codex', '--', 'prompt'];
  const argv = sessionArgv(codex, original, { tasksMcpHome: home });
  assert.deepEqual(argv.slice(0, 3), original.slice(0, 3)); assert.deepEqual(argv.slice(-2), ['--', 'prompt']);
  assert.match(argv[4], /mcp_servers.herdr_tasks/); assert.match(argv[4], /C:\/Users\/A B\/herdr\/mods/);
  assert.match(argv[4], /env_vars=\["HC_TERMINAL_ID"\]/);
  assert.deepEqual(tasksMcpServer(home).env_vars, ['HC_TERMINAL_ID']);
  assert.equal(Object.hasOwn(tasksMcpServer(home).env, 'HC_TERMINAL_ID'), false);
  const flags = sessionArgv(claude, ['claude', '--mcp-config', 'existing.json'], { tasksMcpHome: home });
  assert.equal(JSON.parse(flags[2]).mcpServers.herdr_tasks.env.HERDR_APP_HOME, home);
  assert.equal(Object.hasOwn(JSON.parse(flags[2]).mcpServers.herdr_tasks, 'env_vars'), false);
  assert.deepEqual(flags.slice(3), ['--mcp-config', 'existing.json']);
  assert.deepEqual(sessionArgv(codex, ['codex']), ['codex']);
});
