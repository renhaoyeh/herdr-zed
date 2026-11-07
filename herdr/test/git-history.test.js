import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
async function load(host = {}) {
  const source = await readFile(new URL('../mods/devkits/git-history.js', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../mods/devkits/shell.js', import.meta.url), 'utf8');
  const command = await readFile(new URL('../mods/devkits/shell-command.js', import.meta.url), 'utf8');
  return new Function(...Object.keys(host), (command + '\n' + shell + '\n' + source).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { CommitHistory, parseCommitHistory, readCommitHistory, readCommitPatch, readCommitSummary, commitAge };')(...Object.values(host));
}
const record = (sha, subject) => [sha, sha.slice(0, 7), '作者 Name', '1700000000', `${subject}\n\nBody | $(literal)\n`].join('\0') + '\0';
const clock = () => {
  const tasks = [], cx = { notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  return { cx, async drain() { while (tasks.length) await Promise.all(tasks.splice(0)); } };
};

test('history pages are anchored to a revision and previews handle root and merge commits', async t => {
  const folder = await mkdtemp(join(tmpdir(), "devkits history ' $(x)"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const repo = join(folder, 'repo'), path = repo.replaceAll('\\', '/');
  const git = (...args) => run('git', ['-c', 'user.name=作者 Name', '-c', 'user.email=t@t', ...args]);
  const { readCommitHistory, readCommitPatch, readCommitSummary } = await load({ exec: async (cmd, args, options) => {
    assert.equal(options.on, 'box');
    try { const { stdout, stderr } = await run(cmd, args, { maxBuffer: 8 * 1024 * 1024 }); return { code: 0, stdout, stderr }; }
    catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  } });
  await git('init', '-q', '-b', 'main', repo);
  assert.deepEqual(await readCommitHistory(path, 'box'), { revision: null, entries: [], hasMore: false });
  await writeFile(join(repo, '中文.txt'), 'first\n');
  await git('-C', repo, 'add', '.'); await git('-C', repo, 'commit', '-qm', '初始提交\n\nBody | $(literal)');
  const root = (await readCommitHistory(path, 'box')).entries[0];
  assert.equal(root.author, '作者 Name');
  assert.equal(root.subject, '初始提交');
  assert.match(root.message, /Body \| \$\(literal\)/);
  assert.deepEqual(await readCommitSummary(path, 'box', root.sha), root);
  const rootPatch = await readCommitPatch(path, 'box', root.sha);
  assert.match(rootPatch.text, /--- \/dev\/null/);
  assert.match(rootPatch.text, /中文.txt/);
  assert.equal(rootPatch.truncated, false);
  // Import empty commits efficiently, retaining the root's tree for every revision.
  const stream = Array.from({ length: 54 }, (_, i) => {
    const message = `Commit ${i + 1}\n`;
    return `commit refs/heads/main\nmark :${i + 1}\ncommitter 作者 Name <t@t> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}from ${i ? ':' + i : root.sha}\n\n`;
  }).join('');
  await new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', repo, 'fast-import', '--quiet'], error => error ? reject(error) : resolve());
    child.stdin.end(stream);
  });
  const first = await readCommitHistory(path, 'box');
  assert.equal(first.entries.length, 50); assert.equal(first.hasMore, true);
  await git('-C', repo, 'commit', '--allow-empty', '-qm', 'new while paging');
  const second = await readCommitHistory(path, 'box', first.revision, 50);
  assert.equal(second.revision, first.revision);
  assert.equal(second.entries.length, 5); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.sha)).size, 55);
  assert.equal(second.entries.at(-1).sha, root.sha);
  assert.equal((await readCommitHistory(path, 'box')).entries[0].subject, 'new while paging');
  await git('-C', repo, 'checkout', '-qb', 'feature', root.sha);
  await writeFile(join(repo, 'feature.txt'), 'feature\n');
  await git('-C', repo, 'add', '.'); await git('-C', repo, 'commit', '-qm', 'feature');
  await git('-C', repo, 'checkout', '-q', 'main');
  await writeFile(join(repo, 'main.txt'), 'main\n');
  await git('-C', repo, 'add', '.'); await git('-C', repo, 'commit', '-qm', 'main work');
  await git('-C', repo, 'merge', '--no-ff', '-qm', 'merge', 'feature');
  const merge = (await readCommitHistory(path, 'box')).entries[0];
  const patch = await readCommitPatch(path, 'box', merge.sha);
  assert.match(patch.text, /feature.txt/);
  assert.doesNotMatch(patch.text, /main.txt/);
  await assert.rejects(readCommitHistory(folder.replaceAll('\\', '/'), 'box'), /Not a Git repository/);
  await assert.rejects(readCommitPatch(path, 'box', 'HEAD; echo bad'), /Invalid commit/);
});

test('history parsing preserves multiline messages and formats commit ages', async () => {
  const { parseCommitHistory, commitAge } = await load();
  const sha = 'a'.repeat(40), parsed = parseCommitHistory(sha + '\0' + record(sha, '修正 | feature'));
  assert.equal(parsed.entries[0].subject, '修正 | feature');
  assert.equal(parsed.entries[0].message, '修正 | feature\n\nBody | $(literal)');
  assert.deepEqual(parseCommitHistory(''), { revision: null, entries: [] });
  const now = 1700000000000;
  assert.equal(commitAge(now / 1000 - 90, now), '1m');
  assert.equal(commitAge(now / 1000 - 7200, now), '2h');
  assert.equal(commitAge(now / 1000 - 86400, now), '1d');
});

test('history keeps previews during refresh, ignores stale selections and isolates projects', async () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), pending = [], parsed = [];
  const { CommitHistory } = await load({ VirtualListScrollHandle: { new: () => ({}) },
    exec: (cmd, args) => new Promise(resolve => pending.push({ cmd, args, resolve })) });
  const { cx, drain } = clock();
  const history = new CommitHistory(cx, text => { parsed.push(text); return [text]; });
  history.reset({ folder: '/first', machine: 'box' }); history.load(cx);
  pending.shift().resolve({ code: 0, stdout: b + '\0' + record(b, 'second') + record(a, 'first') });
  await drain();
  const entries = history.entries;
  history.select(entries[1], cx); history.select(entries[0], cx);
  pending[1].resolve({ code: 0, stdout: 'new diff' });
  pending[0].resolve({ code: 0, stdout: 'stale diff' }); pending.length = 0;
  await drain();
  assert.equal(history.preview.commit.sha, b); assert.deepEqual(parsed, ['new diff']);
  history.load(cx); assert.equal(history.preview.files[0], 'new diff');
  pending.shift().resolve({ code: 0, stdout: b + '\0' + record(b, 'second') + record(a, 'first') });
  await drain(); assert.equal(history.entries, entries);
  history.select(entries[1], cx);
  pending.shift().resolve({ code: 1, stderr: 'preview failed' });
  await drain(); assert.equal(history.previewError, 'preview failed'); assert.equal(history.preview.commit.sha, b);
  history.select(entries[1], cx); history.reset({ folder: '/other' });
  pending.shift().resolve({ code: 0, stdout: 'old project' });
  await drain(); assert.equal(history.preview, null); assert.equal(history.entries.length, 0);
});

test('history virtualizes rows and dispatches clicks and keyboard selection outside deferred rows', async () => {
  let list, deferred = false, built = 0, selected;
  const nodes = new Map();
  const element = () => {
    built++;
    const data = {};
    const el = new Proxy(data, { get(_target, key) {
      if (key in data) return data[key];
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      return (...args) => {
        if (deferred && key.startsWith('on_')) assert.fail(`Deferred row registered ${key}`);
        if (key === 'id') nodes.set(args[0], data);
        if (key === 'on_item_click') data.click = args[0];
        if (key === 'on_key_down') data.key = args[0];
        if (key === 'on_size_change') data.sizeChange = args[0];
        return el;
      };
    } });
    return el;
  };
  const { CommitHistory } = await load({ div: element, v_flex: element, h_flex: element,
    Scrollbar: { vertical: element }, VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    v_virtual_list(id, count, height, key, render) {
      const el = element(); list = { id, count, height, key, render, el }; return el;
    } });
  const history = new CommitHistory({}, () => []);
  history.entries = Array.from({ length: 5000 }, (_, index) => ({ sha: index.toString(16).padStart(40, '0'),
    shortSha: String(index), subject: `Commit ${index}`, author: 'Author', at: 1700000000 }));
  history.hasMore = true;
  history.select = entry => { selected = entry; };
  let pages = 0;
  history.load = (_cx, more) => { assert.equal(more, true); pages++; history.loading = true; };
  const panel = history.render({});
  assert.equal(list.count, 5001); assert.equal(list.height, 56); assert.ok(built < 20);
  deferred = true;
  assert.equal(list.render({ start: 10, end: 20 }).length, 10);
  deferred = false;
  assert.equal(pages, 0, 'Constructing the list and painting ordinary rows do not fetch pages');
  list.el.click(list.key(12), {}); assert.equal(selected, history.entries[12]);
  panel.key({ key: 'down' }, { stop_propagation() {}, notify() {} });
  panel.key({ key: 'enter' }, { stop_propagation() {}, notify() {} });
  assert.equal(selected, history.entries[13]);
  const timers = [], layout = { timer: { after(ms, handler) { assert.equal(ms, 0); timers.push(handler); } } };
  deferred = true;
  const beforeTail = built;
  const [tail] = list.render({ start: 5000, end: 5001 }, layout);
  assert.ok(built > beforeTail, 'The tail is built inside the deferred element arena');
  const [nextTail] = list.render({ start: 5000, end: 5001 }, layout);
  assert.notEqual(tail, nextTail, 'Each layout pass receives a fresh tail element');
  deferred = false;
  assert.equal(pages, 0, 'Layout never starts a Git read or notifies the view');
  assert.equal(timers.length, 1, 'Repeated layout passes queue only one pagination request');
  const request = timers[0];
  request({});
  request({});
  assert.equal(pages, 1, 'The visible tail loads the next page once, without clicking');
  history.loading = false; history.error = 'failed';
  request({});
  assert.equal(pages, 1, 'A failure waits for Retry instead of looping');
  history.error = null; history.entries.push({ sha: 'f'.repeat(40) });
  request({});
  assert.equal(pages, 1, 'Old tail callbacks cannot request a later page');
  history.reset({ folder: '/other' }); history.entries = Array(5000); history.hasMore = true;
  request({});
  assert.equal(pages, 1, 'A closed project cannot paginate its replacement');
});
