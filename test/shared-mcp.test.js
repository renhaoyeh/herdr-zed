import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sessionKind, settingsKey, sessionArgv, tasksMcpServer } from '../components/session-model.js';
import { evaluateNative } from './source-harness.js';
import { parseSharedMcp, mcpToml, platformSharedMcp, claudeMcpConfig } from '../components/shared-mcp-model.js';
import { syncSharedMcp } from '../mods/herdr-zed-agents/shared-mcp-sync.js';

const config = { version: 1, servers: { vs: { command: 'bridge', args: ['繁體中文', 'C:\\with spaces\\bridge', 'quote"'] }, ic: { url: 'http://127.0.0.1:18765/mcp' } } };

const host = { parseSharedMcp, mcpToml, platformSharedMcp, claudeMcpConfig, window: () => ({ platform: 'windows' }), home: () => '/home', exec: async () => ({ code: 0 }), sessionKind, tasksMcpServer, settingsKey, appHome: () => '/herdr', readTextFile: async () => JSON.stringify(config) };
const load = extra => evaluateNative('../components/shared-mcp.js', { ...host, ...extra }, 'parseSharedMcp, sharedMcpArgv, sessionMcpArgv, mcpToml');

test('shared MCP accepts only the current schema and preserves explicit CLI precedence', async () => {
  const { parseSharedMcp, sharedMcpArgv } = await load();
  const shared = parseSharedMcp(JSON.stringify(config));
  const agent = { key: 'review', profileKey: 'herdr-zed-codex-work' };
  assert.throws(() => parseSharedMcp(JSON.stringify({ ...config, profiles: {} })), /Unsupported shared MCP fields/);
  const original = ['env', 'CODEX_HOME=/account', 'codex', '-c', 'mcp_servers.vs.command="explicit"', '--', 'prompt'];
  const argv = sharedMcpArgv(agent, original, shared);
  assert.ok(argv.includes(`mcp_servers.vs=${mcpToml(config.servers.vs)}`));
  assert.ok(argv.includes('mcp_servers.ic={"url"="http://127.0.0.1:18765/mcp"}'));
  assert.deepEqual(argv.slice(-4), original.slice(-4));
  assert.deepEqual(original.slice(0, 3), ['env', 'CODEX_HOME=/account', 'codex']);
  delete shared.servers.ic;
  assert.ok(!sharedMcpArgv(agent, ['codex'], shared).some(arg => arg.startsWith('mcp_servers.ic')));
});

test('launch preparation synchronizes account defaults before returning argv and skips other providers', async () => {
  const calls = [];
  const reads = [], { sessionMcpArgv } = await load({ exec: async (...args) => { calls.push(args); return { code: 0 }; }, readTextFile: async path => { reads.push(path); return JSON.stringify(config); } });
  await sessionMcpArgv({ key: 'review', profileKey: 'herdr-zed-codex-work' }, ['env', 'CODEX_HOME=/account', 'codex']);
  assert.equal(calls[0][1][1], '/account');
  assert.deepEqual(JSON.parse(calls[0][1][2]), { ...config.servers, herdr_tasks: tasksMcpServer('/herdr'),
    herdr_ecc: { command: 'node', args: ['/herdr/mods/herdr-zed-agents/ecc-mcp-server.cjs', '/herdr'], env: { HERDR_APP_HOME: '/herdr' } } });
  assert.deepEqual(JSON.parse(calls[0][1][2]).herdr_tasks.env_vars, ['HC_TERMINAL_ID']);
  assert.deepEqual(reads, ['/herdr/data/herdr-zed/shared-mcp.json']);
  await sessionMcpArgv({ key: 'claude' }, ['claude']);
  assert.equal(calls.length, 1, 'Claude never synchronizes account files');
  await sessionMcpArgv({ key: 'shell' }, ['zsh']);
  assert.equal(reads.length, 2);
  const absent = await load({ readTextFile: async () => null });
  assert.ok((await absent.sessionMcpArgv({ key: 'codex' }, ['codex'])).some(arg => arg.startsWith('mcp_servers.herdr_ecc=')));
});

test('malformed shared settings stop preparation and invalid edits are rejected', async () => {
  const { parseSharedMcp } = await load();
  for (const servers of [{ ic: { url: 'https://external.example/mcp' } }, { a: { command: 'x', args: [3] } }, { a: { command: 'x', enabled: 'false' } }, { a: null }]) {
    assert.throws(() => parseSharedMcp(JSON.stringify({ version: 1, servers })));
  }
  const broken = await load({ readTextFile: async () => '{broken' });
  await assert.rejects(broken.sessionMcpArgv({ key: 'codex' }, ['codex']));
});

test('Codex parses generated MCP arguments including Windows paths, quotes and disabled shared services', async () => {
  const { sharedMcpArgv } = await load();
  const directory = await mkdtemp(join(tmpdir(), 'devkits-mcp-cli-'));
  const shared = { ...config, servers: { ...config.servers, ic: { ...config.servers.ic, enabled: false } } };
  const argv = sharedMcpArgv({ key: 'codex' }, ['codex', 'mcp', 'list', '--json'], shared);
  const result = await promisify(execFile)('codex', argv.slice(1), { env: { ...process.env, CODEX_HOME: directory }, timeout: 15000, windowsHide: true });
  const servers = JSON.parse(result.stdout);
  assert.deepEqual(servers.find(server => server.name === 'vs').transport.args, config.servers.vs.args);
  assert.equal(servers.find(server => server.name === 'ic').enabled, false);
});

test('MCP synchronization replaces transports, cleans owned entries, preserves personal changes and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devkits-mcp-sync-'));
  await writeFile(join(directory, 'config.toml'), '# original\n');
  const old = { command: 'old', args: ['old'] }, changed = { command: 'personal-edit' };
  const state = { model: 'personal', mcp_servers: { update: old, remove: old, edited: changed, personal: old },
    herdr_zed_shared_mcp: { servers: { update: old, remove: old, edited: old } } };
  const desired = { update: { url: 'http://127.0.0.1:18765/mcp', enabled: false } };
  let writes = 0, closes = 0;
  const service = async () => ({ config: state, close: async () => closes++, write: async edits => {
    writes++;
    for (const edit of edits) {
      if (edit.keyPath === 'herdr_zed_shared_mcp') state.herdr_zed_shared_mcp = edit.value;
      else {
        const name = JSON.parse(edit.keyPath.slice('mcp_servers.'.length));
        if (edit.value === null) delete state.mcp_servers[name]; else state.mcp_servers[name] = edit.value;
      }
    }
  } });
  await syncSharedMcp(directory, desired, service);
  assert.deepEqual(state.mcp_servers, { ...desired, edited: changed, personal: old });
  assert.equal(state.model, 'personal');
  assert.equal(await readFile(join(directory, 'config.toml.before-herdr-zed-mcp-sync.bak'), 'utf8'), '# original\n');
  await syncSharedMcp(directory, desired, service);
  assert.equal(writes, 1); assert.equal(closes, 2);
  await syncSharedMcp(directory, {}, service);
  assert.deepEqual(state.mcp_servers, { edited: changed, personal: old });
});

test('real Codex config persists complete disabled transports and supports background enabled-only overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devkits-mcp-persist-'));
  await writeFile(join(directory, 'config.toml'), '# preserve comment\nmodel = "personal"\n[mcp_servers.own]\ncommand = "personal-server"\n[mcp_servers.ic]\nurl = "http://127.0.0.1:18765/mcp"\nenabled = false\n');
  const servers = { ic: { url: 'http://127.0.0.1:18765/mcp', enabled: false }, brandNew: { command: 'node', args: ['server.js'] } };
  await syncSharedMcp(directory, servers);
  const run = args => promisify(execFile)('codex', args, { env: { ...process.env, CODEX_HOME: directory }, timeout: 15000, windowsHide: true });
  const result = JSON.parse((await run(['-c', 'mcp_servers.ic.enabled=false', 'mcp', 'list', '--json'])).stdout);
  assert.equal(result.find(server => server.name === 'ic').transport.url, servers.ic.url);
  assert.equal(result.find(server => server.name === 'ic').enabled, false);
  assert.ok(result.find(server => server.name === 'own'));
  assert.match(await readFile(join(directory, 'config.toml'), 'utf8'), /# preserve comment/);
  await syncSharedMcp(directory, {});
  const after = JSON.parse((await run(['mcp', 'list', '--json'])).stdout);
  assert.deepEqual(after.map(server => server.name).sort(), ['ic', 'own']);
});

test('synchronization failure prevents launching with incomplete settings', async () => {
  const { sessionMcpArgv } = await load({ exec: async () => ({ code: 1, stderr: 'sync failed' }) });
  await assert.rejects(sessionMcpArgv({ key: 'codex' }, ['codex']), /sync failed/);
});

test('local launch persists Tasks transport without shared settings for background title generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devkits-title-mcp-'));
  await writeFile(join(directory, 'config.toml'), '# account settings\n[mcp_servers.own]\ncommand = "personal-server"\n[mcp_servers.herdr_tasks]\ncommand = "node"\nargs = ["/herdr/mods/herdr-zed-tasks/mcp-server.cjs"]\nenabled = false\n');
  const appDirectory = 'C:\\Users\\A B\\herdr';
  let synchronized = false;
  const { sessionMcpArgv } = await load({
    appHome: () => appDirectory, readTextFile: async () => null,
    exec: async (_command, args) => {
      assert.equal(args[1], directory);
      await syncSharedMcp(args[1], JSON.parse(args[2]));
      synchronized = true;
      return { code: 0 };
    },
  });
  const agent = { key: 'codex' };
  const argv = sessionArgv(agent, ['env', `CODEX_HOME=${directory}`, 'codex'], { tasksMcpHome: appDirectory });
  assert.ok((await sessionMcpArgv(agent, argv)).some(arg => arg.startsWith('mcp_servers.herdr_ecc=')));
  assert.equal(synchronized, true);
  // Like the background title worker, supply only disabled flags, with no launch transports.
  const result = await promisify(execFile)('codex', ['-c', 'mcp_servers.herdr_tasks.enabled=false',
    '-c', 'mcp_servers.own.enabled=false', 'mcp', 'list', '--json'], {
    env: { ...process.env, CODEX_HOME: directory }, timeout: 15000, windowsHide: true,
  });
  const servers = JSON.parse(result.stdout), tasks = servers.find(server => server.name === 'herdr_tasks');
  assert.equal(tasks.enabled, false);
  assert.equal(tasks.transport.command, 'node');
  assert.deepEqual(tasks.transport.args, tasksMcpServer(appDirectory).args);
  assert.deepEqual(tasks.transport.env, { HERDR_APP_HOME: appDirectory });
  assert.equal(servers.find(server => server.name === 'own').transport.command, 'personal-server');
  assert.match(await readFile(join(directory, 'config.toml'), 'utf8'), /# account settings/);
});

test('automatic MCP synchronization excludes Windows-only transports on other platforms without rewriting shared source', async () => {
  const source = JSON.stringify({ version: 1, servers: { visual_studio: { command: 'C:/VS/bridge.exe' }, browser: { command: 'browser' } } });
  for (const platform of ['windows', 'macos', 'linux']) {
    const calls = [];
    const { sessionMcpArgv } = await load({ window: () => ({ platform }), readTextFile: async () => source,
      exec: async (...args) => { calls.push(args); return { code: 0 }; } });
    const argv = await sessionMcpArgv({ key: 'codex' }, ['codex']);
    const synchronized = JSON.parse(calls[0][1][2]);
    assert.equal(Boolean(synchronized.visual_studio), platform === 'windows');
    assert.equal(argv.some(arg => arg.startsWith('mcp_servers.visual_studio=')), platform === 'windows');
    assert.ok(synchronized.browser && synchronized.herdr_tasks);
    assert.ok(JSON.parse(source).servers.visual_studio);
  }
});

test('clearing Zed restores a displaced Devkits MCP connection and removes only its own ownership marker', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-zed-mcp-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'config.toml'), '# keep account settings\n');
  const devkits = { command: 'node', args: ['/herdr/mods/devkits-tasks/mcp-server.cjs'] };
  const zed = { command: 'node', args: ['/herdr/mods/herdr-zed-tasks/mcp-server.cjs'] };
  const state = { mcp_servers: { herdr_tasks: devkits }, devkits_shared_mcp: { servers: { herdr_tasks: devkits } } };
  const service = async () => ({ config: state, close: async () => {}, write: async edits => {
    for (const edit of edits) {
      if (edit.keyPath === 'herdr_zed_shared_mcp') {
        if (edit.value === null) delete state.herdr_zed_shared_mcp; else state.herdr_zed_shared_mcp = edit.value;
      } else {
        const name = JSON.parse(edit.keyPath.slice('mcp_servers.'.length));
        if (edit.value === null) delete state.mcp_servers[name]; else state.mcp_servers[name] = edit.value;
      }
    }
  } });
  await syncSharedMcp(directory, { herdr_tasks: zed }, service);
  assert.deepEqual(state.mcp_servers.herdr_tasks, zed);
  await syncSharedMcp(directory, { herdr_tasks: zed }, service);
  await syncSharedMcp(directory, {}, service);
  assert.deepEqual(state.mcp_servers.herdr_tasks, devkits);
  assert.deepEqual(state.devkits_shared_mcp, { servers: { herdr_tasks: devkits } });
  assert.equal(Object.hasOwn(state, 'herdr_zed_shared_mcp'), false);
});

test('Claude receives enabled shared servers as one per-launch MCP config before explicit arguments', async () => {
  const source = { version: 1, servers: {
    vs: { command: 'bridge', args: ['a b'], env_vars: ['HC_TERMINAL_ID'], startup_timeout_sec: 20 },
    ic: { url: 'http://127.0.0.1:18765/mcp', bearer_token_env_var: 'IC_TOKEN', env_http_headers: { 'X-Key': 'IC_KEY' } },
    off: { command: 'off', enabled: false }, herdr_tasks: { command: 'shadow' }, visual_studio: { command: 'C:/VS/bridge.exe' } } };
  const { sessionMcpArgv } = await load({ window: () => ({ platform: 'macos' }), readTextFile: async () => JSON.stringify(source),
    exec: async () => { throw new Error('Claude must not synchronize files'); } });
  const original = ['env', 'CLAUDE_CONFIG_DIR=/account', 'claude', '--mcp-config', '{"mcpServers":{"herdr_tasks":{}}}', '--', 'prompt'];
  const argv = await sessionMcpArgv({ key: 'claude' }, original);
  assert.deepEqual(argv.slice(0, 4), ['env', 'CLAUDE_CONFIG_DIR=/account', 'claude', '--mcp-config']);
  assert.deepEqual(argv.slice(5), original.slice(3));
  assert.deepEqual(JSON.parse(argv[4]), { mcpServers: {
    herdr_ecc: { type: 'stdio', command: 'node', args: ['/herdr/mods/herdr-zed-agents/ecc-mcp-server.cjs', '/herdr'] },
    vs: { type: 'stdio', command: 'bridge', args: ['a b'] },
    ic: { type: 'http', url: 'http://127.0.0.1:18765/mcp', headers: { 'X-Key': '${IC_KEY}', Authorization: 'Bearer ${IC_TOKEN}' } } } });
  const empty = await load({ readTextFile: async () => null });
  assert.ok((await empty.sessionMcpArgv({ key: 'claude' }, ['claude'])).includes('--mcp-config'));
});
