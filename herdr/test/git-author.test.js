import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitShellCommand } from '../mods/devkits/components/session-shell.js';

const run = promisify(execFile);
test('account modal loads an account draft without applying it and Default restores repository author', async () => {
  const source = await readFile(new URL('../mods/devkits/git-author-settings.js', import.meta.url), 'utf8');
  const { GitAuthorSettings } = new Function('readAccountAuthor', 'readGitAuthor',
    source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn { GitAuthorSettings };')(
    async () => ({ name: 'Alice', email: '' }), async () => ({ name: 'Repo', email: 'repo@example.test' }));
  const view = new GitAuthorSettings(), pending = [];
  const input = () => ({ value: '', set_value(value) { this.value = value; } });
  Object.assign(view, { target: { folder: '/repo', machine: 'remote' }, name: input(), email: input(),
    accounts: [{ host: 'github.com', login: 'alice', available: true }, { login: 'unavailable', available: false }] });
  const cx = { notify() {}, spawn(fn) { pending.push(fn); } };
  view.chooseAccount('1', cx); assert.equal(pending.length, 0);
  view.chooseAccount('0', cx); assert.equal(view.loaded, false);
  await pending.shift()(cx);
  assert.equal(view.name.value, 'Alice'); assert.equal(view.email.value, '');
  assert.equal(view.loaded, true);
  view.chooseAccount('default', cx); await pending.shift()(cx);
  assert.equal(view.account, null); assert.equal(view.email.value, 'repo@example.test');
});

test('selecting accounts always waits for Save, asks for missing email and commits choices only after successful writes', async () => {
  const source = await readFile(new URL('../mods/devkits/git-author-settings.js', import.meta.url), 'utf8');
  const account = { host: 'github.com', login: 'alice' };
  for (const email of ['alice@example.test', '', null]) {
    const target = { folder: '/repo', machine: 'remote', overlay: 'dialog', account };
    const pending = [], events = [];
    let fail = false;
    const { GitAuthorSettings } = new Function('props', 'InputState', 'gitAccount', 'readAccountAuthor', 'saveGitAuthor', 'rememberGitAuthor', 'setGitAccount', 'closeOverlay',
      source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn { GitAuthorSettings };')(
      () => target, { new: () => ({ text: '', on() {}, value() { return this.text; }, set_value(text) { this.text = text; }, release() {} }) },
      () => null, async () => { if (email === null) throw new Error('Offline'); return { name: 'Alice', email }; },
      async (...args) => { events.push(['write', ...args]); if (fail) throw new Error('Locked'); },
      (...args) => events.push(['remember', ...args]), (...args) => events.push(['account', ...args]), id => events.push(['close', id]));
    const cx = { notify() {}, spawn(fn) { pending.push(fn); } };
    const view = new GitAuthorSettings(); view.init(cx);
    await pending.shift()(cx);
    assert.equal(view.email.value(), email || '', 'Never prefill another account email');
    assert.equal(pending.length, 0); assert.deepEqual(events, []);
    if (!email) {
      assert.equal(pending.length, 0); assert.deepEqual(events, []);
      view.email.set_value('manual@example.test'); fail = true;
      view.save(cx); await pending.shift()(cx);
      assert.deepEqual(events.map(event => event[0]), ['write']);
      assert.equal(view.error, 'Locked'); events.length = 0;
      fail = false; view.save(cx);
    }
    if (email) view.save(cx);
    await pending.shift()(cx);
    assert.deepEqual(events.map(event => event[0]), ['write', 'remember', 'account', 'close']);
    assert.deepEqual(events[2], ['account', target, account]);
    view.close();
  }
});

test('author dialog preserves failed drafts for retry and saves to its original repository', async () => {
  const target = { folder: '/repo', machine: 'remote', overlay: 'author-dialog' };
  const source = await readFile(new URL('../mods/devkits/git-author-settings.js', import.meta.url), 'utf8');
  const pending = [], writes = [], closed = [];
  let fail = true;
  const { GitAuthorSettings } = new Function('props', 'InputState', 'readGitAuthor', 'saveGitAuthor', 'closeOverlay', 'gitAccount',
    source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn { GitAuthorSettings };')(
    () => target, { new: () => ({ text: '', on() {}, value() { return this.text; }, set_value(text) { this.text = text; }, release() {} }) },
    async () => ({ name: 'Initial', email: 'initial@example.test' }),
    async (...args) => { writes.push(args); if (fail) throw new Error('Config locked'); }, id => closed.push(id), () => null);
  const cx = { notify() {}, spawn(fn) { pending.push(fn); } };
  const view = new GitAuthorSettings(); view.init(cx);
  view.save(cx); assert.equal(writes.length, 0);
  await pending.shift()(cx);
  view.name.set_value('Edited'); view.save(cx); view.save(cx);
  assert.equal(pending.length, 1);
  await pending.shift()(cx);
  assert.equal(view.error, 'Config locked'); assert.equal(view.name.value(), 'Edited');
  assert.deepEqual(closed, []);
  fail = false; view.save(cx); await pending.shift()(cx);
  assert.deepEqual(writes.at(-1), ['/repo', 'remote', { name: 'Edited', email: 'initial@example.test' }]);
  assert.deepEqual(closed, ['author-dialog']); view.close();
});

test('commit author inherits defaults, saves only repository config and applies to future commits', async t => {
  const folder = await mkdtemp(join(tmpdir(), "devkits-author ' $(unused)-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const global = join(folder, 'global');
  await writeFile(global, '[user]\n name = Inherited\n email = inherited@example.test\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => run('git', args, { env });
  const repo = join(folder, 'repo');
  await git('init', '-q', repo);
  await git('-C', repo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'before');
  const source = await readFile(new URL('../mods/devkits/git-author.js', import.meta.url), 'utf8');
  const { readGitAuthor, saveGitAuthor } = new Function('execShell', source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { readGitAuthor, saveGitAuthor };')(async (args, options) => {
    assert.equal(options.on, 'fixture-machine');
    const [cmd, ...argv] = process.platform === 'win32' ? gitShellCommand(args) : ['sh', ...args];
    try { return { code: 0, ...await run(cmd, argv, { env }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  });
  const path = repo.replaceAll('\\', '/');
  assert.deepEqual(await readGitAuthor(path, 'fixture-machine'), { name: 'Inherited', email: 'inherited@example.test' });
  const author = { name: "中文 O'Neil $(unused)", email: 'author+test@example.test' };
  await saveGitAuthor(path, 'fixture-machine', author);
  assert.deepEqual(await readGitAuthor(path, 'fixture-machine'), author);
  await git('-C', repo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'after');
  assert.equal((await git('-C', repo, 'log', '-1', '--format=%an <%ae>')).stdout.trim(), `${author.name} <${author.email}>`);
  assert.equal((await git('-C', repo, 'log', '-1', '--format=%an', 'HEAD~')).stdout.trim(), 'Inherited');
  assert.equal((await git('config', '--global', 'user.name')).stdout.trim(), 'Inherited');
  await assert.rejects(saveGitAuthor(path, 'fixture-machine', { name: 'bad\nname', email: 'a@b' }), /Enter a name/);
  await writeFile(global, '');
  await git('-C', repo, 'config', '--local', '--unset-all', 'user.name');
  await git('-C', repo, 'config', '--local', '--unset-all', 'user.email');
  assert.deepEqual(await readGitAuthor(path, 'fixture-machine'), { name: '', email: '' });
});
