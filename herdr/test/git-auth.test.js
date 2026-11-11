import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { gitShellCommand } from '../mods/devkits/components/session-shell.js';

const run = promisify(execFile);
async function load(host = {}) {
  const source = await readFile(new URL('../mods/devkits/git-auth.js', import.meta.url), 'utf8');
  return new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { gitAccount, setGitAccount, readGitAccounts, gitAuthArgs, readAccountAuthor, rememberGitAuthor };')(...Object.values(host));
}

test('account authors load public profiles and remember only name/email per machine, host and login', async () => {
  const memory = {}, calls = [];
  const auth = await load({ shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    exec: async (...args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ login: 'alice', name: 'Alice', email: null, token: 'discard' }) }; } });
  const account = { host: 'github.com', login: 'alice' };
  assert.deepEqual(await auth.readAccountAuthor(account, 'remote'), { name: 'Alice', email: '' });
  assert.deepEqual(calls[0], ['gh', ['api', 'users/alice', '--hostname', 'github.com', '--jq', '{login,name,email}'], { on: 'remote' }]);
  auth.rememberGitAuthor(account, 'remote', { name: ' Alice Custom ', email: 'private@example.test', token: 'discard' });
  assert.deepEqual(await auth.readAccountAuthor(account, 'remote'), { name: 'Alice Custom', email: 'private@example.test' });
  assert.equal(calls.length, 1);
  await auth.readAccountAuthor(account, 'other-machine');
  await auth.readAccountAuthor({ ...account, host: 'enterprise.example' }, 'remote');
  assert.equal(calls.length, 3);
  assert.ok(!JSON.stringify(memory).includes('discard'));
  const mismatch = await load({ shared: () => null, exec: async () => ({ code: 0, stdout: '{"login":"bob"}' }) });
  await assert.rejects(mismatch.readAccountAuthor(account), /does not match/);
  const failed = await load({ shared: () => null, exec: async () => ({ code: 1 }) });
  await assert.rejects(failed.readAccountAuthor(account), /Enter the commit author/);
});

test('GitHub accounts retain only public metadata and report unavailable accounts', async () => {
  let call;
  const auth = await load({ exec: async (...args) => {
    call = args;
    return { code: 0, stdout: JSON.stringify([
      { host: 'github.com', login: 'alice', state: 'success', token: 'discard-me' },
      { host: 'git.example.com', login: 'bob', state: 'error' },
      { host: 'github.com; bad', login: 'invalid', state: 'success' },
    ]) };
  } });
  assert.deepEqual(await auth.readGitAccounts('remote'), [
    { host: 'github.com', login: 'alice', available: true },
    { host: 'git.example.com', login: 'bob', available: false },
  ]);
  assert.equal(call[0], 'gh');
  assert.deepEqual(call[2], { on: 'remote' });
  assert.ok(call[1].includes('[.hosts[][] | {host,login,state}]'));
  assert.ok(!call[1].includes('--show-token'));
  const bad = await load({ exec: async () => ({ code: 0, stdout: '{}' }) });
  await assert.rejects(bad.readGitAccounts(), /Update gh/);
  const missing = await load({ exec: async () => ({ code: 1 }) });
  await assert.rejects(missing.readGitAccounts(), /gh auth login/);
});

test('account choices are scoped by machine and folder and Default removes the choice', async () => {
  let data;
  const auth = await load({ shared: () => data, setShared: (_key, value) => { data = value; } });
  const project = { machine: '', folder: 'C:/project' };
  auth.setGitAccount(project, { host: 'github.com', login: 'alice', token: 'discard-me' });
  assert.deepEqual(auth.gitAccount(project), { host: 'github.com', login: 'alice' });
  assert.equal(auth.gitAccount({ ...project, machine: 'remote' }), null);
  assert.equal(auth.gitAccount({ folder: 'C:/other' }), null);
  assert.ok(!JSON.stringify(data).includes('discard-me'));
  auth.setGitAccount(project, null);
  assert.equal(auth.gitAccount(project), null);
  assert.throws(() => auth.setGitAccount(project, { host: 'github.com', login: '$(bad)' }), /Invalid/);
  assert.deepEqual(auth.gitAuthArgs(null), []);
});

test('Git uses the selected account through a host-scoped helper without global switches or writes', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'devkits-gh-helper-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  // This fixture contains no real credential and fails if inherited tokens override the selection.
  await writeFile(join(folder, 'gh'), '#!/bin/sh\n'
    + '[ "$*" = "auth token --hostname github.com --user alice" ] || exit 9\n'
    + '[ -z "${GH_TOKEN+x}${GITHUB_TOKEN+x}${GH_ENTERPRISE_TOKEN+x}${GITHUB_ENTERPRISE_TOKEN+x}" ] || exit 8\n'
    + 'printf "%s\\n" fixture-password\n', { mode: 0o755 });
  const { gitAuthArgs } = await load();
  const args = gitAuthArgs({ host: 'github.com', login: 'alice' });
  const script = 'PATH="$(cd "$1" && pwd):$PATH"; export PATH; shift; '
    + 'printf "protocol=https\\nhost=%s\\n\\n" "$1" | { shift; git "$@" credential fill; }';
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GH_TOKEN: 'override', GITHUB_TOKEN: 'override',
    GH_ENTERPRISE_TOKEN: 'override', GITHUB_ENTERPRISE_TOKEN: 'override' };
  const invoke = host => {
    const shellArgs = ['-c', script, 'fixture', folder.replaceAll('\\', '/'), host, ...args];
    const [command, ...argv] = process.platform === 'win32' ? gitShellCommand(shellArgs) : ['sh', ...shellArgs];
    return run(command, argv, { env });
  };
  const result = await invoke('github.com');
  assert.match(result.stdout, /username=alice/);
  assert.match(result.stdout, /password=fixture-password/);
  await assert.rejects(invoke('other.example.com'), /could not read Username/);
  for (const url of ['git@github.com:org/repo.git', 'ssh://git@github.com/org/repo.git']) {
    const result = await run('git', [...args, 'ls-remote', '--get-url', url], { env });
    assert.equal(result.stdout.trim(), 'https://github.com/org/repo.git');
  }
  assert.throws(() => gitAuthArgs({ host: "github.com'", login: 'alice' }), /Invalid/);
});
