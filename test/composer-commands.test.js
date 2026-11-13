import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../components/extension-contract.js';
import { evaluateNative } from './source-harness.js';

const commands = [{ id: 'mine:skills:review', name: 'review', description: 'Review code' },
  { id: 'visual-studio', name: 'visual-studio', description: 'Build the solution' }];
const project = { id: 's', folder: '/project', name: 'Project', machine: null };
async function shell() {
  const memory = {}, events = {}, bindings = [], cx = { notify() {}, stop_propagation() {}, bind_keys: keys => bindings.push(...keys) };
  const input = { text: '', on(name, fn) { events[name] = fn; }, set_auto_grow() {}, value() { return this.text; }, set_value(value) { this.text = value; },
    set_selected_range(range) { this.range = range; }, focus() {} };
  const host = { ...contract, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, spaces: () => [],
    withAttachments: text => text, TextareaState: { new: () => input } };
  const { startPanel, LAUNCH_INTENTS } = await evaluateNative('../mods/herdr-zed/start-panel.js', host, 'startPanel, LAUNCH_INTENTS');
  const view = { ...startPanel }; view.initStartPanel(cx);
  const target = () => ({ intent: { launcher: 'custom-provider', choice: 'account', values: {} }, project, target: { folder: project.folder }, takesTask: true });
  view.startTarget = target();
  const edit = text => { input.text = text; events.change({}, cx); };
  return { view, memory, input, cx, edit, bindings, LAUNCH_INTENTS, target };
}

test('slash menu requests scoped commands, filters, selects by keyboard and hands an opaque command ID to the launcher', async () => {
  const h = await shell(); h.edit('/');
  assert.equal(h.bindings.length, 5);
  const request = h.memory[contract.COMPOSER_COMMAND_REQUESTS][0];
  assert.equal(request.launcher, 'custom-provider'); assert.equal(request.choice, 'account'); assert.equal(request.target.folder, '/project');
  h.memory[contract.COMPOSER_COMMAND_RESULTS] = { [request.id]: { items: commands, expiresAt: request.expiresAt } };
  h.view.refreshStartCommands(h.cx);
  assert.deepEqual(h.view.startCommandItems(), commands);
  h.edit('/solution'); assert.deepEqual(h.view.startCommandItems(), [commands[1]]);
  h.edit('/'); h.view.startCommandAction('down', h.cx); h.view.startCommandAction('enter', h.cx);
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

test('command transport rejects unknown fields, invalid targets, duplicates, paths and expired replies', () => {
  const now = 100, request = { id: 'request:1', launcher: 'agents', choice: 'codex', target: { folder: '/project' }, expiresAt: now + 30000 };
  assert.equal(contract.validComposerCommandRequest(request, now, []), true);
  for (const bad of [{ ...request, token: 'secret' }, { ...request, expiresAt: now }, { ...request, target: { folder: '/project', space: 'unknown' } }])
    assert.equal(contract.validComposerCommandRequest(bad, now, []), false);
  assert.deepEqual(contract.composerCommands({ items: commands, expiresAt: 200 }, now), commands);
  for (const items of [[commands[0], commands[0]], [{ ...commands[0], name: '../review' }], [{ ...commands[0], path: '/source' }]])
    assert.equal(contract.composerCommands({ items, expiresAt: 200 }, now), null);
  assert.equal(contract.composerCommands({ items: commands, expiresAt: now }, now), null);
});

test('provider discovers skills for the requested choice/project without launching and returns errors as retryable results', async () => {
  const now = Date.now(), requests = [{ id: 'request:1', launcher: 'agents', choice: 'codex', target: { folder: '/project' }, expiresAt: now + 30000 }];
  const memory = { [contract.COMPOSER_COMMAND_REQUESTS]: requests, 'herdr-zed.agent-cache': { null: [{ key: 'codex' }] } }, calls = [], jobs = [];
  const { Composer } = await evaluateNative('../mods/herdr-zed-agents/composer.js', { ...contract, LAUNCHER_ID: 'agents',
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

test('the provider launches with the resolved skill task as the actual first prompt', async () => {
  const memory = {}, task = 'Use the skill at `/snapshot/SKILL.md`.\n\nCheck this project.';
  const { emitLaunch, LAUNCH_REQUESTS } = await evaluateNative('../mods/herdr-zed-agents/launch.js', { ...contract,
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, spaces: () => [], window: () => ({ platform: 'windows' }),
    sessionKind: () => 'codex', terminalArgv: argv => argv, prepareSession: async () => ({ argv: ['codex'], session: {}, task }) }, 'emitLaunch, LAUNCH_REQUESTS');
  await emitLaunch({ key: 'codex', name: 'Codex' }, { folder: '/project', task: '/review Check this project.' }, { command: 'mine:skills:review' });
  assert.deepEqual(memory[LAUNCH_REQUESTS][0].argv, ['codex', '--', task]);
});

test('slash results live in a native popup content slot, outside the composer layout flow', async () => {
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
  const { startPanel } = await evaluateNative('../mods/herdr-zed/start-panel.js', { ...contract,
    div: () => make('div'), h_flex: () => make('row'), v_flex: () => make('column'), glyph: () => make('icon'),
    Textarea: { new: () => make('textarea') }, Popup: { new: (id, trigger) => make('popup', id).child(trigger) },
    Button: id => make('button', id), ToolbarButton: id => make('button', id) }, 'startPanel');
  const view = { ...startPanel, startTask: { value: () => '/' }, startImages: [], startGitView: () => null,
    startTarget: { intent: { launcher: 'fixture', choice: 'fixture' }, target: { folder: '/fixture' } } };
  view.startCommandCache = { scope: view.startCommandScope(), items: commands };
  const tree = view.composerView({ name: 'Fixture' }, {}, {}, { ready: true, takesTask: true });
  const walk = node => node && typeof node === 'object' && node.nodes ? [node, ...node.nodes.flatMap(walk)] : [];
  const layout = walk(tree), popup = layout.find(node => node.name === 'project-start-command-popup');
  assert.ok(popup); assert.deepEqual(popup.styles.anchor, ['bottom_left']);
  assert.equal(layout.some(node => node.name === 'project-start-commands'), false);
  assert.ok(walk(popup.overlay).some(node => node.name === 'project-start-commands'));
});
