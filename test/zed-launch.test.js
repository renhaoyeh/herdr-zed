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
