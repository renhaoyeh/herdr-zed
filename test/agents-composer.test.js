import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import * as model from '../mods/herdr-zed-agents/components/session-model.js';
import { composerChoices, composerUsage as readUsage } from '../components/extension-contract.js';

async function composer(memory = {}) {
  const launches = [], notes = [];
  const host = { ...model, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, home: () => '/home/me',
    readTextFile: async () => null, notify: note => notes.push(note), LAUNCHER_ID: 'agents',
    availableAgents: profiles => profiles, discoverAgents: async () => [], emitLaunch: async (...args) => { launches.push(args); return {}; } };
  return { ...(await evaluateNative('../mods/herdr-zed-agents/composer.js', host,
    'Composer, composerEnvelope, composerChoice, intentOptions, choiceKey, COMPOSER_KEY, LAUNCH_INTENTS')), launches, notes, memory };
}

const claude = { key: 'claude', name: 'Claude Code', icon: 'icons/claude.svg' };
const codex = { key: 'codex', name: 'Codex', icon: 'icons/codex.svg', tint: true };
const codexList = [{ key: 'gpt', label: 'GPT', efforts: ['low', 'high'] }, { key: 'mini', label: 'Mini', efforts: ['low'] }];

test('the envelope lists each visible program with model, effort and (Codex) Fast, and the shell accepts it', async () => {
  const { composerEnvelope } = await composer();
  const envelope = composerEnvelope({ [JSON.stringify(null)]: [claude, codex, { key: 'copilot', name: 'Copilot' }] },
    new Map([['/home/me/.codex', codexList]]), '/home/me',
    { sessions: { codex: { model: 'gpt', effort: 'high', serviceTier: 'fast' } }, hidden: ['agent:copilot'] });
  const choices = composerChoices({ updatedAt: 1, ...envelope }, null);
  assert.deepEqual(choices.map(choice => choice.key), ['claude', 'codex']);
  const [, codexChoice] = choices;
  assert.deepEqual(codexChoice.fields.map(field => [field.id, field.value]), [['model', 'gpt'], ['effort', 'high'], ['fast', true]]);
  assert.deepEqual(codexChoice.fields[1].options.find(option => option.key === 'high').only, { model: ['gpt'] });
  assert.equal(choices[0].fields.some(field => field.id === 'fast'), false, 'Claude has no Fast');
});

test('an intent launches the chosen program with its task and options, then becomes the default', async () => {
  const memory = { 'herdr-zed.agent-cache': { [JSON.stringify(null)]: [codex] },
    'herdr-zed.launch.intents': [{ id: 'i1', launcher: 'agents', choice: 'codex', target: { space: 's', folder: '/repo' },
      values: { model: 'mini', effort: 'low', fast: true }, task: 'Fix it', expiresAt: Date.now() + 10000 },
    { id: 'other', launcher: 'someone', expiresAt: Date.now() + 10000 }] };
  const { Composer, launches, notes } = await composer(memory);
  const spawned = [];
  new Composer().poll({ spawn: fn => spawned.push(fn()) });
  await Promise.all(spawned);
  assert.deepEqual(notes, []);
  assert.deepEqual(launches, [[codex, { space: 's', folder: '/repo', task: 'Fix it' }, { model: 'mini', effort: 'low', serviceTier: 'fast' }]]);
  assert.deepEqual(memory['herdr-zed.launch.intents'].map(intent => intent.id), ['other'], 'only its own intents are taken');
  assert.deepEqual(memory['herdr-zed.profile-sessions'].codex, { model: 'mini', effort: 'low', serviceTier: 'fast' });
});

test('the composer usage lists the Usage sidebar\'s accounts, names and windows, and the shell accepts it', async () => {
  const { UsageClient } = await evaluateNative('../components/usage.js', { ...model, div: () => null, v_flex: () => null, h_flex: () => null,
    shared: () => null, openOverlay() {}, run() {}, layout: () => null, Button: () => null, Progress: () => null, glyph: () => null, AgentIcon: () => null }, 'UsageClient');
  const { composerUsage } = await evaluateNative('../mods/herdr-zed-agents/composer.js', { ...model, UsageClient, LAUNCHER_ID: 'agents' }, 'composerUsage');
  const snapshot = { machine: null, loading: false, error: null,
    choices: [{ key: 'work', name: 'Claude Code · Work', agent: { key: 'work', icon: 'icons/claude.svg' }, provider: 'claude' },
      { key: 'idle', name: 'Codex', agent: { key: 'idle' }, provider: 'codex' }],
    usage: [{ key: 'work', windows: [{ bucket: 'claude', minutes: 300, usedPercent: 37, resetsAt: 1 }, { bucket: 'claude', minutes: 10080, usedPercent: 91, resetsAt: null }] }] };
  const usage = composerUsage(snapshot);
  assert.deepEqual(usage, [{ key: 'work', label: 'Work', icon: 'icons/claude.svg', windows: [
    { label: '5h', minutes: 300, usedPercent: 37, resetsAt: 1 }, { label: 'Week', minutes: 10080, usedPercent: 91, resetsAt: null }] },
    { key: 'idle', label: 'No account', muted: true, windows: [] }],
    'accounts without readings remain visible, named as Usage names them');
  const { composerUsage: read } = await import('../components/extension-contract.js');
  assert.deepEqual(read({ machines: { '': { choices: [], usage } } }, null), usage);
  assert.deepEqual(read({ machines: { '': { choices: [], usage: [{ ...usage[0], windows: [] }] } } }, null), [{ ...usage[0], windows: [] }]);
});

test('composer fields always select explicit available options and reuse saved choices', async () => {
  const { composerChoice, composerEnvelope } = await composer();
  const fresh = composerChoice(codex, codexList);
  assert.deepEqual(fresh.fields.slice(0, 2).map(field => field.value), ['gpt', 'low']);
  assert.ok(fresh.fields.filter(field => field.type === 'select').every(field => !field.options.some(option => option.key === 'default')));
  const saved = composerChoice(codex, codexList, { sessions: { codex: { model: 'mini', effort: 'high' } } });
  assert.deepEqual(saved.fields.slice(0, 2).map(field => field.value), ['mini', 'low'], 'unavailable effort falls back to an explicit supported value');
  assert.equal(composerChoice(codex, []), null, 'no cached models cannot launch with an implicit default');
  assert.deepEqual(composerEnvelope({ null: [codex] }, new Map(), '/home/me').machines[''].choices, []);
});

test('only local Codex and Claude account cards offer the defaults menu; Custom has no model fields', async () => {
  const { composerUsage } = await evaluateNative('../mods/herdr-zed-agents/composer.js', { ...model, LAUNCHER_ID: 'agents',
    UsageClient: class { visibleEntries(snapshot) { return snapshot; } } }, 'composerUsage');
  const custom = { key: 'custom', name: 'Custom', run: ['custom'] };
  const entries = [codex, claude, custom].map(agent => ({ choice: { agent }, name: agent.name, windows: [] }));
  const local = composerUsage(entries);
  assert.deepEqual(local.map(item => Boolean(item.menu)), [true, true, false]);
  assert.ok(composerUsage(entries, 'remote').every(item => !item.menu));
  const { composerChoice } = await composer();
  assert.deepEqual(composerChoice(custom, codexList).fields, []);
  const envelope = usage => ({ machines: { '': { choices: [], usage } } });
  assert.equal(readUsage(envelope(local), null).length, 3);
  for (const menu of [null, {}, { view: '../custom', width: 400 }, { view: 'defaults', width: 0 },
    { view: 'defaults', width: 400, mod: 'other' }]) {
    assert.deepEqual(readUsage(envelope([{ ...local[0], menu }]), null), []);
  }
});

test('root model visibility applies to all accounts and their derived profiles', async () => {
  const { composerChoice } = await composer();
  const work = { ...codex, key: 'herdr-zed-codex-work' };
  const personal = { ...codex, key: 'herdr-zed-codex-personal' };
  const state = { options: { codex: { models: ['mini'] } } };
  assert.deepEqual(composerChoice(work, codexList, state).fields[0].options.map(item => item.key), ['gpt']);
  assert.deepEqual(composerChoice(personal, codexList, state).fields[0].options.map(item => item.key), ['gpt']);
  const named = { ...work, key: 'herdr-zed-preset-fast', profileKey: work.key };
  assert.deepEqual(composerChoice(named, codexList, state).fields[0].options.map(item => item.key), ['gpt']);
});
