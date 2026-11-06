import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

async function load(host = {}) {
  const source = await readFile(new URL('../mods/devkits/diff.js', import.meta.url), 'utf8');
  return new Function(...Object.keys(host), source.replace(/^import .*;\n/gm, '')
    .replace('export default class', 'class').replace(/^export /gm, '') + '\nreturn { DiffViewer, parseDiff, readDiff, affectsDiff, pairLines, changedRanges, changeSections, changeTree };')(...Object.values(host));
}
const run = promisify(execFile);

test('parser numbers old and new lines and classifies added, deleted, renamed and binary files', async () => {
  const { parseDiff } = await load();
  const files = parseDiff([
    'diff --git a/src/a.js b/src/a.js', 'index 1..2 100644', '--- a/src/a.js', '+++ b/src/a.js',
    '@@ -10,3 +10,3 @@ function f() {', ' keep', '-\told', '+new', ' end',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    'diff --git a/old.md b/new.md', 'similarity index 100%', 'rename from old.md', 'rename to new.md',
    'diff --git a/img.png b/img.png', 'new file mode 100644', 'Binary files /dev/null and b/img.png differ',
    'diff --git "a/\\344\\275\\240.txt" "b/\\344\\275\\240.txt"', 'new file mode 100644', '--- /dev/null', '+++ "b/\\344\\275\\240.txt"', '@@ -0,0 +1 @@', '+hi',
  ].join('\n'));
  assert.deepEqual(files.map(file => [file.path, file.status, file.added, file.removed]),
    [['gone.txt', 'deleted', 0, 1], ['img.png', 'added', 0, 0], ['new.md', 'renamed', 0, 0], ['src/a.js', 'modified', 1, 1], ['你.txt', 'added', 1, 0]]);
  assert.equal(files[1].binary, true);
  assert.equal(files[2].oldPath, 'old.md');
  assert.deepEqual(files[3].hunks[0].lines, [
    { type: 'ctx', old: 10, new: 10, text: 'keep' }, { type: 'del', old: 11, text: '    old' },
    { type: 'add', new: 11, text: 'new' }, { type: 'ctx', old: 12, new: 12, text: 'end' }]);
});

test('reads tracked, untracked, renamed and deleted changes against HEAD in one diff', async t => {
  const folder = await mkdtemp(join(tmpdir(), "devkits diff ' $(x)"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const git = (...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: folder });
  await git('init', '-q');
  await writeFile(join(folder, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(folder, 'drop.txt'), 'x\n');
  await writeFile(join(folder, 'move.txt'), 'same content here\nand more\n');
  await git('add', '.'); await git('commit', '-qm', 'init');
  await writeFile(join(folder, 'a.txt'), 'one\n2\nthree\n');
  await rm(join(folder, 'drop.txt'));
  await rename(join(folder, 'move.txt'), join(folder, 'moved.txt')); await git('add', '-A', 'move.txt', 'moved.txt');
  await writeFile(join(folder, '新檔 $(touch X).txt'), 'hello\n');
  const { readDiff } = await load({ exec: async (cmd, args, options) => {
    assert.equal(options.on, 'box');
    try { const { stdout, stderr } = await run(cmd, args); return { code: 0, stdout, stderr }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  } });
  const shellFolder = process.platform === 'win32' ? folder.replaceAll('\\', '/') : folder;
  const { files, truncated } = await readDiff(shellFolder, 'box');
  assert.equal(truncated, false);
  assert.deepEqual(files.map(file => [file.path, file.status, file.added, file.removed, file.untracked]),
    [['a.txt', 'modified', 1, 1, false], ['drop.txt', 'deleted', 0, 1, false], ['moved.txt', 'renamed', 0, 0, false], ['新檔 $(touch X).txt', 'added', 1, 0, true]]);
  await assert.rejects(readDiff(tmpdir().replaceAll('\\', '/'), 'box'), /Not a Git repository/);
});

test('rows form one fixed-height multibuffer in unified or split layout, collapsing per file', async () => {
  const memory = {};
  const { DiffViewer, parseDiff, affectsDiff } = await load({ shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) } });
  const view = new DiffViewer(); view.init();
  view.files = parseDiff(['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,2 @@', ' k', '-x', '+y', '@@ -9 +9 @@', '-p', '+q',
    'diff --git a/b b/b', '--- a/b', '+++ b/b', '@@ -1 +1 @@', '-x', '+y'].join('\n'));
  const kinds = () => view.rows().rows.map(row => row.kind);
  assert.deepEqual(kinds(), ['file', 'line', 'line', 'line', 'separator', 'line', 'line', 'file', 'line', 'line']);
  assert.deepEqual(view.rows().sizes, [32, 20, 20, 20, 12, 20, 20, 40, 20, 20]);
  view.setLayout('split', { notify() {} });
  assert.deepEqual(kinds(), ['file', 'pair', 'pair', 'separator', 'pair', 'file', 'pair']);
  view.toggle('a', { notify() {} });
  assert.deepEqual(kinds(), ['file', 'file', 'pair']);
  assert.ok(affectsDiff('/src/a.js'));
  assert.ok(affectsDiff('/.git/refs/heads/main') && affectsDiff('/.git/HEAD'));
  assert.ok(!affectsDiff('/.git/index') && !affectsDiff('/.git/objects/ab/cd'));
});

test('split pairs deletions beside their replacements and marks only similar changed words', async () => {
  const { pairLines, changedRanges } = await load();
  const del = text => ({ type: 'del', text }), add = text => ({ type: 'add', text }), ctx = { type: 'ctx', text: 'c' };
  const pairs = pairLines([ctx, del('a'), del('b'), add('A'), ctx, add('n')]);
  assert.deepEqual(pairs.map(pair => [pair.left?.text ?? null, pair.right?.text ?? null]),
    [['c', 'c'], ['a', 'A'], ['b', null], ['c', 'c'], [null, 'n']]);
  assert.deepEqual(changedRanges('const value = 1;', 'const value = 22;'), [[14, 15], [14, 16]]);
  assert.deepEqual(changedRanges('alpha', 'omega zulu'), [null, null]);
});

test('changed files group as Tracked then Untracked, matching the multibuffer, and jump to an expanded header', async () => {
  const scrolled = [];
  const { DiffViewer, parseDiff, changeSections, changeTree } = await load({ shared: () => undefined, setShared() {},
    VirtualListScrollHandle: { new: () => ({ scroll_to_item: (...args) => scrolled.push(args) }) } });
  const header = path => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  const files = parseDiff([...header('src/b.js'), 'devkits-untracked-files', ...header('a.md'), ...header('src/lib/c.js')].join('\n'));
  assert.deepEqual(files.map(file => [file.path, file.untracked]), [['src/b.js', false], ['a.md', true], ['src/lib/c.js', true]]);
  assert.deepEqual(changeSections(files).map(section => [section.label, section.files.map(file => file.path)]),
    [['Tracked', ['src/b.js']], ['Untracked', ['a.md', 'src/lib/c.js']]]);
  const tree = [{ path: 'apps/desktop/main/index.ts' }, { path: 'apps/desktop/README.md' }, { path: 'top.md' }];
  assert.deepEqual(changeTree(tree, new Set(), 'T:').map(row => [row.kind, row.name, row.depth, row.path]), [
    ['dir', 'apps/desktop', 0, 'T:apps/desktop'], ['dir', 'main', 1, 'T:apps/desktop/main'],
    ['file', 'index.ts', 2, 'apps/desktop/main/index.ts'], ['file', 'README.md', 1, 'apps/desktop/README.md'], ['file', 'top.md', 0, 'top.md']]);
  assert.deepEqual(changeTree(tree, new Set(['T:apps/desktop']), 'T:').map(row => row.name), ['apps/desktop', 'top.md']);
  const view = new DiffViewer(); view.init();
  view.files = [...files].sort((a, b) => a.path.localeCompare(b.path));
  view.toggle('a.md', { notify() {} });
  view.reveal('src/lib/c.js', { notify() {} });
  assert.deepEqual(scrolled, [[3, 'top']]);
  assert.equal(view.selected, 'src/lib/c.js');
  view.reveal('a.md', { notify() {} });
  assert.ok(!view.collapsed.has('a.md'));
});
