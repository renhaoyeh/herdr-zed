import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as model from '../mods/devkits/components/session-model.js';
import { evaluateNative } from './source-harness.js';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
const clock = errors => {
  const timers = [], cx = { notify() {}, timer: { every(ms, tick) { timers.push({ ms, tick }); } },
    spawn(fn) { fn(cx).catch(error => errors.push(error)); } };
  return { cx, timers };
};
async function setup(options = {}) {
  const memory = {}, writes = [], queries = [], discoveries = [], errors = [], endpoints = [];
  const available = [{ key: 'codex', name: 'Codex', installed: true, run: ['codex', 'PRIVATE=hidden'] }];
  const endpoint = name => {
    const endpoint = { name, queue: [], waiting: null }; endpoints.push(endpoint);
    return { ...model,
      layout: () => ({ content: { mod: 'devkits-usage', props: { view: 'service' } } }),
      globalThis: { window: { sessionStorage: { getItem: () => null, setItem() {} } } },
      shared: key => clone(memory[key]), setShared: (key, value) => { memory[key] = clone(value); writes.push(key); },
      appHome: () => '/herdr', home: () => '/home', readTextFile: async () => null,
      knownAgents: async args => { discoveries.push(args); return options.discover ? options.discover(args) : available; },
      ensureClaudeStatusLine: async () => {},
      exec: async (command, args) => {
        queries.push([command, args]);
        assert.match(args[0], /mods\/devkits-usage\/usage-reader.js$/);
        return { code: 0, stdout: JSON.stringify(JSON.parse(args[1]).map(account => ({ key: account.key, secret: 'hidden',
          plan: 'plus', email: null, windows: [{ bucket: 'codex', name: 'Codex', minutes: 300, usedPercent: 42, resetsAt: Date.now() / 1000 + 1800, secret: 'hidden' }] }))) };
      },
      nextCommand: () => endpoint.queue.length ? Promise.resolve(endpoint.queue.shift()) : new Promise(resolve => { endpoint.waiting = resolve; }),
      run: command => {
        const index = command.indexOf('.'), name = command.slice(0, index), message = command.slice(index + 1);
        for (const target of endpoints.filter(endpoint => endpoint.name === name)) {
          if (target.waiting) { const resolve = target.waiting; target.waiting = null; resolve(message); }
          else target.queue.push(message);
        }
      },
    };
  };
  const exports = 'UsageClient, usageClientPrefix, usageRefreshPrefix, usageMessage, usageCommand';
  const owner = endpoint('devkits-usage');
  Object.assign(owner, await evaluateNative('../mods/devkits/components/usage.js', owner, exports));
  Object.assign(owner, await evaluateNative('../mods/devkits-usage/monitor.js', owner, 'UsageMonitor'));
  const { UsageService } = await evaluateNative('../mods/devkits-usage/service.js', owner, 'UsageService');
  const service = new UsageService(), serviceClock = clock(errors); service.init(serviceClock.cx);
  const client = async config => {
    const host = endpoint(`consumer-${endpoints.length}`);
    const { UsageClient } = await evaluateNative('../mods/devkits/components/usage.js', host, 'UsageClient');
    const client = new UsageClient(config); client.init(clock(errors).cx); return client;
  };
  return { memory, writes, queries, discoveries, errors, available, owner, service, serviceClock, client };
}

test('one Usage service serves isolated consumers, coalesces quota queries and publishes only display data', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const h = await setup(); assert.equal(h.queries.length, 0);
  const one = await h.client(), two = await h.client(); await flush();
  assert.equal(h.queries.length, 1); assert.equal(one.snapshot().usage[0].windows[0].usedPercent, 42);
  assert.deepEqual(one.snapshot(), two.snapshot());
  assert.equal(JSON.stringify(one.snapshot()).includes('hidden'), false);
  assert.equal(one.snapshot().choices[0].agent.run, undefined);
  const changed = h.writes.length; one.snapshot(); two.snapshot(); assert.equal(h.writes.length, changed, 'Reading a snapshot never queries or writes state');
  one.close(); await flush(); assert.equal(h.service.active(null), true);
  two.close(); now += 5001;
  for (const timer of h.serviceClock.timers) timer.tick(h.serviceClock.cx);
  await flush(); assert.equal(h.service.active(null), false); assert.deepEqual(h.errors, []);
  assert.equal(h.queries.length, 1, 'Expired leases never trigger another quota read');
});

test('the host controls visibility and disabling during discovery prevents a provider query', async () => {
  let finish, visible = false;
  const h = await setup({ discover: () => new Promise(resolve => { finish = resolve; }) });
  const client = await h.client({ active: () => visible }); await flush();
  assert.equal(h.discoveries.length, 0); assert.equal(h.queries.length, 0);
  visible = true; client.sync(); await flush(); assert.equal(typeof finish, 'function');
  visible = false; client.sync(); await flush(); finish(h.available); await flush();
  assert.equal(h.queries.length, 0); assert.equal(h.service.active(null), false);
  visible = true; client.sync(); await flush();
  assert.equal(h.queries.length, 1, 'Re-enabling retries an aborted discovery immediately');
  assert.equal(client.snapshot().loading, false); assert.deepEqual(h.errors, []);
});

test('the quota cache survives provider reloads and manual refresh bypasses it without duplicate requests', async () => {
  const h = await setup(), client = await h.client(); await flush(); assert.equal(h.queries.length, 1);
  h.service.monitors.clear(); client.heartbeat(); await flush();
  assert.equal(h.queries.length, 1, 'A fresh provider monitor reuses the existing five-minute cache');
  assert.equal(client.snapshot().usage[0].windows[0].usedPercent, 42);
  client.refresh(); client.refresh(); await flush();
  assert.equal(h.queries.length, 2); assert.equal(h.discoveries.length, 2, 'Manual refresh rediscovers profiles once');
  assert.deepEqual(h.errors, []);
});

test('local and remote consumers keep separate snapshots and remote projects never query local quotas', async () => {
  const h = await setup({ discover: args => args.on ? [{ key: 'codex', name: 'Remote Codex', installed: true, run: ['codex'] },
    { key: 'devkits-codex-local', name: 'Local account', installed: true, run: ['codex'] }] : [{ key: 'codex', name: 'Local Codex', installed: true, run: ['codex'] }] });
  const local = await h.client(), remote = await h.client({ context: () => ({ machine: 'remote' }) }); await flush();
  assert.equal(h.queries.length, 1); assert.equal(local.snapshot().choices[0].name, 'Local Codex');
  assert.equal(remote.snapshot().choices[0].name, 'Remote Codex'); assert.equal(remote.snapshot().choices.length, 1);
  assert.equal(remote.snapshot().choices[0].provider, null); assert.deepEqual(remote.snapshot().usage, []);
  remote.refresh(); await flush(); assert.equal(h.queries.length, 1); assert.deepEqual(h.errors, []);
});

test('expired consumer leases stop automatic quota refreshes and unchanged heartbeats do not republish data', async t => {
  let now = 1000000; t.mock.method(Date, 'now', () => now);
  const h = await setup(), client = await h.client(); await flush();
  const changed = h.writes.length; client.heartbeat(); await flush();
  assert.equal(h.writes.length, changed);
  now += 6 * 60000;
  for (const timer of h.serviceClock.timers) timer.tick(h.serviceClock.cx); await flush();
  assert.equal(h.service.active(null), false); assert.equal(h.queries.length, 1);
  client.heartbeat(); await flush(); assert.equal(h.queries.length, 2); assert.deepEqual(h.errors, []);
});

test('the configured Claude hook stays idempotent and preserves existing chains and backups', async () => {
  const previous = { type: 'command', command: 'node "/app/mods/devkits-usage/claude-statusline.js"', padding: 2 };
  const files = { '/profile/settings.json': JSON.stringify({ statusLine: previous }), '/profile/devkits-statusline-chain.json': 'original chain', '/profile/settings.json.devkits-backup': 'original backup' }, written = [];
  const { ensureClaudeStatusLine } = await evaluateNative('../mods/devkits/components/claude-usage-hook.js', {
    appHome: () => '/app', readTextFile: async path => files[path] ?? null,
    writeTextFile: async (path, text, expected) => { assert.equal(files[path] ?? null, expected); files[path] = text; written.push(path); },
  }, 'ensureClaudeStatusLine');
  assert.equal(await ensureClaudeStatusLine('/profile', { chain: true }), false);
  assert.equal(JSON.parse(files['/profile/settings.json']).statusLine.command, 'node "/app/mods/devkits-usage/claude-statusline.js"');
  assert.deepEqual(written, []);
  assert.equal(files['/profile/devkits-statusline-chain.json'], 'original chain'); assert.equal(files['/profile/settings.json.devkits-backup'], 'original backup');
  assert.equal(await ensureClaudeStatusLine('/profile', { chain: true }), false);
});

test('the Usage mod status-line entry records usage directly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'devkits-hook-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../mods/devkits-usage/claude-statusline.js', import.meta.url));
  const result = spawnSync(process.execPath, [script], { env: { ...process.env, CLAUDE_CONFIG_DIR: directory },
    input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42 } } }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '5h 42%');
  const saved = JSON.parse(await readFile(join(directory, 'devkits-usage.json'), 'utf8'));
  assert.equal(saved.rate_limits.five_hour.used_percentage, 42);
});
