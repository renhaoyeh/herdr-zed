import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const graphRun = promisify(execFile);
const sha = letter => letter.repeat(40);
async function data(host = {}) {
  const sources = await Promise.all(['components/session-shell.js', 'shell.js', 'git-graph-data.js'].map(name => readFile(new URL(`../mods/herdr-zed/${name}`, import.meta.url), 'utf8')));
  return new Function(...Object.keys(host), sources.join('\n').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { readGraphSnapshot, readGraphPage, parseGraphCommits, graphRows, searchGraph, graphDate };')(...Object.values(host));
}
const nativeExec = async (command, args, options) => {
  assert.equal(options.on, 'machine');
  try { const { stdout, stderr } = await graphRun(command, args, { maxBuffer: 8 * 1024 * 1024 }); return { code: 0, stdout, stderr }; }
  catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
};
const graphClock = () => {
  const tasks = [], timers = [];
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }),
    spawn(fn) { tasks.push(fn(cx)); }, timer: { after(_ms, fn) { const timer = { fn, cancel() { timer.cancelled = true; } }; timers.push(timer); return timer; } } };
  return { cx, timers, async drain() { while (tasks.length) await Promise.all(tasks.splice(0)); } };
};
async function graph(host = {}) {
  const source = await readFile(new URL('../mods/herdr-zed/git-graph.js', import.meta.url), 'utf8');
  class Details { reset() { this.preview = null; } select(commit) { this.commit = commit; } }
  class State {}
  const base = { shared: () => undefined, setShared() {}, graphDate: () => '1 day ago', CommitHistory: Details, DropdownMenuState: State, SidePanelState: State,
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    InputState: { new: () => { let value = ''; return { on() {}, value: () => value, set_value(next) { value = next; } }; } }, ...host };
  return new Function(...Object.keys(base), source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn GitGraph;')(...Object.values(base));
}

test('Git graph snapshots every branch and annotated tag, pages fixed tips, and searches literal authors/messages/hashes', async t => {
  const folder = await mkdtemp(join(tmpdir(), "graph ' $(literal) "));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const git = (...args) => graphRun('git', ['-c', 'user.name=作者 Graph', '-c', 'user.email=graph@example.test', '-C', folder, ...args]);
  const { readGraphPage, searchGraph } = await data({ exec: nativeExec });
  await graphRun('git', ['init', '-q', '-b', 'main', folder]);
  assert.deepEqual((await readGraphPage(folder, 'machine')).entries, []);
  await writeFile(join(folder, 'first.txt'), 'root\n');
  await git('add', '.'); await git('commit', '-qm', 'Initial commit');
  const root = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('branch', 'side');
  await git('tag', '-a', 'v1', '-m', 'release');
  const stream = Array.from({ length: 105 }, (_, index) => {
    const message = `Main ${index} [literal]\n`;
    return `commit refs/heads/main\nmark :${index + 1}\ncommitter 作者 Graph <graph@example.test> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}from ${index ? ':' + index : root}\n\n`;
  }).join('');
  await new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', folder, 'fast-import', '--quiet'], error => error ? reject(error) : resolve()); child.stdin.end(stream);
  });
  await git('checkout', '-q', 'side'); await git('commit', '--allow-empty', '-qm', 'Unmerged side $(literal)');
  const side = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('update-ref', 'refs/remotes/origin/side', side);
  await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/side');
  await git('checkout', '-q', 'main');
  const first = await readGraphPage(folder, 'machine');
  assert.equal(first.entries.length, 100); assert.equal(first.hasMore, true);
  assert.ok(first.snapshot.tips.includes(side));
  assert.ok(first.snapshot.refs[side].some(ref => ref.kind === 'remote' && ref.name === 'origin/side'));
  assert.ok(!Object.values(first.snapshot.refs).flat().some(ref => ref.name === 'origin/HEAD'));
  assert.ok(first.snapshot.refs[root].some(ref => ref.kind === 'tag' && ref.name === 'v1'));
  assert.ok(first.snapshot.refs[first.snapshot.head].some(ref => ref.name === 'main' && ref.head));
  await git('commit', '--allow-empty', '-qm', 'Created during paging');
  const second = await readGraphPage(folder, 'machine', first.snapshot, 100);
  const entries = [...first.entries, ...second.entries];
  assert.equal(entries.length, 107); assert.equal(second.hasMore, false);
  assert.equal(new Set(entries.map(entry => entry.sha)).size, 107);
  assert.ok(entries.some(entry => entry.sha === side));
  assert.ok(!entries.some(entry => entry.subject === 'Created during paging'));
  assert.deepEqual(await searchGraph(folder, 'machine', first.snapshot, '$(literal)', false), [side]);
  assert.equal((await searchGraph(folder, 'machine', first.snapshot, '[literal]', false)).length, 105);
  assert.equal((await searchGraph(folder, 'machine', first.snapshot, '作者 graph', false)).length, 107);
  assert.equal((await searchGraph(folder, 'machine', first.snapshot, '作者 graph', true)).length, 0);
  assert.ok((await searchGraph(folder, 'machine', first.snapshot, root.slice(0, 8), false)).includes(root));
  assert.equal((await searchGraph(folder, 'machine', first.snapshot, 'Created during paging', false)).length, 0);
  const positions = new Map(entries.map((entry, index) => [entry.sha, index]));
  for (const [index, commit] of entries.entries()) for (const parent of commit.parents) {
    if (positions.has(parent)) assert.ok(positions.get(parent) > index, 'children precede parents');
  }
  await assert.rejects(readGraphPage(folder, 'machine', { tips: ['HEAD;bad'] }), /Invalid graph revision/);
  await assert.rejects(readGraphPage(folder, 'machine', first.snapshot, -1), /Invalid graph offset/);
});

test('graph geometry keeps fork/merge lanes connected, reuses vacant lanes and retains pagination geometry', async () => {
  const { graphRows } = await data();
  const commits = [
    { sha: sha('a'), parents: [sha('b'), sha('c'), sha('d')] },
    { sha: sha('b'), parents: [sha('e')] },
    { sha: sha('c'), parents: [sha('e')] },
    { sha: sha('d'), parents: [sha('e')] },
    { sha: sha('e'), parents: [] },
    { sha: sha('f'), parents: [] },
  ];
  const { rows, width } = graphRows(commits, sha('a'));
  assert.equal(width, 3); assert.equal(rows[0].head, true); assert.equal(rows[0].merge, true);
  assert.deepEqual(rows.map(row => row.lane), [0, 0, 1, 2, 0, 0]);
  assert.equal(rows[0].edges.length, 3);
  assert.deepEqual(rows.at(-1).edges, []);
  assert.deepEqual(graphRows(commits.slice(0, 3), sha('a')).rows, rows.slice(0, 3));
  for (let index = 0; index < rows.length - 1; index++) {
    const bottom = new Set(rows[index].edges.filter(edge => edge.half === 'bottom').map(edge => edge.to));
    const top = new Set(rows[index + 1].edges.filter(edge => edge.half === 'top').map(edge => edge.from));
    assert.deepEqual(top, bottom, 'every line continues at the next row boundary');
  }
});

test('graph ignores old pages/searches after changing project, retains good data on error and seeks matches beyond the first page', async () => {
  const { graphRows } = await data();
  const pages = [], searches = [];
  const Graph = await graph({ graphRows, readGraphPage: (...args) => new Promise(resolve => pages.push({ args, resolve })),
    searchGraph: (...args) => new Promise(resolve => searches.push({ args, resolve })) });
  const { cx, timers, drain } = graphClock();
  const view = new Graph(cx, () => []);
  const entry = letter => ({ sha: sha(letter), parents: [], subject: letter, author: 'Name' });
  const snapshot = { revision: 'one', head: sha('a'), tips: [sha('a')], refs: {} };
  view.reset({ folder: '/first' }); view.load(cx); view.load(cx, true);
  assert.equal(pages.length, 1);
  pages.shift().resolve({ snapshot, entries: [entry('a')], hasMore: true }); await drain();
  view.input.set_value('old'); view.queueSearch(cx); timers.at(-1).fn(cx);
  view.input.set_value('new'); view.queueSearch(cx); timers.at(-1).fn(cx);
  searches[1].resolve([sha('b')]); searches[0].resolve([sha('a')]); searches.length = 0;
  // Search completion immediately starts the next page to find the match.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(pages.length, 1);
  assert.equal(pages[0].args[2], snapshot); assert.equal(pages[0].args[3], 1);
  pages.shift().resolve({ snapshot, entries: [entry('b')], hasMore: false }); await drain();
  assert.equal(view.selected.sha, sha('b')); assert.deepEqual(view.matches, [sha('b')]);
  view.load(cx); view.reset({ folder: '/other' });
  pages.shift().resolve({ snapshot, entries: [entry('c')], hasMore: false }); await drain();
  assert.equal(view.entries.length, 0); assert.equal(view.selected, null);
});

test('graph virtual list builds only visible native paths and keeps all interaction handlers outside deferred rows', async () => {
  const { graphRows } = await data();
  let list, deferred = false, count = 0;
  const nodes = new Map();
  const element = () => {
    count++; const state = {};
    const el = new Proxy(state, { get(_target, key) {
      if (key in state) return state[key];
      if (key === 'when') return (condition, fn) => { if (condition) fn(el); return el; };
      return (...args) => {
        if (deferred && String(key).startsWith('on_')) assert.fail(`Deferred handler ${key}`);
        if (key === 'id') nodes.set(args[0], state);
        if (key === 'on_item_click') state.click = args[0];
        if (key === 'on_click') state.double = args[0];
        return el;
      };
    } }); return el;
  };
  const Graph = await graph({ graphRows, div: element, h_flex: element, v_flex: element, svg: element,
    Scrollbar: { vertical: element }, PathBuilder: { stroke: element }, globalThis: { window: { paint_path: element } },
    v_virtual_list(id, items, height, key, render) { const el = element(); list = { items, height, key, render, el }; return el; } });
  const { cx } = graphClock(), view = new Graph(cx, () => []);
  view.entries = Array.from({ length: 5000 }, (_, index) => ({ sha: index.toString(16).padStart(40, '0'), shortSha: String(index), author: 'A',
    subject: `Commit ${index}`, parents: index === 4999 ? [] : [(index + 1).toString(16).padStart(40, '0')] }));
  view.layout = graphRows(view.entries); view.hasMore = true;
  view.table({});
  assert.equal(list.items, 5001); assert.equal(list.height, 28); assert.ok(count < 50);
  deferred = true;
  assert.equal(list.render({ start: 10, end: 15 }, cx).length, 5);
  deferred = false;
  list.el.click(list.key(12), cx); assert.equal(view.index, 12);
  let opened; view.onOpen = commit => { opened = commit; };
  list.el.double({ click_count: 2 }, cx); assert.equal(opened, view.entries[12]);
  let requested = 0;
  view.load = (_cx, more) => { assert.ok(more); requested++; view.loading = true; };
  deferred = true;
  const timers = [], deferredCx = { timer: { after(_ms, fn) { timers.push(fn); } } };
  list.render({ start: 5000, end: 5001 }, deferredCx); list.render({ start: 5000, end: 5001 }, deferredCx);
  deferred = false;
  assert.equal(requested, 0); assert.equal(timers.length, 1);
  timers[0](cx); timers[0](cx); assert.equal(requested, 1);
  view.loading = false; view.error = 'fail'; timers[0](cx); assert.equal(requested, 1);
});

test('graph parsing retains SHA-256 parents, Unicode and multiline messages and dates reject invalid values', async () => {
  const { parseGraphCommits, graphDate } = await data();
  const id = 'a'.repeat(64), parent = 'b'.repeat(64);
  const [entry] = parseGraphCommits([id, id.slice(0, 7), '作者', 'a@b', '1700000000', parent, '修正\n\nBody $(literal)\n', ''].join('\0'));
  assert.equal(entry.sha, id); assert.deepEqual(entry.parents, [parent]);
  assert.equal(entry.message, '修正\n\nBody $(literal)');
  assert.equal(graphDate(NaN), ''); assert.equal(graphDate(1e30, false), '');
  assert.equal(graphDate(1699999940, true, 1700000000000), '1 minute ago');
  assert.equal(graphDate(1699992800, true, 1700000000000), '2 hours ago');
  assert.match(graphDate(1700000000, false), /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
});

test('graph refresh errors preserve loaded commits and a project reset invalidates an in-flight search', async () => {
  const { graphRows } = await data();
  let fail = false, searchDone;
  const commit = { sha: sha('a'), parents: [] }, snapshot = { head: commit.sha, revision: 'first', refs: {}, tips: [commit.sha] };
  const Graph = await graph({ graphRows, readGraphPage: async () => {
    if (fail) throw new Error('Read failed'); return { snapshot, entries: [commit], hasMore: false };
  }, searchGraph: () => new Promise(resolve => { searchDone = resolve; }) });
  const { cx, timers, drain } = graphClock(), view = new Graph(cx, () => []);
  view.reset({ folder: '/repo' }); view.load(cx); await drain();
  const entries = view.entries;
  fail = true; view.load(cx); await drain();
  assert.equal(view.entries, entries); assert.equal(view.error, 'Read failed');
  view.input.set_value('text'); view.queueSearch(cx); timers.at(-1).fn(cx);
  view.reset({ folder: '/other' }); searchDone([commit.sha]); await drain();
  assert.deepEqual(view.matches, []); assert.equal(view.selected, null); assert.equal(view.searching, false);
});
