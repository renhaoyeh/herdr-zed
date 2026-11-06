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
    .replace('export default class', 'class').replace(/^export /gm, '') + '\nreturn { DiffViewer, parseDiff, readDiff, affectsDiff, pairLines, changedRanges, changeSections, changeTree, wrapLine };')(...Object.values(host));
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

test('rows form one multibuffer in unified or split layout, collapsing per file', async () => {
  const memory = {};
  const { DiffViewer, parseDiff, affectsDiff } = await load({ shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) } });
  const view = new DiffViewer(); view.init();
  view.files = parseDiff(['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,2 @@', ' k', '-x', '+y', '@@ -9 +9 @@', '-p', '+q',
    'diff --git a/b b/b', '--- a/b', '+++ b/b', '@@ -1 +1 @@', '-x', '+y'].join('\n'));
  const kinds = () => view.rows().rows.map(row => row.kind);
  assert.deepEqual(kinds(), ['file', 'line', 'line', 'line', 'separator', 'line', 'line', 'file', 'line', 'line']);
  assert.deepEqual(view.rows().rows.filter(row => row.kind === 'file').map(row => row.first), [true, false]);
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

test('soft wrapping preserves source text, Unicode, whitespace, line numbers and highlight offsets', async () => {
  const { wrapLine } = await load();
  const text = '    const 中文 = "' + 'a'.repeat(80) + ' old word";  ';
  const start = text.indexOf('old'), marks = [start, start + 'old word'.length];
  const parts = wrapLine({ type: 'add', new: 12, text, marks }, 12);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.equal(parts.filter(part => part.new !== undefined).length, 1);
  assert.equal(parts[0].new, 12);
  assert.equal(parts.filter(part => part.marks).map(part => part.text.slice(...part.marks)).join(''), 'old word');
  assert.ok(parts.every(part => Array.from(part.text).length <= 12));
  assert.deepEqual(wrapLine({ text: '中文🙂e\u0301' }, 2).map(part => part.text), ['中', '文', '🙂', 'e\u0301']);
  assert.deepEqual(wrapLine({ text: ' aaaaaaaaa中' }, 10).map(part => part.text), [' aaaaaaaaa', '中']);
  assert.deepEqual(wrapLine({ text: '' }, 10).map(part => part.text), ['']);
  assert.deepEqual(wrapLine(null, 10), []);
});

test('wrapping follows viewport width and font metrics, aligns split rows and keeps file jumps exact', async () => {
  const memory = {}, scrolled = [];
  const { DiffViewer, parseDiff } = await load({ shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item: (...args) => scrolled.push(args) }) } });
  const view = new DiffViewer(); view.init(); view.width = 216; view.charWidth = 8;
  view.files = parseDiff(['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,2 @@', '-short', '+' + 'x'.repeat(60), ' next',
    'diff --git a/b b/b', '--- a/b', '+++ b/b', '@@ -1 +1 @@', '-old', '+new'].join('\n'));
  const original = view.rows();
  assert.equal(original.rows.filter(row => row.line?.type === 'add' && row.line?.text.startsWith('x')).length, 3);
  view.width = 536;
  assert.equal(view.rows().rows.filter(row => row.line?.text.startsWith('x')).length, 1);
  view.charWidth = 16;
  assert.equal(view.rows().rows.filter(row => row.line?.text.startsWith('x')).length, 2);
  view.width = 216; view.charWidth = 8; view.setLayout('split', { notify() {} });
  const { rows, sizes } = view.rows(), pairs = rows.filter(row => row.kind === 'pair');
  assert.equal(pairs.filter(row => row.right?.text.startsWith('x')).length, 10);
  assert.equal(pairs[0].left.text, 'short');
  assert.equal(pairs[1].left, undefined);
  assert.equal(pairs[1].right.new, undefined);
  assert.equal(pairs[10].left.text, 'next');
  assert.equal(pairs[10].right.new, 2);
  assert.ok(sizes.every(size => [20, 32, 40].includes(size)));
  view.reveal('b', { notify() {} });
  assert.deepEqual(scrolled, [[rows.findIndex(row => row.key === 'file:b'), 'top']]);
  view.files = [{ path: 'huge', hunks: [{ lines: Array.from({ length: 25 }, () => ({ type: 'ctx', text: 'x'.repeat(2000) })) }] }];
  view.width = 72; view.rowCache = null;
  assert.equal(view.rows().rows.length, 20000);
  assert.equal(view.rows().limited, true);
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

test('reloads keep the shown diff and skip repainting until git diff output changes', async () => {
  let text = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '-x', '+y'].join(String.fromCharCode(10));
  const { DiffViewer } = await load({ shared: () => undefined, setShared() {},
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    exec: async () => ({ code: 0, stdout: text, stderr: '' }) });
  const tasks = [];
  let notified = 0;
  const cx = { notify() { notified++; }, spawn(fn) { tasks.push(fn(cx)); } };
  const drain = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  const view = new DiffViewer(); view.init(); view.context = { folder: '/p' };
  view.reload(cx); await drain();
  const files = view.files;
  assert.equal(notified, 1);
  view.reload(cx); await drain();
  assert.equal(view.files, files);
  assert.equal(notified, 1);
  text += String.fromCharCode(10) + '+z';
  view.reload(cx); await drain();
  assert.notEqual(view.files, files);
  assert.equal(notified, 2);
});

test('loaded diff text preserves row rendering in unified and split views', async () => {
  const memory = {}, painted = [];
  const element = () => {
    const el = new Proxy({}, { get: (_target, key) => {
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      if (key === 'child') return value => { if (typeof value === 'string') painted.push(value); return el; };
      return () => el;
    } });
    return el;
  };
  const text = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1 +1 @@', '-before', '+after'].join('\n');
  const { DiffViewer } = await load({ div: element, svg: element, h_flex: element, v_flex: element,
    GitStatusColor: { added: '#27a657', deleted: '#e06c76' },
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    VirtualListScrollHandle: { new: () => ({}) }, exec: async () => ({ code: 0, stdout: text }) });
  const tasks = [], cx = { notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  const view = new DiffViewer(); view.init(); view.observe = () => {};
  view.refresh({ id: 'project', folder: '/project' }, cx);
  await Promise.all(tasks);
  for (const layout of ['unified', 'split']) {
    painted.length = 0;
    view.setLayout(layout, cx);
    const { rows, gutter } = view.rows();
    for (const row of rows) view.row(row, {}, 'monospace', gutter);
    assert.ok(painted.includes('a.js'), `${layout} paints the file header`);
    assert.ok(painted.includes('before'), `${layout} paints deleted text`);
    assert.ok(painted.includes('after'), `${layout} paints added text`);
    assert.ok(painted.includes('1'), `${layout} paints line numbers`);
  }
});
