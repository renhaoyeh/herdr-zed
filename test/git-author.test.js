import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitShellCommand } from '../components/session-shell.js';
import { evaluateNative } from './source-harness.js';

const run = promisify(execFile);
test('Changes opens an author editor bound to the selected repository, excluding aggregate views and private project fields', async () => {
  const opened = [];
  const { openGitAuthor } = await evaluateNative('../mods/herdr-zed/git-author-settings.js',
    { openOverlay: spec => { opened.push(spec); return 'author'; } }, 'openGitAuthor');
  const project = { folder: '/repo/selected', machine: 'remote', name: 'Selected', token: 'private' };
  assert.equal(openGitAuthor(project), 'author');
  assert.deepEqual(opened[0].props, { view: 'commit-author', context: { folder: '/repo/selected', machine: 'remote', name: 'Selected' } });
  project.folder = '/other';
  assert.equal(opened[0].props.context.folder, '/repo/selected');
  assert.equal(openGitAuthor({ ...project, allRepositories: true }), null);
  assert.equal(openGitAuthor(null), null);
  assert.equal(opened.length, 1);
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


async function authorDialog({ write }) {
  const source = await readFile(new URL('../mods/herdr-zed/git-author-settings.js', import.meta.url), 'utf8');
  const autosave = await readFile(new URL('../components/autosave.js', import.meta.url), 'utf8');
  const { Autosave } = new Function(autosave.replace(/^export /gm, '') + '\nreturn { Autosave };')();
  const pending = [], closed = [], handlers = {}, timers = [];
  const el = () => new Proxy({}, { get: (_t, key) => key === 'when' ? (c, f) => (c ? f(el()) : el())
    : (...args) => { if (key === 'on_key_down') handlers.key = args[0]; return el(); } });
  const input = () => ({ text: '', on() {}, value() { return this.text; }, set_value(text) { this.text = text; }, release() {} });
  const names = ['InputState', 'readGitAuthor', 'saveGitAuthor', 'closeOverlay', 'props', 'DialogContent', 'DialogHeader', 'DialogDescription',
    'Autosave', 'v_flex', 'h_flex', 'div', 'Input', 'openOverlay'];
  const { GitAuthorDialog } = new Function(...names, source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn { GitAuthorDialog };')(
    { new: input }, async () => ({ name: 'Ann', email: 'ann@example.test' }), write, id => closed.push(id),
    () => ({ overlay: 'author', context: { folder: '/repo', machine: 'remote' } }), el, (_t, _title, { onClose }) => { handlers.close = onClose; return el(); }, el,
    Autosave, el, el, el, { new: el }, () => 'x');
  const cx = { notify() {}, spawn(fn) { pending.push(fn); }, focus_handle: () => ({ focus() {} }), stop_propagation() {}, timer: { every(_ms, fn) { timers.push(fn); } } };
  const dialog = new GitAuthorDialog(); dialog.init(cx); await pending.shift()(cx);
  return { dialog, closed, handlers, cx };
}

test('the author form saves itself after the last edit to its own repository, never empty, and keeps a failed edit for retry', async () => {
  const writes = []; let fail = true;
  const { dialog, cx } = await authorDialog({ write: async (...args) => { writes.push(args); if (fail) throw new Error('Config locked'); } });
  const form = dialog.form;
  form.auto.tick(cx, 0); form.auto.tick(cx, 1000);
  assert.deepEqual(writes, [], 'loading is not written back');
  form.email.set_value(''); form.auto.tick(cx, 2000); await form.auto.tick(cx, 3000);
  assert.deepEqual(writes, [], 'an empty email is never written');
  form.email.set_value('ann@example.test'); form.name.set_value('Edited');
  form.auto.tick(cx, 4000); await form.auto.tick(cx, 4600);
  assert.equal(form.auto.error, 'Config locked'); assert.equal(form.name.value(), 'Edited'); assert.equal(form.auto.dirty(), true);
  fail = false; await form.auto.flush(cx);
  assert.deepEqual(writes.at(-1), ['/repo', 'remote', { name: 'Edited', email: 'ann@example.test' }]);
  assert.equal(form.auto.status(), 'Saved');
});

test('closing the author dialog writes an edit still waiting for the delay, then closes, without asking', async () => {
  const writes = [];
  const { dialog, closed, handlers, cx } = await authorDialog({ write: async (...args) => { writes.push(args); } });
  dialog.form.name.set_value('Bea');
  dialog.render({});
  handlers.key({ key: 'escape' }, cx);
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(writes.map(args => args[2].name), ['Bea'], 'flushed before closing');
  assert.deepEqual(closed, ['author']);
});
