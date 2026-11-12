import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, lstat, link, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAccountStorage } from '../mods/herdr-zed-agents/account-storage-reader.js';
import { accountStorageDirectory, storageSize } from '../mods/herdr-zed-agents/account-storage-model.js';
import { evaluateNative } from './source-harness.js';

test('storage scan counts allocated blocks, groups directories and files, and excludes linked targets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'account-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (!Number.isFinite((await lstat(root)).blocks)) return t.skip('filesystem does not expose allocated blocks');
  const sizes = { 'sessions/2026/session.jsonl': 1234, 'projects/project/chat.jsonl': 234,
    'file-history/chat/file': 23, '.tmp/plugins/checkout/file': 200,
    'plugins/cache/plugin/file': 300, 'skills/learned/SKILL.md': 90,
    'thread_history_1.sqlite': 600, 'thread_history_1.sqlite-wal': 70,
    'packages/app-server-daemon/daemon': 800, 'computer-use/Tool.app/program': 100, 'vendor_imports/skills/SKILL.md': 60,
    'logs_2.sqlite-wal': 500, 'debug/session.log': 60, 'state_5.sqlite': 100, 'auth.json': 10 };
  for (const [name, bytes] of Object.entries(sizes)) {
    const file = join(root, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, Buffer.alloc(bytes));
  }
  // Junctions work on Windows without developer-mode symlink permission.
  await symlink(root, join(root, 'plugins', 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await readAccountStorage(root);
  const expected = { conversations: 0, cache: 0, extensions: 0, runtime: 0, logs: 0, other: (await lstat(root)).blocks * 512 };
  const directories = new Set();
  for (const name of Object.keys(sizes)) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const { storageGroup } = await import('../mods/herdr-zed-agents/account-storage-model.js');
  for (const name of [...directories, ...Object.keys(sizes)]) expected[storageGroup(name.split('/')[0])] += (await lstat(join(root, name))).blocks * 512;
  assert.deepEqual(result.groups, expected);
  assert.equal(result.bytes, Object.values(expected).reduce((sum, value) => sum + value, 0));
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
  assert.deepEqual(accountStorageDirectory({ key: 'herdr-zed-preset-one', profileKey: 'herdr-zed-codex-account-one',
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


test('sparse allocation and hard links do not inflate disk usage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'account-blocks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (!Number.isFinite((await lstat(root)).blocks)) return t.skip('filesystem does not expose allocated blocks');
  const path = join(root, 'sparse');
  const file = await open(path, 'w');
  try { await file.truncate(64 * 1024 * 1024); await file.write(Buffer.from('x'), 0, 1, 0); }
  finally { await file.close(); }
  await link(path, join(root, 'same-file'));
  const info = await lstat(path), directory = await lstat(root);
  const result = await readAccountStorage(root);
  assert.equal(result.bytes, (info.blocks + directory.blocks) * 512, 'one inode contributes only once');
  if (info.blocks * 512 < info.size) assert.ok(result.bytes < info.size, 'sparse holes do not count as allocated space');
});


test('Codex history databases and tool installations are not unidentified account data', async () => {
  const { storageGroup } = await import('../mods/herdr-zed-agents/account-storage-model.js');
  for (const name of ['thread_history_1.sqlite', 'thread_history_1.sqlite-wal', 'thread_history_2.sqlite-shm'])
    assert.equal(storageGroup(name), 'conversations');
  for (const name of ['packages', 'computer-use']) assert.equal(storageGroup(name), 'runtime');
  assert.equal(storageGroup('vendor_imports'), 'extensions');
  assert.equal(storageGroup('auth.json'), 'other');
  assert.equal(storageGroup('unrecognized'), 'other');
});
