import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sessionKind, settingsKey } from '../mods/devkits/components/session-model.js';
import { evaluateNative } from './source-harness.js';
import { migrateSharedMcp } from '../mods/devkits/shared-mcp-migrate.js';

const config = { version: 1, servers: { vs: { command: 'bridge', args: ['繁體中文', 'C:\\with spaces\\bridge', 'quote"'] }, ic: { url: 'http://127.0.0.1:18765/mcp' } },
  profiles: { work: { ic: false }, review: { vs: { command: 'review-bridge' } } } };
const host = { sessionKind, settingsKey, appHome: () => '/herdr', readTextFile: async () => JSON.stringify(config) };
const load = extra => evaluateNative('../mods/devkits/components/shared-mcp.js', { ...host, ...extra }, 'parseSharedMcp, sharedMcpArgv, sessionMcpArgv, mcpToml');

test('shared MCP inherits account exceptions, applies agent overrides and preserves explicit CLI precedence', async () => {
  const { parseSharedMcp, sharedMcpArgv } = await load();
  const shared = parseSharedMcp(JSON.stringify(config));
  const agent = { key: 'review', profileKey: 'devkits-codex-work' };
  shared.profiles['devkits-codex-work'] = shared.profiles.work;
  const original = ['env', 'CODEX_HOME=/account', 'codex', '-c', 'mcp_servers.vs.command="explicit"', '--', 'prompt'];
  const argv = sharedMcpArgv(agent, original, shared);
  assert.ok(argv.includes('mcp_servers.vs={"command"="review-bridge"}'));
  assert.ok(argv.includes('mcp_servers.ic={"url"="http://127.0.0.1:18765/mcp","enabled"=false}'));
  assert.deepEqual(argv.slice(-4), original.slice(-4));
  assert.deepEqual(original.slice(0, 3), ['env', 'CODEX_HOME=/account', 'codex']);
  delete shared.servers.ic;
  assert.ok(!sharedMcpArgv(agent, ['codex'], shared).some(arg => arg.startsWith('mcp_servers.ic')));
});

test('launch preparation reads one local file, never writes or spawns, and skips other providers', async () => {
  const reads = [], { sessionMcpArgv } = await load({ readTextFile: async path => { reads.push(path); return JSON.stringify(config); } });
  await sessionMcpArgv({ key: 'codex' }, ['codex']);
  assert.deepEqual(reads, ['/herdr/data/devkits/codex-mcp.json']);
  await sessionMcpArgv({ key: 'claude' }, ['claude']);
  assert.equal(reads.length, 1);
  const absent = await load({ readTextFile: async () => null });
  assert.deepEqual(await absent.sessionMcpArgv({ key: 'codex' }, ['codex']), ['codex']);
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
  const shared = { ...config, profiles: { codex: { ic: false } } };
  const argv = sharedMcpArgv({ key: 'codex' }, ['codex', 'mcp', 'list', '--json'], shared);
  const result = await promisify(execFile)('codex', argv.slice(1), { env: { ...process.env, CODEX_HOME: directory }, timeout: 15000, windowsHide: true });
  const servers = JSON.parse(result.stdout);
  assert.deepEqual(servers.find(server => server.name === 'vs').transport.args, config.servers.vs.args);
  assert.equal(servers.find(server => server.name === 'ic').enabled, false);
});

test('explicit migration backs up accounts, preserves different transports and leaves unrelated MCP settings alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkits-mcp-migrate-'));
  const profiles = [{ key: 'codex', directory: join(root, 'main') }, { key: 'work', directory: join(root, 'work') }];
  for (const profile of profiles) { await mkdir(profile.directory); await writeFile(join(profile.directory, 'config.toml'), '# private settings\n'); }
  const data = new Map(profiles.map((profile, index) => [profile.directory, { mcp_servers: { vs: { command: index ? 'custom' : 'bridge' }, remote: { url: 'https://private.example' } } }]));
  const writes = [], closed = [];
  const service = async directory => ({ config: data.get(directory), close: async () => closed.push(directory), write: async edits => writes.push([directory, edits]) });
  const file = join(root, 'shared.json');
  await migrateSharedMcp({ file, profiles, names: ['vs'] }, service);
  const result = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(result.servers, { vs: { command: 'bridge' } });
  assert.deepEqual(result.profiles.work, { vs: { command: 'custom' } });
  assert.equal(writes.length, 2);
  assert.equal(writes[0][1][0].keyPath, 'mcp_servers."vs"');
  assert.equal(writes[0][1].length, 1);
  assert.equal(await readFile(join(profiles[0].directory, 'config.toml.before-shared-mcp.bak'), 'utf8'), '# private settings\n');
  assert.equal(closed.length, 2);
});
