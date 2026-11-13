import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { configuredAgents } from '../components/session-model.js';
import { composeSessionRules } from '../mods/herdr-zed-agents/global-rules-model.js';

const profile = { key: 'codex', name: 'Codex', run: ['codex'] };
const preset = { key: 'herdr-zed-preset-review', profileKey: 'codex', name: 'Review', instructions: 'Use the current profile guide.' };

async function load({ eccInstructions = '', kitInstructions = '', remote = false, rulesError = false, rulesGate = null, config = preset, saved = {}, options = {}, target = { space: 'local' } } = {}) {
  const calls = [], memory = {
    'herdr-zed.agent-cache': { null: [{ ...profile, name: 'Current Codex' }] },
    'herdr-zed.agent-configs': config ? [config] : [],
    'herdr-zed.profile-sessions': { [config?.key || 'codex']: { model: 'saved-model', effort: 'high', serviceTier: 'fast', ...saved } },
    'herdr-zed.codex-permissions': { [config?.key || 'codex']: 'workspace-write' },
    'herdr-zed.session-options': {},
  };
  const host = {
    spaces: () => [{ id: 'local', ...(remote ? { machine: 'host' } : {}) }],
    shared: key => memory[key], appHome: () => '/herdr',
    configuredAgents, composeSessionRules,
    settingsKey: agent => agent?.key,
    sessionKind: () => 'codex',
    launcherArgv: (agent, permission) => { calls.push(['launcher', agent?.key, permission, agent?.run]); return agent?.run; },
    sessionArgv: (agent, argv, settings) => { calls.push(['session', settings]); return [...argv, `model=${settings.model}`, `effort=${settings.effort}`, `tier=${settings.serviceTier}`, `tasks=${settings.tasksMcpHome}`]; },
    rulesArgv: (agent, argv, rules, instructions) => { calls.push(['rules', rules, instructions]); return [...argv, `rules=${rules?.text || ''}`, `instructions=${instructions || ''}`]; },
    sessionRules: async () => { calls.push(['read-rules']); if (rulesGate) await rulesGate; if (rulesError) throw Error('unreadable'); return { file: '/guide', text: 'Global rules' }; },
    prepareEcc: async (agent, argv, target) => { calls.push(['ecc', target]); return { argv, instructions: eccInstructions, mcp: { browser: false } }; },
    sessionDevkits: async () => { calls.push(['devkits']); return kitInstructions; },
    sessionMcpArgv: async (agent, argv, mcp) => { calls.push(['mcp', mcp]); return [...argv, 'shared-mcp']; },
  };
  const { prepareSession } = await evaluateNative('../mods/herdr-zed-agents/session-preparation.js', host, 'prepareSession');
  return { prepareSession, calls, options, target, memory };
}

test('local preparation uses current profile instructions, saved settings and per-call model/effort choices', async () => {
  const h = await load({ options: { model: 'one-time-model', effort: null } });
  const result = await h.prepareSession({ key: preset.key, profileKey: 'codex', run: ['stale'], instructions: 'stale' }, h.target, h.options);
  assert.deepEqual(result.session, { model: 'one-time-model', effort: null, serviceTier: 'fast', permission: 'workspace-write' });
  assert.ok(result.argv.includes('tasks=/herdr'));
  assert.ok(result.argv.includes('shared-mcp'));
  assert.deepEqual(h.calls.filter(([name]) => ['rules', 'mcp', 'ecc'].includes(name)).map(([name]) => name), ['ecc', 'mcp', 'rules']);
  assert.equal(h.calls.find(([name]) => name === 'rules')[2], preset.instructions);
  assert.equal(h.calls.find(([name]) => name === 'launcher')[1], preset.key);
  assert.deepEqual(h.calls.find(([name]) => name === 'launcher')[3], ['codex']);
  assert.deepEqual(h.calls.find(([name]) => name === 'mcp')[1], { browser: false });
});

test('project-aware ECC preparation receives the launch folder rather than the current UI project', async () => {
  const target = { space: 'local', folder: 'C:/explicit-project' }, h = await load({ target });
  await h.prepareSession(profile, target);
  assert.equal(h.calls.find(([name]) => name === 'ecc')[1].folder, target.folder);
});

test('either remote target marker omits local rules, profile instructions and both MCP sources', async () => {
  for (const target of [{ machine: 'host', space: 'local' }, { space: 'local' }]) {
    const h = await load({ remote: target.machine === undefined, target });
    h.memory['herdr-zed.agent-cache'][JSON.stringify('host')] = [{ ...profile, run: ['remote-codex'] }];
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
  delete h.memory['herdr-zed.agent-cache'];
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
  h.memory['herdr-zed.agent-configs'] = [];
  release();
  await assert.rejects(pending, /configuration is unavailable/);
  assert.ok(!h.calls.some(([name]) => name === 'mcp'));
});

test('selected ECC guidance combines with global rules and profile instructions without replacing either', async () => {
  const h = await load({ eccInstructions: 'Selected ECC rule' });
  const result = await h.prepareSession({ key: preset.key, profileKey: 'codex', run: ['codex'] }, h.target, h.options);
  assert.ok(result.argv.some(arg => arg.includes('Global rules') && arg.includes('Selected ECC rule')));
  assert.ok(result.argv.includes('instructions=' + preset.instructions));
  const remote = await load({ remote: true, eccInstructions: 'Should not load' });
  await remote.prepareSession({ key: profile.key, run: ['codex'] }, remote.target, {});
  assert.ok(!remote.calls.some(([name]) => name === 'ecc'));
});


test('Devkits package guidance joins existing rules and ECC only for local preparation', async () => {
  const h = await load({ eccInstructions: 'ECC guide', kitInstructions: { summary: '- **Frontend**', sections: '## Frontend\n\nUse frontend skill then browser' } });
  const result = await h.prepareSession({ key: preset.key, profileKey: 'codex', run: ['codex'] }, h.target);
  assert.ok(result.argv.some(arg => arg.includes('Global rules') && arg.includes('ECC guide') && arg.includes('Use frontend skill then browser')));
  const remote = await load({ remote: true, kitInstructions: { summary: 'Must not load' } });
  await remote.prepareSession({ key: profile.key, run: ['codex'] }, remote.target);
  assert.ok(!remote.calls.some(([name]) => name === 'devkits'));
});
