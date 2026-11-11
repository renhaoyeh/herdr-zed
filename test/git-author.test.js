import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitShellCommand } from '../components/session-shell.js';

const run = promisify(execFile);
test('author dialog preserves failed drafts for retry and saves to its original repository', async () => {
  const target = { folder: '/repo', machine: 'remote', overlay: 'author-dialog' };
  const source = await readFile(new URL('../mods/herdr-zed/git-author-settings.js', import.meta.url), 'utf8');
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
  const source = await readFile(new URL('../mods/herdr-zed/git-author.js', import.meta.url), 'utf8');
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
