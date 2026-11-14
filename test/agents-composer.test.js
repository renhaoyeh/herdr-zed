import { agentWorkflowFields, launchWorkflowOptions } from '../components/agent-launch-options.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import * as model from '../mods/herdr-zed-agents/components/session-model.js';
import { composerChoices, composerUsage as readUsage } from '../components/extension-contract.js';
import * as contract from '../components/extension-contract.js';
import { eccProfiles } from '../mods/herdr-zed-agents/ecc-profiles.js';

async function composer(memory = {}, overrides = {}) {
  const launches = [], workflows = [], notes = [], commandReads = [];
  const { skillCommandTask } = await evaluateNative('../mods/herdr-zed-agents/session-preparation.js', {}, 'skillCommandTask');
  const host = { ...model, ...contract, eccProfiles, agentWorkflowFields, launchWorkflowOptions, spaces: () => [], shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, home: () => '/home/me',
    readTextFile: async () => null, notify: note => notes.push(note), LAUNCHER_ID: 'agents',
    availableAgents: profiles => profiles, discoverAgents: async () => [], emitLaunch: async (...args) => { launches.push(args); return {}; },
    workflowExecutor: () => null, requestAgentWorkflow: (...args) => { workflows.push(args); return args[4]?.id; }, skillCommandTask,
    providerCommands: async () => [], providerDevkits: async (...args) => { commandReads.push(args); return { commands: [] }; }, ...overrides };
  return { ...(await evaluateNative('../mods/herdr-zed-agents/composer.js', host,
    'Composer, composerEnvelope, composerChoice, intentOptions, choiceKey, COMPOSER_KEY, LAUNCH_INTENTS')), launches, workflows, commandReads, notes, memory };
}

const claude = { key: 'claude', name: 'Claude Code', icon: 'icons/claude.svg' };
const codex = { key: 'codex', name: 'Codex', icon: 'icons/codex.svg', tint: true };
const codexList = [{ key: 'gpt', label: 'GPT', efforts: ['low', 'high'] }, { key: 'mini', label: 'Mini', efforts: ['low'] }];
const executor = { owner: 'tasks', label: 'Supervisor', providers: ['claude', 'codex'], expiresAt: Date.now() + 60000 };

test('the envelope lists each visible program with model, effort and (Codex) Fast, and the shell accepts it', async () => {
  const { composerEnvelope } = await composer();
  const envelope = composerEnvelope({ [JSON.stringify(null)]: [claude, codex, { key: 'copilot', name: 'Copilot' }] },
    new Map([['/home/me/.codex', codexList]]), '/home/me',
    { sessions: { codex: { model: 'gpt', effort: 'high', serviceTier: 'fast' } }, hidden: ['agent:copilot'] });
  const choices = composerChoices({ updatedAt: 1, ...envelope }, null);
  assert.deepEqual(choices.map(choice => choice.key), ['claude', 'codex']);
  const [, codexChoice] = choices;
  assert.deepEqual(codexChoice.fields.map(field => [field.id, field.value]), [['model', 'gpt'], ['effort', 'high'], ['fast', true], ['eccProfile', 'inherit']]);
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
  assert.deepEqual(memory['herdr-zed.profile-sessions'].codex, { model: 'mini', effort: 'low', serviceTier: 'fast', eccProfile: null });
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

test('Supervisor fields use each local provider\'s offered models and remain absent remotely or without an executor', async () => {
  const { composerChoice, composerEnvelope } = await composer();
  const state = { workflows: [executor], options: { codex: { models: ['mini'] }, claude: { models: ['haiku'] } },
    sessions: { codex: { workflow: 'supervisor', researchModel: 'mini', reviewModel: 'gpt', model: 'gpt', effort: 'high', serviceTier: 'fast' } } };
  for (const agent of [claude, codex]) {
    const choice = composerChoice(agent, codexList, state);
    assert.ok(choice.fields.length <= 7);
    const main = choice.fields.find(field => field.id === 'model');
    const workflow = choice.fields.find(field => field.id === 'workflow');
    assert.deepEqual(workflow.options, [{ key: 'direct', label: 'Single session' }, { key: 'supervisor', label: 'Supervisor' }]);
    assert.ok(!choice.fields.some(field => ['researchModel', 'reviewModel'].includes(field.id)));
  }
  const codexFields = composerChoice(codex, codexList, state).fields;
  assert.deepEqual(codexFields.map(field => field.value), ['gpt', 'high', true, 'supervisor', 'inherit']);
  assert.equal(composerChoice(claude, codexList, { workflows: [{ ...executor, providers: ['codex'] }] }).fields.length, 3);
  assert.equal(composerChoice(codex, codexList).fields.length, 4);
  assert.deepEqual(composerChoice({ key: 'custom', name: 'Custom', run: ['custom'] }, codexList, state).fields, []);
  const envelope = composerEnvelope({ null: [claude, codex], '"remote"': [claude, codex] }, new Map([['/home/me/.codex', codexList]]), '/home/me', state);
  assert.equal(composerChoices({ updatedAt: 1, ...envelope }, null).length, 2, 'the shell contract accepts shared launch fields');
  assert.ok(envelope.machines.remote.choices.every(choice => choice.fields.every(field => !['workflow', 'researchModel', 'reviewModel'].includes(field.id))));
  assert.deepEqual(state.sessions.codex, { workflow: 'supervisor', researchModel: 'mini', reviewModel: 'gpt', model: 'gpt', effort: 'high', serviceTier: 'fast' }, 'describing choices changes no defaults');
});

test('only Supervisor adds workflow options; direct preserves the launch option shape and unknown is rejected', async () => {
  const { intentOptions } = await composer();
  const values = { model: 'gpt', effort: 'high', fast: true, researchModel: 'default', reviewModel: 'mini' };
  const direct = { model: 'gpt', effort: 'high', serviceTier: 'fast' };
  assert.deepEqual(intentOptions(values), direct);
  assert.deepEqual(intentOptions({ ...values, workflow: 'direct' }), direct);
  assert.throws(() => intentOptions({ ...values, workflow: 'unknown' }), /available workflow/);
  assert.deepEqual(intentOptions({ ...values, workflow: 'supervisor' }), { ...direct, workflow: 'supervisor' });
});

test('Supervisor queues either provider with the exact intent identity and saves defaults without launching directly', async () => {
  for (const agent of [claude, codex]) {
    const models = model.sessionChoices(model.sessionKind(agent), codexList).models, main = models[0].key, review = models[1].key;
    const intent = { id: `supervisor-${agent.key}`, launcher: 'agents', choice: agent.key, target: { folder: '/repo' }, task: 'Fix it',
      values: { model: main, effort: 'high', fast: true, workflow: 'supervisor', researchModel: 'default', reviewModel: review }, expiresAt: Date.now() + 10000 };
    const memory = { 'herdr-zed.agent-cache': { null: [agent] }, 'herdr-zed.launch.intents': [intent] };
    const h = await composer(memory, { workflowExecutor: () => executor }), jobs = [];
    const service = new h.Composer(); service.codexModelsByHome.set('/home/me/.codex', codexList);
    service.poll({ spawn: fn => jobs.push(fn()) }); await Promise.all(jobs);
    assert.deepEqual(h.notes, []);
    assert.deepEqual(h.launches, []);
    assert.deepEqual(h.commandReads, [], 'ordinary tasks need no skill discovery');
    assert.deepEqual(h.workflows, [['supervisor', agent, { folder: '/repo', task: 'Fix it' },
      { model: main, effort: 'high', serviceTier: 'fast', workflow: 'supervisor' }, { id: intent.id, expiresAt: intent.expiresAt }]]);
    assert.deepEqual(memory['herdr-zed.profile-sessions'][agent.key], { model: main, effort: 'high', eccProfile: null,
      ...(agent === codex ? { serviceTier: 'fast' } : {}), workflow: 'supervisor' });
  }
});

test('Supervisor expands only the selected immutable skill while retaining the task suffix and attachments', async () => {
  const task = '/review Check this\n\nAttached image: /attachments/screen.png', command = { id: 'mine:review', name: 'review', path: '/snapshot/hash/SKILL.md' };
  for (const selected of [undefined, command.id]) {
    const intent = { id: 'skill', launcher: 'agents', choice: 'codex', target: { folder: '/repo' }, task, command: selected,
      values: { workflow: 'supervisor', eccProfile: 'review' }, expiresAt: Date.now() + 10000 };
    const memory = { 'herdr-zed.agent-cache': { null: [codex] }, 'herdr-zed.launch.intents': [intent] }, reads = [];
    const h = await composer(memory, { workflowExecutor: () => executor,
      providerCommands: async () => { throw Error('Menu inventory does not contain skill paths.'); },
      providerDevkits: async (...args) => { reads.push(args); return { commands: [command] }; } }), jobs = [];
    new h.Composer().poll({ spawn: fn => jobs.push(fn()) }); await Promise.all(jobs);
    assert.deepEqual(h.notes, []);
    assert.deepEqual(reads, [['codex', intent.target, {}, '', { eccProfile: 'review' }]]);
    assert.deepEqual(h.launches, []);
    assert.equal(h.workflows[0][2].task, 'Use the skill at `/snapshot/hash/SKILL.md` for this task. Read its SKILL.md and resolve supporting files relative to it.\n\nCheck this\n\nAttached image: /attachments/screen.png');
  }
});

test('stale or unsupported Supervisor intents reject without direct launches or changed defaults', async () => {
  const custom = { key: 'custom', name: 'Custom', run: ['custom'] };
  for (const [agent, registration, target, command] of [[codex, null, { folder: '/repo' }],
    [claude, { ...executor, providers: ['codex'] }, { folder: '/repo' }], [custom, executor, { folder: '/repo' }],
    [codex, executor, { folder: '/repo', machine: 'remote' }], [codex, executor, { folder: '/repo' }, 'removed-skill']]) {
    const memory = { 'herdr-zed.agent-cache': { [JSON.stringify(target.machine || null)]: [agent] },
      'herdr-zed.profile-sessions': { codex: { model: 'gpt' } },
      'herdr-zed.launch.intents': [{ id: 'bad', launcher: 'agents', choice: agent.key, target, command, task: '/review Fix it',
        values: { workflow: 'supervisor' }, expiresAt: Date.now() + 10000 }] };
    const h = await composer(memory, { workflowExecutor: () => registration }), jobs = [];
    new h.Composer().poll({ spawn: fn => jobs.push(fn()) }); await Promise.all(jobs);
    assert.equal(h.notes.length, 1);
    assert.deepEqual(h.launches, []);
    assert.deepEqual(h.workflows, []);
    assert.deepEqual(memory['herdr-zed.profile-sessions'], { codex: { model: 'gpt' } });
    if (!command) assert.deepEqual(h.commandReads, [], 'reject before reading skills');
  }
});

test('unused stage model values never enter a Supervisor request', async () => {
  const intent = { id: 'main-only', launcher: 'agents', choice: 'codex', target: { folder: '/repo' }, task: 'Fix it',
    values: { model: 'gpt', workflow: 'supervisor', researchModel: 'removed', reviewModel: 'mini' }, expiresAt: Date.now() + 10000 };
  const memory = { 'herdr-zed.agent-cache': { null: [codex] }, 'herdr-zed.launch.intents': [intent] };
  const h = await composer(memory, { workflowExecutor: () => executor }), jobs = [];
  new h.Composer().poll({ spawn: fn => jobs.push(fn()) }); await Promise.all(jobs);
  assert.deepEqual(h.notes, []);
  assert.deepEqual(h.workflows[0][3], { model: 'gpt', effort: null, serviceTier: null, workflow: 'supervisor' });
});

test('a failed Supervisor enqueue preserves defaults; choosing Single session remembers the direct workflow', async () => {
  const intent = { id: 'enqueue', launcher: 'agents', choice: 'codex', target: { folder: '/repo' }, task: 'Fix it',
    values: { model: 'gpt', workflow: 'supervisor' }, expiresAt: Date.now() + 10000 };
  const memory = { 'herdr-zed.agent-cache': { null: [codex] }, 'herdr-zed.profile-sessions': { codex: { workflow: 'supervisor', reviewModel: 'mini' } },
    'herdr-zed.launch.intents': [intent] };
  const h = await composer(memory, { workflowExecutor: () => executor, requestAgentWorkflow: () => { throw Error('Executor stopped'); } }), service = new h.Composer(), jobs = [];
  service.poll({ spawn: fn => jobs.push(fn()) }); await Promise.all(jobs);
  assert.equal(h.notes[0].body, 'Executor stopped');
  assert.deepEqual(h.launches, []);
  assert.deepEqual(memory['herdr-zed.profile-sessions'].codex, { workflow: 'supervisor', reviewModel: 'mini' });
  memory['herdr-zed.launch.intents'] = [{ ...intent, id: 'direct', values: { model: 'gpt', workflow: 'direct' } }];
  service.poll({ spawn: fn => jobs.push(fn()) }); await Promise.all(jobs);
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0][2], { model: 'gpt', effort: null, serviceTier: null });
  assert.deepEqual(memory['herdr-zed.profile-sessions'].codex, { model: 'gpt', effort: null, serviceTier: null, eccProfile: null, workflow: 'direct', reviewModel: 'mini' });
});

test('ECC presets reuse the existing catalog for local providers and selection changes no settings', async () => {
  const memory = { 'herdr-zed.profile-sessions': { codex: { eccProfile: 'development' }, claude: { eccProfile: null } } };
  const before = structuredClone(memory), h = await composer(memory);
  for (const agent of [claude, codex]) {
    const local = h.composerChoice(agent, codexList, { sessions: memory['herdr-zed.profile-sessions'] });
    const field = local.fields.find(field => field.id === 'eccProfile');
    assert.deepEqual(field.options, [{ key: 'inherit', label: 'Global/project default' }, ...eccProfiles.map(profile => ({ key: profile.id, label: profile.name }))]);
    assert.equal(field.value, agent === codex ? 'development' : 'inherit');
    assert.ok(!h.composerChoice(agent, codexList, { local: false, workflows: [executor] }).fields.some(field => ['eccProfile', 'workflow'].includes(field.id)));
  }
  assert.ok(!h.composerEnvelope({ '"remote"': [claude] }, new Map(), '/home/me').machines.remote.choices[0].fields.some(field => field.id === 'eccProfile'));
  assert.deepEqual(memory, before);
});

test('ECC launch options omit inheritance and reject unknown explicit presets', async () => {
  const { intentOptions } = await composer();
  for (const eccProfile of [undefined, null, 'inherit', 'default']) assert.deepEqual(intentOptions({ eccProfile }), { model: null, effort: null, serviceTier: null });
  for (const { id } of eccProfiles) assert.equal(intentOptions({ eccProfile: id }).eccProfile, id);
  for (const eccProfile of ['custom', '', false, 1]) assert.throws(() => intentOptions({ eccProfile }), /available ECC preset/);
});

test('local direct and Supervisor launches forward explicit ECC presets or inherit without changing global policy', async () => {
  for (const agent of [claude, codex]) for (const workflow of ['direct', 'supervisor']) for (const eccProfile of ['inherit', 'basic']) {
    const intent = { id: 'ecc', launcher: 'agents', choice: agent.key, target: { folder: '/repo' }, task: 'Fix it',
      values: { workflow, eccProfile }, expiresAt: Date.now() + 10000 };
    const memory = { 'herdr-zed.agent-cache': { null: [agent] }, 'herdr-zed.launch.intents': [intent] }, writes = [];
    const h = await composer(memory, { workflowExecutor: () => executor,
      setShared: (key, value) => { writes.push(key); memory[key] = value; }, readTextFile: async () => { throw Error('Composer must not read global ECC policy.'); } }), jobs = [];
    new h.Composer().poll({ spawn: fn => jobs.push(fn()) }); await Promise.all(jobs);
    assert.deepEqual(h.notes, []);
    const options = workflow === 'direct' ? h.launches[0][2] : h.workflows[0][3];
    assert.equal(options.eccProfile, eccProfile === 'basic' ? 'basic' : undefined);
    assert.equal(memory['herdr-zed.profile-sessions'][agent.key].eccProfile, eccProfile === 'basic' ? 'basic' : null);
    assert.deepEqual(writes, ['herdr-zed.launch.intents', 'herdr-zed.profile-sessions'], 'only launch transport and per-profile defaults are written');
    assert.equal(h.launches.length, workflow === 'direct' ? 1 : 0);
    assert.equal(h.workflows.length, workflow === 'supervisor' ? 1 : 0);
  }
});

test('invalid, remote and unsupported ECC selections reject before launch and retain the saved preset', async () => {
  const custom = { key: 'custom', name: 'Custom', run: ['custom'] };
  for (const [agent, machine, eccProfile] of [[codex, null, 'unknown'], [claude, 'remote', 'basic'], [custom, null, 'basic']]) {
    const memory = { 'herdr-zed.agent-cache': { [JSON.stringify(machine)]: [agent] },
      'herdr-zed.profile-sessions': { [agent.key]: { eccProfile: 'development' } },
      'herdr-zed.launch.intents': [{ id: 'bad-ecc', launcher: 'agents', choice: agent.key, target: { folder: '/repo', machine },
        values: { eccProfile }, expiresAt: Date.now() + 10000 }] };
    const h = await composer(memory), jobs = [];
    new h.Composer().poll({ spawn: fn => jobs.push(fn()) }); await Promise.all(jobs);
    assert.equal(h.notes.length, 1);
    assert.deepEqual(h.launches, []);
    assert.deepEqual(h.workflows, []);
    assert.deepEqual(memory['herdr-zed.profile-sessions'][agent.key], { eccProfile: 'development' });
  }
});
