import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexPermissionModes, claudePermissionModes, launcherArgv } from '../components/session-model.js';

test('Codex modes preserve default commands and do not apply to other launchers', () => {
  const codex = { key: 'codex', run: ['codex', '--profile', 'work'] };
  for (const mode of [undefined, 'default', 'unrecognized']) assert.equal(launcherArgv(codex, mode), codex.run);
  const claude = { key: 'claude', run: ['claude'] };
  assert.equal(launcherArgv(claude, 'danger-full-access'), claude.run);
  assert.equal(launcherArgv(codex, 'bypassPermissions'), codex.run);
  assert.equal(launcherArgv(undefined, 'read-only'), undefined);
  for (const mode of codexPermissionModes.slice(1)) {
    assert.deepEqual(launcherArgv(codex, mode.key), ['codex', ...mode.args, '--profile', 'work']);
  }
});

test('account launch flags retain credentials, model, and daemon settings while replacing conflicting permissions', () => {
  const prefix = ['env', '-u', 'OPENAI_API_KEY', 'CODEX_HOME=/config/data/devkits/codex/codex', 'codex'];
  const argv = [...prefix, '--sandbox=danger-full-access', '-s', 'workspace-write', '-sdanger-full-access',
    '-a=never', '--ask-for-approval', 'never', '--approve-for-me', '--full-auto', '--yolo',
    '--dangerously-bypass-approvals-and-sandbox', '-c', 'cli_auth_credentials_store="file"', '--no-daemon', '-m', 'chosen-model'];
  const agent = { key: 'devkits-codex-work', run: argv };
  assert.deepEqual(launcherArgv(agent, 'read-only'), [...prefix,
    '--sandbox', 'read-only', '--ask-for-approval', 'on-request',
    '-c', 'cli_auth_credentials_store="file"', '--no-daemon', '-m', 'chosen-model']);
  assert.equal(agent.run, argv);
  assert.ok(argv.includes('--yolo'));
});

test('permission flags precede a literal prompt and unsupported launch wrappers fail without launching', () => {
  const agent = { key: 'codex', run: ['/usr/local/bin/codex', '--', '--sandbox', 'literal prompt'] };
  assert.deepEqual(launcherArgv(agent, 'workspace-write'), ['/usr/local/bin/codex',
    '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--', '--sandbox', 'literal prompt']);
  assert.throws(() => launcherArgv({ key: 'codex', run: ['custom-wrapper'] }, 'read-only'), /Could not find Codex/);
});

test('Claude modes set --permission-mode and replace conflicting flags in account launchers', () => {
  const claude = { key: 'claude', run: ['claude'] };
  assert.equal(launcherArgv(claude, 'default'), claude.run);
  for (const mode of claudePermissionModes.slice(1)) assert.deepEqual(launcherArgv(claude, mode.key), ['claude', ...mode.args]);
  const prefix = ['env', 'CLAUDE_CONFIG_DIR=/accounts/work', 'CLAUDE_SECURESTORAGE_CONFIG_DIR=/accounts/work', 'claude'];
  const agent = { key: 'devkits-claude-work', run: [...prefix, '--permission-mode', 'plan', '--permission-mode=auto',
    '--dangerously-skip-permissions', '--model', 'opus', '--', '--permission-mode'] };
  assert.deepEqual(launcherArgv(agent, 'bypassPermissions'), [...prefix, '--permission-mode', 'bypassPermissions',
    '--model', 'opus', '--', '--permission-mode']);
  assert.throws(() => launcherArgv({ key: 'claude', run: ['custom-wrapper'] }, 'plan'), /Could not find Claude/);
});
