import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sessions from '../mods/devkits/components/session-model.js';
import { evaluateNative } from './source-harness.js';

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
async function modules(overrides = {}) {
  const memory = {}, queue = [], calls = [];
  const host = { ...sessions, appHome: () => '/herdr',
    shared: key => clone(memory[key]), setShared: (key, value) => { memory[key] = clone(value); },
    layout: () => ({ id: 'root', children: [{ content: { mod: 'devkits-agents', props: { view: 'service' } } }] }),
    run: (...args) => calls.push(args), openOverlay: spec => spec, spaces: () => [],
    ensureRules: async () => {}, discoverAgents: async () => [{ key: 'codex' }],
    prepareSession: async (agent, target, options) => ({ argv: [agent.key, options.model || 'default'], session: {} }),
    ...overrides,
  };
  const { AgentClient } = await evaluateNative('../mods/devkits/components/agents.js', host, 'AgentClient');
  const { AgentsService } = await evaluateNative('../mods/devkits-agents/service.js', host, 'AgentsService');
  const cx = { timer: { every() {} }, spawn(fn) { queue.push(fn(this)); }, notify() {} };
  const service = new AgentsService(), client = new AgentClient(); client.init(cx);
  const drain = async () => { service.poll(cx); await Promise.all(queue.splice(0)); client.poll(); };
  return { host, memory, client, service, drain, calls };
}

test('isolated Agents clients use serialized discovery and preparation without creating tabs or tasks', async () => {
  const h = await modules();
  const discovery = h.client.discover(null); await h.drain();
  assert.deepEqual(await discovery, [{ key: 'codex' }]);
  const preparation = h.client.prepare({ key: 'codex' }, { space: 'one' }, { model: 'chosen' }); await h.drain();
  assert.deepEqual((await preparation).argv, ['codex', 'chosen']);
  assert.deepEqual(h.memory['devkits.agents.requests'], []);
  assert.deepEqual(h.memory['devkits.agents.results'], {});
  assert.deepEqual(h.calls, []);
  assert.ok(!Object.keys(h.memory).some(key => key.includes('tasks') || key.includes('thread')));
});

test('preparation failures reach the caller and cancelled in-flight replies are discarded', async () => {
  const failure = await modules({ prepareSession: async () => { throw new Error('Shared MCP config is invalid'); } });
  const pending = failure.client.prepare({ key: 'codex' });
  const rejection = assert.rejects(pending, /Shared MCP config is invalid/);
  await failure.drain(); await rejection;
  let finish, reads = 0;
  const h = await modules({ prepareSession: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
  const cancelled = h.client.prepare({ key: 'codex' });
  const rejected = assert.rejects(cancelled, /cancelled/);
  h.service.poll({ spawn(fn) { this.promise = fn({ notify() {} }); }, promise: null });
  h.service.poll({ spawn() { assert.fail('Pending preparation must not run twice'); } });
  h.client.close(); await rejected;
  finish({ argv: ['codex'] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.deepEqual(h.memory['devkits.agents.results'], {});
});

test('unmounted and expired requests fail without hanging or retaining transport data', async () => {
  const unavailable = await modules({ layout: () => null });
  await assert.rejects(unavailable.client.prepare({ key: 'codex' }), /unavailable/);
  const h = await modules();
  const pending = h.client.discover();
  const rejected = assert.rejects(pending, /timed out/);
  for (const item of h.client.pending.values()) item.expiresAt = 0;
  h.client.poll(); await rejected;
  h.client.close();
});

test('one client consuming its reply preserves another client’s pending reply', async () => {
  const h = await modules(), other = new h.client.constructor();
  other.init({ timer: { every() {} } });
  const first = h.client.discover(), second = other.discover('remote');
  await h.drain();
  assert.deepEqual(await first, [{ key: 'codex' }]);
  assert.equal(Object.keys(h.memory['devkits.agents.results']).length, 1);
  other.poll(); assert.deepEqual(await second, [{ key: 'codex' }]);
  assert.deepEqual(h.memory['devkits.agents.results'], {});
});
