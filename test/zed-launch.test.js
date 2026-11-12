import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCH_REQUESTS, LAUNCH_HANDLED, THREADS, claimLaunchRequests, acceptLaunchRequests, reconcileLaunches, openLaunch, pendingLaunch, pollLaunchIntake }
  from '../mods/herdr-zed/launch-intake.js';
import { newTerminalCommand, readNewTerminalCommand } from '../components/extension-contract.js';
import { evaluateNative } from './source-harness.js';
import { terminalArgv } from '../components/session-shell.js';

const NOW = 1_000_000;
const request = (overrides = {}) => ({ id: 'req-1', source: 'alpha', name: 'Claude', profile: 'work',
  target: { space: 'space-1', folder: '/repo', projectName: 'Repo' }, argv: ['claude', '--model', 'sonnet', 'a b', '$(unused)'],
  expiresAt: NOW + 30_000, ...overrides });
const options = (overrides = {}) => ({ now: NOW, launcherId: 'alpha', spaces: [{ id: 'space-1', machine: null }], ...overrides });

function memoryStore(initial = {}) {
  const memory = { ...initial };
  return { memory, shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); } };
}
// The shell's native API as pollLaunchIntake uses it; `calls` records native commands, `notices` the notifications.
const intakeApi = (store, calls = [], notices = []) => ({ shared: store.shared, setShared: store.setShared,
  spaces: () => [{ id: 'space-1', machine: null, tabs: [] }], run: (command, args) => calls.push([command, args]),
  closeOverlay: id => calls.push(['close', id]), notify: notice => notices.push(notice), launcherId: 'alpha' });
const tabOpens = calls => calls.filter(([command]) => command === 'tab.new').length;

test('a queued request is processed once: handled IDs are remembered in memory and in shared state', () => {
  const store = memoryStore({ [LAUNCH_REQUESTS]: [request(), request({ id: 'req-2' })] });
  const calls = [], api = intakeApi(store, calls);
  const state = { handled: [] };
  pollLaunchIntake(api, state, NOW);
  pollLaunchIntake(api, state, NOW + 100);
  assert.equal(tabOpens(calls), 2, 'each request opens one tab, however often the queue is polled');
  pollLaunchIntake(api, { handled: [] }, NOW + 200);
  assert.equal(tabOpens(calls), 2, 'a new view with an empty in-memory list still reads the shared handled list');
  store.memory[LAUNCH_HANDLED] = [];
  pollLaunchIntake(api, state, NOW + 300);
  assert.equal(tabOpens(calls), 2, 'the in-memory list alone also prevents a second open');
});

test('the shell never writes the request queue and prunes handled IDs once they expire', () => {
  const writes = [];
  const memory = { [LAUNCH_REQUESTS]: [request({ id: 'live' }), request({ id: 'old', expiresAt: NOW - 1 })] };
  const api = { ...intakeApi(memoryStore()), shared: key => memory[key],
    setShared: (key, value) => { writes.push(key); memory[key] = structuredClone(value); } };
  const state = { handled: [] };
  pollLaunchIntake(api, state, NOW);
  assert.equal(writes.includes(LAUNCH_REQUESTS), false);
  assert.deepEqual(memory[LAUNCH_HANDLED], [{ id: 'live', expiresAt: NOW + 30_000 }]);
  pollLaunchIntake(api, { handled: [] }, NOW + 30_000);
  assert.deepEqual(memory[LAUNCH_HANDLED], [], 'the entry is pruned at expiresAt');
  assert.equal(memory[LAUNCH_REQUESTS].length, 2, 'the provider, not the shell, prunes the queue');
});

test('expired and malformed queue entries are never claimed; a rejected request is reported once', () => {
  const queue = [request({ id: 'old', expiresAt: NOW }), request({ id: 'string-expiry', expiresAt: String(NOW + 1000) }),
    request({ id: 'bad', argv: [] })];
  const { claimed, handled } = claimLaunchRequests(queue, [], NOW);
  assert.deepEqual(claimed.map(item => item.id), ['bad']);
  assert.deepEqual(handled, [{ id: 'bad', expiresAt: NOW + 30_000 }]);
  const store = memoryStore({ [LAUNCH_REQUESTS]: queue }), notices = [], calls = [];
  const state = { handled: [] };
  pollLaunchIntake(intakeApi(store, calls, notices), state, NOW);
  pollLaunchIntake(intakeApi(store, calls, notices), state, NOW + 100);
  assert.equal(notices.length, 1, 'the rejection is shown once');
  assert.match(notices[0].body, /argv/);
  assert.equal(tabOpens(calls), 0);
});

test('a Terminal request from the Agents picker opens exactly the native Terminal choice', async () => {
  const picker = { view: 'launcher', overlay: 'picker-1', space: 'space-1', folder: '/repo', projectName: 'Repo', machine: null };
  const native = [], nativeMemory = {};
  const host = (calls, memory) => ({ spaces: () => [{ id: 'space-1', machine: null }], shared: key => memory[key],
    setShared: (key, value) => { memory[key] = value; }, run: (...args) => calls.push(args), closeOverlay: id => calls.push(['close', id]),
    window: () => ({ platform: 'windows' }), terminalArgv });
  const { createNativeThread } = await evaluateNative('../mods/herdr-zed/native-threads.js', host(native, nativeMemory), 'createNativeThread');
  createNativeThread(null, { space: 'space-1', folder: '/repo', projectName: 'Repo', machine: null, overlay: 'picker-1' });

  const shell = readNewTerminalCommand(newTerminalCommand(picker), [{ id: 'space-1', machine: null }]);
  assert.equal(shell.ok, true);
  const opened = [], openedMemory = {};
  const { createNativeThread: openFromShell } = await evaluateNative('../mods/herdr-zed/native-threads.js', host(opened, openedMemory), 'createNativeThread');
  openFromShell(null, shell.value);
  assert.deepEqual(opened, native, 'same layout, tab and overlay calls as the native picker');
  assert.deepEqual(openedMemory, nativeMemory, 'same shell keys as the native picker');
  assert.deepEqual(opened.find(([name]) => name === 'tab.new'), ['tab.new', { space: 'space-1', folder: '/repo' }]);
});

test('valid request opens the tab with argv identical to the one sent, and focuses main', () => {
  const sent = request();
  const { accepted, errors } = acceptLaunchRequests([sent], options());
  assert.deepEqual(errors, []);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].argv, sent.argv, 'the same array, not a rewritten copy');
  const store = memoryStore({ [THREADS]: {} });
  const calls = [], closed = [];
  const api = { spaces: () => [{ id: 'space-1', tabs: [{ id: 'tab-old', name: 'Shell' }] }], shared: store.shared, setShared: store.setShared,
    run: (command, args) => calls.push([command, args]), closeOverlay: id => closed.push(id) };
  openLaunch({ ...accepted[0], target: { ...accepted[0].target, overlay: 'picker-overlay' } }, api);
  assert.deepEqual(calls, [
    ['layout.select', { stack: 'workspace-view', child: 'main' }],
    ['tab.new', { space: 'space-1', folder: '/repo', name: 'Claude', argv: sent.argv }],
  ]);
  assert.equal(calls[1][1].argv, sent.argv, 'argv reaches the native call unchanged');
  assert.deepEqual(closed, ['picker-overlay']);
  assert.equal(store.memory['herdr-zed.launch.pending'].length, 1);
  assert.deepEqual(store.memory['herdr-zed.launch.pending'][0].known, ['tab-old']);
});

test('a request task reaches tab.new as the first message; empty or oversize tasks are rejected', () => {
  const { accepted, errors } = acceptLaunchRequests([request({ task: 'Fix the login bug' })], options());
  assert.deepEqual(errors, []);
  assert.equal(accepted[0].task, 'Fix the login bug');
  const calls = [], store = memoryStore({ [THREADS]: {} });
  openLaunch(accepted[0], { spaces: () => [{ id: 'space-1', tabs: [] }], shared: store.shared, setShared: store.setShared,
    run: (command, args) => calls.push([command, args]), closeOverlay() {} });
  assert.equal(calls.find(([command]) => command === 'tab.new')[1].task, 'Fix the login bug');
  for (const task of ['  ', 42, 'x'.repeat(20001)])
    assert.equal(acceptLaunchRequests([request({ id: `t-${String(task).length}`, task })], options()).accepted.length, 0);
});

test('expired, wrong-source, inactive-launcher and malformed requests are dropped with one message per distinct error', () => {
  const expired = request({ id: 'old', expiresAt: NOW - 1 });
  const wrongSource = request({ id: 'other', source: 'beta' });
  const duplicate = request({ id: 'dup', source: 'beta' });
  const { accepted, errors } = acceptLaunchRequests([expired, wrongSource, duplicate, request({ id: 'bad', argv: [] })], options());
  assert.deepEqual(accepted, []);
  assert.equal(errors.length, 3, 'expired, wrong source and empty argv are distinct messages');
  assert.match(errors[0], /expired/);
  assert.match(errors[1], /not the active launcher/);
  const none = acceptLaunchRequests([request()], options({ launcherId: null }));
  assert.deepEqual(none.accepted, []);
  assert.match(none.errors[0], /not the active launcher/);
});

test('origin is accepted and echoed into the thread read model; malformed origins are rejected', () => {
  const origin = { extension: 'tasks', ref: 'run-42' };
  const { accepted } = acceptLaunchRequests([request({ origin })], options());
  assert.deepEqual(accepted[0].origin, origin);
  const rejected = acceptLaunchRequests([request({ origin: { extension: 'Tasks', ref: 'x' } }), request({ id: 'b', origin: { extension: 'tasks', ref: 'x', extra: 1 } })], options());
  assert.equal(rejected.accepted.length, 0);
  assert.equal(rejected.errors.length, 1, 'both malformed origins share one message');
});

test('a new tab with the requested name in the target space is recorded once; closed tabs are pruned', () => {
  const launch = pendingLaunch(request({ origin: { extension: 'tasks', ref: 'run-42' } }), ['tab-old']);
  const spaces = [{ id: 'space-1', tabs: [{ id: 'tab-old', name: 'Claude' }, { id: 'tab-new', name: 'Claude' }] }];
  const first = reconcileLaunches({ pending: [launch], threads: { 'tab-gone': { profile: null, source: 'alpha' } } }, spaces, NOW);
  assert.deepEqual(first.threads, { 'tab-new': { profile: 'work', source: 'alpha', origin: { extension: 'tasks', ref: 'run-42' } } },
    'the known tab is not matched and the closed tab is pruned');
  assert.deepEqual(first.pending, []);
  const again = reconcileLaunches({ pending: first.pending, threads: first.threads }, spaces, NOW);
  assert.deepEqual(again.threads, first.threads);
});

test('a launch is matched only in its own target space and expires after the grace period', () => {
  const launch = pendingLaunch(request(), []);
  const elsewhere = [{ id: 'space-2', tabs: [{ id: 'tab-x', name: 'Claude' }] }];
  const kept = reconcileLaunches({ pending: [launch], threads: {} }, elsewhere, NOW);
  assert.deepEqual(kept.threads, {});
  assert.equal(kept.pending.length, 1, 'still waiting while within expiresAt plus grace');
  const expired = reconcileLaunches({ pending: [launch], threads: {} }, elsewhere, launch.expiresAt + 1);
  assert.deepEqual(expired.pending, [], 'dropped after the grace period');
});

test('a new space launch matches by folder and machine when no space is given', () => {
  const launch = pendingLaunch(request({ target: { folder: '/repo', machine: 'box', projectName: 'Repo' } }), []);
  const spaces = [{ id: 'space-9', folder: '/repo', machine: 'box', tabs: [{ id: 'tab-9', name: 'Claude' }] },
    { id: 'space-8', folder: '/repo', machine: null, tabs: [{ id: 'tab-8', name: 'Claude' }] }];
  const result = reconcileLaunches({ pending: [launch], threads: {} }, spaces, NOW);
  assert.deepEqual(Object.keys(result.threads), ['tab-9']);
});

test('Start a thread hands its task to the agent as the first message; a terminal takes none', async () => {
  const calls = [], memory = {};
  const api = { spaces: () => [{ id: 'space-1', machine: null }], shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    run: (...args) => calls.push(args), closeOverlay() {}, window: () => ({ platform: 'linux' }) };
  const { createNativeThread } = await evaluateNative('../mods/herdr-zed/native-threads.js', { ...api, terminalArgv }, 'createNativeThread');
  const target = { space: 'space-1', folder: '/repo', projectName: 'Repo', machine: null, task: 'Fix the login bug' };
  createNativeThread({ key: 'claude', name: 'Claude Code', run: ['claude'] }, target, api);
  assert.deepEqual(calls.find(([name]) => name === 'tab.new')[1].task, 'Fix the login bug');
  calls.length = 0;
  createNativeThread(null, target, api);
  assert.equal('task' in calls.find(([name]) => name === 'tab.new')[1], false);
  calls.length = 0;
  createNativeThread({ key: 'codex', name: 'Codex', run: ['codex'] }, { ...target, space: null }, api);
  assert.equal(calls.find(([name]) => name === 'space.new')[1].task, 'Fix the login bug');
});

test('with a launcher, the composer shows its published fields and hands it a launch intent', async () => {
  const memory = {};
  const contract = await import('../components/extension-contract.js');
  const { startPanel, LAUNCH_INTENTS } = await evaluateNative('../mods/herdr-zed/start-panel.js', { withAttachments: text => text, AttachmentStrip: () => null, pasteClipboardImage: async () => null, 
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, window: () => ({ platform: 'windows' }), spaces: () => [],
    Button() {}, Select() {}, SelectState: class {}, Empty() {}, EmptyTitle() {}, EmptyDescription() {}, glyph() {}, AgentIcon() {},
    div() {}, v_flex() {}, h_flex() {}, Textarea: {}, activeLauncher: () => ({ id: 'agents' }), COMPOSE_TAB: 'compose', ...contract,
    TextareaState: { new: () => ({ handlers: {}, text: 'Task', on(event, fn) { this.handlers[event] = fn; }, set_auto_grow() {}, value() { return this.text; }, set_value(text) { this.text = text; } }) },
  }, 'startPanel, LAUNCH_INTENTS');
  const choice = { key: 'codex', label: 'Codex', fields: [
    { id: 'model', label: 'Model', type: 'select', value: 'default', options: [{ key: 'default', label: 'Default' }, { key: 'gpt', label: 'GPT' }, { key: 'mini', label: 'Mini' }] },
    { id: 'effort', label: 'Effort', type: 'select', value: 'xhigh', options: [{ key: 'default', label: 'Default' },
      { key: 'xhigh', label: 'XHigh', only: { model: ['default', 'gpt'] } }] },
    { id: 'fast', label: 'Fast', type: 'toggle', value: false }] };
  const view = { ...startPanel };
  view.initStartPanel({});
  assert.deepEqual(view.startValues(choice), { model: 'default', effort: 'xhigh', fast: false });
  view.pickStartValue(choice, 'model', 'mini', { notify() {} });
  assert.equal(view.startValues(choice).effort, 'default', 'an effort the model lacks falls back');
  assert.deepEqual(({ ...startPanel }).startValues(choice), view.startValues(choice), 'a new view keeps the last chosen values');
  view.pickStartValue(choice, 'fast', true, { notify() {} });
  view.startTarget = { intent: { launcher: 'agents', choice: 'codex', values: view.startValues(choice) }, takesTask: true, target: { space: 's', folder: '/repo' } };
  view.submitStart({ notify() {} });
  const [intent] = memory[LAUNCH_INTENTS];
  assert.deepEqual({ ...intent, id: null, expiresAt: null }, { id: null, expiresAt: null, launcher: 'agents', choice: 'codex',
    target: { space: 's', folder: '/repo' }, values: { model: 'mini', effort: 'default', fast: true }, task: 'Task' });
  assert.ok(view.startPending, 'the panel stays and waits for the thread');
});

test('composer choices keep valid entries per machine and drop malformed ones', async () => {
  const { composerChoices, composerOptionShown } = await import('../components/extension-contract.js');
  const good = { key: 'claude', label: 'Claude', fields: [{ id: 'model', label: 'Model', type: 'select', value: 'default', options: [{ key: 'default', label: 'Default' }] }] };
  const envelope = { updatedAt: 1, machines: { '': { choices: [good, { key: 'terminal', label: 'T', fields: [] },
    { key: 'bad', label: 'Bad', fields: [{ id: 'model', label: 'Model', type: 'select', value: 'missing', options: [{ key: 'a', label: 'A' }] }] },
    { key: 'x', label: 'X', fields: [], extra: 1 }] } } };
  assert.deepEqual(composerChoices(envelope, null), [good]);
  assert.equal(composerChoices(envelope, 'remote'), null, 'an unpublished machine falls back to the picker');
  assert.equal(composerOptionShown({ only: { model: ['a'] } }, { model: 'b' }), false);
  assert.equal(composerOptionShown({}, { model: 'b' }), true);
});

test('Start a thread opens on the program last chosen in the project and starts only on Ctrl/Cmd+Enter', async () => {
  const tabs = [], memory = {};
  const { startChoice, startProjectKey, startPanel } = await evaluateNative('../mods/herdr-zed/start-panel.js', { withAttachments: text => text, AttachmentStrip: () => null, pasteClipboardImage: async () => null, 
    shared: key => memory[key], setShared() {}, window: () => ({ platform: 'windows' }), spaces: () => tabs, Button() {}, Select() {}, SelectState: class {},
    Empty() {}, EmptyTitle() {}, EmptyDescription() {}, glyph() {}, AgentIcon() {}, div() {}, v_flex() {}, h_flex() {}, Textarea: {},
    TextareaState: { new: () => ({ handlers: {}, text: 'Task', on(event, fn) { this.handlers[event] = fn; }, set_auto_grow() {}, value() { return this.text; }, set_value(text) { this.text = text; } }) },
  }, 'startChoice, startProjectKey, startPanel');
  const programs = [{ key: 'claude' }, { key: 'codex' }], project = { id: 's', folder: 'C:\\repo\\', machine: null };
  assert.equal(startChoice(programs, project, {}).key, 'claude', 'first program by default');
  assert.equal(startChoice(programs, project, { [startProjectKey(project)]: 'codex' }).key, 'codex');
  assert.equal(startChoice(programs, project, { [startProjectKey(project)]: 'terminal' }).key, 'claude', 'the composer offers agents only');
  const finished = [], shown = [];
  const started = [], view = { ...startPanel, editor: { projectKey: 'repo', finishCompose: key => finished.push(key) },
    showConversation: (...args) => shown.push(args), startThread: (agent, target) => started.push([agent?.key, target.task]) };
  view.initStartPanel({});
  view.startTarget = { agent: programs[0], takesTask: true, target: { space: 's' } };
  view.startTask.handlers.submit({ secondary: false }, { notify() {} });
  assert.deepEqual(started, [], 'plain Enter only adds a line');
  view.startTask.handlers.submit({ secondary: true }, { notify() {} });
  assert.deepEqual(started, [['claude', 'Task']]);
  assert.equal(view.startTask.value(), 'Task', 'the task stays until the thread appears');
  view.startTask.handlers.submit({ secondary: true }, { notify() {} });
  assert.equal(started.length, 1, 'Start is disabled while waiting');
  view.settleStart({ notify() {} }, Date.now() + 60000);
  assert.equal(view.startPending, null);
  assert.equal(view.startTask.value(), 'Task', 'a launch that never shows keeps the task to retry');
  view.startTask.handlers.submit({ secondary: true }, { notify() {} });
  tabs.push({ id: 'other', active: false, tabs: [{ id: 'unrelated' }] });
  view.settleStart({ notify() {} });
  assert.equal(view.startTask.value(), 'Task', 'another project cannot complete this launch');
  tabs.push({ id: 's', active: true, tabs: [{ id: 'new' }] });
  view.settleStart({ notify() {} });
  assert.equal(view.startTask.value(), '', 'the new thread clears the task');
  assert.deepEqual(finished, ['repo'], 'success closes the originating composer');
  assert.equal(shown[0][1].tabs[0].id, 'new', 'success reveals the new thread');
  memory['herdr-zed.ctrl-enter-submit'] = false;
  view.startTask.set_value('Next task');
  view.startTask.handlers.submit({ secondary: true }, { notify() {} });
  view.startTask.handlers.submit({ secondary: false, shift: true }, { notify() {} });
  assert.equal(started.length, 2, 'when unchecked, Ctrl+Enter and Shift+Enter do not submit');
  view.startTask.handlers.submit({ secondary: false }, { notify() {} });
  assert.equal(started.length, 3, 'when unchecked, Enter submits');
  assert.deepEqual(started.at(-1), ['claude', 'Next task']);

});

test('the panel reads the branch, changes and push state from git status', async () => {
  const { parseGitStatus } = await evaluateNative('../mods/herdr-zed/start-panel.js', {}, 'parseGitStatus');
  assert.deepEqual(parseGitStatus('## main...origin/main [ahead 4, behind 1]\n M a.js\n?? b.js\n'), { branch: 'main', changes: 2, ahead: 4, behind: 1 });
  assert.deepEqual(parseGitStatus('## No commits yet on dev\n'), { branch: 'dev', changes: 0, ahead: 0, behind: 0 });
  assert.equal(parseGitStatus('').branch, null);
});

test('a composer choice may carry a toned detail; a bad one drops the choice', async () => {
  const { composerChoices } = await import('../components/extension-contract.js');
  const choice = extra => ({ key: 'c', label: 'C', fields: [], ...extra });
  const read = c => composerChoices({ machines: { '': { choices: [c] } } }, null);
  assert.equal(read(choice({ detail: '5h 37% · Week 27%', tone: 'warning' })).length, 1);
  assert.equal(read(choice({ tone: 'loud' })).length, 0);
  assert.equal(read(choice({ detail: '' })).length, 0);
});

test('each control keeps its own starred options, listed first in its menu', async () => {
  const memory = {};
  const { startPanel, START_FAVORITES_KEY } = await evaluateNative('../mods/herdr-zed/start-panel.js', { withAttachments: text => text, AttachmentStrip: () => null, pasteClipboardImage: async () => null, 
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, window: () => ({}), spaces: () => [],
  }, 'startPanel, START_FAVORITES_KEY');
  const view = { ...startPanel }, cx = { notify() {} };
  view.toggleStartFavorite('agents', 'codex:model', 'sol', cx);
  view.toggleStartFavorite('agents', 'program', 'codex', cx);
  assert.deepEqual(view.startFavorites('agents', 'codex:model'), ['sol']);
  assert.deepEqual(view.startFavorites('agents', 'program'), ['codex']);
  assert.deepEqual(view.startFavorites('', 'program'), [], 'kept per launcher');
  view.toggleStartFavorite('agents', 'codex:model', 'sol', cx);
  assert.deepEqual(memory[START_FAVORITES_KEY].agents['codex:model'], [], 'starring again unstars');
});
