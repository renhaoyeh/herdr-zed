import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tasksMcpCall } from '../mods/herdr-zed-tasks/mcp-api.js';
import { sessionArgv, tasksMcpServer } from '../components/session-model.js';
import { evaluateNative } from './source-harness.js';
const { start } = createRequire(import.meta.url)('../mods/herdr-zed-tasks/mcp-server.cjs');

test('inbox helper creates an isolated directory and lists only published UUID requests', async t => {
  const home = await mkdtemp(join(tmpdir(), 'herdr tasks inbox '));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'inbox'), id = '12345678-1234-1234-1234-123456789abc';
  const list = () => JSON.parse(execFileSync(process.execPath,
    [fileURLToPath(new URL('../mods/herdr-zed-tasks/mcp-server.cjs', import.meta.url)), '--pending', directory], { encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(list(), []);
  for (const name of [`${id}.tmp`, `${id}.json`, `${id}.request.json`, 'invalid.request.json'])
    await writeFile(join(directory, name), '{}');
  assert.deepEqual(list(), [`${id}.request.json`]);
});

test('native check mode never starts a Tasks inbox or process', async () => {
  const { TasksMcpBridge } = await evaluateNative('../mods/herdr-zed-tasks/mcp-bridge.js', { checking: () => true }, 'TasksMcpBridge');
  new TasksMcpBridge().init({}, {});
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

test('hidden bridge uses startup and watcher events without timers, rejects expiry and deduplicates', async () => {
  const id = '12345678-1234-1234-1234-123456789abc', file = `${id}.request.json`;
  const writes = [], calls = [], batches = [[file], [file], [file]]; let reads = 0, scans = 0;
  const { TasksMcpBridge } = await evaluateNative('../mods/herdr-zed-tasks/mcp-bridge.js', {
    checking: () => false, appHome: () => '/herdr',
    exec: async () => { scans++; return { code: 0, stdout: JSON.stringify(['../../escape', file]) }; },
    watchFolder: async () => { if (!batches.length) throw Error('stop'); return batches.shift(); },
    readTextFile: async path => path.endsWith('/service.json') ? null : JSON.stringify({ id, until: ++reads === 1 ? Date.now() - 100 : Date.now() + 5000, name: 'create_task', args: {} }),
    writeTextFile: async (path, text) => writes.push({ path, result: JSON.parse(text) }),
    tasksMcpCall: () => { calls.push(1); return { task: { gid: 'one' } }; }, console: { log() {} },
  }, 'TasksMcpBridge');
  // Deliberately no timer API: background transport must never schedule polling.
  const cx = { notify() {}, spawn(fn) { return fn(cx); } };
  let pending; new TasksMcpBridge().init({ refresh() {} }, { ...cx, spawn(fn) { pending = fn(cx); } });
  await pending;
  assert.equal(scans, 2, 'Only startup scans; individual file events require no helper');
  assert.equal(calls.length, 1);
  const responses = writes.filter(write => !write.path.endsWith('/service.json'));
  assert.equal(responses.length, 1);
  const journal = writes.filter(write => write.path.endsWith('/service.json')).at(-1).result;
  assert.ok(journal.events.some(event => event.event === 'request.ignored'));
  assert.equal(journal.events.at(-1).event, 'watch.stopped');
  assert.equal(journal.events.at(-1).error, 'stop');
  assert.equal(responses[0].path, `/herdr/data/herdr-zed/tasks-mcp/${id}.json`);
});

test('Supervisor reports carry the server terminal with explicit stage runs and validate verdicts', async () => {
  const input = new PassThrough(), output = new PassThrough(), calls = [];
  let raw = ''; output.on('data', chunk => { raw += chunk; });
  const server = start(input, output, async (_name, args) => { calls.push(args); return { task: { run: args.run } }; });
  const send = (id, method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const previous = process.env.HC_TERMINAL_ID;
  try {
    process.env.HC_TERMINAL_ID = 't-review';
    send(1, 'initialize', {});
    send(2, 'tools/call', { name: 'report_task', arguments: { run: 'stage:review', status: 'done', message: 'Reviewed diff', verdict: 'pass' } });
    send(3, 'tools/call', { name: 'report_task', arguments: { run: 'stage:review', status: 'done', message: 'Invalid', verdict: 'maybe' } });
    await server.drained();
    assert.deepEqual(calls, [{ run: 'stage:review', status: 'done', message: 'Reviewed diff', verdict: 'pass', terminal: 't-review' }]);
    assert.equal(JSON.parse(raw.trim().split('\n').at(-1)).result.isError, true);
  } finally {
    server.lines.close();
    if (previous === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = previous;
  }
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


test('client timeout persists correlated diagnostics without request payloads', async t => {
  const home = await mkdtemp(join(tmpdir(), 'herdr-tasks-diagnostics-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = await readFile(new URL('../mods/herdr-zed-tasks/mcp-server.cjs', import.meta.url), 'utf8');
  const require = createRequire(import.meta.url), endpoint = { exports: {} };
  const { runInNewContext } = await import('node:vm');
  let now = 100000;
  class Clock extends Date { static now() { return now; } }
  runInNewContext(source, { module: endpoint, process: { pid: 42, env: { HERDR_APP_HOME: home }, stderr: { write() {} } }, Date: Clock,
    require: name => name === 'node:timers/promises' ? { setTimeout: async () => { now += 11000; } } : require(name) });
  await assert.rejects(endpoint.exports.bridge('report_task', { message: 'PRIVATE BODY', run: 'private-run' }), /Diagnostics:/);
  const journal = await readFile(join(home, 'data/herdr-zed/tasks-mcp-diagnostics/client-42.json'), 'utf8');
  const events = JSON.parse(journal).events;
  assert.deepEqual(events.map(event => event.event), ['request.start', 'request.published', 'request.timeout', 'request.error']);
  assert.ok(events.every(event => event.id === events[0].id));
  assert.ok(events.every(event => event.name === 'report_task'));
  assert.ok(!journal.includes('PRIVATE BODY') && !journal.includes('private-run'));
  assert.deepEqual(await readdir(join(home, 'data/herdr-zed/tasks-mcp')), []);
});

test('service preserves scan and watcher failure details even when diagnostic writes fail', async () => {
  for (const writable of [true, false]) {
    const writes = [], messages = [];
    let pending;
    const { TasksMcpBridge } = await evaluateNative('../mods/herdr-zed-tasks/mcp-bridge.js', {
      checking: () => false, appHome: () => '/isolated',
      exec: async () => { throw Error('helper unavailable'); },
      watchFolder: () => { throw Error('watch limit reached'); },
      readTextFile: async () => writes.length ? JSON.stringify(writes.at(-1)) : null,
      writeTextFile: async (_path, contents, expected) => {
        if (!writable) throw Error('read only');
        assert.equal(expected, writes.length ? JSON.stringify(writes.at(-1)) : null);
        writes.push(JSON.parse(contents));
      },
      console: { log: message => messages.push(message) },
    }, 'TasksMcpBridge');
    const cx = { spawn(fn) { pending = fn(cx); } };
    new TasksMcpBridge().init({}, cx);
    await pending;
    if (writable) {
      const events = writes.at(-1).events;
      assert.equal(events[0].event, 'service.start');
      assert.equal(events.find(event => event.event === 'scan.error').error, 'helper unavailable');
      assert.equal(events.at(-1).event, 'watch.stopped');
      assert.match(events.at(-1).stack, /watch limit reached/);
    } else assert.ok(messages.some(message => message.includes('diagnostic write failed')));
    assert.ok(messages.some(message => message.includes('Tasks MCP watch: watch limit reached')));
  }
});


test('runtime initialization failures persist before starting the inbox', async () => {
  const writes = []; let pending;
  const { TasksMcpBridge } = await evaluateNative('../mods/herdr-zed-tasks/mcp-bridge.js', {
    checking: () => false, appHome: () => '/isolated',
    readTextFile: async () => writes.at(-1) || null,
    writeTextFile: async (_path, text) => { writes.push(text); }, console: { log() {} },
    exec: () => assert.fail('An uninitialized runtime must not accept requests'),
  }, 'TasksMcpBridge');
  const cx = { spawn(fn) { pending = fn(cx); } };
  new TasksMcpBridge().init({}, cx, () => { throw Error('interrupted in snapshot'); });
  await pending;
  const events = JSON.parse(writes.at(-1)).events;
  assert.equal(events[0].event, 'service.start');
  assert.equal(events.at(-1).event, 'service.init.error');
  assert.match(events.at(-1).stack, /interrupted in snapshot/);
});
