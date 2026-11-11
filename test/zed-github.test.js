import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { evaluateNative } from './source-harness.js';

const run = promisify(execFile);
const path = file => new URL(`../mods/herdr-zed/${file}`, import.meta.url);
const input = () => ({ text: '', on() {}, value() { return this.text; }, set_value(value) { this.text = value; }, release() {} });

async function settingsFor(target, host) {
  const source = await readFile(path('git-author-settings.js'), 'utf8');
  const clean = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const names = ['Input', 'div', 'InputState', 'v_flex', 'props', 'openOverlay', 'closeOverlay', 'Button', 'Select', 'SelectState',
    'DialogContent', 'DialogTitle', 'DialogDescription', 'DialogFooter', 'readGitAuthor', 'saveGitAuthor', 'gitAccount', 'setGitAccount',
    'readAccountAuthor', 'rememberGitAuthor', 'readGitAccounts'];
  const bindings = { Input: {}, div() {}, InputState: { new: input }, v_flex() {}, props: () => target, openOverlay() {},
    closeOverlay: host.closeOverlay, Button() {}, Select() {}, SelectState: class { constructor() { this.search = { release() {} }; } },
    DialogContent() {}, DialogTitle() {}, DialogDescription() {}, DialogFooter() {}, readGitAuthor: host.readGitAuthor,
    saveGitAuthor: host.saveGitAuthor, gitAccount: host.gitAccount, setGitAccount: host.setGitAccount,
    readAccountAuthor: host.readAccountAuthor, rememberGitAuthor: host.rememberGitAuthor, readGitAccounts: host.readGitAccounts };
  const GitAuthorSettings = new Function(...names, clean + '\nreturn GitAuthorSettings;')(...names.map(name => bindings[name]));
  return new GitAuthorSettings();
}

async function settle(tasks) { while (tasks.length) await tasks.shift()({ notify() {}, stop_propagation() {} }); }

test('Zed account selection preserves the old account and draft after a failed repository author write', async () => {
  const events = [], tasks = [], target = { folder: '/repo', machine: 'box', overlay: 'dialog', accountPicker: true };
  const old = { host: 'github.com', login: 'old' }, chosen = { host: 'github.com', login: 'alice', available: true };
  const view = await settingsFor(target, {
    gitAccount: () => old,
    readGitAuthor: async () => ({ name: 'Repo', email: 'repo@example.test' }),
    readAccountAuthor: async () => ({ name: 'Old', email: 'old@example.test' }),
    readGitAccounts: async () => [chosen],
    readAccountAuthor: async () => ({ name: 'Alice', email: '' }),
    saveGitAuthor: async (...args) => { events.push(['write', ...args]); throw new Error('config locked'); },
    rememberGitAuthor: () => events.push(['remember']), setGitAccount: () => events.push(['account']),
    closeOverlay: () => events.push(['close']),
  });
  const cx = { notify() {}, spawn(fn) { tasks.push(fn); } };
  view.init(cx); await settle(tasks);
  view.chooseAccount('0', cx); await settle(tasks);
  assert.equal(view.name.value(), 'Alice'); assert.equal(view.email.value(), '');
  view.email.set_value('alice@example.test');
  view.save(cx); await settle(tasks);
  assert.deepEqual(events.map(event => event[0]), ['write']);
  assert.deepEqual(events[0].slice(1), ['/repo', 'box', { name: 'Alice', email: 'alice@example.test' }]);
  assert.equal(view.account, chosen); assert.equal(view.name.value(), 'Alice');
  assert.equal(view.email.value(), 'alice@example.test'); assert.equal(view.error, 'config locked');
});

test('Zed Cancel discards the draft without writing Git config or account state', async () => {
  const events = [], tasks = [], target = { folder: '/repo', machine: '', overlay: 'dialog', accountPicker: true };
  const view = await settingsFor(target, { gitAccount: () => null,
    readGitAuthor: async () => ({ name: 'Saved', email: 'saved@example.test' }),
    readGitAccounts: async () => [], saveGitAuthor: async () => events.push('write'),
    setGitAccount: () => events.push('account'), rememberGitAuthor: () => events.push('remember'),
    closeOverlay: id => events.push(['close', id]) });
  const cx = { notify() {}, spawn(fn) { tasks.push(fn); } };
  view.init(cx); await settle(tasks);
  view.name.set_value('Unsaved');
  const nodes = new Map(), element = () => { const data = {}; const el = new Proxy(data, { get(obj, key) { if (key === 'when') return (condition, fn) => { if (condition) fn(el); return el; }; return (...args) => { if (key === 'id') nodes.set(args[0], data); if (key === 'on_click') data.click = args[0]; return el; }; } }); return el; };
  const renderView = await settingsFor(target, {});
  Object.assign(renderView, view);
  // Invoke the actual Cancel button callback produced by render.
  const native = await readFile(path('git-author-settings.js'), 'utf8');
  const render = new Function('div', 'v_flex', 'Input', 'Button', 'Select', 'DialogContent', 'DialogTitle', 'DialogDescription', 'DialogFooter', 'props', 'closeOverlay', 'theme', 'settings', native.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn GitAuthorSettings.prototype.render;');
  const renderFn = render(element, element, { new: element }, (id) => element().id(id), () => element(), element, element, element, element, () => target, id => events.push(['close', id]), () => ({}), {});
  renderFn.call(view, {}); nodes.get('git-author-cancel').click({}, { notify() {} });
  assert.deepEqual(events, [['close', 'dialog']]);
});

test('Zed Save writes repository-local author before remembering and committing the account', async () => {
  const events = [], tasks = [], target = { folder: '/repo', machine: 'box', overlay: 'dialog', accountPicker: true };
  const account = { host: 'github.com', login: 'alice', available: true };
  const view = await settingsFor(target, { gitAccount: () => null,
    readGitAuthor: async () => ({ name: 'Before', email: 'before@example.test' }),
    readGitAccounts: async () => [account], readAccountAuthor: async () => ({ name: 'Alice', email: '' }),
    saveGitAuthor: async (...args) => events.push(['write', ...args]),
    rememberGitAuthor: (...args) => events.push(['remember', ...args]),
    setGitAccount: (...args) => events.push(['account', ...args]), closeOverlay: id => events.push(['close', id]) });
  const cx = { notify() {}, spawn(fn) { tasks.push(fn); } };
  view.init(cx); await settle(tasks); view.chooseAccount('0', cx); await settle(tasks);
  view.email.set_value('alice@example.test'); view.save(cx); await settle(tasks);
  assert.deepEqual(events.map(event => event[0]), ['write', 'remember', 'account', 'close']);
  assert.deepEqual(events[0], ['write', '/repo', 'box', { name: 'Alice', email: 'alice@example.test' }]);
  assert.deepEqual(events[2], ['account', target, account]);
});

test('Zed git-auth helper routes remote Git through the selected account without global credential state', async () => {
  const memory = {}, calls = [];
  const auth = await evaluateNative(path('git-auth.js'), { shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    exec: async (...args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ login: 'alice', name: null, email: null }) }; } },
  'gitAccount, setGitAccount, readGitAccounts, gitAuthArgs, readAccountAuthor, rememberGitAuthor');
  const account = { host: 'github.com', login: 'alice', available: true };
  auth.setGitAccount({ folder: '/repo', machine: 'box' }, account);
  assert.deepEqual(auth.gitAccount({ folder: '/repo', machine: 'box' }), { host: account.host, login: account.login });
  assert.deepEqual(auth.gitAccount({ folder: '/repo', machine: 'other' }), null);
  assert.deepEqual(auth.gitAuthArgs(account).slice(0, 2), ['-c', 'credential.https://github.com.helper=']);
  assert.ok(auth.gitAuthArgs(account).some(value => value.includes('gh auth token --hostname')));
  assert.deepEqual(await auth.readAccountAuthor(account, 'box'), { name: 'alice', email: '' });
  assert.equal(calls[0][0], 'gh'); assert.deepEqual(calls[0][2], { on: 'box' });
  assert.ok(!JSON.stringify(memory).includes('fixture-token'));
  const gitCalls = [];
  const { gitRemoteAction } = await evaluateNative(path('diff.js'), { gitAuthArgs: auth.gitAuthArgs,
    execShell: async (...args) => { gitCalls.push(args); return { code: 0, stdout: '', stderr: '' }; } }, 'gitRemoteAction');
  await gitRemoteAction('/repo', 'box', 'push', undefined, auth.gitAccount({ folder: '/repo', machine: 'box' }));
  assert.deepEqual(gitCalls[0][0].slice(0, 3), ['-c', 'cd "$1" || exit 2; shift; GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git "$@"', 'herdr-zed-git']);
  assert.ok(gitCalls[0][0].includes('credential.https://github.com.username=alice'));
  assert.equal(gitCalls[0][1].on, 'box');
});
