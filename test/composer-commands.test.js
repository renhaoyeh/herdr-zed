import { agentWorkflowFields, launchWorkflowOptions } from '../components/agent-launch-options.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../components/extension-contract.js';
import { evaluateNative } from './source-harness.js';
import { sessionKind } from '../components/session-model.js';
import { eccProfiles } from '../mods/herdr-zed-agents/ecc-profiles.js';

const commands = [{ id: 'mine:skills:review', name: 'review', description: 'Review code' },
  { id: 'visual-studio', name: 'visual-studio', description: 'Build the solution' }];
const project = { id: 's', folder: '/project', name: 'Project', machine: null };
async function shell() {
  const memory = {}, events = {}, bindings = [], scrolled = [], cx = { notify() {}, stop_propagation() {}, bind_keys: keys => bindings.push(...keys) };
  const input = { text: '', on(name, fn) { events[name] = fn; }, set_auto_grow() {}, value() { return this.text; }, set_value(value) { this.text = value; },
    set_selected_range(range) { this.range = range; }, focus() {} };
  const host = { ...contract, launchWorkflowOptions, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, spaces: () => [],
    withAttachments: text => text, ScrollHandle: { new: () => ({ scroll_to_item: index => scrolled.push(index), release() {} }) }, TextareaState: { new: () => input } };
  const { startPanel, LAUNCH_INTENTS } = await evaluateNative('../mods/herdr-zed/start-panel.js', host, 'startPanel, LAUNCH_INTENTS');
  const view = { ...startPanel }; view.initStartPanel(cx);
  const target = () => ({ intent: { launcher: 'custom-provider', choice: 'account', values: {} }, project, target: { folder: project.folder }, takesTask: true });
  view.startTarget = target();
  const edit = text => { input.text = text; events.change({}, cx); };
  return { view, memory, input, cx, edit, bindings, scrolled, LAUNCH_INTENTS, target };
}

test('slash menu requests scoped commands, filters, selects by keyboard and hands an opaque command ID to the launcher', async () => {
  const h = await shell(); h.edit('/');
  assert.equal(h.bindings.length, 7);
  assert.ok(h.bindings.slice(0, 5).every(binding => binding.context === 'HerdrComposerCommands > Input'));
  assert.deepEqual(h.bindings.slice(5), ['ctrl-enter', 'cmd-enter'].map(keystroke => ({
    keystroke, action: 'herdr-composer-submit', context: 'HerdrComposerSubmit > Input',
  })));
  const request = h.memory[contract.COMPOSER_COMMAND_REQUESTS][0];
  assert.equal(request.launcher, 'custom-provider'); assert.equal(request.choice, 'account'); assert.equal(request.target.folder, '/project');
  assert.deepEqual(request.values, {});
  h.memory[contract.COMPOSER_COMMAND_RESULTS] = { [request.id]: { items: commands, expiresAt: request.expiresAt } };
  h.view.refreshStartCommands(h.cx);
  assert.deepEqual(h.view.startCommandItems(), commands);
  h.edit('/solution'); assert.deepEqual(h.view.startCommandItems(), [commands[1]]);
  h.edit('/');
  h.view.startCommandAction('up', h.cx); assert.equal(h.view.startCommandIndex, 1);
  assert.equal(h.scrolled.at(-1), 1);
  h.view.startCommandAction('down', h.cx); assert.equal(h.view.startCommandIndex, 0);
  assert.equal(h.scrolled.at(-1), 0);
  h.view.startCommandAction('down', h.cx); h.view.startCommandAction('enter', h.cx);
  assert.equal(h.input.text, '/visual-studio '); assert.equal(h.view.startCommandOpen(), false);
  assert.deepEqual(h.input.range, { start: h.input.text.length, end: h.input.text.length });
  assert.equal(h.memory[h.LAUNCH_INTENTS], undefined, 'choosing a skill does not start an agent');
  h.edit('/visual-studio Build Debug'); h.view.submitStart(h.cx);
  const intent = h.memory[h.LAUNCH_INTENTS][0];
  assert.equal(intent.command, 'visual-studio'); assert.equal(intent.task, '/visual-studio Build Debug');
});

test('Escape dismisses without changing the draft; editing away the token drops the selected command', async () => {
  const h = await shell(); h.edit('/');
  const request = h.memory[contract.COMPOSER_COMMAND_REQUESTS][0];
  h.memory[contract.COMPOSER_COMMAND_RESULTS] = { [request.id]: { items: commands, expiresAt: request.expiresAt } };
  h.view.refreshStartCommands(h.cx); h.view.startCommandAction('escape', h.cx);
  assert.equal(h.view.startCommandOpen(), false); assert.equal(h.input.text, '/');
  h.edit('/rev'); h.view.startCommandAction('tab', h.cx);
  assert.equal(h.input.text, '/review ');
  h.edit('A different task'); h.view.submitStart(h.cx);
  assert.equal(h.memory[h.LAUNCH_INTENTS][0].command, undefined);
});

test('project or program changes discard selected commands and ignore late command results', async () => {
  const h = await shell(); h.edit('/');
  const old = h.memory[contract.COMPOSER_COMMAND_REQUESTS][0];
  h.view.startTarget = { ...h.target(), project: { ...project, folder: '/other' }, target: { folder: '/other' } };
  h.view.refreshStartCommands(h.cx);
  h.memory[contract.COMPOSER_COMMAND_RESULTS] = { [old.id]: { items: commands, expiresAt: old.expiresAt } };
  h.view.refreshStartCommands(h.cx); assert.deepEqual(h.view.startCommandItems(), []);
  const current = h.view.startCommandCache;
  h.view.refreshStartCommands(h.cx, current.expiresAt + 1);
  assert.match(current.error, /Could not load/); assert.equal(h.input.text, '/');
});

test('successful skill lists survive transport expiry, new drafts and switching scopes; Refresh reloads only the current scope', async () => {
  const h = await shell(); h.edit('/');
  const request = h.memory[contract.COMPOSER_COMMAND_REQUESTS][0];
  h.memory[contract.COMPOSER_COMMAND_RESULTS] = { [request.id]: { items: commands, expiresAt: request.expiresAt } };
  h.view.refreshStartCommands(h.cx);
  h.memory[contract.COMPOSER_COMMAND_REQUESTS] = [];
  h.memory[contract.COMPOSER_COMMAND_RESULTS] = {};
  h.edit(''); h.edit('/');
  h.view.refreshStartCommands(h.cx, request.expiresAt + 1);
  assert.deepEqual(h.view.startCommandItems(), commands);
  assert.deepEqual(h.memory[contract.COMPOSER_COMMAND_REQUESTS], []);

  const first = h.view.startCommandCache;
  h.view.chooseStartAgent(project, 'other', h.cx);
  h.view.startTarget = { ...h.target(), intent: { ...h.target().intent, choice: 'other' } };
  h.view.refreshStartCommands(h.cx);
  const other = h.view.startCommandCache;
  assert.notEqual(other, first);
  h.view.startTarget = { ...h.target(), target: { folder: '/other' } };
  h.view.refreshStartCommands(h.cx);
  const otherProject = h.view.startCommandCache;
  assert.notEqual(otherProject, first);
  h.view.startTarget = h.target(); h.view.refreshStartCommands(h.cx);
  assert.equal(h.view.startCommandCache, first);
  assert.deepEqual(h.view.startCommandItems(), commands);

  h.view.reloadStartCommands(h.cx);
  assert.notEqual(h.view.startCommandCache, first);
  assert.equal(h.view.startCommandCache.items, null);
  assert.equal(h.view.startCommandCaches.get(other.scope), other);
  assert.equal(h.view.startCommandCaches.get(otherProject.scope), otherProject);
});

test('failed skill discovery can be retried without keeping the failed scope cache', async () => {
  const h = await shell(); h.edit('/');
  const request = h.memory[contract.COMPOSER_COMMAND_REQUESTS][0];
  h.memory[contract.COMPOSER_COMMAND_RESULTS] = { [request.id]: { items: [], error: 'Read failed', expiresAt: request.expiresAt } };
  h.view.refreshStartCommands(h.cx);
  assert.equal(h.view.startCommandCache.error, 'Read failed');
  h.view.reloadStartCommands(h.cx);
  const retry = h.view.startCommandCache;
  assert.equal(retry.items, null); assert.equal(retry.error, null);
  h.memory[contract.COMPOSER_COMMAND_RESULTS][retry.id] = { items: commands, expiresAt: retry.expiresAt };
  h.view.refreshStartCommands(h.cx);
  assert.deepEqual(h.view.startCommandItems(), commands);
});

test('invocation choices scope skill caches and changing ECC immediately requests its skills without reusing late results', async () => {
  const h = await shell(), choice = { key: 'account', fields: [
    { id: 'eccProfile', type: 'select', value: 'inherit', options: ['inherit', 'development', 'basic'].map(key => ({ key, label: key })) },
    { id: 'fast', type: 'toggle', value: false },
  ] };
  h.view.startTarget.intent.values = { eccProfile: 'inherit', fast: false };
  h.edit('/');
  const inherited = h.memory[contract.COMPOSER_COMMAND_REQUESTS][0], originalScope = h.view.startCommandScope();
  h.memory[contract.COMPOSER_COMMAND_RESULTS] = { [inherited.id]: { items: commands, expiresAt: inherited.expiresAt } };
  h.view.refreshStartCommands(h.cx);
  h.view.startTarget.intent.values = { fast: false, eccProfile: 'inherit' };
  assert.equal(h.view.startCommandScope(), originalScope, 'property insertion order does not change scope');

  h.view.pickStartValue(choice, 'eccProfile', 'development', h.cx);
  const selected = h.memory[contract.COMPOSER_COMMAND_REQUESTS].at(-1);
  assert.notEqual(selected.id, inherited.id);
  assert.deepEqual(selected.values, { eccProfile: 'development', fast: false });
  assert.deepEqual(inherited.values, { eccProfile: 'inherit', fast: false }, 'queued invocation values are a snapshot');
  h.view.refreshStartCommands(h.cx);
  assert.deepEqual(h.view.startCommandItems(), [], 'the inherited result cannot fill the new scope');
  const presetSkills = [{ id: 'ecc:tdd', name: 'ecc-tdd', description: 'Development skill' }];
  h.memory[contract.COMPOSER_COMMAND_RESULTS][selected.id] = { items: presetSkills, expiresAt: selected.expiresAt };
  h.view.refreshStartCommands(h.cx);
  assert.deepEqual(h.view.startCommandItems(), presetSkills);
  h.view.chooseStartCommand(presetSkills[0], h.cx);
  h.view.pickStartValue(choice, 'eccProfile', 'basic', h.cx);
  assert.equal(h.view.startCommandSelection, null, 'changing invocation values invalidates the selected opaque ID');
  assert.equal(h.input.text, '/ecc-tdd ', 'changing ECC preserves the draft');
  h.edit('/');
  const basic = h.memory[contract.COMPOSER_COMMAND_REQUESTS].at(-1);
  h.view.pickStartValue(choice, 'eccProfile', 'inherit', h.cx);
  h.memory[contract.COMPOSER_COMMAND_RESULTS][basic.id] = { items: [], expiresAt: basic.expiresAt };
  h.view.refreshStartCommands(h.cx);
  assert.equal(h.view.startCommandScope(), originalScope);
  assert.deepEqual(h.view.startCommandItems(), commands, 'returning to inheritance restores only its own cached list');
});

test('command transport rejects unknown fields, invalid targets, duplicates, paths and expired replies', () => {
  const now = 100, request = { id: 'request:1', launcher: 'agents', choice: 'codex', target: { folder: '/project' }, values: { eccProfile: 'development', fast: true }, expiresAt: now + 30000 };
  assert.equal(contract.validComposerCommandRequest(request, now, []), true);
  for (const bad of [{ ...request, token: 'secret' }, { ...request, expiresAt: now }, { ...request, target: { folder: '/project', space: 'unknown' } }])
    assert.equal(contract.validComposerCommandRequest(bad, now, []), false);
  for (const values of [undefined, null, [], { model: null }, { fast: 1 }, { 'invalid key': 'basic' }, { model: 'x'.repeat(201) },
    Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field${index}`, 'value']))])
    assert.equal(contract.validComposerCommandRequest({ ...request, values }, now, []), false);
  assert.deepEqual(contract.composerCommands({ items: commands, expiresAt: 200 }, now), commands);
  for (const items of [[commands[0], commands[0]], [{ ...commands[0], name: '../review' }], [{ ...commands[0], path: '/source' }]])
    assert.equal(contract.composerCommands({ items, expiresAt: 200 }, now), null);
  assert.equal(contract.composerCommands({ items: commands, expiresAt: now }, now), null);
});

test('provider discovers skills for the requested choice/project without launching and returns errors as retryable results', async () => {
  const now = Date.now(), requests = [{ id: 'request:1', launcher: 'agents', choice: 'codex', target: { folder: '/project' }, values: { eccProfile: 'inherit' }, expiresAt: now + 30000 }];
  const memory = { [contract.COMPOSER_COMMAND_REQUESTS]: requests, 'herdr-zed.agent-cache': { null: [{ key: 'codex' }] } }, calls = [], jobs = [];
  const { Composer } = await evaluateNative('../mods/herdr-zed-agents/composer.js', { ...contract, launchWorkflowOptions, LAUNCHER_ID: 'agents',
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, spaces: () => [], availableAgents: profiles => profiles,
    providerCommands: async (agent, target) => { calls.push([agent, target]); return commands; } }, 'Composer');
  const service = new Composer(), cx = { spawn: fn => jobs.push(fn()) };
  service.pollCommands(cx); await Promise.all(jobs);
  assert.deepEqual(calls, [[{ key: 'codex' }, { folder: '/project' }]]);
  assert.deepEqual(memory[contract.COMPOSER_COMMAND_RESULTS]['request:1'].items, commands);
  assert.deepEqual(memory[contract.COMPOSER_COMMAND_REQUESTS], []);
  memory[contract.COMPOSER_COMMAND_REQUESTS] = [{ ...requests[0], id: 'request:2', choice: 'removed' }];
  service.pollCommands(cx); await Promise.all(jobs);
  assert.match(memory[contract.COMPOSER_COMMAND_RESULTS]['request:2'].error, /no longer available/);
  assert.equal(calls.length, 1);
});

test('explicit ECC skill discovery uses the invocation snapshot for either provider and publishes only command metadata', async () => {
  for (const kind of ['claude', 'codex']) {
    const request = { id: `preset:${kind}`, launcher: 'agents', choice: kind, target: { folder: '/project' }, values: { eccProfile: 'development' }, expiresAt: Date.now() + 30000 };
    const memory = { [contract.COMPOSER_COMMAND_REQUESTS]: [request], 'herdr-zed.agent-cache': { null: [{ key: kind }] } }, calls = [], jobs = [];
    const { Composer } = await evaluateNative('../mods/herdr-zed-agents/composer.js', { ...contract, launchWorkflowOptions, eccProfiles, sessionKind, LAUNCHER_ID: 'agents',
      shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, spaces: () => [], availableAgents: profiles => profiles,
      providerCommands: async () => { throw Error('Global inventory must not replace the selected preset.'); },
      providerDevkits: async (...args) => { calls.push(args); return { commands: [{ id: 'ecc:tdd', name: 'ecc-tdd', description: 'Development skill', path: '/immutable/SKILL.md' }] }; } }, 'Composer');
    const service = new Composer(), cx = { spawn: fn => jobs.push(fn()) };
    service.pollCommands(cx); await Promise.all(jobs);
    assert.deepEqual(calls, [[kind, request.target, {}, '', { eccProfile: 'development' }]]);
    assert.deepEqual(memory[contract.COMPOSER_COMMAND_RESULTS][request.id], {
      items: [{ id: 'ecc:tdd', name: 'ecc-tdd', description: 'Development skill' }], expiresAt: request.expiresAt,
    });
    assert.deepEqual(memory[contract.COMPOSER_COMMAND_REQUESTS], []);
    memory[contract.COMPOSER_COMMAND_REQUESTS] = [{ ...request, id: `invalid:${kind}`, values: { eccProfile: 'unknown' } }];
    service.pollCommands(cx); await Promise.all(jobs);
    assert.match(memory[contract.COMPOSER_COMMAND_RESULTS][`invalid:${kind}`].error, /available ECC preset/);
    assert.equal(calls.length, 1, 'invalid presets never read a skill snapshot');
  }
});

test('the provider launches with the resolved skill task as the actual first prompt', async () => {
  const memory = {}, task = 'Use the skill at `/snapshot/SKILL.md`.\n\nCheck this project.';
  const { emitLaunch, LAUNCH_REQUESTS } = await evaluateNative('../mods/herdr-zed-agents/launch.js', { ...contract, launchWorkflowOptions,
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, spaces: () => [], window: () => ({ platform: 'windows' }),
    sessionKind: () => 'codex', terminalArgv: argv => argv, prepareSession: async () => ({ argv: ['codex'], session: {}, task }) }, 'emitLaunch, LAUNCH_REQUESTS');
  await emitLaunch({ key: 'codex', name: 'Codex' }, { folder: '/project', task: '/review Check this project.' }, { command: 'mine:skills:review' });
  assert.deepEqual(memory[LAUNCH_REQUESTS][0].argv, ['codex', '--', task]);
});

test('slash results live in a native popup content slot, outside the composer layout flow', async () => {
  const memory = {};
  const make = (type, id) => {
    const data = { type, name: id, nodes: [], styles: {} }; let proxy;
    proxy = new Proxy(data, { get(target, key) {
      if (key in target) return target[key];
      if (key === 'when') return (condition, fn) => { if (condition) fn(proxy); return proxy; };
      if (key === 'child') return child => { if (child) data.nodes.push(child); return proxy; };
      if (key === 'children') return children => { data.nodes.push(...children.filter(Boolean)); return proxy; };
      if (key === 'content') return value => { data.overlay = value; return proxy; };
      if (key === 'id') return value => { data.name = value; return proxy; };
      return (...args) => { data.styles[key] = args; return proxy; };
    } }); return proxy;
  };
  const { startPanel } = await evaluateNative('../mods/herdr-zed/start-panel.js', { ...contract, launchWorkflowOptions,
    div: () => make('div'), h_flex: () => make('row'), v_flex: () => make('column'), glyph: () => make('icon'),
    shared: key => memory[key], Textarea: { new: () => make('textarea') }, Popup: { new: (id, trigger) => make('popup', id).child(trigger) },
    Button: id => make('button', id), ToolbarButton: id => make('button', id) }, 'startPanel');
  const view = { ...startPanel, startTask: { value: () => '/' }, startImages: [], startGitView: () => null,
    startTarget: { intent: { launcher: 'fixture', choice: 'fixture' }, target: { folder: '/fixture' } } };
  const manyCommands = Array.from({ length: 8 }, (_, i) => ({ id: `skill:${i}`, name: `skill-${i}`, description: 'Description' }));
  view.startCommandCache = { scope: view.startCommandScope(), items: manyCommands };
  const tree = view.composerView({ name: 'Fixture' }, {}, {}, { ready: true, takesTask: true });
  assert.deepEqual(tree.styles.key_context, ['HerdrComposerSubmit']);
  let submitted = 0, stopped = 0;
  view.submitStart = () => submitted++;
  const [action, submit] = tree.styles.on_action;
  assert.equal(action, 'herdr-composer-submit');
  submit({}, { stop_propagation() { stopped++; } });
  assert.equal(submitted, 1); assert.equal(stopped, 1, 'submission consumes the key instead of inserting a newline');
  memory['herdr-zed.ctrl-enter-submit'] = false;
  assert.equal(view.composerView({ name: 'Fixture' }, {}, {}, { ready: true, takesTask: true }).styles.key_context, undefined);
  const walk = node => node && typeof node === 'object' && node.nodes ? [node, ...node.nodes.flatMap(walk)] : [];
  const layout = walk(tree), popup = layout.find(node => node.name === 'project-start-command-popup');
  assert.ok(popup); assert.deepEqual(popup.styles.anchor, ['top_left']);
  assert.equal(layout.some(node => node.name === 'project-start-commands'), false);
  const trigger = walk(popup.nodes[0]);
  assert.ok(trigger.some(node => node.name === 'project-start-task'));
  assert.ok(trigger.some(node => node.name === 'project-start-toolbar'), 'Popup starts below the toolbar, not over it');
  assert.ok(trigger.some(node => node.name === 'project-start-submit'));
  const menu = walk(popup.overlay).find(node => node.name === 'project-start-commands');
  const list = walk(popup.overlay).find(node => node.name === 'project-start-command-list');
  assert.ok(menu); assert.ok(list);
  assert.equal(menu.styles.overflow_y_scroll, undefined, 'Only the options scroll; header/footer stay visible');
  assert.deepEqual(list.styles.h, [4 * 48]);
  assert.equal(list.nodes.length, 8, 'Overflow options remain reachable by scrolling');
  assert.deepEqual(list.styles.overflow_y_scrollbar, []);
  assert.deepEqual(popup.overlay.styles.pt, [6]);
  for (const row of list.nodes) {
    assert.deepEqual(row.styles.h, [48]);
    assert.deepEqual(row.styles.flex_none, []);
  }
  const resize = layout.find(node => node.name === 'project-start-task-anchor').styles.on_size_change[0];
  let notified = 0;
  for (const width of [640, 320]) {
    resize({ width }, { notify() { notified++; } });
    const resized = walk(view.startCommandMenu({})).find(node => node.name === 'project-start-commands');
    assert.deepEqual(resized.styles.w, [width]);
  }
  resize({ width: 320 }, { notify() { notified++; } });
  resize({ width: 0 }, { notify() { notified++; } });
  assert.equal(notified, 2, 'Only a changed nonzero input width redraws the menu');
});
