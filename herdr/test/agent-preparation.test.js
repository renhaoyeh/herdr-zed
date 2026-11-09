import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { configuredAgents } from '../mods/devkits/components/session-model.js';

const profile = { key: 'codex', name: 'Codex', run: ['codex'] };
const preset = { key: 'devkits-preset-review', profileKey: 'codex', name: 'Review', instructions: 'Use the current profile guide.' };

async function load({ remote = false, rulesError = false, rulesGate = null, config = preset, saved = {}, options = {}, target = { space: 'local' } } = {}) {
  const calls = [], memory = {
    'devkits.agent-cache': { null: [{ ...profile, name: 'Current Codex' }] },
    'devkits.agent-configs': config ? [config] : [],
    'devkits.profile-sessions': { [config?.key || 'codex']: { model: 'saved-model', effort: 'high', serviceTier: 'fast', ...saved } },
    'devkits.codex-permissions': { [config?.key || 'codex']: 'workspace-write' },
    'devkits.session-options': {},
  };
  const host = {
    spaces: () => [{ id: 'local', ...(remote ? { machine: 'host' } : {}) }],
    shared: key => memory[key], appHome: () => '/herdr',
    configuredAgents,
    settingsKey: agent => agent?.key,
    sessionKind: () => 'codex',
    launcherArgv: (agent, permission) => { calls.push(['launcher', agent?.key, permission, agent?.run]); return agent?.run; },
    sessionArgv: (agent, argv, settings) => { calls.push(['session', settings]); return [...argv, `model=${settings.model}`, `effort=${settings.effort}`, `tier=${settings.serviceTier}`, `tasks=${settings.tasksMcpHome}`]; },
    rulesArgv: (agent, argv, rules, instructions) => { calls.push(['rules', rules, instructions]); return [...argv, `rules=${rules?.text || ''}`, `instructions=${instructions || ''}`]; },
    sessionRules: async () => { calls.push(['read-rules']); if (rulesGate) await rulesGate; if (rulesError) throw Error('unreadable'); return { file: '/guide', text: 'Global rules' }; },
    sessionMcpArgv: async (agent, argv) => { calls.push(['mcp']); return [...argv, 'shared-mcp']; },
  };
  const { prepareSession } = await evaluateNative('../mods/devkits-agents/session-preparation.js', host, 'prepareSession');
  return { prepareSession, calls, options, target, memory };
}

test('local preparation uses current profile instructions, saved settings and per-call model/effort choices', async () => {
  const h = await load({ options: { model: 'one-time-model', effort: null } });
  const result = await h.prepareSession({ key: preset.key, profileKey: 'codex', run: ['stale'], instructions: 'stale' }, h.target, h.options);
  assert.deepEqual(result.session, { model: 'one-time-model', effort: null, serviceTier: 'fast', permission: 'workspace-write' });
  assert.ok(result.argv.includes('tasks=/herdr'));
  assert.ok(result.argv.includes('shared-mcp'));
  assert.deepEqual(h.calls.filter(([name]) => ['rules', 'mcp'].includes(name)).map(([name]) => name), ['rules', 'mcp']);
  assert.equal(h.calls.find(([name]) => name === 'rules')[2], preset.instructions);
  assert.equal(h.calls.find(([name]) => name === 'launcher')[1], preset.key);
  assert.deepEqual(h.calls.find(([name]) => name === 'launcher')[3], ['codex']);
});

test('either remote target marker omits local rules, profile instructions and both MCP sources', async () => {
  for (const target of [{ machine: 'host', space: 'local' }, { space: 'local' }]) {
    const h = await load({ remote: target.machine === undefined, target });
    h.memory['devkits.agent-cache'][JSON.stringify('host')] = [{ ...profile, run: ['remote-codex'] }];
    const result = await h.prepareSession({ key: 'codex', run: ['stale-codex'] }, target, {});
    assert.ok(result.argv.includes('tasks=null'));
    assert.ok(!result.argv.includes('shared-mcp'));
    assert.deepEqual(h.calls.map(([name]) => name), ['launcher', 'session']);
    assert.deepEqual(h.calls[0][3], ['remote-codex']);
  }
});

test('missing named profile configuration rejects before argv preparation', async () => {
  const h = await load({ config: null });
  await assert.rejects(h.prepareSession({ key: preset.key, profileKey: 'codex' }, h.target), /configuration is unavailable/);
  assert.deepEqual(h.calls, []);
});

test('a valid passed named profile remains usable before the profile cache is populated', async () => {
  const h = await load();
  delete h.memory['devkits.agent-cache'];
  const result = await h.prepareSession({ key: preset.key, profileKey: 'codex', run: ['codex'] }, h.target);
  assert.ok(result.argv.includes('instructions=Use the current profile guide.'));
  assert.equal(h.calls.find(([name]) => name === 'launcher')[1], preset.key);
});

test('an unreadable global guide does not block launch or discard saved profile instructions', async () => {
  const h = await load({ rulesError: true });
  const result = await h.prepareSession({ key: preset.key, profileKey: 'codex' }, h.target);
  assert.ok(result.argv.includes('instructions=Use the current profile guide.'));
  assert.ok(h.calls.some(([name]) => name === 'mcp'));
});


test('removing a profile while its global guide loads prevents the prepared launch', async () => {
  let release;
  const rulesGate = new Promise(resolve => { release = resolve; });
  const h = await load({ rulesGate });
  const pending = h.prepareSession({ key: preset.key, profileKey: 'codex' }, h.target);
  h.memory['devkits.agent-configs'] = [];
  release();
  await assert.rejects(pending, /configuration is unavailable/);
  assert.ok(!h.calls.some(([name]) => name === 'mcp'));
});
