import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { codexTaskFile, claudeTaskFile, locateWindowsTaskFile } from '../mods/devkits-tasks/agent-task-file-windows.js';

const { readTaskEvents } = createRequire(import.meta.url)('../mods/devkits-tasks/agent-task-events.cjs');

test('JScript process discovery follows wrappers, excludes other terminals and rejects reused parent PIDs', async () => {
  const source = await readFile(new URL('../mods/devkits-tasks/agent-task-process-windows.js', import.meta.url), 'utf8');
  function Enumerator(rows) {
    let index = 0;
    this.atEnd = () => index >= rows.length; this.moveNext = () => index++; this.item = () => rows[index];
  }
  const { taskProviderProcesses, processDate } = new Function('Enumerator', source + '\nreturn { taskProviderProcesses, processDate };')(Enumerator);
  const row = (pid, parent, name, created = '20261108030001.000000+000') => ({ ProcessId: pid, ParentProcessId: parent, Name: name, CreationDate: created });
  const rows = [row(1, 0, 'powershell.exe'), row(2, 1, 'git.exe'), row(3, 2, 'sh.exe'), row(4, 3, 'env.exe'),
    row(5, 4, 'codex.exe'), row(6, 99, 'codex.exe'), row(7, 5, 'codex.exe'), row(8, 1, 'codex.exe', '20261108020000.000000+000')];
  assert.deepEqual(taskProviderProcesses(rows, 1, 'codex').map(process => process.pid), [5]);
  assert.deepEqual(taskProviderProcesses(rows, 999, 'codex'), []);
  assert.equal(processDate('20261108110000.000000+480'), Date.UTC(2026, 10, 8, 3));
  assert.equal(processDate(null), null);
});

test('JS Codex discovery matches process identity and creation time, excluding other threads and sub-agents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'devkits-js-task-'));
  const account = join(root, 'Account [work]', '作業 (draft)'); await mkdir(join(account, 'sessions'), { recursive: true });
  const logs = new DatabaseSync(join(account, 'logs_2.sqlite')), state = new DatabaseSync(join(account, 'state_5.sqlite'));
  t.after(async () => { logs.close(); state.close(); await rm(root, { recursive: true, force: true }); });
  logs.exec('CREATE TABLE logs (thread_id TEXT, process_uuid TEXT, ts INTEGER, ts_nanos INTEGER)');
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT, archived INTEGER)');
  const add = async (id, process, ts, source = 'cli', directory = join(account, 'sessions')) => {
    const file = join(directory, `rollout-${id}.jsonl`);
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
    state.prepare('INSERT INTO threads VALUES (?, ?, ?, 0)').run(id, file, source);
    logs.prepare('INSERT INTO logs VALUES (?, ?, ?, 0)').run(id, process, ts);
    return file;
  };
  const file = await add('current', 'pid:42:current-process', 3);
  await add('other-window', 'pid:43:other-process', 4);
  await add('reused-pid', 'pid:42:old-process', 1);
  await add('sub-agent', 'pid:42:current-process', 4, '{"subagent":{"thread_spawn":{}}}');
  await add('outside-profile', 'pid:42:current-process', 4, 'cli', root);
  const processes = [{ pid: 42, createdAt: 2000 }];
  assert.equal(await codexTaskFile(account, processes), file);
  const empty = await readTaskEvents(file, 'codex'); assert.equal(empty.hasInput, false);
  await appendFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Run this task' } }) + '\n');
  assert.equal((await readTaskEvents(file, 'codex', empty.cursor)).hasInput, true);
  assert.equal(await codexTaskFile(account, [{ pid: 999, createdAt: 2000 }]), null);
  await add('ambiguous-current', 'pid:42:current-process', 5);
  assert.equal(await codexTaskFile(account, processes), null, 'Ambiguous matches never select the newest conversation');
});

test('JS Claude discovery uses the selected profile PID mapping and literal Unicode paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'devkits-js-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'Account [work] 作業'), session = '11111111-2222-3333-4444-555555555555';
  const project = join(profile, 'projects', 'C--Work');
  await mkdir(project, { recursive: true }); await mkdir(join(profile, 'sessions'));
  const file = join(project, `${session}.jsonl`); await writeFile(file, '{}\n');
  await writeFile(join(profile, 'sessions', '123.json'), JSON.stringify({ sessionId: session }));
  assert.equal(await claudeTaskFile(profile, [{ pid: 123 }]), file);
  assert.equal(await claudeTaskFile(profile, [{ pid: 999 }]), null);
});

test('Windows runs JS discovery through the existing script host without PowerShell or a compiled helper', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'devkits-js-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '11111111-2222-3333-4444-555555555555';
  await mkdir(join(root, 'sessions')); await mkdir(join(root, 'projects', 'work'), { recursive: true });
  const file = join(root, 'projects', 'work', `${id}.jsonl`); await writeFile(file, '{}\n');
  await writeFile(join(root, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId: id }));
  assert.equal(await locateWindowsTaskFile(process.pid, 'claude', root), file);
});
