import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { credentialArgsFor } from '../mods/herdr-zed/git-credentials.js';
import { projectKey } from '../components/extension-contract.js';

// A branch menu bound to a fake project. execShell answers each git call in order from `replies`.
async function menu({ branch = 'main', machine = null, localNames = [branch], replies = [], provider = null, memory = {} } = {}) {
  const calls = [], notices = [], closed = [];
  const exec = async (args, options) => {
    calls.push({ args, on: options.on });
    return replies.shift() || { code: 0, stdout: '', stderr: '' };
  };
  const project = { folder: '/repo', machine, branch, overlay: 'branch-overlay' };
  const host = {
    div: () => null, v_flex: () => null, h_flex: () => null, glyph: () => null,
    DropdownMenuContent: () => null, DropdownMenuLabel: () => null, DropdownMenuSeparator: () => null,
    props: () => project, closeOverlay: id => closed.push(id), notify: notice => notices.push(notice),
    shared: key => memory[key], execShell: exec,
    extensionCatalog: () => ({ resolved: { gitCredentials: provider } }),
    credentialArgsFor,
  };
  const api = await evaluateNative('../mods/herdr-zed/branch-menu.js', host, 'BranchMenu, switchPlan, parseBranches');
  const instance = new api.BranchMenu();
  instance.branches = { local: localNames.map(name => ({ name, when: '' })), remote: [] };
  return { api, instance, calls, notices, closed, cx: { notify() {} } };
}
// The git arguments after the runner's `sh -c script herdr-zed-git <folder>` prefix.
const gitArgs = call => call.args.slice(4);

test('parseBranches keeps local and remote refs and skips remote HEAD aliases', async () => {
  const { api } = await menu();
  assert.deepEqual(api.parseBranches('refs/heads/main\t2 days ago\nrefs/remotes/origin/main\t1 day ago\nrefs/remotes/origin/HEAD\t\n'), {
    local: [{ name: 'main', when: '2 days ago' }],
    remote: [{ name: 'origin/main', when: '1 day ago' }],
  });
});

test('switchPlan switches local rows, reuses a same-named local branch for remote rows, and tracks otherwise', async () => {
  const { api } = await menu();
  assert.deepEqual(api.switchPlan('local', 'feature', ['main']), { branch: 'feature', args: ['switch', 'feature'] });
  assert.deepEqual(api.switchPlan('remote', 'origin/feature', ['main', 'feature']), { branch: 'feature', args: ['switch', 'feature'] });
  assert.deepEqual(api.switchPlan('remote', 'origin/feature/x', ['main']), { branch: 'feature/x', args: ['switch', '--track', 'origin/feature/x'] });
});

test('a clean checkout checks the status, switches to the chosen local branch, and closes the menu silently', async () => {
  const { instance, calls, notices, closed, cx } = await menu({ localNames: ['main', 'feature'] });
  await instance.choose('local', { name: 'feature' }, cx);
  assert.equal(calls.length, 2);
  assert.deepEqual(gitArgs(calls[0]), ['status', '--porcelain']);
  assert.deepEqual(gitArgs(calls[1]), ['switch', 'feature']);
  assert.equal(calls[1].on, null);
  assert.deepEqual(closed, ['branch-overlay']);
  assert.deepEqual(notices, []);
  assert.equal(instance.busy, false);
});

test('a dirty checkout refuses the switch, notifies, and leaves the menu open', async () => {
  const { instance, calls, notices, closed, cx } = await menu({
    localNames: ['main', 'feature'], replies: [{ code: 0, stdout: ' M src/app.js\n', stderr: '' }],
  });
  await instance.choose('local', { name: 'feature' }, cx);
  assert.equal(calls.length, 1, 'only the status check runs');
  assert.deepEqual(notices, [{ title: 'Commit or stash changes before switching branches', level: 'error' }]);
  assert.deepEqual(closed, []);
  assert.equal(instance.busy, false);
});

test('an untracked file counts as dirty because porcelain status lists it', async () => {
  const { instance, calls, notices, cx } = await menu({
    localNames: ['main', 'feature'], replies: [{ code: 0, stdout: '?? notes.md\n', stderr: '' }],
  });
  await instance.choose('local', { name: 'feature' }, cx);
  assert.equal(calls.length, 1);
  assert.equal(notices[0].title, 'Commit or stash changes before switching branches');
});

test('a failed switch closes the menu and reports the git error', async () => {
  const { instance, notices, closed, cx } = await menu({
    localNames: ['main', 'feature'], replies: [{ code: 0, stdout: '' }, { code: 1, stdout: '', stderr: 'error: pathspec is missing\n' }],
  });
  await instance.choose('local', { name: 'feature' }, cx);
  assert.deepEqual(closed, ['branch-overlay']);
  assert.deepEqual(notices, [{ title: 'Could not switch branch', body: 'error: pathspec is missing', level: 'error' }]);
});

test('a failed status check closes the menu and reports the error without switching', async () => {
  const { instance, calls, notices, closed, cx } = await menu({
    localNames: ['main', 'feature'], replies: [{ code: 128, stdout: '', stderr: 'fatal: not a git repository\n' }],
  });
  await instance.choose('local', { name: 'feature' }, cx);
  assert.equal(calls.length, 1);
  assert.deepEqual(closed, ['branch-overlay']);
  assert.equal(notices[0].body, 'fatal: not a git repository');
});

test('the current branch row is inert: no git call and no close', async () => {
  const { instance, calls, closed, cx } = await menu({ branch: 'main' });
  await instance.choose('local', { name: 'main' }, cx);
  assert.equal(calls.length, 0);
  assert.deepEqual(closed, []);
});

test('a remote row whose local branch is the current one is inert too', async () => {
  const { instance, calls, cx } = await menu({ branch: 'feature', localNames: ['main', 'feature'] });
  await instance.choose('remote', { name: 'origin/feature' }, cx);
  assert.equal(calls.length, 0);
});

test('a remote row tracks its branch only when no local branch of that name exists', async () => {
  const tracked = await menu({ localNames: ['main'] });
  await tracked.instance.choose('remote', { name: 'origin/feature' }, tracked.cx);
  assert.deepEqual(gitArgs(tracked.calls[1]), ['switch', '--track', 'origin/feature']);

  const existing = await menu({ localNames: ['main', 'feature'] });
  await existing.instance.choose('remote', { name: 'origin/feature' }, existing.cx);
  assert.deepEqual(gitArgs(existing.calls[1]), ['switch', 'feature']);
});

test('a second choice is ignored while a switch is still running', async () => {
  const { instance, calls, cx } = await menu({ localNames: ['main', 'feature', 'other'] });
  instance.busy = true;
  await instance.choose('local', { name: 'feature' }, cx);
  assert.equal(calls.length, 0);
});

test('a remote machine runs git there, with the gitCredentials pairs placed before the subcommand', async () => {
  const provider = { id: 'github' };
  const memory = { 'herdr-zed.git-credentials.github': { repositories: { [projectKey('remote', '/repo')]: {
    host: 'github.com', login: 'octo', config: [['credential.https://github.com.helper', '!gh auth git-credential']],
  } } } };
  const { instance, calls, cx } = await menu({ machine: 'remote', localNames: ['main', 'feature'], provider, memory });
  await instance.choose('local', { name: 'feature' }, cx);
  assert.equal(calls[0].on, 'remote');
  assert.deepEqual(gitArgs(calls[0]), ['-c', 'credential.https://github.com.helper=!gh auth git-credential', 'status', '--porcelain']);
  assert.deepEqual(gitArgs(calls[1]), ['-c', 'credential.https://github.com.helper=!gh auth git-credential', 'switch', 'feature']);
});
