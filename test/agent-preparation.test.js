import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { configuredAgents, launcherArgv, sessionArgv, sessionKind, rulesArgv } from '../components/session-model.js';
import { claudeMcpConfig, mcpToml } from '../components/shared-mcp-model.js';
import { composeSessionRules } from '../mods/herdr-zed-agents/global-rules-model.js';

const profile = { key: 'codex', name: 'Codex', run: ['codex'] };
const preset = { key: 'herdr-zed-preset-review', profileKey: 'codex', name: 'Review', instructions: 'Use the current profile guide.' };

async function load({ eccInstructions = '', kitInstructions = '', remote = false, rulesError = false, rulesGate = null, config = preset, saved = {}, options = {}, target = { space: 'local' }, program = profile, nativeArgv = false } = {}) {
  const { sharedMcpArgv } = await evaluateNative('../components/shared-mcp.js', { sessionKind, claudeMcpConfig, mcpToml }, 'sharedMcpArgv');
  const calls = [], memory = {
    'herdr-zed.agent-cache': { null: [{ ...program, name: 'Current program' }] },
    'herdr-zed.agent-configs': config ? [config] : [],
    'herdr-zed.profile-sessions': { [config?.key || program.key]: { model: 'saved-model', effort: 'high', serviceTier: 'fast', ...saved } },
    'herdr-zed.codex-permissions': { [config?.key || program.key]: 'workspace-write' },
    'herdr-zed.session-options': {},
  };
  const host = {
    spaces: () => [{ id: 'local', ...(remote ? { machine: 'host' } : {}) }],
    shared: key => memory[key], appHome: () => '/herdr',
    configuredAgents, composeSessionRules,
    settingsKey: agent => agent?.key,
    sessionKind,
    launcherArgv: (agent, permission) => { calls.push(['launcher', agent?.key, permission, agent?.run]); return nativeArgv ? launcherArgv(agent, permission) : agent?.run; },
    sessionArgv: (agent, argv, settings) => { calls.push(['session', settings]); return nativeArgv ? sessionArgv(agent, argv, settings) : [...argv, `model=${settings.model}`, `effort=${settings.effort}`, `tier=${settings.serviceTier}`, `tasks=${settings.tasksMcpHome}`]; },
    rulesArgv: (agent, argv, rules, instructions) => { calls.push(['rules', rules, instructions]); return nativeArgv ? rulesArgv(agent, argv, rules, instructions) : [...argv, `rules=${rules?.text || ''}`, `instructions=${instructions || ''}`]; },
    sessionRules: async () => { calls.push(['read-rules']); if (rulesGate) await rulesGate; if (rulesError) throw Error('unreadable'); return { file: '/guide', text: 'Global rules' }; },
    prepareEcc: async (agent, argv, target) => { calls.push(['ecc', target]); return { argv, instructions: eccInstructions, mcp: { browser: false } }; },
    sessionDevkits: async () => { calls.push(['devkits']); return kitInstructions; },
    sessionMcpArgv: async (agent, argv, mcp) => { calls.push(['mcp', mcp]); return nativeArgv ? sharedMcpArgv(agent, argv, { servers: { herdr_ecc: { command: 'node', args: ['/ecc-mcp'] } } }) : [...argv, 'shared-mcp']; },
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

test('Supervisor read-only stages override this invocation without changing saved permissions or ECC', async () => {
  const h = await load({ eccInstructions: 'Keep selected ECC guidance' });
  const agent = { key: preset.key, profileKey: 'codex' };
  const result = await h.prepareSession(agent, h.target, { readOnly: true });
  assert.equal(result.session.permission, 'read-only');
  assert.equal(h.calls.find(([name]) => name === 'launcher')[2], 'read-only');
  assert.equal(h.memory['herdr-zed.codex-permissions'][preset.key], 'workspace-write');
  assert.ok(result.argv.some(arg => arg.includes('Keep selected ECC guidance')));
  await assert.rejects(h.prepareSession(agent, h.target, { readOnly: 'yes' }), /boolean/);
  await assert.rejects(h.prepareSession(agent, { ...h.target, machine: 'remote' }, { readOnly: true }), /local Codex/);
});

test('Claude Supervisor uses native Plan mode and retains reporting, MCP, skills and account defaults', async () => {
  for (const extra of [[], ['--allowed-tools=Read', '--allowedTools', 'WebSearch', '--disallowed-tools', 'NotebookEdit']]) {
    const program = { key: 'herdr-zed-claude-primary', name: 'Claude account', run: ['env', 'CLAUDE_CONFIG_DIR=/account', 'claude',
      '--dangerously-skip-permissions', '--permission-mode=bypassPermissions', '--settings', '{"enabledPlugins":{"existing":true}}',
      '--mcp-config', '{"mcpServers":{"existing":{"command":"node"}}}', ...extra, '--', 'existing prompt'] };
    const config = { ...preset, profileKey: program.key };
    const h = await load({ program, config, nativeArgv: true, eccInstructions: 'Keep selected ECC guidance',
      kitInstructions: { summary: 'Selected skills', sections: 'Keep selected skill guidance' } });
    const before = structuredClone(h.memory);
    const agent = { key: config.key, profileKey: config.profileKey };
    const result = await h.prepareSession(agent, h.target, { readOnly: true });
    const argv = result.argv;
    assert.equal(result.session.permission, 'plan');
    assert.deepEqual(argv.slice(0, 3), program.run.slice(0, 3));
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(!argv.includes('--dangerously-skip-permissions'));
    assert.ok(!argv.includes('--permission-mode=bypassPermissions'));
    assert.ok(!argv.includes('-p'));
    assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', 'existing prompt']);
    const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
    assert.deepEqual(allowed, ['mcp__herdr_tasks__report_task', 'mcp__herdr_tasks__list_projects', 'mcp__herdr_tasks__list_tasks',
      ...(extra.length ? ['Read', 'WebSearch'] : [])]);
    assert.equal(argv[argv.indexOf('--disallowedTools') + 1], 'ExitPlanMode');
    if (extra.length) assert.ok(argv.includes('NotebookEdit'));
    assert.ok(!argv.includes('Bash'));
    const mcps = argv.flatMap((arg, i) => arg === '--mcp-config' ? [JSON.parse(argv[i + 1]).mcpServers] : []);
    assert.ok(mcps.some(servers => servers.herdr_tasks));
    assert.ok(mcps.some(servers => servers.herdr_ecc));
    assert.ok(mcps.some(servers => servers.existing));
    assert.ok(argv.includes('{"enabledPlugins":{"existing":true}}'));
    assert.equal(argv[argv.indexOf('--model') + 1], 'saved-model');
    assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
    const instructions = argv[argv.indexOf('--append-system-prompt') + 1];
    for (const text of ['Global rules', 'Keep selected ECC guidance', 'Keep selected skill guidance', config.instructions]) assert.ok(instructions.includes(text));
    assert.deepEqual(h.memory, before);
    const normal = await h.prepareSession(agent, h.target, { readOnly: false });
    assert.equal(normal.session.permission, 'workspace-write');
    assert.ok(normal.argv.includes('--dangerously-skip-permissions'));
    assert.ok(!normal.argv.includes('ExitPlanMode'));
    await assert.rejects(h.prepareSession(agent, { machine: 'host' }, { readOnly: true }), /local Codex or Claude/);
  }
});

test('Codex read-only keeps native sandbox and approval flags, and unsupported providers reject before preparation', async () => {
  const h = await load({ nativeArgv: true });
  const result = await h.prepareSession(profile, h.target, { readOnly: true });
  assert.equal(result.argv[result.argv.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(result.argv[result.argv.indexOf('--ask-for-approval') + 1], 'on-request');
  assert.ok(!result.argv.includes('ExitPlanMode'));
  const unsupported = await load({ config: null, program: { key: 'other', run: ['other'] } });
  await assert.rejects(unsupported.prepareSession({ key: 'other', run: ['other'] }, unsupported.target, { readOnly: true }), /local Codex or Claude/);
  assert.deepEqual(unsupported.calls, []);
});

test('slash-selected skill expands against this launch snapshot and preserves the task suffix', async () => {
  const command = { id: 'mine:skills:review', name: 'review', path: 'C:\\snapshot\\review\\SKILL.md' };
  const h = await load({ kitInstructions: { commands: [command], summary: 'Review', sections: 'Read skill.' } });
  const result = await h.prepareSession(profile, { folder: '/project', task: '/review Check src/main.js' }, { command: command.id });
  assert.match(result.task, /Use the skill at `C:\/snapshot\/review\/SKILL.md`/);
  assert.match(result.task, /Check src\/main.js$/);
  const missing = await load();
  await assert.rejects(missing.prepareSession(profile, { task: '/review Check' }, { command: command.id }), /no longer available/);
  const remote = await load({ remote: true });
  await assert.rejects(remote.prepareSession(profile, { space: 'local', task: '/review Check' }, { command: command.id }), /only for local/);
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
