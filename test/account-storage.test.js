import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAccountStorage } from '../mods/herdr-zed-agents/account-storage-reader.js';
import { accountStorageDirectory, storageSize } from '../mods/herdr-zed-agents/account-storage-model.js';
import { evaluateNative } from './source-harness.js';

test('storage scan groups files once, excludes linked contents and leaves files intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'account-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sizes = { 'sessions/2026/session.jsonl': 1234, 'projects/project/chat.jsonl': 234,
    'file-history/chat/file': 23, '.tmp/plugins/checkout/file': 200,
    'plugins/cache/plugin/file': 300, 'skills/learned/SKILL.md': 90,
    'logs_2.sqlite-wal': 500, 'debug/session.log': 60, 'state_5.sqlite': 100, 'auth.json': 10 };
  for (const [name, bytes] of Object.entries(sizes)) {
    const file = join(root, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, Buffer.alloc(bytes));
  }
  // Junctions work on Windows without developer-mode symlink permission.
  await symlink(root, join(root, 'plugins', 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await readAccountStorage(root);
  assert.deepEqual(result.groups, { conversations: 1491, cache: 200, extensions: 390, logs: 560, other: 110 });
  assert.equal(result.bytes, Object.values(sizes).reduce((sum, value) => sum + value, 0));
  assert.equal(result.skippedLinks, 1);
  assert.equal(result.partial, false);
  assert.deepEqual(await readAccountStorage(root), result);
});

test('missing account data differs from a failed read and bounded scans report incomplete sizes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'account-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await readAccountStorage(join(root, 'absent'))).missing, true);
  await writeFile(join(root, 'file'), 'data');
  const partial = await readAccountStorage(root, { maxEntries: 1 });
  assert.equal(partial.partial, true);
  assert.equal(partial.missing, false);
  await assert.rejects(readAccountStorage('relative/path'), /must be absolute/);
});

test('profiles resolve to their existing account directory, including default and Windows homes', () => {
  assert.deepEqual(accountStorageDirectory({ key: 'codex' }, '/home/rick'), { kind: 'codex', directory: '/home/rick/.codex' });
  assert.deepEqual(accountStorageDirectory({ key: 'devkits-preset-one', profileKey: 'devkits-codex-account-one',
    run: ['env', 'CODEX_HOME=C:\\Users\\Rick\\Codex Account', 'codex'] }, 'ignored'),
  { kind: 'codex', directory: 'C:\\Users\\Rick\\Codex Account' });
  assert.deepEqual(accountStorageDirectory({ key: 'claude', run: ['env', 'CLAUDE_CONFIG_DIR=/custom', 'claude'] }, '/home'),
    { kind: 'claude', directory: '/custom' });
  assert.equal(accountStorageDirectory({ key: 'terminal' }, '/home'), null);
  assert.equal(storageSize(0), '0 B');
  assert.equal(storageSize(1000 ** 3), '1.0 GB');
  assert.equal(storageSize(undefined), 'Unavailable');
});

test('account reads coalesce; late results stay with their account and closed views ignore results', async () => {
  const pending = [], jobs = [];
  const { sessionMenu } = await evaluateNative('../mods/herdr-zed-agents/session-menu.js', {
    accountStorageDirectory, availableAgents() {}, home: () => '/home', appHome: () => '/herdr',
    exec: (_command, args) => new Promise(resolve => pending.push({ args, resolve })),
  }, 'sessionMenu');
  let notifications = 0;
  const cx = { notify() { notifications++; }, spawn(fn) { jobs.push(fn(cx)); } };
  const view = { ...sessionMenu };
  const claude = { key: 'claude' }, codex = { key: 'codex' };
  view.loadAccountStorage(claude, cx);
  view.loadAccountStorage(claude, cx);
  view.loadAccountStorage(codex, cx);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].args[1], '/home/.claude');
  const reply = bytes => ({ code: 0, stdout: JSON.stringify({ bytes, groups: {} }) });
  pending[1].resolve(reply(2)); await jobs[1];
  pending[0].resolve(reply(1)); await jobs[0];
  assert.deepEqual([...view.accountStorage.values()].map(state => state.data.bytes), [1, 2]);
  view.loadAccountStorage(codex, cx, true);
  view.storageClosed = true;
  pending[2].resolve(reply(99)); await jobs[2];
  assert.equal(notifications, 2);
  assert.equal([...view.accountStorage.values()][1].data.bytes, 2);
});
