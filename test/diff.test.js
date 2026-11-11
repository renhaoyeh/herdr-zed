import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

async function load(host = {}) {
  const memory = {};
  host = { readBuildRules: async () => null, withBuildRulesFile: (rules, _on, read) => read(rules?.path || ''), openSettings() {}, SelectState: class { constructor() { this.open = false; } }, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, TextEncoder: undefined, TextDecoder: undefined,
    v_virtual_list: (_id, count, _sizes, _key, render) => { render({ start: 0, end: count }); return host.div(); },
    Scrollbar: { vertical: () => host.div() },
    // Provider-facing shell functions used by the Git panel; no provider is active unless a test supplies one.
    extensionActions: () => [], extensionCatalog: () => ({ resolved: {} }), openGitAction() {}, credentialArgsFor: () => [],
    ...host };
  const source = await readFile(new URL('../mods/herdr-zed/diff.js', import.meta.url), 'utf8');
  const sidePanel = await readFile(new URL('../components/side-panel.js', import.meta.url), 'utf8');
  const icons = await readFile(new URL('../components/icon.js', import.meta.url), 'utf8');
  const menu = await readFile(new URL('../components/dropdown-menu.js', import.meta.url), 'utf8');
  const history = await readFile(new URL('../mods/herdr-zed/git-history.js', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../mods/herdr-zed/shell.js', import.meta.url), 'utf8');
  const command = await readFile(new URL('../components/session-shell.js', import.meta.url), 'utf8');
  const utf8 = await readFile(new URL('../mods/herdr-zed/utf8.js', import.meta.url), 'utf8');
  const toast = await readFile(new URL('../mods/herdr-zed/git-result-toast.js', import.meta.url), 'utf8');
  return new Function(...Object.keys(host), (utf8 + '\n' + command + '\n' + shell + '\n' + icons + '\n' + menu + '\n' + history + '\n' + sidePanel + '\n' + toast + '\n' + source).replace(/^import .*;\r?\n/gm, '')
    .replace('export default class', 'class').replace(/^export /gm, '') + '\nreturn { DiffViewer, ALL_REPOSITORIES, readAllDiff, readRepositories, DropdownMenu, DropdownMenuState, showGitToast, clearGitToast, utf8ByteLength, parseDiff, parseDiffBatches, parseDiffAsync, parseDiffIndex, readDiff, readPushState, pushBranch, gitRemoteAction, affectsDiff, pairLines, changedRanges, changeSections, changeTree, wrapLine, isBuildOutput };')(...Object.values(host));
}
const run = promisify(execFile);
const indexFor = path => `${'a'.repeat(40)}\0/repo\0:100644 100644 abc def M\0${path}\0` + `1\t1\t${path}\0\0`;

test('repository discovery reads immediate child repositories and linked worktrees without entering nested trees', async t => {
  const folder = await mkdtemp(join(tmpdir(), "devkits repositories ' $(unused) "));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const git = (...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  const alpha = join(folder, 'alpha');
  await git('init', '-q', '-b', 'main', alpha);
  await git('-C', alpha, 'commit', '--allow-empty', '-qm', 'initial');
  await git('-C', alpha, 'worktree', 'add', '-qb', 'linked', join(folder, 'linked'));
  await git('init', '-q', join(folder, '中文 repo'));
  await git('init', '-q', join(folder, '.hidden'));
  await git('init', '-q', join(folder, 'ordinary', 'nested'));
  await git('init', '-q', '--bare', join(folder, 'bare.git'));
  await mkdir(join(folder, 'broken', '.git'), { recursive: true });
  const { readRepositories } = await load({ exec: async (command, args, options) => {
    assert.equal(options.on, 'remote');
    try { return { code: 0, ...await run(command, args) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  } });
  const names = await readRepositories(folder.replaceAll('\\', '/'), 'remote');
  assert.deepEqual(new Set(names), new Set(['alpha', 'linked', '中文 repo', '.hidden']));
  assert.deepEqual(await readRepositories(alpha.replaceAll('\\', '/'), 'remote'), ['.']);
  await mkdir(join(alpha, 'src'));
  assert.deepEqual(await readRepositories(join(alpha, 'src').replaceAll('\\', '/'), 'remote'), ['.']);
  assert.deepEqual(await readRepositories(join(folder, 'ordinary', 'nested').replaceAll('\\', '/'), 'remote'), ['.']);
  assert.deepEqual(await readRepositories(join(folder, 'broken').replaceAll('\\', '/'), 'remote'), []);
});

test('child repository selection scopes reads, remembers the choice and discards obsolete discovery', async () => {
  const memory = {}, pending = [], reads = [], tasks = [];
  const { DiffViewer } = await load({
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    VirtualListScrollHandle: { new: () => ({}) },
    exec: async (_command, args, options) => {
      assert.ok(args.includes('herdr-zed-repositories'));
      assert.equal(options.on, 'remote');
      return new Promise(resolve => pending.push(resolve));
    },
  });
  const cx = { sleep: async () => {}, notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  const drain = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  const view = new DiffViewer(); view.init();
  view.observe = () => {}; view.reload = () => reads.push(view.context.folder);
  view.showChanges = () => { view.previewMode = false; };
  let switched = 0; view.onRepositoryChange = () => switched++;
  const project = { id: 'parent', folder: '/parent', machine: 'remote', branch: 'wrong-parent-branch' };
  view.refresh(project, cx); await Promise.resolve();
  pending.shift()({ code: 0, stdout: 'alpha\0beta\0' }); await drain();
  assert.equal(view.context.folder, '/parent/alpha');
  assert.equal(view.history.context.folder, '/parent/alpha');
  assert.equal(view.nativeBranch, null);
  view.selectRepository('beta', cx); await drain();
  assert.equal(switched, 1);
  assert.equal(view.project.folder, '/parent');
  assert.equal(view.context.folder, '/parent/beta');
  assert.deepEqual(reads, ['/parent/alpha', '/parent/beta']);
  view.selectRepository('../elsewhere', cx); assert.equal(switched, 1);
  view.refresh(project, cx); await Promise.resolve();
  pending.shift()({ code: 0, stdout: 'alpha\0beta\0' }); await drain();
  assert.equal(view.context.folder, '/parent/beta', 'Restores the saved repository');
  view.refresh(project, cx); await Promise.resolve();
  const obsolete = pending.shift();
  view.refresh({ ...project, id: 'next', folder: '/next' }, cx); await Promise.resolve();
  pending.shift()({ code: 0, stdout: 'current\0' });
  obsolete({ code: 0, stdout: 'obsolete\0' }); await drain();
  assert.equal(view.context.folder, '/next/current');
  view.refresh(project, cx); await Promise.resolve();
  pending.shift()({ code: 0, stdout: 'alpha\0' }); await drain();
  assert.equal(view.context.folder, '/parent/alpha', 'A missing saved repository falls back to an available one');
});

test('All reads every index first, keeps identical paths distinct and preserves successful repositories on errors', async () => {
  const calls = [];
  let failed = false;
  const { readAllDiff, DiffViewer } = await load({
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    exec: async (_cmd, args, options) => {
      assert.equal(options.on, 'remote');
      if (args.includes('herdr-zed-diff-index')) {
        const folder = args[3]; calls.push(`index:${folder}`);
        if (failed && folder.endsWith('/beta')) return { code: 1, stdout: '', stderr: 'Unavailable' };
        return { code: 0, stdout: indexFor('src/same.js').replace('/repo', folder) };
      }
      assert.ok(args.includes('herdr-zed-diff-file'));
      calls.push(`patch:${args[3]}:${args[6]}`);
      return { code: 0, stdout: `diff --git a/src/same.js b/src/same.js\n--- a/src/same.js\n+++ b/src/same.js\n@@ -1 +1 @@\n-old\n+${args[3]}\n` };
    },
  });
  const project = { folder: '/parent', machine: 'remote' };
  let indexed;
  const first = await readAllDiff(project, ['alpha', 'beta'], { onIndex: files => { indexed = files; assert.equal(calls.length, 2); } });
  assert.deepEqual(calls, ['index:/parent/alpha', 'index:/parent/beta', 'patch:/parent/alpha:src/same.js', 'patch:/parent/beta:src/same.js']);
  assert.deepEqual(indexed.map(file => file.path), ['alpha/src/same.js', 'beta/src/same.js']);
  assert.deepEqual(first.files.map(file => file.hunks[0].lines.at(-1).text), ['/parent/alpha', '/parent/beta']);
  const stable = await readAllDiff(project, ['alpha', 'beta'], { previous: first.files });
  assert.equal(stable.files, first.files);
  const view = new DiffViewer(); view.init(); view.context = { ...project, allRepositories: true };
  view.repositories = ['alpha', 'beta']; view.files = first.files;
  assert.deepEqual(view.fileRows(first.files).filter(row => row.kind === 'section').map(row => row.section.label), ['alpha · Tracked', 'beta · Tracked']);
  assert.deepEqual(view.fileRows(first.files).filter(row => row.kind === 'dir').map(row => row.name), ['src', 'src']);
  view.reveal('beta/src/same.js', { notify() {} });
  assert.equal(view.selected, 'beta/src/same.js');
  assert.equal(view.rows().rows.filter(row => row.kind === 'file').length, 2);
  failed = true;
  const partial = await readAllDiff(project, ['alpha', 'beta'], { previous: first.files });
  assert.match(partial.error, /beta: Unavailable/);
  assert.equal(partial.files, first.files);
  assert.equal(await readAllDiff(project, ['alpha', 'beta'], { cancelled: () => true }), null);
});

test('All shares the source-line budget and prioritizes a selected file without changing repository order', async () => {
  const calls = [];
  const { readAllDiff } = await load({ exec: async (_cmd, args) => {
    if (args.includes('herdr-zed-diff-index')) return { code: 0, stdout: indexFor('same').replace('/repo', args[3]) };
    calls.push(args[3]);
    const count = Math.min(6000, Number(args[8]) - 64);
    return { code: 0, stdout: `diff --git a/same b/same\n--- a/same\n+++ b/same\n@@ -0,0 +1,${count} @@\n` + '+new\n'.repeat(count) };
  } });
  const result = await readAllDiff({ folder: '/parent' }, ['alpha', 'beta'], { priority: 'beta/same' });
  assert.deepEqual(calls, ['/parent/beta', '/parent/alpha']);
  assert.deepEqual(result.files.map(file => file.path), ['alpha/same', 'beta/same']);
  assert.equal(result.files[1].hunks[0].lines.length, 6000);
  assert.equal(result.files.reduce((sum, file) => sum + file.hunks.reduce((n, hunk) => n + hunk.lines.length, 0), 0), 10000);
});

test('All selection is remembered, scopes history and remote operations, and restores single-repository behavior', async () => {
  const memory = {}, tasks = [];
  const { DiffViewer, ALL_REPOSITORIES } = await load({
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    exec: async () => ({ code: 0, stdout: 'alpha\0beta\0' }),
  });
  const cx = { sleep: async () => {}, notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  const drain = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  const view = new DiffViewer(); view.init(); view.observe = () => {}; view.reload = () => {};
  const project = { id: 'parent', folder: '/parent' };
  view.refresh(project, cx); await drain();
  view.panelTab = 'history'; view.selectRepository(ALL_REPOSITORIES, cx); await drain();
  assert.equal(view.allRepositories, true); assert.equal(view.context.folder, '/parent');
  assert.equal(view.history.context, null); assert.equal(view.panelTab, 'changes');
  assert.match(view.pushUnavailable('fetch'), /Select a repository/);
  view.setPanelTab('history', cx); view.openGraph(cx); view.openCommit({ sha: 'abc' }, cx);
  assert.equal(view.panelTab, 'changes'); assert.equal(view.graphMode, false); assert.equal(view.previewMode, false);
  view.refresh(project, cx); await drain(); assert.equal(view.allRepositories, true);
  view.selectRepository('beta', cx); await drain();
  assert.equal(view.allRepositories, false); assert.equal(view.context.folder, '/parent/beta');
  assert.equal(view.history.context.folder, '/parent/beta');
});

test('All panel exposes the saved choice, disables History and omits branch and remote controls', async () => {
  const nodes = new Map(); let selection;
  const element = () => {
    const data = {};
    const el = new Proxy(data, { get(target, key) {
      if (key in target) return target[key];
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      return (...args) => {
        if (key === 'id') nodes.set(args[0], data);
        if (key === 'disabled') data.disabledValue = args[0];
        return el;
      };
    } });
    return el;
  };
  const { DiffViewer, ALL_REPOSITORIES } = await load({
    div: element, svg: element, h_flex: element, v_flex: element,
    Button: id => element().id(id), ToolbarButton: id => element().id(id), Popup: { new: id => element().id(id) },
    Select: (_id, _state, value, options) => { selection = { value, options }; return element(); },
    VirtualListScrollHandle: { new: () => ({}) },
  });
  const view = new DiffViewer(); view.init(); view.project = { folder: '/parent' };
  view.context = { folder: '/parent', allRepositories: true }; view.repositories = ['alpha', 'beta'];
  view.panel({});
  assert.equal(selection.value, ALL_REPOSITORIES);
  assert.deepEqual(selection.options.map(option => option.label), ['All', 'alpha', 'beta']);
  assert.equal(nodes.get('git-tab-history').disabledValue, true);
  assert.equal(nodes.has('diff-push'), false);
  assert.equal(nodes.has('git-open-graph'), false);
});

test('build filtering follows Git classification and preserves tracked changes', async () => {
  const memory = {};
  const { DiffViewer, isBuildOutput } = await load({
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
  });
  assert.equal(isBuildOutput({ path: 'custom/output', untracked: true, buildOutput: true }), true);
  assert.equal(isBuildOutput({ path: 'custom/output', untracked: false, buildOutput: true }), false);
  assert.equal(isBuildOutput({ path: 'anything.obj', untracked: true, buildOutput: false }), false);
  const view = new DiffViewer(); view.init();
  view.files = [
    { path: 'Cargo.lock' }, { path: 'src/main.cpp' },
    { path: 'repo/x64/Debug/main.obj', sourcePath: 'x64/Debug/main.obj', untracked: true, buildOutput: true },
    { path: 'repo/x64/Debug/tracked.dll', untracked: false },
  ];
  const visible = view.displayFiles;
  assert.deepEqual(visible.map(file => file.path), ['Cargo.lock', 'src/main.cpp', 'repo/x64/Debug/tracked.dll'], 'Tracked lockfiles stay visible');
  assert.equal(view.displayFiles, visible, 'Stable filtering preserves the asynchronous row cache');
});

test('hidden output skips patch reads and saved filter rules that reveal files load deferred contents', async () => {
  const memory = {}, tasks = [], patches = [];
  let rules = { path: '/rules', text: '*.obj\n*.lock' };
  const { DiffViewer } = await load({
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, readBuildRules: async () => rules,
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    exec: async (_cmd, args) => {
      if (args.includes('herdr-zed-diff-index')) return { code: 0, stdout: indexFor('src/main.cpp') + 'x64/Debug/main.obj\0Cargo.lock\0\0' + (rules.text ? 'x64/Debug/main.obj\0Cargo.lock\0' : '') };
      if (!args.includes('herdr-zed-diff-file')) return { code: 0, stdout: '' };
      const path = args[6]; patches.push(path);
      return { code: 0, stdout: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+new\n` };
    },
  });
  const cx = { sleep: async () => {}, notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  const drain = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  const view = new DiffViewer(); view.init(); view.context = { folder: '/repo' };
  view.reload(cx); await drain();
  assert.deepEqual(patches, ['src/main.cpp']);
  assert.deepEqual(view.displayFiles.map(file => file.path), ['src/main.cpp']);
  assert.equal(view.files.find(file => file.path === 'x64/Debug/main.obj').deferred, true);
  rules = { ...rules, text: '' }; view.reload(cx); await drain();
  assert.equal(view.files.find(file => file.path === 'x64/Debug/main.obj').deferred, false);
  assert.equal(view.displayFiles.length, 3);
  assert.ok(patches.includes('x64/Debug/main.obj')); assert.ok(patches.includes('Cargo.lock'));
});

test('Git evaluates downloaded templates and user exceptions without hiding tracked files or lockfiles', async t => {
  const folder = await mkdtemp(join(tmpdir(), "devkits gitignore ' $(literal) "));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const git = (...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  await git('init', '-q', folder);
  await writeFile(join(folder, 'tracked.obj'), 'original');
  await git('-C', folder, 'add', 'tracked.obj');
  await git('-C', folder, 'commit', '-qm', 'initial');
  await writeFile(join(folder, 'tracked.obj'), 'changed');
  for (const path of ['Debug/build.obj', 'new.custom', 'keep.obj', 'Cargo.lock', 'package-lock.json', 'strange 中文 $(literal).obj']) {
    await mkdir(join(folder, path, '..'), { recursive: true });
    await writeFile(join(folder, path), 'contents');
  }
  const templates = await Promise.all(['VisualStudio', 'Qt'].map(name => readFile(new URL(`../mods/herdr-zed/assets/gitignore/${name}.gitignore`, import.meta.url), 'utf8')));
  const rulesPath = join(folder, '..', `rules-${Date.now()}.gitignore`);
  t.after(() => rm(rulesPath, { force: true }));
  await writeFile(rulesPath, templates.join('\n') + '\n*.custom\n!keep.obj\n');
  const { readDiff } = await load({ exec: async (command, args) => {
    try { return { code: 0, ...await run(command, args) }; }
    catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  } });
  const options = { buildRules: { path: rulesPath.replaceAll('\\', '/') }, include: file => !file.buildOutput };
  const first = await readDiff(folder.replaceAll('\\', '/'), null, options);
  const classified = new Map(first.files.map(file => [file.path, file]));
  for (const name of ['Debug/build.obj', 'new.custom', 'strange 中文 $(literal).obj']) {
    assert.equal(classified.get(name).buildOutput, true, name);
    assert.equal(classified.get(name).deferred, true, name);
  }
  for (const name of ['keep.obj', 'Cargo.lock', 'package-lock.json', 'tracked.obj']) {
    assert.ok(!classified.get(name).buildOutput, name);
    assert.equal(classified.get(name).deferred, false, name);
  }
  await writeFile(rulesPath, templates.join('\n') + '\n!*.obj\n');
  const second = await readDiff(folder.replaceAll('\\', '/'), null, { ...options, previous: first.files });
  assert.equal(second.files.find(file => file.path === 'Debug/build.obj').buildOutput, true, 'An excluded parent directory still wins, following Git semantics');
  assert.equal(second.files.find(file => file.path === 'strange 中文 $(literal).obj').deferred, false);
  assert.equal(second.files.find(file => file.path === 'new.custom').deferred, false);
});

test('Git panel settings open filter rules and display the hidden count', async () => {
  const memory = {}; let opened = 0;
  const { DiffViewer } = await load({
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, openSettings: key => { if (key === 'git') opened++; },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
  });
  const view = new DiffViewer(); view.init();
  view.files = [{ path: 'Cargo.lock' }, { path: 'debug/build.tlog', untracked: true, buildOutput: true }, { path: 'src/main.cpp' }];
  let options = view.panelSettingsItems();
  assert.deepEqual(options.map(item => item.key), ['list', 'tree', 'filter-rules']);
  assert.equal(options.at(-1).description, '1 hidden');
  view.choosePanelSetting('filter-rules', { notify() {} });
  assert.equal(opened, 1);
  assert.deepEqual(memory, {}, 'The menu no longer stores filter switches');
});

test('push reads clean, unborn and detached branches and respects Git push configuration', async t => {
  const folder = await mkdtemp(join(tmpdir(), "devkits push ' $(x)"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const repo = join(folder, 'work'), origin = join(folder, 'origin.git'), target = join(folder, 'target.git');
  const git = (...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  await git('init', '-q', '-b', 'main', repo);
  await git('init', '-q', '--bare', origin);
  await git('init', '-q', '--bare', target);
  const { readPushState, pushBranch, gitRemoteAction } = await load({ exec: async (cmd, args, options) => {
    assert.equal(options.on, 'machine');
    try { const { stdout, stderr } = await run(cmd, args); return { code: 0, stdout, stderr }; }
    catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  } });
  const path = repo.replaceAll('\\', '/');
  assert.deepEqual(await readPushState(path, 'machine'), { branch: 'main', committed: false, remote: false, remotes: [], upstream: 'none', pushRemote: null, ahead: null, behind: null, revision: null });
  await git('-C', repo, 'remote', 'add', 'origin', origin);
  await git('-C', repo, 'remote', 'add', 'target', target);
  await writeFile(join(repo, 'a.txt'), 'first\n');
  await git('-C', repo, 'add', '.');
  await git('-C', repo, 'commit', '-qm', 'initial');
  const { stdout: initial } = await git('-C', repo, 'rev-parse', 'HEAD');
  assert.deepEqual(await readPushState(path, 'machine'), { branch: 'main', committed: true, remote: true, remotes: ['origin', 'target'], upstream: 'none', pushRemote: 'origin', ahead: null, behind: null, revision: initial.trim() });
  await git('-C', repo, 'config', 'push.default', 'simple');
  await git('-C', repo, 'config', 'push.autoSetupRemote', 'false');
  await assert.rejects(pushBranch(path, 'machine'), /no upstream branch/);
  await git('-C', repo, 'push', '-qu', 'origin', 'main');
  assert.equal((await readPushState(path, 'machine')).ahead, 0);
  assert.equal((await readPushState(path, 'machine')).behind, 0);
  await git('-C', repo, 'config', 'branch.main.pushRemote', 'target');
  // A dirty working tree is not committed or staged by Push.
  await writeFile(join(repo, 'a.txt'), 'uncommitted\n');
  await pushBranch(path, 'machine');
  const { stdout: pushed } = await git('--git-dir', target, 'show', 'main:a.txt');
  assert.equal(pushed, 'first\n');
  const { stdout: dirty } = await git('-C', repo, 'status', '--porcelain');
  assert.match(dirty, / M a.txt/);
  await writeFile(join(repo, 'a.txt'), 'first\n');
  const { stdout: upstream } = await git('-C', repo, 'rev-parse', '@{upstream}');
  await git('-C', repo, 'commit', '--allow-empty', '-qm', 'local commit');
  let state = await readPushState(path, 'machine');
  assert.deepEqual([state.ahead, state.behind], [1, 0]);
  const { stdout: remoteCommit } = await git('-C', repo, 'commit-tree', 'HEAD^{tree}', '-p', upstream.trim(), '-m', 'remote commit');
  await git('-C', repo, 'update-ref', 'refs/remotes/origin/main', remoteCommit.trim());
  state = await readPushState(path, 'machine');
  assert.deepEqual([state.ahead, state.behind], [1, 1]);
  await git('-C', repo, 'update-ref', 'refs/remotes/origin/main', upstream.trim());
  await git('-C', repo, 'push', '-q', 'origin', 'main');
  state = await readPushState(path, 'machine');
  assert.deepEqual([state.ahead, state.behind], [0, 0]);
  // A rejected update must surface the error and leave the remote ref alone.
  await git('-C', repo, 'config', '--unset', 'branch.main.pushRemote');
  await git('-C', repo, 'checkout', '-q', '--orphan', 'other');
  await git('-C', repo, 'commit', '-qam', 'unrelated');
  const { stdout: other } = await git('-C', repo, 'rev-parse', 'HEAD');
  await git('--git-dir', target, 'fetch', '-q', repo, 'other');
  await git('--git-dir', target, 'update-ref', 'refs/heads/main', other.trim());
  await git('-C', repo, 'checkout', '-q', 'main');
  await git('-C', repo, 'config', 'remote.pushDefault', 'target');
  await assert.rejects(pushBranch(path, 'machine'), /rejected/);
  await assert.rejects(gitRemoteAction(path, 'machine', 'force-push'), /rejected/);
  const { stdout: unchanged } = await git('--git-dir', target, 'rev-parse', 'main');
  assert.equal(unchanged, other);
  await gitRemoteAction(path, 'machine', 'fetch', 'target');
  await gitRemoteAction(path, 'machine', 'force-push', 'target');
  const { stdout: forced } = await git('--git-dir', target, 'rev-parse', 'main');
  const { stdout: local } = await git('-C', repo, 'rev-parse', 'HEAD');
  assert.equal(forced, local);
  await git('-C', repo, 'checkout', '-q', '--detach');
  assert.deepEqual(await readPushState(path, 'machine'), { branch: null, committed: true, remote: true, remotes: ['origin', 'target'], upstream: 'none', pushRemote: 'target', ahead: null, behind: null, revision: local.trim() });
  await assert.rejects(readPushState(folder.replaceAll('\\', '/'), 'machine'), /Git branch|git repository/);
});

test('Git menu runs only known commands and passes remote names as literal arguments', async () => {
  const calls = [];
  const { gitRemoteAction } = await load({ exec: async (...args) => { calls.push(args); return { code: 0 }; } });
  for (const [action, args] of [['fetch', ['fetch', '--all']], ['pull', ['pull']], ['pull-rebase', ['pull', '--rebase']],
    ['push', ['push']], ['force-push', ['push', '--force-with-lease']]]) {
    await gitRemoteAction('/folder $(x)', 'box', action);
    assert.deepEqual(calls.at(-1).slice(1), [[
      '-c', 'cd "$1" || exit 2; shift; GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git "$@"',
      'herdr-zed-git', '/folder $(x)', ...args,
    ], { on: 'box' }]);
  }
  await gitRemoteAction('/project', null, 'fetch', 'remote$(x)');
  assert.deepEqual(calls.at(-1)[1].slice(-3), ['fetch', '--', 'remote$(x)']);
  await assert.rejects(gitRemoteAction('/project', null, 'reset'), /Unknown/);
  assert.equal(calls.length, 6);
  await assert.rejects(gitRemoteAction('/project', null, 'publish'), /Choose a Git remote/);
  await assert.rejects(gitRemoteAction('/project', null, 'push-tags'), /Choose a Git remote/);
  // Credential arguments arrive already validated by the shell (credentialArgsFor); they precede the Git subcommand.
  const credential = ['-c', 'credential.https://github.com.username=alice'];
  await gitRemoteAction('/project', 'box', 'push', 'origin', credential);
  assert.deepEqual(calls.at(-1)[1].slice(4, 6), credential);
  assert.ok(calls.at(-1)[1].includes('credential.https://github.com.username=alice'));
  assert.deepEqual(calls.at(-1)[1].slice(-3), ['push', '--', 'origin']);
  await gitRemoteAction('/project', 'box', 'push-tags', 'remote$(x)', credential);
  assert.ok(calls.at(-1)[1].includes('credential.https://github.com.username=alice'));
  assert.deepEqual(calls.at(-1)[1].slice(-4), ['push', '--tags', '--', 'remote$(x)']);
});

test('Push Tags selects a remote, pushes lightweight and annotated tags only and retains conflicting remote tags', async t => {
  const folder = await mkdtemp(join(tmpdir(), "devkits tags ' $(x)"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const repo = join(folder, 'work'), alpha = join(folder, 'alpha.git'), beta = join(folder, 'beta.git');
  const git = (...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  await git('init', '-q', '-b', 'main', repo);
  for (const [name, path] of [['alpha', alpha], ['beta', beta]]) {
    await git('init', '-q', '--bare', path);
    await git('-C', repo, 'remote', 'add', name, path);
  }
  await git('-C', repo, 'commit', '--allow-empty', '-qm', 'initial');
  await git('-C', repo, 'tag', 'v1-light');
  await git('-C', repo, 'tag', '-am', 'release', 'v1-annotated');
  await git('-C', repo, 'config', 'push.default', 'nothing');
  await git('-C', repo, 'config', 'remote.alpha.push', 'HEAD:refs/heads/unwanted');
  const { DiffViewer, readPushState } = await load({
    VirtualListScrollHandle: { new: () => ({}) },
    exec: async (cmd, args) => {
      try { const { stdout, stderr } = await run(cmd, args); return { code: 0, stdout, stderr }; }
      catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    },
  });
  const tasks = [], cx = { notify() {}, timer: { after: () => ({ cancel() {} }) }, spawn(fn) { tasks.push(fn(cx)); } };
  const view = new DiffViewer(); view.init(); view.context = { folder: repo.replaceAll('\\', '/') };
  view.reload = () => {};
  const refresh = async () => { view.pushState = await readPushState(view.context.folder); };
  await refresh();
  view.remoteAction('push-tags', cx);
  assert.equal(view.gitMenu.page, 'push-tags');
  assert.equal(view.gitMenu.open, true);
  assert.equal(tasks.length, 0);
  view.remoteAction('push-tags', cx, 'alpha');
  view.remoteAction('push-tags', cx, 'beta');
  assert.equal(tasks.length, 1, 'Tag pushes share the remote operation lock');
  await Promise.all(tasks.splice(0));
  assert.equal(view.pushResult.failed, false, view.pushResult.message);
  assert.equal((await git('--git-dir', alpha, 'tag', '-l')).stdout.trim(), 'v1-annotated\nv1-light');
  assert.equal((await git('--git-dir', alpha, 'for-each-ref', 'refs/heads')).stdout, '', 'Configured branch refspecs must not publish branches');
  assert.equal((await git('--git-dir', beta, 'tag', '-l')).stdout, '');
  assert.equal(view.pushState.upstream, 'none');
  const original = (await git('--git-dir', alpha, 'rev-parse', 'refs/tags/v1-light')).stdout;
  await git('-C', repo, 'commit', '--allow-empty', '-qm', 'next');
  await git('-C', repo, 'tag', '-f', 'v1-light');
  view.remoteAction('push-tags', cx, 'alpha'); await Promise.all(tasks.splice(0));
  assert.equal(view.pushResult.failed, true);
  assert.match(view.pushResult.message, /rejected|already exists/);
  assert.equal((await git('--git-dir', alpha, 'rev-parse', 'refs/tags/v1-light')).stdout, original);
  await git('-C', repo, 'config', 'remote.pushDefault', 'beta');
  await git('-C', repo, 'checkout', '-q', '--detach');
  await refresh();
  assert.equal(view.pushUnavailable('push-tags'), null);
  view.remoteAction('push-tags', cx); await Promise.all(tasks.splice(0));
  assert.equal(view.pushResult.failed, false, view.pushResult.message);
  assert.equal((await git('--git-dir', beta, 'tag', '-l')).stdout.trim(), 'v1-annotated\nv1-light');
  await git('-C', repo, 'checkout', '-q', '--orphan', 'unborn');
  await refresh();
  assert.equal(view.pushState.committed, false);
  assert.equal(view.pushUnavailable('push-tags'), null, 'Existing tags can be pushed before the current branch has a commit');
  view.remoteAction('push-tags', cx); await Promise.all(tasks.splice(0));
  assert.equal(view.pushResult.failed, false);
  view.pushState.remote = false;
  view.remoteAction('push-tags', cx);
  assert.equal(tasks.length, 0);
});

test('Zed remote actions publish, fetch every remote, pull before push and republish a missing upstream', async t => {
  const folder = await mkdtemp(join(tmpdir(), "devkits publish ' $(x)"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const repo = join(folder, 'work'), alpha = join(folder, 'alpha.git'), beta = join(folder, 'beta.git');
  const git = (...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  const branch = 'feature/中文$(x)';
  await git('init', '-q', '-b', branch, repo);
  for (const [name, path] of [['alpha', alpha], ['beta', beta]]) {
    await git('init', '-q', '--bare', path);
    await git('-C', repo, 'remote', 'add', name, path);
  }
  await writeFile(join(repo, 'a.txt'), 'initial\n');
  await git('-C', repo, 'add', '.'); await git('-C', repo, 'commit', '-qm', 'initial');
  await git('-C', repo, 'config', 'push.default', 'nothing');
  await git('-C', repo, 'config', 'remote.alpha.push', 'HEAD:refs/heads/wrong');
  await git('-C', repo, 'config', 'pull.rebase', 'true');
  const { DiffViewer, readPushState, gitRemoteAction } = await load({
    VirtualListScrollHandle: { new: () => ({}) }, notify() {},
    exec: async (cmd, args) => {
      try { const { stdout, stderr } = await run(cmd, args); return { code: 0, stdout, stderr }; }
      catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    },
  });
  const tasks = [], cx = { notify() {}, timer: { after: () => ({ cancel() {} }) }, spawn(fn) { tasks.push(fn(cx)); } };
  const path = repo.replaceAll('\\', '/');
  const view = new DiffViewer(); view.init(); view.context = { folder: path };
  view.reload = () => {};
  const refresh = async () => { view.pushState = await readPushState(path); return view.primaryRemoteAction(); };
  assert.equal(await refresh(), 'publish');
  assert.equal(view.pushState.pushRemote, null);
  view.remoteAction('publish', cx);
  assert.equal(view.gitMenu.open, true);
  assert.equal(view.gitMenu.page, 'publish');
  assert.equal(tasks.length, 0, 'Multiple remotes without a default require selection');
  await writeFile(join(repo, 'a.txt'), 'uncommitted\n');
  view.remoteAction('push', cx, 'alpha'); await Promise.all(tasks.splice(0));
  assert.equal(view.pushResult.failed, false);
  assert.equal(await refresh(), 'fetch');
  assert.equal(view.pushState.upstream, 'tracked');
  assert.equal(view.pushState.pushRemote, 'alpha');
  assert.equal((await git('-C', repo, 'config', '--get', 'branch.' + branch + '.merge')).stdout.trim(), 'refs/heads/' + branch);
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'uncommitted\n');
  await assert.rejects(git('--git-dir', alpha, 'rev-parse', '--verify', 'refs/heads/wrong'));
  await writeFile(join(repo, 'a.txt'), 'initial\n');
  const initial = (await git('-C', repo, 'rev-parse', 'HEAD')).stdout.trim();
  const tree = (await git('-C', repo, 'rev-parse', 'HEAD^{tree}')).stdout.trim();
  const remoteCommit = (await git('--git-dir', alpha, 'commit-tree', tree, '-p', initial, '-m', 'remote')).stdout.trim();
  await git('--git-dir', alpha, 'update-ref', 'refs/heads/' + branch, remoteCommit);
  await git('--git-dir', beta, 'fetch', '-q', repo, 'HEAD:refs/heads/other');
  assert.equal(await refresh(), 'fetch', 'No network operation runs when reading state');
  await gitRemoteAction(path, null, 'fetch');
  assert.equal((await git('-C', repo, 'rev-parse', 'refs/remotes/beta/other')).stdout.trim(), initial);
  assert.equal(await refresh(), 'pull');
  assert.deepEqual([view.pushState.ahead, view.pushState.behind], [0, 1]);
  await git('-C', repo, 'commit', '--allow-empty', '-qm', 'local');
  assert.equal(await refresh(), 'pull', 'Divergence prioritizes Pull');
  assert.deepEqual([view.pushState.ahead, view.pushState.behind], [1, 1]);
  await gitRemoteAction(path, null, 'pull');
  assert.equal(await refresh(), 'push');
  await git('--git-dir', alpha, 'update-ref', '-d', 'refs/heads/' + branch);
  await git('-C', repo, 'update-ref', '-d', 'refs/remotes/alpha/' + branch);
  assert.equal(await refresh(), 'republish');
  view.remoteAction('push', cx); await Promise.all(tasks.splice(0));
  assert.equal(view.pushResult.failed, false);
  assert.equal(await refresh(), 'fetch');
  await git('-C', repo, 'config', 'remote.pushDefault', 'beta');
  await refresh(); assert.equal(view.pushState.pushRemote, 'beta');
  await git('-C', repo, 'config', 'branch.' + branch + '.pushRemote', 'alpha');
  await refresh(); assert.equal(view.pushState.pushRemote, 'alpha');
  await git('-C', repo, 'checkout', '-q', '--detach');
  assert.equal(await refresh(), 'fetch');
});

test('split button menu exposes Git operations, counts and keyboard navigation while loading stays centered', async () => {
  const nodes = new Map(), actions = [], painted = [];
  const editors = [];
  let accountSettings;
  const memory = {};
  const tasks = [];
  const element = () => {
    const data = { children: [] };
    const el = new Proxy(data, { get(target, key) {
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      return (...args) => {
        if (key === 'id') nodes.set(args[0], data);
        if (key === 'child') { data.children.push(args[0]); if (typeof args[0] === 'string') painted.push(args[0]); }
        if (key === 'children') data.children.push(...args[0]);
        if (key === 'on_click' || key === 'on_item_click') data.click = args[0];
        if (key === 'on_key_down') data.key = args[0];
        if (key === 'on_open_change') data.openChange = args[0];
        return el;
      };
    } });
    return el;
  };
  const { DiffViewer, showGitToast } = await load({ div: element, svg: element, v_flex: element, h_flex: element,
    openSettings: (key, project) => actions.push(['settings', key, project]),
    openGitAuthor: project => actions.push(['author', project]),
    Button: id => element().id(id), ToolbarButton: id => element().id(id), Popup: { new: id => element().id(id) },
    Empty: element, EmptyDescription: element, theme: () => ({}), settings: () => ({}),
    shared: key => key === 'herdr-zed.git-accounts' ? accountSettings : memory[key],
    setShared: (key, value) => { if (key === 'herdr-zed.git-accounts') accountSettings = value; else memory[key] = value; },
    exec: async () => ({ code: 0, stdout: JSON.stringify([{ host: 'github.com', login: 'alice', state: 'success' },
      { host: 'github.com', login: 'bob', state: 'error' }]) }),
    VirtualListScrollHandle: { new: () => ({}) }, Editor: { new: element },
    EditorState: { new: options => { const state = { ...options, release() { this.released = true; } }; editors.push(state); return state; } } });
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn(fn) { tasks.push(fn(cx)); } };
  const view = new DiffViewer(); view.init(cx);
  view.context = { id: 'project', folder: '/project', branch: 'native/main' };
  view.render(view.context, cx);
  assert.ok(painted.includes('Loading changes…'));
  assert.ok(painted.includes('Changes'));
  assert.ok(!painted.includes('Changes (0)'), 'Do not report zero files before reading the index');
  assert.ok(painted.includes('native/main'), 'Native branch is shown before the Git reads finish');
  view.render({ ...view.context, branch: 'native/next' }, cx);
  assert.ok(painted.includes('native/next'), 'Branch follows the same live project data as the status bar');
  assert.ok(!painted.includes('Loading branch…'));
  assert.equal(nodes.get('diff-git-footer').children.length, 1);
  view.loaded = true;
  view.pushState = { branch: 'main', committed: true, remote: true, remotes: ['origin', 'back'], ahead: 3, behind: 2 };
  view.remoteAction = (...args) => actions.push(args);
  view.pushFooter({});
  assert.equal(nodes.get('diff-git-footer').children.length, 1);
  assert.ok(nodes.get('diff-push').children.includes('↓2 ↑3 Pull'));
  nodes.get('diff-push').click({}, cx);
  assert.deepEqual(actions.pop(), ['pull', cx]);
  view.pushState.ahead = 0; view.pushState.behind = 0; view.pushFooter({});
  assert.ok(nodes.get('diff-push').children.includes('Fetch'));
  nodes.get('diff-push').click({}, cx);
  assert.deepEqual(actions.pop(), ['fetch', cx]);
  view.pushState.ahead = 3; view.pushFooter({});
  assert.ok(nodes.get('diff-push').children.includes('↑3 Push'));
  nodes.get('diff-push').click({}, cx);
  assert.deepEqual(actions.pop(), ['push', cx]);
  view.pushState.ahead = null; view.pushState.behind = null; view.pushState.upstream = 'none'; view.pushFooter({});
  assert.ok(nodes.get('diff-push').children.includes('Publish'));
  nodes.get('diff-push').click({}, cx);
  assert.deepEqual(actions.pop(), ['publish', cx]);
  view.pushState.upstream = 'gone'; view.pushFooter({});
  assert.ok(nodes.get('diff-push').children.includes('Republish'));
  nodes.get('diff-push').click({}, cx);
  assert.deepEqual(actions.pop(), ['republish', cx]);
  for (const key of ['fetch', 'fetch-from', 'pull', 'pull-rebase', 'push', 'push-to', 'push-tags', 'force-push']) {
    assert.ok(nodes.has(`diff-git-actions-${key}`));
  }
  nodes.get('diff-git-actions-push-tags').click({}, cx);
  assert.deepEqual(actions.pop(), ['push-tags', cx, undefined]);
  view.gitMenu.page = 'push-tags'; view.pushFooter({});
  nodes.get('diff-git-actions-remote:back').click({}, cx);
  assert.deepEqual(actions.pop(), ['push-tags', cx, 'back']);
  view.gitMenu.page = null; view.pushFooter({});
  nodes.get('diff-git-menu').click({}, cx);
  nodes.get('diff-git-actions-content').key({ key: 'down' }, cx);
  nodes.get('diff-git-actions-content').key({ key: 'enter' }, cx);
  assert.equal(view.gitMenu.page, 'fetch');
  assert.equal(actions.length, 0);
  assert.equal(view.gitMenu.open, true);
  view.pushFooter({});
  assert.ok(nodes.has('diff-git-actions-all'));
  nodes.get('diff-git-actions-remote:back').click({}, cx);
  assert.deepEqual(actions[0], ['fetch', cx, 'back']);
  view.gitMenu.page = null; view.pushFooter({});
  nodes.get('diff-git-actions-pull-rebase').click({}, cx);
  assert.deepEqual(actions[1], ['pull-rebase', cx, undefined]);
  view.pushState.branch = null; view.pushFooter({});
  nodes.get('diff-git-actions-push').click({}, cx);
  assert.equal(actions.length, 2);
  nodes.get('diff-git-actions-fetch').click({}, cx);
  assert.equal(actions.length, 3);
  view.pushResult = { message: 'fatal: authentication failed\nremote: details', failed: true };
  view.resultTitle = 'Push failed';
  showGitToast(view.context, view.resultTitle, true);
  painted.length = 0;
  view.render(view.context, cx);
  assert.equal(nodes.get('diff-git-footer').children.length, 1, 'Failures never expand the footer');
  assert.ok(!painted.includes('Push failed'), 'Git results are rendered outside the diff content');
  assert.ok(!painted.includes(view.pushResult.message), 'Raw Git output stays out of the notification');
  view.openLog(cx);
  assert.equal(memory['herdr-zed.git-result-toast'], null);
  assert.equal(editors[0].readonly, true);
  assert.equal(editors[0].value, view.pushResult.message);
  view.render(view.context, cx);
  assert.ok(nodes.has('git-output'));
  nodes.get('git-output-close').click({}, cx);
  assert.equal(editors[0].released, true);
  assert.equal(view.output, null);
  assert.equal(view.pushResult.failed, true, 'Dismissal retains the result');
  view.pushFooter({});
  // The shell's menu keeps Commit author; GitHub account comes from the git.actions catalog (see git-actions tests).
  nodes.get('diff-git-actions-commit-author').click({}, cx);
  assert.deepEqual(actions.at(-1), ['author', view.context]);
  assert.equal(accountSettings, undefined, 'Opening the commit author does not change any account');
});


test('push prevents duplicate actions, retains errors for retry and isolates project changes', async () => {
  const tasks = [], notices = [], calls = [];
  const memory = {};
  let complete;
  const { DiffViewer } = await load({ VirtualListScrollHandle: { new: () => ({}) },
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    notify: notice => notices.push(notice),
    exec: (cmd, args, options) => {
      if (args.includes('herdr-zed-push-state')) return Promise.resolve({ code: 0, stderr: '',
        stdout: `main\n${'a'.repeat(40)}\n0\t0\nrefs/remotes/origin/main\norigin\norigin\n` });
      if (args.includes('--no-patch')) return Promise.resolve({ code: 0, stderr: '', stdout: '' });
      calls.push({ cmd, args, options }); return new Promise(resolve => { complete = resolve; });
    } });
  const cx = { notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  const view = new DiffViewer(); view.init();
  view.context = { folder: '/project', machine: 'remote' };
  view.pushState = { branch: 'main', committed: true, remote: false, upstream: 'tracked', ahead: 3, behind: 0 };
  view.push(cx);
  assert.equal(calls.length, 0);
  view.pushState.remote = true;
  let reloads = 0;
  view.reload = () => { reloads++; };
  view.push(cx); view.push(cx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.on, 'remote');
  assert.deepEqual(calls[0].args.slice(-2), ['/project', 'push']);
  complete({ code: 1, stderr: 'authentication failed', stdout: '' });
  await Promise.all(tasks.splice(0));
  assert.equal(view.pushing, null);
  assert.equal(view.pushState.ahead, 0, 'Counts are refreshed before the button is re-enabled');
  assert.deepEqual(view.pushResult, { message: 'authentication failed', failed: true });
  assert.equal(memory['herdr-zed.git-result-toast'].title, 'Push failed');
  assert.equal(view.resultTitle, 'Push failed');
  assert.equal(notices.length, 0, 'The local toast does not duplicate a native notification');
  assert.equal(reloads, 1);
  view.push(cx);
  assert.equal(calls.length, 2);
  view.close(); view.context = { folder: '/another' }; view.pushResult = null;
  complete({ code: 0, stderr: '', stdout: '' });
  await Promise.all(tasks);
  assert.equal(view.pushResult, null);
  assert.equal(reloads, 1);
  assert.equal(notices[0].level, 'success');
});

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
    catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  } });
  const shellFolder = process.platform === 'win32' ? folder.replaceAll('\\', '/') : folder;
  const { files, truncated } = await readDiff(shellFolder, 'box');
  assert.equal(truncated, false);
  assert.deepEqual(files.map(file => [file.path, file.status, file.added, file.removed, file.untracked]),
    [['a.txt', 'modified', 1, 1, false], ['drop.txt', 'deleted', 0, 1, false], ['moved.txt', 'renamed', 0, 0, false], ['新檔 $(touch X).txt', 'added', 1, 0, true]]);
  const subfolder = join(folder, 'nested');
  await mkdir(subfolder);
  const nested = await readDiff(subfolder.replaceAll('\\', '/'), 'box');
  assert.deepEqual(nested.files.map(file => [file.path, file.hunks]), files.map(file => [file.path, file.hunks]),
    'Projects inside a repository resolve tracked and untracked paths from the Git root');
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
  assert.ok(!affectsDiff('\\.git\\index') && !affectsDiff('\\.git\\objects\\ab\\cd'));
  assert.ok(affectsDiff('\\.git\\HEAD') && affectsDiff('\\.git\\refs\\heads\\main') && affectsDiff('\\src\\main.js'));
});

test('History previews reuse the diff renderer without replacing working changes', async () => {
  const { DiffViewer, parseDiff } = await load({ shared: () => undefined,
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) } });
  const view = new DiffViewer(); view.init();
  const patch = name => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, '@@ -1 +1 @@', '-old', '+new'].join('\n');
  const working = view.files = parseDiff(patch('working.txt'));
  assert.equal(view.rows().rows[0].file.path, 'working.txt');
  const files = view.history.parsePreview(patch('committed.txt'));
  view.history.preview = { commit: { sha: 'a'.repeat(40) }, files };
  const cx = { notify() {} };
  view.setPanelTab('history', cx);
  assert.equal(view.rows().rows[0].file.path, 'working.txt');
  view.history.onSelect();
  assert.equal(view.rows().rows[0].file.path, 'committed.txt');
  assert.equal(view.files, working);
  view.setPanelTab('changes', cx);
  assert.equal(view.rows().rows[0].file.path, 'committed.txt');
  view.showChanges(cx);
  assert.equal(view.rows().rows[0].file.path, 'working.txt');
  assert.equal(view.history.preview.files, files);
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

test('large hunks bound pairing by the remaining display rows', async () => {
  let layout;
  const { pairLines, DiffViewer } = await load({ shared: () => layout });
  const del = { type: 'del', old: 1, text: 'old' }, add = { type: 'add', new: 1, text: 'new' };
  let reads = 0;
  const lines = new Proxy(Array(1000000).fill(add), {
    get(target, key) { if (/^\d+$/.test(String(key))) reads++; return target[key]; },
  });
  assert.deepEqual(pairLines(lines, 2), [{ left: null, right: add }, { left: null, right: add }]);
  assert.ok(reads < 20, 'Pairing must not traverse a million additions to display two rows');
  assert.deepEqual(pairLines([del, del, del, add, add, add], 2),
    [{ left: del, right: add }, { left: del, right: add }]);
  assert.deepEqual(pairLines([del, add], 0), []);

  // A preceding file can exhaust almost all of the shared multibuffer budget.
  const view = new DiffViewer(); view.collapsed = new Set();
  view.files = [
    { path: 'first', hunks: [{ lines: Array(9997).fill({ type: 'ctx', text: '' }) }] },
    { path: 'large', hunks: [{ lines }] },
  ];
  for (layout of ['unified', 'split']) {
    reads = 0; view.rowCache = null;
    assert.equal(view.rows().rows.length, 10000);
    assert.equal(view.rows().limited, true);
    assert.ok(reads < 20, 'Rows must pass the remaining budget into pairing');
  }
});

test('large diffs render within the native item_sizes limit in both layouts, with and without wrapping', async () => {
  const memory = {}, lists = [], labels = [];
  const element = () => {
    const el = new Proxy({}, { get(_target, key) {
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      return (...args) => { if (key === 'child' && typeof args[0] === 'string') labels.push(args[0]); return el; };
    } });
    return el;
  };
  const { DiffViewer } = await load({
    div: element, svg: element, h_flex: element, v_flex: element, Button: element, ToolbarButton: element,
    Popup: { new: element }, Scrollbar: { vertical: element },
    VirtualListScrollHandle: { new: () => ({}) }, theme: () => ({}), settings: () => ({}),
    shared: key => memory[key],
    v_virtual_list(id, count, sizes, getKey, render) {
      assert.ok(sizes.length <= 10000, 'item_sizes may contain at most 10000 entries');
      assert.equal(sizes.length, count);
      assert.equal(typeof getKey(count - 1), 'string');
      assert.equal(render({ start: count - 1, end: count }).length, 1);
      lists.push(count);
      return element();
    },
  });
  const view = new DiffViewer(); view.init(); view.context = { id: 'project', folder: '/project' };
  view.panel = element; view.width = 216; view.charWidth = 8;
  for (const layout of ['unified', 'split']) for (const wrap of [true, false]) {
    memory['herdr-zed.diff-layout'] = layout; memory['herdr-zed.diff-wrap'] = wrap;
    // Include the file header in the boundary; wrapped lines add more visual rows.
    for (const count of [9999, 10000, 10001]) {
      view.files = [{ path: 'large', hunks: [{ lines: Array(count - 1).fill({ type: 'ctx', text: 'x'.repeat(60) }) }] }];
      view.rowCache = null; labels.length = 0;
      const rows = view.rows();
      view.render(view.context, {}, true);
      assert.equal(lists.at(-1), wrap ? 10000 : Math.min(count, 10000));
      assert.equal(rows.limited, wrap || count > 10000);
      assert.equal(labels.includes('Diff limited to 4 MB and 10,000 rows.'), rows.limited);
    }
  }
  assert.equal(lists.length, 12);
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

test('native row builds yield, preserve the last frame and discard obsolete work', async () => {
  const { DiffViewer } = await load();
  const tasks = [], waits = [], scrolled = [];
  let notifications = 0;
  const cx = {
    notify() { notifications++; },
    sleep() { return new Promise(resolve => waits.push(resolve)); },
    spawn(fn) { tasks.push(fn(cx)); return { cancel() {} }; },
  };
  const view = new DiffViewer();
  view.collapsed = new Set(); view.width = 200; view.charWidth = 8;
  view.scroll = { scroll_to_item: (...args) => scrolled.push(args) };
  view.files = [{ path: 'a', hunks: [{ lines: Array.from({ length: 100 }, (_, i) =>
    ({ type: 'ctx', old: i + 1, new: i + 1, text: 'a long source line '.repeat(20) })) }] }];
  assert.equal(view.rows(cx).rows.length, 0);
  assert.equal(tasks.length, 1);
  assert.equal(view.rowCache, undefined, 'Render must not synchronously build rows');
  view.rows(cx);
  assert.equal(tasks.length, 1, 'Renders share the pending build');
  const drain = async () => {
    let batches = 0;
    while (waits.length) {
      waits.shift()(); await Promise.resolve();
      assert.ok(++batches < 1000);
    }
    await Promise.all(tasks.splice(0));
    return batches;
  };
  assert.ok(await drain() > 10, 'Large builds must yield between batches');
  const first = view.rows(cx);
  assert.ok(first.rows.length > 100);
  assert.equal(notifications, 1);
  view.width = 500;
  assert.equal(view.rows(cx), first, 'Keep the last completed frame during a resize');
  const obsolete = view.rowJob;
  view.width = 800;
  view.rows(cx);
  assert.notEqual(view.rowJob, obsolete);
  view.pendingReveal = 'a';
  await drain();
  assert.equal(view.rowCache.width, 800);
  assert.equal(notifications, 2, 'Obsolete builds must not publish a frame');
  assert.deepEqual(scrolled, [[0, 'top']]);
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
  const b = rows.findIndex(row => row.key === 'file:b');
  assert.deepEqual(scrolled, [[b, 'top']], 'An unmeasured viewport cannot be scrolled past');
  view.files = [{ path: 'huge', hunks: [{ lines: Array.from({ length: 25 }, () => ({ type: 'ctx', text: 'x'.repeat(2000) })) }] }];
  view.width = 72; view.rowCache = null;
  assert.equal(view.rows().rows.length, 10000);
  assert.equal(view.rows().limited, true);
});

test('Wrap preference preserves full lines, highlights and horizontal extent in both diff layouts', async () => {
  const memory = {};
  const { DiffViewer, parseDiff } = await load({ shared: key => memory[key],
    setShared: (key, value) => { memory[key] = value; },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) } });
  const view = new DiffViewer(); view.init(); view.width = 216; view.charWidth = 8;
  const old = 'prefix ' + '中'.repeat(60) + ' old', next = 'prefix ' + '中'.repeat(60) + ' new';
  view.files = parseDiff(['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '-' + old, '+' + next].join('\n'));
  const cx = { notify() {} };
  assert.equal(view.wrap, true);
  assert.ok(view.rows().rows.length > 3);
  view.toggleWrap(cx);
  assert.equal(memory['herdr-zed.diff-wrap'], false);
  const unified = view.rows();
  assert.deepEqual(unified.rows.filter(row => row.kind === 'line').map(row => row.line.text), [old, next]);
  assert.ok(unified.contentWidth >= (7 + 120 + 4) * 8 + unified.gutter + 24, 'Wide glyphs must be reachable by horizontal scrolling');
  assert.equal(unified.rows[2].line.new, 1);
  assert.equal(unified.rows[2].line.text.slice(...unified.rows[2].line.marks), 'new');
  view.setLayout('split', cx);
  const split = view.rows();
  assert.equal(split.rows.length, 2);
  assert.equal(split.rows[1].left.text, old);
  assert.equal(split.rows[1].right.text, next);
  assert.equal(split.contentWidth, unified.contentWidth * 2 + 1);
  view.width = 4000;
  assert.equal(view.rows().contentWidth, 4000, 'Short lines must still fill the viewport');
  view.width = 216;
  view.panelTab = 'history'; view.previewMode = true; view.history.preview = { files: view.files };
  assert.equal(view.rows().rows.length, 2);
  const reopened = new DiffViewer(); reopened.init();
  assert.equal(reopened.wrap, false);
  view.toggleWrap(cx);
  assert.ok(view.rows().rows.length > 2);
  assert.equal(view.rows().contentWidth, 216);
});

test('changed files group as Tracked then Untracked, matching the multibuffer, and jump to an expanded header', async () => {
  const scrolled = [];
  const { DiffViewer, parseDiff, changeSections, changeTree } = await load({ shared: () => undefined, setShared() {},
    VirtualListScrollHandle: { new: () => ({ scroll_to_item: (...args) => scrolled.push(args) }) } });
  const header = path => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  const files = parseDiff([...header('src/b.js'), 'herdr-zed-untracked-files', ...header('a.md'), ...header('src/lib/c.js')].join('\n'));
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
  view.viewportHeight = 40;
  view.reveal('src/lib/c.js', { notify() {} });
  assert.deepEqual(scrolled, [[4, 'top'], [3, 'top']], 'A header first scrolls past the top, then aligns to it from above');
  scrolled.length = 0; view.visible = { rows: view.rows().rows, start: 4 };
  view.reveal('src/lib/c.js', { notify() {} });
  assert.deepEqual(scrolled, [[3, 'top']], 'A header above the viewport aligns in one step');
  assert.equal(view.selected, 'src/lib/c.js');
  view.reveal('a.md', { notify() {} });
  assert.ok(!view.collapsed.has('a.md'));
});

test('List and Tree menu choices persist and preserve selection, collapsed folders and the diff cache', async () => {
  const memory = {}, nodes = new Map(), treeRows = [], scrolled = [];
  const element = () => {
    const data = {};
    const el = new Proxy(data, { get(target, key) {
      if (key in target) return target[key];
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      return (...args) => {
        if (key === 'id') nodes.set(args[0], data);
        if (key === 'on_click' || key === 'on_item_click') data.click = args[0];
        return el;
      };
    } });
    return el;
  };
  const { DiffViewer, parseDiff } = await load({ div: element, svg: element, h_flex: element, v_flex: element,
    Button: id => element().id(id), ToolbarButton: id => element().id(id), Popup: { new: id => element().id(id) },
    TreeItem: (id, depth, selected) => { treeRows.push({ id, depth, selected }); return element().id(id); },
    TreeItemIcon: element, TreeItemLabel: element, GitStatusColor: {},
    v_virtual_list: (id, count, _sizes, _key, render) => { render({ start: 0, end: count }); return element().id(id); },
    Scrollbar: { vertical: element }, theme: () => ({}), settings: () => ({}),
    VirtualListScrollHandle: { new: () => ({ scroll_to_item: (...args) => scrolled.push(args) }) },
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; } });
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }) };
  const view = new DiffViewer(); view.init(cx); view.loaded = true;
  view.context = { id: 'project', folder: '/project' };
  const patch = name => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n`;
  view.files = parseDiff(patch('src/deep/a.js') + patch('Cargo.lock') + 'herdr-zed-untracked-files\n' + patch('new/b.js'));
  view.selected = 'src/deep/a.js'; view.folders.add('Tracked:src/deep');
  const cache = view.rows();
  assert.equal(view.fileView, 'tree');
  view.render(view.context, cx);
  assert.ok(treeRows.some(row => row.id === 'diff-tree-Tracked:src/deep'));
  assert.ok(!treeRows.some(row => row.id === 'diff-tree-src/deep/a.js'));
  assert.ok(nodes.has('diff-files-toolbar'));
  assert.ok(nodes.has('diff-view'));
  let opened = 0; view.onOpen = () => { opened++; };
  nodes.get('diff-view').click({}, cx); assert.equal(opened, 1);
  assert.ok(!nodes.has('diff-options-list'));
  nodes.get('diff-file-view-trigger').click({}, cx);
  assert.equal(view.fileViewMenu.open, true);
  nodes.get('diff-file-view-list').click({}, cx);
  assert.equal(view.fileViewMenu.open, false);
  assert.equal(memory['herdr-zed.diff-file-view'], 'list');
  assert.equal(view.selected, 'src/deep/a.js');
  assert.equal(view.rows(), cache);
  assert.deepEqual(scrolled, []);
  treeRows.length = 0; view.render(view.context, cx);
  assert.deepEqual(treeRows.filter(row => row.id.startsWith('diff-tree-')), [
    { id: 'diff-tree-Cargo.lock', depth: 1, selected: false },
    { id: 'diff-tree-src/deep/a.js', depth: 1, selected: true },
    { id: 'diff-tree-new/b.js', depth: 1, selected: false },
  ]);
  nodes.get('diff-files-list').click('file:new/b.js', cx);
  assert.equal(view.selected, 'new/b.js');
  assert.ok(scrolled.length > 0);
  const reopened = new DiffViewer(); reopened.init(cx);
  assert.equal(reopened.fileView, 'list');
  nodes.get('diff-file-view-tree').click({}, cx);
  assert.equal(view.fileView, 'tree');
  assert.ok(view.folders.has('Tracked:src/deep'));
  assert.equal(view.selected, 'new/b.js');
  assert.equal(view.rows(), cache);
  nodes.clear(); view.panelTab = 'history'; view.previewMode = true; view.history.render = element;
  view.render(view.context, cx);
  assert.ok(!nodes.has('diff-files-toolbar'));
  assert.ok(!nodes.has('diff-file-view-trigger'));
});

test('reloads keep the shown diff and skip repainting until git diff output changes', async () => {
  let text = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '-x', '+y'].join(String.fromCharCode(10));
  const { DiffViewer } = await load({ shared: () => undefined, setShared() {},
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    exec: async (_cmd, args) => ({ code: 0, stdout: args.includes('herdr-zed-diff-index') ? indexFor('a') : args.includes('herdr-zed-diff-file') ? text : '', stderr: '' }) });
  const tasks = [];
  let notified = 0;
  const cx = { notify() { notified++; }, spawn(fn) { tasks.push(fn(cx)); } };
  const drain = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  const view = new DiffViewer(); view.init(); view.context = { folder: '/p' };
  view.reload(cx); await drain();
  const files = view.files;
  assert.equal(notified, 2, 'Publish the file index before the first patch finishes');
  view.reload(cx); await drain();
  assert.equal(view.files, files);
  assert.equal(notified, 2);
  text += String.fromCharCode(10) + '+z';
  view.reload(cx); await drain();
  assert.notEqual(view.files, files);
  assert.equal(notified, 3);
});

test('project initialization yields before watchers, Git reads and History notifications', async () => {
  const { DiffViewer } = await load({ VirtualListScrollHandle: { new: () => ({}) }, exec: async () => ({ code: 0, stdout: '.\0' }) });
  const tasks = [], waits = [], started = [];
  let rendering = true;
  const cx = {
    spawn(fn) { tasks.push(fn(cx)); },
    sleep() { return new Promise(resolve => waits.push(resolve)); },
    notify() { assert.equal(rendering, false, 'Cannot notify while rendering'); },
  };
  const view = new DiffViewer(); view.init(); view.panelTab = 'history'; view.previewMode = true;
  view.observe = () => started.push(['watch', view.context.folder]);
  view.reload = () => started.push(['diff', view.context.folder]);
  view.history.load = cx => { cx.notify(); started.push(['history', view.context.folder]); };
  // Includes a folder without Git: initialization must not depend on a successful read.
  view.refresh({ id: 'plain', folder: '/plain-folder' }, cx);
  assert.deepEqual(started, [], 'First render must only schedule initialization');
  view.refresh({ id: 'repo', folder: '/repo' }, cx);
  rendering = false;
  waits.splice(0).forEach(resolve => resolve());
  await Promise.all(tasks.splice(0));
  assert.deepEqual(started, [['watch', '/repo'], ['diff', '/repo'], ['history', '/repo']]);
  rendering = true;
  view.refresh({ id: 'plain', folder: '/plain-folder' }, cx);
  view.close(); rendering = false;
  waits.splice(0).forEach(resolve => resolve());
  await Promise.all(tasks);
  assert.equal(started.length, 3, 'Closing before the task resumes must discard initialization');
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
    VirtualListScrollHandle: { new: () => ({}) }, exec: async (_cmd, args) => ({ code: 0, stdout: args.includes('herdr-zed-diff-index') ? indexFor('a.js') : args.includes('herdr-zed-diff-file') ? text : '' }) });
  const tasks = [], cx = { notify() {}, sleep: async () => {}, spawn(fn) { tasks.push(fn(cx)); } };
  const view = new DiffViewer(); view.init(); view.observe = () => {};
  view.refresh({ id: 'project', folder: '/project' }, cx);
  while (tasks.length) await Promise.all(tasks.splice(0));
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

test('Git Graph opens in the editor, reuses loaded commit changes and returns to the preserved working diff', async () => {
  const patch = name => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`;
  const graphs = [];
  class Graph {
    constructor(_cx, parser) { this.parser = parser; this.focus = { focus() {} }; graphs.push(this); }
    reset(context) { this.context = context; }
    load() { this.loads = (this.loads || 0) + 1; }
  }
  const { DiffViewer, parseDiff } = await load({ GitGraph: Graph,
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) } });
  const cx = { notify() {} }, view = new DiffViewer(); view.init(cx);
  view.context = { folder: '/repo' }; view.files = parseDiff(patch('working.txt'));
  const working = view.files;
  view.openGraph(cx);
  const graph = graphs[0];
  assert.equal(view.graphMode, true); assert.equal(graph.context.folder, '/repo');
  assert.equal(graph.fileRows(working)[0].path, 'working.txt');
  const commit = { sha: 'c'.repeat(40), shortSha: 'ccccccc' }, files = parseDiff(patch('committed.txt'));
  view.history.pending = 'old'; const selection = view.history.selection;
  graph.onOpen(commit, cx, 'committed.txt', { commit, files });
  assert.equal(view.graphMode, false); assert.equal(view.graphReturn, true);
  assert.equal(view.history.selection, selection + 1); assert.equal(view.history.pending, null);
  assert.equal(view.history.preview.files, files); assert.equal(view.pendingReveal, 'committed.txt');
  assert.deepEqual(view.displayFiles, files); assert.equal(view.files, working);
  view.openGraph(cx); assert.equal(graphs.length, 1); assert.equal(graph.loads, 2);
  view.showChanges(cx); assert.equal(view.graphMode, false); assert.deepEqual(view.displayFiles, working);
  view.close(); assert.equal(graph.context, null); assert.equal(view.graphReturn, false);
});

test('commit descriptions start folded, expand on demand and leave single-line messages without a disclosure', async () => {
  const nodes = new Map();
  const element = () => {
    const state = { children: [], styles: {} };
    const el = new Proxy(state, { get(_target, key) {
      if (key in state) return state[key];
      if (key === 'when') return (condition, fn) => { if (condition) fn(el); return el; };
      if (key === 'child') return value => { state.children.push(value); return el; };
      if (key === 'id') return id => { nodes.set(id, state); return el; };
      if (key === 'on_click') return fn => { state.click = fn; return el; };
      return (...args) => { state.styles[key] = args; return el; };
    } }); return el;
  };
  const { DiffViewer } = await load({ div: element, v_flex: element, h_flex: element, svg: element,
    Button: id => element().id(id), ToolbarButton: id => element().id(id), VirtualListScrollHandle: { new: () => ({}) } });
  const view = new DiffViewer(); view.init();
  const commit = { sha: 'a'.repeat(40), author: 'Author', at: 1700000000, message: 'Subject\n\nLong description\nSecond line' };
  const render = current => { nodes.clear(); view.commitHeader({ commit: current }, {}); };
  const cx = { notify() {} };
  render(commit);
  assert.deepEqual(nodes.get('commit-description').children, ['Subject']);
  assert.deepEqual(nodes.get('commit-description').styles.h, [20]);
  assert.ok(nodes.has('commit-description-toggle'));
  nodes.get('commit-description-toggle').click({}, cx); render(commit);
  assert.deepEqual(nodes.get('commit-description').children, [commit.message]);
  assert.deepEqual(nodes.get('commit-description').styles.max_h, [240]);
  assert.ok(nodes.get('commit-description').styles.overflow_y_scrollbar);
  render({ ...commit, sha: 'b'.repeat(40) });
  assert.deepEqual(nodes.get('commit-description').children, ['Subject']);
  render(commit); nodes.get('commit-description-toggle').click({}, cx); render(commit);
  assert.deepEqual(nodes.get('commit-description').children, ['Subject']);
  render({ ...commit, message: 'Single line' });
  assert.equal(nodes.has('commit-description-toggle'), false);
  view.expandedCommitMessage = commit.sha; view.close();
  assert.equal(view.expandedCommitMessage, null);
});

test('each commit tab retains its scroll handle and pending commit tabs never display working changes', async () => {
  let serial = 0;
  const { DiffViewer } = await load({ VirtualListScrollHandle: { new: () => ({ serial: ++serial, scroll_to_item() {} }) } });
  const view = new DiffViewer(); view.init();
  const cx = { notify() {} }, a = { sha: 'a'.repeat(40), at: 1700000000 }, b = { sha: 'b'.repeat(40), at: 1700000000 };
  const workingScroll = view.scroll;
  view.openCommit(a, cx, { commit: a, files: ['A'] }); const aScroll = view.scroll;
  view.openCommit(b, cx, { commit: b, files: ['B'] }); const bScroll = view.scroll;
  assert.notEqual(aScroll, bScroll);
  view.openCommit(a, cx, { commit: a, files: ['A'] }); assert.equal(view.scroll, aScroll);
  view.showChanges(cx); assert.equal(view.scroll, workingScroll);
  view.history.pending = b.sha;
  view.openCommit(b, cx);
  assert.equal(view.previewMode, true); assert.equal(view.graphMode, false);
  assert.equal(view.commitPreview.commit.sha, b.sha); assert.equal(view.commitPreview.pending, true);
  assert.deepEqual(view.displayFiles, []);
});

test('Git Graph entry is in the latest-commit row below Git actions and absent from the Changes/History tab bar', async () => {
  const nodes = new Map();
  const element = () => {
    const state = { items: [] };
    const el = new Proxy(state, { get(_target, key) {
      if (key in state) return state[key];
      if (key === 'when') return (condition, fn) => { if (condition) fn(el); return el; };
      if (key === 'id') return id => { nodes.set(id, el); return el; };
      if (key === 'child') return child => { state.items.push(child); return el; };
      if (key === 'children') return children => { state.items.push(...children); return el; };
      return () => el;
    } }); return el;
  };
  const { DiffViewer } = await load({ div: element, h_flex: element, v_flex: element, svg: element,
    Button: id => element().id(id), ToolbarButton: id => element().id(id), Popup: { new: element }, VirtualListScrollHandle: { new: () => ({}) } });
  const view = new DiffViewer(); view.init(); view.pushFooter = () => element().id('git-actions');
  view.latestCommit = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'Latest commit' };
  const panel = view.panel({});
  assert.ok(nodes.get('git-latest-commit').items.includes(nodes.get('git-open-graph')));
  assert.ok(panel.items.indexOf(nodes.get('git-actions')) < panel.items.indexOf(nodes.get('git-latest-commit')));
  nodes.clear(); view.panelTab = 'history'; view.history.render = element; view.panel({});
  assert.equal(nodes.has('git-open-graph'), false);
  assert.equal(nodes.has('git-actions'), false, 'History has no branch or remote-action footer');
  nodes.clear(); view.panelTab = 'changes'; view.panel({});
  assert.ok(nodes.has('git-actions'), 'Returning to Changes restores Git actions');
});

test('patch parsing yields and bounds allocations before a million short lines or oversized tab expansion', async () => {
  const { parseDiffBatches, parseDiff } = await load();
  const patch = 'diff --git a/large b/large\n--- /dev/null\n+++ b/large\n@@ -0,0 +1,1000000 @@\n' + '+\n'.repeat(1000000);
  let slices = 0;
  const source = { length: patch.length, indexOf: (...args) => patch.indexOf(...args),
    slice: (...args) => { slices++; return patch.slice(...args); }, split() { assert.fail('Do not split the entire patch'); } };
  const parser = parseDiffBatches(source);
  let next, batches = 0;
  do { next = parser.next(); batches++; } while (!next.done);
  assert.equal(next.value[0].hunks[0].lines.length, 10000);
  assert.equal(next.value.truncated, true);
  assert.ok(batches > 70);
  assert.ok(slices < 10100, 'Stop scanning as soon as the source-row budget is exhausted');
  const long = parseDiff('diff --git a/tabs b/tabs\n--- /dev/null\n+++ b/tabs\n@@ -0,0 +1 @@\n+' + '\t'.repeat(2000000));
  assert.ok(long[0].hunks[0].lines[0].text.length < 2010);
  const headers = parseDiff('diff --git a/a b/a\n' + '@@ -0,0 +0,0 @@\n'.repeat(100000));
  assert.equal(headers.truncated, true);
  assert.ok(headers[0].hunks.length < 10000, 'Empty hunks have an allocation budget too');
});

test('NUL-delimited change metadata preserves unusual paths, rename pairs, binary and untracked files', async () => {
  const { parseDiffIndex } = await load();
  const base = 'b'.repeat(40), old = 'old\tname\n.txt', path = 'new\tname\n.txt';
  const index = parseDiffIndex(`${base}\0/repo\0:100644 100644 abc def R100\0${old}\0${path}\0`
    + ':100644 100644 abc def M\0binary\0' + `2\t3\t\0${old}\0${path}\0-\t-\tbinary\0\0新檔 $(literal)\0`);
  assert.equal(index.base, base); assert.equal(index.truncated, false);
  assert.deepEqual(index.files.map(file => [file.path, file.oldPath, file.status, file.added, file.removed, file.binary, file.untracked]),
    [['binary', 'binary', 'modified', 0, 0, true, false], [path, old, 'renamed', 2, 3, false, false],
      ['新檔 $(literal)', null, 'added', 0, 0, false, true]]);
  assert.throws(() => parseDiffIndex('bad revision\0'), /revision/);
});

test('ordered file loads publish small batches, skip hidden lockfiles and stop immediately when obsolete', async () => {
  const calls = [], progress = [], paths = ['a', 'b', 'c', 'd', 'e', 'yarn.lock'];
  let cancelled = false, yields = 0;
  const index = 'a'.repeat(40) + '\0/repo\0' + paths.map(path => `:100644 100644 abc def M\0${path}\0`).join('')
    + paths.map(path => `1\t1\t${path}\0`).join('') + '\0';
  const { readDiff } = await load({ exec: async (_cmd, args) => {
    if (args.includes('herdr-zed-diff-index')) return { code: 0, stdout: index };
    const path = args[6]; calls.push(path);
    return { code: 0, stdout: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n` };
  } });
  const options = { yield: async () => { yields++; }, cancelled: () => cancelled,
    include: file => file.path !== 'yarn.lock', progress: files => progress.push(files.filter(file => !file.deferred).length) };
  const first = await readDiff('/repo', null, options);
  assert.deepEqual(calls, paths.slice(0, 5)); assert.deepEqual(progress, [4]);
  assert.ok(yields > 10); assert.equal(first.truncated, false);
  assert.equal(first.files.at(-1).deferred, true);
  const unchanged = await readDiff('/repo', null, { ...options, previous: first.files });
  assert.equal(unchanged.files, first.files, 'Reuse unchanged parsed buffers and filtered metadata');
  calls.length = 0; cancelled = true;
  assert.equal(await readDiff('/repo', null, options), null);
  assert.deepEqual(calls, [], 'Do not start any per-file read for an abandoned project');
});

test('Git caps short-line and huge-line responses before transfer and can prioritize a later file', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'herdr-zed-large-diff-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await run('git', ['init', '-q', folder]);
  await writeFile(join(folder, 'a-short'), 'x\n'.repeat(200000));
  await writeFile(join(folder, 'z-small'), 'last\n');
  const responses = [];
  const { readDiff } = await load({ exec: async (cmd, args) => {
    const result = await run(cmd, args, { maxBuffer: 5 * 1024 * 1024 });
    if (args.includes('herdr-zed-diff-file')) responses.push({ path: args[6], bytes: Buffer.byteLength(result.stdout), lines: result.stdout.split('\n').length });
    return { code: 0, ...result };
  } });
  const path = folder.replaceAll('\\', '/');
  const first = await readDiff(path);
  assert.equal(first.truncated, true);
  assert.equal(first.files[0].hunks[0].lines.length, 10000);
  assert.equal(first.files[1].deferred, true);
  assert.ok(responses[0].lines < 10100);
  const later = await readDiff(path, null, { priority: 'z-small' });
  assert.equal(later.files[1].deferred, false);
  assert.equal(later.files[1].hunks[0].lines[0].text, 'last');
  await rm(join(folder, 'a-short'));
  await writeFile(join(folder, 'huge-line'), 'x'.repeat(5000000));
  responses.length = 0;
  const huge = await readDiff(path);
  assert.equal(huge.truncated, true);
  assert.ok(responses.every(response => response.bytes <= 4000001));
  assert.ok(huge.files.find(file => file.path === 'huge-line').hunks[0].lines[0].text.length < 2010);
});

test('failed refreshes retain the last successful diff and closing releases its row snapshots', async () => {
  let failed = false;
  const { DiffViewer } = await load({ VirtualListScrollHandle: { new: () => ({}) }, exec: async (_cmd, args) => {
    if (failed) throw new Error('Read failed');
    return { code: 0, stdout: args.includes('herdr-zed-diff-index') ? indexFor('a') : args.includes('herdr-zed-diff-file')
      ? 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n' : '' };
  } });
  const tasks = [], cx = { notify() {}, sleep: async () => {}, spawn(fn) { tasks.push(fn(cx)); } };
  const drain = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  const view = new DiffViewer(); view.init(); view.context = { folder: '/repo' };
  view.reload(cx); await drain(); const files = view.files, rows = view.rows();
  failed = true; view.reload(cx); await drain();
  assert.equal(view.files, files); assert.equal(view.rows(), rows); assert.match(view.error, /Read failed/);
  view.visibleRows = rows; view.visible = { rows: rows.rows, start: 0 };
  view.close();
  assert.deepEqual(view.files, []); assert.equal(view.rowCache, null);
  assert.equal(view.visibleRows, null); assert.equal(view.visible, null); assert.equal(view.treeCache, null);
});

test('large Changes panels build native elements only for visible files and dispatch through the list', async () => {
  let list, painting = false, painted = 0;
  const nodes = new Map();
  const element = () => {
    const proxy = new Proxy({}, { get(_target, key) {
      if (painting && key.startsWith('on_')) assert.fail('Deferred rows must not retain input callbacks');
      if (key === 'when') return (condition, fn) => { if (condition) fn(proxy); return proxy; };
      return (...args) => { if (key === 'id') nodes.set(args[0], proxy); return proxy; };
    } }); return proxy;
  };
  const { DiffViewer } = await load({ div: element, svg: element, v_flex: element, h_flex: element,
    Button: element, ToolbarButton: element, Popup: { new: element }, TreeItem: () => { painted++; return element(); },
    TreeItemIcon: element, TreeItemLabel: element, GitStatusColor: {}, Scrollbar: { vertical: element },
    VirtualListScrollHandle: { new: () => ({}) },
    v_virtual_list: (id, count, sizes, key, render) => { list = { id, count, sizes, key, render }; return element(); } });
  const view = new DiffViewer(); view.init(); view.pushFooter = element;
  view.files = Array.from({ length: 12000 }, (_, i) => ({ path: `src/${i}.js`, added: 1, removed: 1, status: 'modified', hunks: [] }));
  view.panel({});
  assert.equal(painted, 0); assert.equal(list.id, 'diff-files-list');
  assert.equal(list.count, 12002); assert.equal(list.sizes, 28);
  painting = true;
  assert.equal(list.render({ start: 10000, end: 10020 }).length, 20);
  assert.equal(painted, 20);
  assert.ok(list.key(10000).startsWith('file:src/'));
});

test('selecting a file beyond the visual-row cap brings its header and contents into the preview', async () => {
  const { DiffViewer } = await load({ VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) } });
  const view = new DiffViewer(); view.init();
  view.files = [
    { path: 'first', hunks: [{ lines: Array(10000).fill({ type: 'add', new: 1, text: 'x' }) }] },
    { path: 'last', hunks: [{ lines: [{ type: 'add', new: 1, text: 'last line' }] }] },
  ];
  assert.ok(!view.rows().rows.some(row => row.key === 'file:last'));
  view.reveal('last', { notify() {} });
  assert.equal(view.rows().rows[0].key, 'file:last');
  assert.equal(view.rows().rows[1].line.text, 'last line');
  assert.equal(view.rows().limited, true);
});

test('async parser cancellation and clearing a pending row build cannot republish stale buffers', async () => {
  const { DiffViewer, parseDiffAsync } = await load();
  let sleeps = 0;
  const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1,10000 @@\n' + '+x\n'.repeat(10000);
  const parsed = await parseDiffAsync(patch, { sleep: async () => { sleeps++; } }, () => sleeps > 2);
  assert.equal(parsed, null); assert.equal(sleeps, 3);
  const waits = [], tasks = [], cx = { notify() {}, sleep: () => new Promise(resolve => waits.push(resolve)),
    spawn(fn) { tasks.push(fn(cx)); return { cancel() {} }; } };
  const view = new DiffViewer(); view.collapsed = new Set();
  view.files = [{ path: 'old', hunks: [{ lines: [{ type: 'add', text: 'old' }] }] }];
  view.rows(cx); view.files = [];
  assert.equal(view.rows(cx).rows.length, 0);
  waits.splice(0).forEach(resolve => resolve()); await Promise.all(tasks);
  assert.equal(view.rowCache.rows.length, 0); assert.equal(view.visibleRows.rows.length, 0);
  assert.equal(view.rowJob, null);
});

test('UTF-8 budgets and Git quoted paths work without browser encoding globals', async () => {
  const { utf8ByteLength, parseDiff } = await load();
  for (const text of ['', 'ASCII\t\n', '中文é', '🙂e\u0301', '\ud800x\udc00', 'a' + '🙂'.repeat(10000)]) {
    assert.equal(await utf8ByteLength(text), Buffer.byteLength(text));
  }
  let pauses = 0;
  await utf8ByteLength('a' + '🙂'.repeat(10000), async () => { pauses++; });
  assert.ok(pauses >= 3, 'Surrogate pairs crossing chunk boundaries must still yield');
  const quoted = String.raw`"b/\344\270\255\346\226\207.txt"`;
  const files = parseDiff(`diff --git a/name b/name\n--- a/name\n+++ ${quoted}\n@@ -1 +1 @@\n-old\n+new\n`);
  assert.equal(files[0].path, '中文.txt');
});

test('the Changes index appears before a blocked first patch or branch-state read finishes', async () => {
  let finishPatch, finishState, notices = 0;
  const { DiffViewer } = await load({ VirtualListScrollHandle: { new: () => ({}) }, exec: async (_cmd, args) => {
    if (args.includes('herdr-zed-diff-index')) return { code: 0, stdout: indexFor('a') };
    if (args.includes('herdr-zed-diff-file')) return new Promise(resolve => { finishPatch = resolve; });
    return new Promise(resolve => { finishState = resolve; });
  } });
  const tasks = [], cx = { notify() { notices++; }, sleep: async () => {}, spawn(fn) { tasks.push(fn(cx)); } };
  const view = new DiffViewer(); view.init(); view.context = { folder: '/repo' };
  view.reload(cx);
  for (let turn = 0; turn < 100 && !finishPatch; turn++) await Promise.resolve();
  assert.equal(typeof finishPatch, 'function'); assert.equal(typeof finishState, 'function');
  assert.equal(view.indexLoaded, true); assert.equal(view.loaded, undefined);
  assert.deepEqual(view.files.map(file => file.path), ['a']);
  assert.equal(view.files[0].deferred, true); assert.equal(notices, 1);
  finishPatch({ code: 0, stdout: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n' });
  finishState({ code: 0, stdout: '' });
  await Promise.all(tasks);
  assert.equal(view.files[0].deferred, false); assert.equal(view.loaded, true);
});

test('Git menu lists git.actions providers, opens them with the repository context and reports a bad credential binding once', async () => {
  const nodes = new Map(), opened = [], notices = [], painted = [];
  const element = () => {
    const data = { children: [] };
    const el = new Proxy(data, { get(target, key) {
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      return (...args) => {
        if (key === 'id') nodes.set(args[0], data);
        if (key === 'child') { data.children.push(args[0]); if (typeof args[0] === 'string') painted.push(args[0]); }
        if (key === 'children') data.children.push(...args[0]);
        if (key === 'on_click' || key === 'on_item_click') data.click = args[0];
        return el;
      };
    } });
    return el;
  };
  const { DiffViewer } = await load({ div: element, svg: element, v_flex: element, h_flex: element,
    Button: id => element().id(id), ToolbarButton: id => element().id(id), Popup: { new: id => element().id(id) }, Empty: element, EmptyDescription: element,
    theme: () => ({}), settings: () => ({}), notify: notice => notices.push(notice),
    VirtualListScrollHandle: { new: () => ({}) }, Editor: { new: element }, EditorState: { new: options => ({ ...options }) },
    extensionActions: location => location === 'git.actions' ? [{ id: 'github.account', title: 'GitHub account…', mod: 'herdr-zed-github', location }] : [],
    openGitAction: (id, repository) => opened.push([id, repository]),
    extensionCatalog: () => ({ resolved: { gitCredentials: { id: 'github', mod: 'herdr-zed-github' } } }),
    credentialArgsFor: (provider, repository, read, report) => { report('Git credential host is invalid.'); report('Git credential host is invalid.'); return []; },
    shared: () => undefined, setShared() {} });
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn() {} };
  const view = new DiffViewer(); view.init(cx);
  view.context = { id: 'project', folder: '/project', machine: 'box' };
  view.loaded = true;
  view.pushState = { branch: 'main', committed: true, remote: true, remotes: ['origin'], ahead: 0, behind: 0 };
  view.pushFooter({});
  assert.ok(nodes.has('diff-git-actions-ext:github.account'), 'the provider action is a menu item');
  assert.ok(nodes.has('diff-git-actions-commit-author'), 'the shell keeps its own Commit author item');
  nodes.get('diff-git-actions-ext:github.account').click({}, cx);
  assert.deepEqual(opened, [['github.account', { id: 'project', folder: '/project', machine: 'box' }]]);
  assert.deepEqual(view.credentialArgs({ folder: '/project', machine: 'box' }), []);
  assert.deepEqual(view.credentialArgs({ folder: '/project', machine: 'box' }), []);
  assert.equal(notices.length, 1, 'the same invalid binding is reported once');
  assert.equal(notices[0].title, 'Git credentials ignored');
});
