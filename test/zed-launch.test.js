import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCH_REQUESTS, THREADS, takeLaunchRequests, acceptLaunchRequests, reconcileLaunches, openLaunch, pendingLaunch }
  from '../mods/herdr-zed/launch-intake.js';

const NOW = 1_000_000;
const request = (overrides = {}) => ({ id: 'req-1', source: 'alpha', name: 'Claude', profile: 'work',
  target: { space: 'space-1', folder: '/repo', projectName: 'Repo' }, argv: ['claude', '--model', 'sonnet', 'a b', '$(unused)'],
  expiresAt: NOW + 30_000, ...overrides });
const options = (overrides = {}) => ({ now: NOW, launcherId: 'alpha', spaces: [{ id: 'space-1', machine: null }], ...overrides });

function memoryStore(initial = {}) {
  const memory = { ...initial };
  return { memory, shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); } };
}

test('a poll takes and clears every queued request exactly once', () => {
  const store = memoryStore({ [LAUNCH_REQUESTS]: [request(), request({ id: 'req-2' })] });
  const taken = takeLaunchRequests(store.shared, store.setShared);
  assert.deepEqual(taken.map(item => item.id), ['req-1', 'req-2']);
  assert.deepEqual(store.memory[LAUNCH_REQUESTS], []);
  assert.deepEqual(takeLaunchRequests(store.shared, store.setShared), []);
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
