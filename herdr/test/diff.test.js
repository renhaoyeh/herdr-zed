import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

async function load(host = {}) {
  host = { shared: () => undefined, setShared() {}, ...host };
  const source = await readFile(new URL('../mods/devkits/diff.js', import.meta.url), 'utf8');
  const menu = await readFile(new URL('../mods/devkits/components/dropdown-menu.js', import.meta.url), 'utf8');
  const history = await readFile(new URL('../mods/devkits/git-history.js', import.meta.url), 'utf8');
  const auth = await readFile(new URL('../mods/devkits/git-auth.js', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../mods/devkits/shell.js', import.meta.url), 'utf8');
  const command = await readFile(new URL('../mods/devkits/shell-command.js', import.meta.url), 'utf8');
  return new Function(...Object.keys(host), (command + '\n' + shell + '\n' + menu + '\n' + history + '\n' + auth + '\n' + source).replace(/^import .*;\r?\n/gm, '')
    .replace('export default class', 'class').replace(/^export /gm, '') + '\nreturn { DiffViewer, DropdownMenu, DropdownMenuState, parseDiff, readDiff, readPushState, pushBranch, gitRemoteAction, affectsDiff, pairLines, changedRanges, changeSections, changeTree, wrapLine, isLockFile };')(...Object.values(host));
}
const run = promisify(execFile);

test('lockfile preference filters working changes and history without discarding Git data', async () => {
  const memory = {};
  const { DiffViewer, isLockFile, parseDiff } = await load({
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
  });
  for (const name of ['Cargo.lock', 'nested/Cargo.lock', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml',
    'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'Pipfile.lock', 'poetry.lock', 'composer.lock', 'Gemfile.lock']) {
    assert.equal(isLockFile(name), true, name);
  }
  for (const name of ['Cargo.toml', 'package.json', 'src/lock.json.ts', 'src/clock.json', 'src/locksmith.yaml', 'Cargo.lock/README.md']) {
    assert.equal(isLockFile(name), false, name);
  }
  const patch = name => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, '@@ -1 +1 @@', '-old', '+new'].join('\n');
  const view = new DiffViewer(); view.init();
  view.files = parseDiff(patch('Cargo.lock') + '\n' + patch('Cargo.toml'));
  assert.deepEqual(view.displayFiles.map(file => file.path), ['Cargo.toml']);
  assert.equal(view.displayFiles, view.displayFiles, 'Stable filtering preserves the asynchronous row cache');
  assert.deepEqual(view.rows().rows.filter(row => row.kind === 'file').map(row => row.file.path), ['Cargo.toml']);
  view.panelTab = 'history';
  view.history.preview = { files: parseDiff(patch('package-lock.json')) };
  const previewFiles = view.displayFiles;
  view.visibleFiles(view.files);
  assert.equal(view.displayFiles, previewFiles, 'Panel rendering must not invalidate the commit row cache');
  assert.equal(view.rows().rows.length, 0);
  view.toggleLockFiles({ notify() {} });
  assert.equal(memory['devkits.diff-hide-lock-files'], false);
  assert.equal(view.rows().rows[0].file.path, 'package-lock.json');
  view.panelTab = 'changes';
  assert.equal(view.displayFiles, view.files);
  assert.equal(view.files.length, 2);
  const reopened = new DiffViewer(); reopened.init();
  assert.equal(reopened.hideLockFiles, false);
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
      'devkits-git', '/folder $(x)', ...args,
    ], { on: 'box' }]);
  }
  await gitRemoteAction('/project', null, 'fetch', 'remote$(x)');
  assert.deepEqual(calls.at(-1)[1].slice(-3), ['fetch', '--', 'remote$(x)']);
  await assert.rejects(gitRemoteAction('/project', null, 'reset'), /Unknown/);
  assert.equal(calls.length, 6);
  await assert.rejects(gitRemoteAction('/project', null, 'publish'), /Choose a Git remote/);
  await gitRemoteAction('/project', 'box', 'push', 'origin', { host: 'github.com', login: 'alice' });
  assert.ok(calls.at(-1)[1].includes('credential.https://github.com.username=alice'));
  assert.deepEqual(calls.at(-1)[1].slice(-3), ['push', '--', 'origin']);
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
  const tasks = [];
  const element = () => {
    const data = { children: [] };
    const el = new Proxy(data, { get(target, key) {
      if (key === 'when') return (condition, render) => { if (condition) render(el); return el; };
      return (...args) => {
        if (key === 'id') nodes.set(args[0], data);
        if (key === 'child') { data.children.push(args[0]); if (typeof args[0] === 'string') painted.push(args[0]); }
        if (key === 'children') data.children.push(...args[0]);
        if (key === 'on_click') data.click = args[0];
        if (key === 'on_key_down') data.key = args[0];
        if (key === 'on_open_change') data.openChange = args[0];
        return el;
      };
    } });
    return el;
  };
  const { DiffViewer } = await load({ div: element, svg: element, v_flex: element, h_flex: element,
    Button: id => element().id(id), Popup: { new: id => element().id(id) },
    Empty: element, EmptyDescription: element, theme: () => ({}), settings: () => ({}),
    shared: key => key === 'devkits.git-accounts' ? accountSettings : undefined,
    setShared: (_key, value) => { accountSettings = value; },
    exec: async () => ({ code: 0, stdout: JSON.stringify([{ host: 'github.com', login: 'alice', state: 'success' },
      { host: 'github.com', login: 'bob', state: 'error' }]) }),
    VirtualListScrollHandle: { new: () => ({}) }, Editor: { new: element },
    EditorState: { new: options => { const state = { ...options, release() { this.released = true; } }; editors.push(state); return state; } } });
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn(fn) { tasks.push(fn(cx)); } };
  const view = new DiffViewer(); view.init(cx);
  view.context = { id: 'project', folder: '/project', branch: 'native/main' };
  view.render(view.context, cx);
  assert.ok(painted.includes('Loading changes…'));
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
  for (const key of ['fetch', 'fetch-from', 'pull', 'pull-rebase', 'push', 'push-to', 'force-push']) {
    assert.ok(nodes.has(`diff-git-actions-${key}`));
  }
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
  view.resultTitle = 'Push failed'; view.toastVisible = true;
  painted.length = 0;
  view.render(view.context, cx);
  assert.equal(nodes.get('diff-git-footer').children.length, 1, 'Failures never expand the footer');
  assert.ok(painted.includes('Push failed'));
  assert.ok(!painted.includes(view.pushResult.message), 'Raw Git output stays out of the notification');
  nodes.get('git-view-log').click({}, cx);
  assert.equal(view.toastVisible, false);
  assert.equal(editors[0].readonly, true);
  assert.equal(editors[0].value, view.pushResult.message);
  view.render(view.context, cx);
  assert.ok(nodes.has('git-output'));
  nodes.get('git-output-close').click({}, cx);
  assert.equal(editors[0].released, true);
  assert.equal(view.output, null);
  view.toastVisible = true; view.resultToast({});
  nodes.get('git-toast-close').click({}, cx);
  assert.equal(view.toastVisible, false);
  assert.equal(view.pushResult.failed, true, 'Dismissal retains the result');
  view.pushFooter({});
  nodes.get('diff-git-actions-accounts').click({}, cx);
  assert.equal(view.gitMenu.page, 'accounts');
  assert.equal(view.gitMenu.open, true);
  await Promise.all(tasks.splice(0));
  view.pushFooter({});
  nodes.get('diff-git-actions-account:1').click({}, cx);
  assert.equal(accountSettings, undefined, 'Unavailable accounts cannot be selected');
  nodes.get('diff-git-actions-account:0').click({}, cx);
  assert.equal(view.gitMenu.page, null);
  view.pushFooter({});
  assert.ok(painted.includes('GitHub account…'));
  assert.ok(painted.includes('alice'));
  assert.deepEqual(Object.values(accountSettings), [{ host: 'github.com', login: 'alice' }]);
  nodes.get('diff-git-actions-accounts').click({}, cx);
  await Promise.all(tasks.splice(0));
  view.pushFooter({});
  nodes.get('diff-git-actions-account:default').click({}, cx);
  assert.deepEqual(accountSettings, {});
});

test('account reads avoid duplicate requests and ignore results after changing projects', async () => {
  const pending = [], tasks = [], machines = [];
  const { DiffViewer } = await load({ VirtualListScrollHandle: { new: () => ({}) },
    exec: (_cmd, _args, options) => { machines.push(options.on); return new Promise(resolve => pending.push(resolve)); } });
  const cx = { notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  const view = new DiffViewer(); view.init();
  view.context = { folder: '/one', machine: 'remote' };
  view.loadAccounts(cx); view.loadAccounts(cx);
  assert.equal(pending.length, 1);
  view.context = { folder: '/two' }; view.accountsLoading = false;
  view.loadAccounts(cx);
  pending[1]({ code: 0, stdout: '[{"host":"github.com","login":"current","state":"success"}]' });
  await tasks[1];
  pending[0]({ code: 0, stdout: '[{"host":"github.com","login":"stale","state":"success"}]' });
  await tasks[0];
  assert.equal(view.accounts[0].login, 'current');
  assert.deepEqual(machines, ['remote', undefined]);
});

test('push prevents duplicate actions, retains errors for retry and isolates project changes', async () => {
  const tasks = [], notices = [], calls = [];
  let complete;
  const { DiffViewer } = await load({ VirtualListScrollHandle: { new: () => ({}) },
    notify: notice => notices.push(notice),
    exec: (cmd, args, options) => {
      if (args.includes('devkits-push-state')) return Promise.resolve({ code: 0, stderr: '',
        stdout: `main\n${'a'.repeat(40)}\n0\t0\nrefs/remotes/origin/main\norigin\norigin\n` });
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
  assert.equal(view.toastVisible, true);
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
  assert.equal(view.rows().rows[0].file.path, 'committed.txt');
  assert.equal(view.files, working);
  view.setPanelTab('changes', cx);
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
    { path: 'first', hunks: [{ lines: Array(19997).fill({ type: 'ctx', text: '' }) }] },
    { path: 'large', hunks: [{ lines }] },
  ];
  for (layout of ['unified', 'split']) {
    reads = 0; view.rowCache = null;
    assert.equal(view.rows().rows.length, 20000);
    assert.equal(view.rows().limited, true);
    assert.ok(reads < 20, 'Rows must pass the remaining budget into pairing');
  }
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
  assert.deepEqual(scrolled, [[rows.findIndex(row => row.key === 'file:b'), 'top']]);
  view.files = [{ path: 'huge', hunks: [{ lines: Array.from({ length: 25 }, () => ({ type: 'ctx', text: 'x'.repeat(2000) })) }] }];
  view.width = 72; view.rowCache = null;
  assert.equal(view.rows().rows.length, 20000);
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
  assert.equal(memory['devkits.diff-wrap'], false);
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
  view.panelTab = 'history'; view.history.preview = { files: view.files };
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

test('project initialization yields before watchers, Git reads and History notifications', async () => {
  const { DiffViewer } = await load({ VirtualListScrollHandle: { new: () => ({}) } });
  const tasks = [], waits = [], started = [];
  let rendering = true;
  const cx = {
    spawn(fn) { tasks.push(fn(cx)); },
    sleep() { return new Promise(resolve => waits.push(resolve)); },
    notify() { assert.equal(rendering, false, 'Cannot notify while rendering'); },
  };
  const view = new DiffViewer(); view.init(); view.panelTab = 'history';
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
    VirtualListScrollHandle: { new: () => ({}) }, exec: async () => ({ code: 0, stdout: text }) });
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
