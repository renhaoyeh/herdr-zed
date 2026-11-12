import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import * as contract from '../components/extension-contract.js';
import { terminalArgv } from '../components/session-shell.js';
import * as sessions from '../components/session-model.js';
import { parseExtensionManifest, extensionMetadata } from '../mods/herdr-zed/extension-model.js';
import { evaluateNative } from './source-harness.js';

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

async function launcher({ platform = 'macos', spaces = [{ id: 'one', machine: null }], prepare, queued } = {}) {
  const memory = queued ? { 'herdr-zed.launch.requests': queued } : {};
  const host = { ...contract, terminalArgv, sessionKind: sessions.sessionKind, window: () => ({ platform }), spaces: () => spaces,
    shared: key => clone(memory[key]), setShared: (key, value) => { memory[key] = clone(value); },
    prepareSession: prepare || (async () => ({ argv: ['codex', '--model', 'gpt'], session: { model: 'gpt', effort: 'high' } })) };
  const { emitLaunch } = await evaluateNative('../mods/herdr-zed-agents/launch.js', host, 'emitLaunch');
  return { emitLaunch, memory };
}

const agent = { key: 'devkits-codex-work', name: 'Codex · work' };
const target = { space: 'one', folder: '/code/api', projectName: 'API', overlay: 'picker-1' };

test('a provider launch appends the prepared argv byte for byte; only local shells get the platform wrapper', async () => {
  const mac = await launcher();
  const result = await mac.emitLaunch(agent, target, {});
  const [request] = mac.memory['herdr-zed.launch.requests'];
  assert.equal(result.id, request.id);
  assert.deepEqual({ model: result.model, effort: result.effort, profile: result.profile }, { model: 'gpt', effort: 'high', profile: 'devkits-codex-work' });
  assert.deepEqual(request.argv, ['codex', '--model', 'gpt']);
  assert.deepEqual(request.target, target);
  assert.equal(request.source, 'agents'); assert.equal(request.name, 'Codex · work'); assert.equal(request.profile, 'devkits-codex-work');
  assert.ok(request.expiresAt > Date.now() && request.expiresAt <= Date.now() + 30000);
  assert.equal(Object.hasOwn(request, 'origin'), false);

  const windows = await launcher({ platform: 'windows' });
  await windows.emitLaunch(agent, target, {});
  assert.deepEqual(windows.memory['herdr-zed.launch.requests'][0].argv, terminalArgv(['codex', '--model', 'gpt'], 'windows'));

  const remote = await launcher({ platform: 'windows', spaces: [{ id: 'remote', machine: 'box' }] });
  await remote.emitLaunch(agent, { space: 'remote', folder: '/srv' }, {});
  assert.deepEqual(remote.memory['herdr-zed.launch.requests'][0].argv, ['codex', '--model', 'gpt']);
  assert.deepEqual(remote.memory['herdr-zed.launch.requests'][0].target, { space: 'remote', folder: '/srv', machine: 'box' });
});

test('appending a launch prunes expired queue entries and keeps unexpired ones the shell has not claimed yet', async () => {
  const expired = { id: 'launch:old', expiresAt: Date.now() - 1 }, waiting = { id: 'launch:waiting', expiresAt: Date.now() + 20000 };
  const h = await launcher({ queued: [expired, waiting] });
  await h.emitLaunch(agent, target, {});
  const queue = h.memory['herdr-zed.launch.requests'];
  assert.equal(queue.length, 2);
  assert.equal(queue[0].id, 'launch:waiting', 'the unexpired entry the shell has not claimed yet is kept');
  assert.equal(queue.some(item => item.id === 'launch:old'), false, 'the expired entry is pruned');
});

test('the Agents Terminal row sends herdr-zed.new-terminal and opens nothing itself', async () => {
  const source = await readFile(new URL('../mods/herdr-zed-agents/main.js', import.meta.url), 'utf8');
  const body = source.match(/\n  openTerminal\(target\) \{([\s\S]*?)\n  \}\n/)?.[1];
  assert.ok(body, 'openTerminal exists');
  assert.equal(body.trim(), 'run(`herdr-zed.${newTerminalCommand(target)}`);');
  for (const key of ['tab.new', 'space.new', 'layout.select', 'conversation-visible', 'selected-project', 'closeOverlay'])
    assert.equal(body.includes(key), false, `${key} belongs to the shell`);
  assert.match(source, /startThread\(agent, target = props\(\) \|\| \{\}, options = \{\}\) \{\n    if \(!agent\) \{ this\.openTerminal\(target\); return; \}/);
});

test('the caller origin is passed through to the launch request and malformed origins are refused', async () => {
  const h = await launcher();
  await h.emitLaunch(agent, target, {}, { extension: 'herdr-zed-tasks', ref: 'task-7' });
  assert.deepEqual(h.memory['herdr-zed.launch.requests'][0].origin, { extension: 'herdr-zed-tasks', ref: 'task-7' });
  await assert.rejects(h.emitLaunch(agent, target, {}, { extension: 'herdr-zed-tasks' }), /origin/);
  assert.equal(h.memory['herdr-zed.launch.requests'].length, 1);
});

test('a failed preparation or an unknown space rejects without appending a launch request', async () => {
  const failing = await launcher({ prepare: async () => { throw new Error('Shared MCP config is invalid'); } });
  await assert.rejects(failing.emitLaunch(agent, target, {}), /Shared MCP config is invalid/);
  assert.equal(failing.memory['herdr-zed.launch.requests'], undefined);
  const unknown = await launcher();
  await assert.rejects(unknown.emitLaunch(agent, { space: 'gone', folder: '/a' }, {}), /space is unknown/);
  assert.equal(unknown.memory['herdr-zed.launch.requests'], undefined);
});

test('AgentClient.launch forwards prepare options except origin and resolves with prepare metadata', async () => {
  const memory = {}, queue = [], seen = [];
  let fail = null;
  const host = { ...sessions, appHome: () => '/herdr', shared: key => clone(memory[key]), setShared: (key, value) => { memory[key] = clone(value); },
    layout: () => ({ content: { mod: 'herdr-zed-agents', props: { view: 'service' } } }), openOverlay: spec => spec, spaces: () => [],
    ensureRules: async () => {}, discoverAgents: async () => [], publishDecorations: () => {},
    emitLaunch: async (agent, target, options, origin) => {
      if (fail) throw fail;
      seen.push({ target, options, origin }); return { id: 'launch:1', model: options.model ?? null, effort: null, profile: agent.key };
    } };
  const { AgentClient } = await evaluateNative('../components/agents.js', host, 'AgentClient');
  const { AgentsService } = await evaluateNative('../mods/herdr-zed-agents/service.js', host, 'AgentsService');
  const cx = { timer: { every() {} }, spawn(fn) { queue.push(fn(this)); }, notify() {} };
  const service = new AgentsService(), client = new AgentClient(); client.init(cx);
  const drain = async () => { service.poll(cx); await Promise.all(queue.splice(0)); client.poll(); };

  const launched = client.launch({ key: 'codex', name: 'Codex' }, { space: 'one', folder: '/a' },
    { model: 'gpt', origin: { extension: 'herdr-zed-tasks', ref: 't1' } });
  await drain();
  assert.deepEqual(await launched, { id: 'launch:1', model: 'gpt', effort: null, profile: 'codex' });
  assert.deepEqual(seen[0].options, { model: 'gpt' });
  assert.deepEqual(seen[0].origin, { extension: 'herdr-zed-tasks', ref: 't1' });

  fail = new Error('boom');
  const failed = client.launch({ key: 'codex' }, { space: 'one', folder: '/a' });
  const rejection = assert.rejects(failed, /boom/);
  await drain(); await rejection;
  assert.equal(seen.length, 1);
});

test('thread decorations label each Agents thread with its account and a quota tone, and publish only on change', async () => {
  const memory = {}; let writes = 0;
  const host = { ...sessions, shared: key => clone(memory[key]), setShared: (key, value) => { writes++; memory[key] = clone(value); } };
  const { threadDecorations, publishDecorations } = await evaluateNative('../mods/herdr-zed-agents/decorations.js', host, 'threadDecorations, publishDecorations');
  const agents = [{ key: 'devkits-codex-work', name: 'Codex · work' }, { key: 'devkits-claude-main', name: 'Claude · main' }, { key: 'codex', name: 'Codex' }];
  const threads = { 11: { profile: 'devkits-codex-work', source: 'agents' }, 12: { profile: 'devkits-claude-main', source: 'agents' },
    13: { profile: null, source: 'native' }, 14: { profile: 'removed-account', source: 'agents' }, 15: { profile: 'codex', source: 'agents' } };
  const usage = [{ key: 'devkits-codex-work', windows: [{ minutes: 300, usedPercent: 75 }] },
    { key: 'devkits-claude-main', windows: [{ minutes: 10080, usedPercent: 90 }] }, { key: 'codex', email: 'me@example.com', windows: [{ minutes: 300, usedPercent: 12 }] }];
  assert.deepEqual(threadDecorations(threads, agents, usage), {
    11: { badge: 'work', tone: 'warning' }, 12: { badge: 'main', tone: 'error' }, 15: { badge: 'me@example.com' } });
  assert.deepEqual(threadDecorations(undefined, agents, usage), {});

  memory['herdr-zed.agent-cache'] = { null: agents };
  memory['herdr-zed.threads'] = threads;
  memory['herdr-zed.usage.snapshot'] = { contexts: { null: { usage } } };
  publishDecorations(); assert.equal(writes, 1);
  const envelope = memory['herdr-zed.decorations.agents'];
  assert.equal(typeof envelope.updatedAt, 'number');
  assert.deepEqual(contract.validateDecorations(envelope), envelope.threads);
  publishDecorations(); assert.equal(writes, 1);
  memory['herdr-zed.usage.snapshot'] = { contexts: { null: { usage: [usage[0], { ...usage[1], windows: [{ minutes: 10080, usedPercent: 10 }] }, usage[2]] } } };
  publishDecorations(); assert.equal(writes, 2);
  assert.deepEqual(memory['herdr-zed.decorations.agents'].threads[12], { badge: 'main' });
});

test('the Agents manifest parses with the shell parser and the separate Usage manifest is gone', async () => {
  const text = await readFile(new URL('../mods/herdr-zed-agents/extension.json', import.meta.url), 'utf8');
  assert.deepEqual(parseExtensionManifest('herdr-zed-agents', text), []);
  const meta = extensionMetadata('herdr-zed-agents', text);
  assert.equal(meta.id, 'agents'); assert.equal(meta.title, 'Agents');
  assert.deepEqual(meta.provides.threadDecorator, { fields: ['badge', 'tone'] });
  assert.deepEqual(meta.provides.launcher.picker, { view: 'launcher', width: 280 });
  await assert.rejects(access(new URL('../mods/herdr-zed-agents/usage/main.js', import.meta.url)), { code: 'ENOENT' });
  await assert.rejects(access(new URL('../mods/herdr-zed-agents/usage/mod.json', import.meta.url)), { code: 'ENOENT' });
});

test('a composer task is the prompt argument for Claude Code and Codex, and a task field for other programs', async () => {
  const codex = await launcher({ platform: 'windows' });
  await codex.emitLaunch(agent, { ...target, task: 'Fix the login\nbug' }, {});
  const [request] = codex.memory['herdr-zed.launch.requests'];
  assert.deepEqual(request.argv, terminalArgv(['codex', '--model', 'gpt', 'Fix the login\nbug'], 'windows'));
  assert.equal(Object.hasOwn(request, 'task'), false, 'not sent twice');
  const other = await launcher({ prepare: async () => ({ argv: ['copilot'], session: {} }) });
  await other.emitLaunch({ key: 'copilot', name: 'Copilot' }, { ...target, task: 'Hi' }, {});
  assert.deepEqual(other.memory['herdr-zed.launch.requests'][0].argv, ['copilot']);
  assert.equal(other.memory['herdr-zed.launch.requests'][0].task, 'Hi');
});
