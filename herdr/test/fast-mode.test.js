import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionArgv } from '../mods/devkits/model.js';

test('Fast applies without a model or effort override and preserves account wrappers', () => {
  const agent = { key: 'devkits-codex-work' };
  const argv = ['env', 'CODEX_HOME=/work', '/bin/codex', '--no-daemon'];
  assert.deepEqual(sessionArgv(agent, argv, { serviceTier: 'fast' }),
    ['env', 'CODEX_HOME=/work', '/bin/codex', '-c', 'service_tier="fast"', '--no-daemon']);
  assert.equal(sessionArgv(agent, argv, { serviceTier: null }), argv);
  assert.equal(sessionArgv(agent, argv, { serviceTier: 'unknown' }), argv);
  assert.throws(() => sessionArgv(agent, ['wrapper'], { serviceTier: 'fast' }), /Could not find Codex/);
});

test('Fast replaces every form of launcher service-tier config, retaining other config and literal arguments', () => {
  const agent = { key: 'codex' };
  const argv = ['codex', '-c', 'service_tier="default"', '--config', 'service_tier = "flex"',
    '-cservice_tier="priority"', '-c=service_tier="default"', '--config=service_tier="flex"',
    '-c', 'other=true', '--', '--config=service_tier="literal"'];
  assert.deepEqual(sessionArgv(agent, argv, { model: 'model', effort: 'high', serviceTier: 'fast' }),
    ['codex', '-m', 'model', '-c', 'model_reasoning_effort="high"', '-c', 'service_tier="fast"',
      '-c', 'other=true', '--', '--config=service_tier="literal"']);
  assert.equal(sessionArgv(agent, argv, {}), argv);
});

test('Fast is Codex-only and never adds flags to Claude or other agents', () => {
  for (const key of ['claude', 'devkits-claude-work', 'aider']) {
    const agent = { key }, argv = [key === 'devkits-claude-work' ? 'claude' : key];
    assert.equal(sessionArgv(agent, argv, { serviceTier: 'fast' }), argv);
  }
  assert.deepEqual(sessionArgv({ key: 'claude' }, ['claude'], { model: 'sonnet', serviceTier: 'fast' }),
    ['claude', '--model', 'sonnet']);
});

test('agent configurations retain their profile credentials and have independent identities', async () => {
  const { configuredAgents, sessionKind, settingsKey, launcherArgv } = await import('../mods/devkits/model.js');
  const profile = { key: 'devkits-codex-work', name: 'Work', icon: 'codex.svg', installed: true,
    run: ['env', 'CODEX_HOME=/work', 'codex', '--no-daemon'] };
  const configs = [{ key: 'devkits-preset-one', profileKey: profile.key, name: 'Sol Fast' },
    { key: 'devkits-preset-two', profileKey: profile.key, name: 'Astra' },
    { key: 'devkits-preset-missing', profileKey: 'missing', name: 'Missing' }];
  const agents = configuredAgents([profile], configs);
  assert.equal(agents.length, 3);
  assert.equal(sessionKind(agents[1]), 'codex');
  assert.equal(settingsKey(agents[1]), 'devkits-preset-one');
  assert.equal(agents[1].run, profile.run);
  assert.equal(agents[1].name, 'Sol Fast - Work');
  assert.equal(agents[2].name, 'Astra - Work');
  assert.deepEqual(configuredAgents(agents, configs), agents);
  assert.deepEqual(launcherArgv(agents[1], 'read-only'),
    ['env', 'CODEX_HOME=/work', 'codex', '--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--no-daemon']);
});

test('icons carry the provider while account and configured-agent labels retain their names', async () => {
  const { launcherLabel, launcherChoices, configuredAgents } = await import('../mods/devkits/model.js');
  assert.equal(launcherLabel('Claude Code · 工作'), '工作');
  assert.equal(launcherLabel('Codex · Work / Sol Fast'), 'Work / Sol Fast');
  const profile = { key: 'claude', name: 'Claude Code', run: ['claude'], icon: 'icons/claude.svg' };
  const agents = configuredAgents([profile], [{ key: 'devkits-preset-one', profileKey: 'claude', name: 'Review' }]);
  const choice = launcherChoices(agents).find(item => item.agent?.profileKey);
  assert.equal(choice.name, 'Review');
  assert.equal(choice.agent.icon, profile.icon);
  assert.equal(choice.agent.run, profile.run);
  assert.equal(profile.name, 'Claude Code');
});

test('shared launcher options omit provider names in any case and retain account names and provider icons', async () => {
  const { launcherLabel, launcherOption } = await import('../mods/devkits/model.js');
  for (const name of ['Codex', 'CODEX', 'cOdEx', 'Codex CLI', 'Claude', 'CLAUDE CODE']) {
    assert.equal(launcherLabel(name), 'Default account');
    assert.equal(launcherLabel(launcherLabel(name)), 'Default account');
  }
  for (const [name, expected] of [['CODEX · 工作', '工作'], ['claude code / Home', 'Home'], ['cOdEx · WORK / Review', 'WORK / Review']]) {
    assert.equal(launcherLabel(name), expected);
  }
  const account = { key: 'codex', name: 'CODEX', run: ['codex'] };
  assert.deepEqual(launcherOption(account), { key: 'codex', label: 'Default account', icon: 'icons/codex.svg', iconTint: false });
  assert.equal(account.name, 'CODEX');
  assert.deepEqual(launcherOption({ key: 'devkits-claude-work', name: 'CLAUDE CODE · WORK', icon: 'icons/custom.svg', tint: true }),
    { key: 'devkits-claude-work', label: 'WORK', icon: 'icons/custom.svg', iconTint: true });
});
