import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateNative } from './source-harness.js';
import { gitCredentialArgs, projectKey } from '../components/extension-contract.js';

const github = file => new URL(`../mods/herdr-zed-github/${file}`, import.meta.url);
const shell = file => new URL(`../mods/herdr-zed/${file}`, import.meta.url);
const input = () => ({ text: '', on() {}, value() { return this.text; }, set_value(value) { this.text = value; }, release() {} });
async function settle(tasks) { while (tasks.length) await tasks.shift()({ notify() {}, stop_propagation() {} }); }

// Loads the account dialog class from the GitHub mod with native and provider bindings supplied explicitly.
const ACCOUNT_NAMES = ['Input', 'div', 'InputState', 'v_flex', 'props', 'closeOverlay', 'Button', 'Select', 'SelectState',
  'DialogContent', 'DialogTitle', 'DialogDescription', 'DialogFooter', 'readGitAuthor', 'saveGitAuthor', 'gitAccount',
  'setGitAccount', 'readAccountAuthor', 'rememberGitAuthor', 'readGitAccounts', 'theme'];
async function accountFor(target, host) {
  const source = await readFile(github('account.js'), 'utf8');
  const clean = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const values = { Input: {}, div() {}, InputState: { new: input }, v_flex() {}, props: () => target, closeOverlay() {},
    Button() {}, Select() {}, SelectState: class { constructor() { this.search = { release() {} }; } },
    DialogContent() {}, DialogTitle() {}, DialogDescription() {}, DialogFooter() {}, gitAccount: () => null,
    theme: () => ({}), ...host };
  const { GitHubAccount } = new Function(...ACCOUNT_NAMES, clean + '\nreturn { GitHubAccount };')(...ACCOUNT_NAMES.map(name => values[name]));
  return new GitHubAccount();
}

test('GitHub account keeps the old account and draft after a failed repository author write', async () => {
  const events = [], tasks = [], project = { folder: '/repo', machine: 'box' };
  const old = { host: 'github.com', login: 'old' }, chosen = { host: 'github.com', login: 'alice', available: true };
  const view = await accountFor({ context: project, overlay: 'dialog' }, {
    gitAccount: () => old,
    readGitAuthor: async () => ({ name: 'Repo', email: 'repo@example.test' }),
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

test('GitHub account draft loads without applying it, and Default restores the repository author', async () => {
  const view = await accountFor({ context: { folder: '/repo', machine: 'remote' }, overlay: 'dialog' }, {
    readAccountAuthor: async () => ({ name: 'Alice', email: '' }),
    readGitAuthor: async () => ({ name: 'Repo', email: 'repo@example.test' }) });
  const pending = [], cx = { notify() {}, spawn(fn) { pending.push(fn); } };
  Object.assign(view, { project: { folder: '/repo', machine: 'remote' }, name: input(), email: input(),
    accounts: [{ host: 'github.com', login: 'alice', available: true }, { login: 'unavailable', available: false }] });
  view.chooseAccount('1', cx); assert.equal(pending.length, 0);
  view.chooseAccount('0', cx); assert.equal(view.loaded, false);
  await pending.shift()(cx);
  assert.equal(view.name.value(), 'Alice'); assert.equal(view.email.value(), '');
  assert.equal(view.loaded, true);
  view.chooseAccount('default', cx); await pending.shift()(cx);
  assert.equal(view.account, null); assert.equal(view.email.value(), 'repo@example.test');
});

test('GitHub Cancel discards the draft without writing Git config or account state', async () => {
  const events = [], tasks = [], target = { context: { folder: '/repo', machine: '' }, overlay: 'dialog' };
  const view = await accountFor(target, { readGitAuthor: async () => ({ name: 'Saved', email: 'saved@example.test' }),
    readGitAccounts: async () => [], saveGitAuthor: async () => events.push('write'),
    setGitAccount: () => events.push('account'), rememberGitAuthor: () => events.push('remember'),
    closeOverlay: id => events.push(['close', id]) });
  const cx = { notify() {}, spawn(fn) { tasks.push(fn); } };
  view.init(cx); await settle(tasks);
  view.name.set_value('Unsaved');
  // Render with the same element stub as the shell tests and invoke the Cancel handler it produced.
  const nodes = new Map(), element = () => { const data = {}; const el = new Proxy(data, { get(obj, key) { if (key === 'when') return (condition, fn) => { if (condition) fn(el); return el; }; return (...args) => { if (key === 'id') nodes.set(args[0], data); if (key === 'on_click') data.click = args[0]; return el; }; } }); return el; };
  const source = await readFile(github('account.js'), 'utf8');
  const render = new Function('div', 'v_flex', 'h_flex', 'glyph', 'Input', 'Button', 'Select', 'DialogContent', 'DialogTitle', 'DialogDescription', 'DialogFooter', 'props', 'closeOverlay', 'theme', 'settings',
    source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn GitHubAccount.prototype.render;');
  const renderFn = render(element, element, element, element, { new: element }, (id) => element().id(id), () => element(), element, element, element, element, () => target, id => events.push(['close', id]), () => ({}), {});
  renderFn.call(view, {});
  for (const id of ['github-account-header', 'github-account-body', 'git-accounts-refresh']) assert.ok(nodes.has(id), `${id}: header, body, footer`);
  nodes.get('git-author-cancel').click({}, { notify() {} });
  assert.deepEqual(events, [['close', 'dialog']]);
});

test('GitHub Save writes repository-local author before remembering and binding the account', async () => {
  const events = [], tasks = [], project = { folder: '/repo', machine: 'box' }, target = { context: project, overlay: 'dialog' };
  const account = { host: 'github.com', login: 'alice', available: true };
  const view = await accountFor(target, { gitAccount: () => null,
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
  assert.deepEqual(events[2], ['account', project, account]);
});

test('GitHub account choice waits for Save, asks for a missing email and commits only after successful writes', async () => {
  const account = { host: 'github.com', login: 'alice', available: true };
  for (const email of ['alice@example.test', '', null]) {
    const project = { folder: '/repo', machine: 'remote' }, target = { context: project, overlay: 'dialog' };
    const tasks = [], events = [];
    let fail = false;
    const view = await accountFor(target, {
      readGitAccounts: async () => [account],
      readGitAuthor: async () => ({ name: 'Repo', email: 'repo@example.test' }),
      readAccountAuthor: async () => { if (email === null) throw new Error('Offline'); return { name: 'Alice', email }; },
      saveGitAuthor: async (...args) => { events.push(['write', ...args]); if (fail) throw new Error('Locked'); },
      rememberGitAuthor: (...args) => events.push(['remember', ...args]),
      setGitAccount: (...args) => events.push(['account', ...args]),
      closeOverlay: id => events.push(['close', id]),
    });
    const cx = { notify() {}, spawn(fn) { tasks.push(fn); } };
    view.init(cx); await settle(tasks);
    view.chooseAccount('0', cx); await settle(tasks);
    assert.equal(view.email.value(), email || '', 'Never prefill another account email');
    assert.deepEqual(events, []);
    if (!email) {
      view.email.set_value('manual@example.test'); fail = true;
      view.save(cx); await settle(tasks);
      assert.deepEqual(events.map(event => event[0]), ['write']);
      assert.equal(view.error, 'Locked'); events.length = 0;
      fail = false; view.save(cx);
    } else view.save(cx);
    await settle(tasks);
    assert.deepEqual(events.map(event => event[0]), ['write', 'remember', 'account', 'close']);
    assert.deepEqual(events[2], ['account', project, account]);
    view.close();
  }
});

test('GitHub publishes one binding per account choice; the shell validates it and tokens never enter shared state', async () => {
  const memory = {};
  const auth = await evaluateNative(github('git-auth.js'), { shared: key => memory[key],
    setShared: (key, value) => { memory[key] = structuredClone(value); }, exec: async () => ({ code: 1 }), projectKey },
  'gitAccount, setGitAccount, gitAuthArgs, publishGitCredentials, CREDENTIALS_KEY');
  const account = { host: 'github.com', login: 'alice', available: true };
  auth.setGitAccount({ folder: '/repo', machine: 'box' }, account);
  const envelope = memory[auth.CREDENTIALS_KEY];
  const binding = envelope.repositories[projectKey('box', '/repo')];
  assert.deepEqual(Object.keys(binding).sort(), ['config', 'host', 'login']);
  assert.equal(binding.host, 'github.com'); assert.equal(binding.login, 'alice');
  assert.deepEqual(gitCredentialArgs(binding), auth.gitAuthArgs(account));
  assert.ok(!JSON.stringify(memory).includes('fixture-token'));
  auth.publishGitCredentials();
  assert.equal(memory[auth.CREDENTIALS_KEY], envelope, 'an unchanged binding is not rewritten');
  auth.setGitAccount({ folder: '/repo', machine: 'box' }, null);
  assert.deepEqual(memory[auth.CREDENTIALS_KEY].repositories, {});
});

test('the shell applies a repository binding as -c pairs and drops an invalid binding with one report', async () => {
  const memory = {};
  const auth = await evaluateNative(github('git-auth.js'), { shared: key => memory[key],
    setShared: (key, value) => { memory[key] = structuredClone(value); }, exec: async () => ({ code: 1 }), projectKey },
  'gitAccount, setGitAccount, gitAuthArgs, publishGitCredentials, CREDENTIALS_KEY');
  const account = { host: 'github.com', login: 'alice', available: true };
  auth.setGitAccount({ folder: '/repo', machine: 'box' }, account);
  const { credentialArgsFor } = await evaluateNative(shell('git-credentials.js'), { gitCredentialArgs, projectKey }, 'credentialArgsFor');
  const read = key => memory[key], reports = [], report = message => reports.push(message);
  const repository = { machine: 'box', folder: '/repo' };
  assert.deepEqual(credentialArgsFor({ id: 'github' }, repository, read, report), auth.gitAuthArgs(account));
  assert.deepEqual(credentialArgsFor({ id: 'github' }, { machine: 'other', folder: '/repo' }, read, report), []);
  assert.deepEqual(credentialArgsFor(null, repository, read, report), []);
  const bad = structuredClone(memory[auth.CREDENTIALS_KEY]);
  bad.repositories[projectKey('box', '/repo')].config.push(['credential.https://evil.example.helper', 'x']);
  memory[auth.CREDENTIALS_KEY] = bad;
  assert.deepEqual(credentialArgsFor({ id: 'github' }, repository, read, report), []);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /key is not allowed/);
});
