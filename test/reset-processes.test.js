import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleAccounts, stopAccountSessions, stopResetServices, resetProcessPids } from '../mods/herdr-zed/reset-data.js';
import { evaluateNative } from './source-harness.js';

test('reset waits for account terminals and finite cache writers without stopping unrelated processes', async () => {
  let terminals = [{ state: 'live', argv: ['env', 'CODEX_HOME=/herdr/data/herdr-zed/codex/account', 'codex'] }];
  let processes = '999999 1 node node /herdr/mods/herdr-zed-usage/analytics-reader.js\n';
  const run = async command => ({ stdout: command === 'hc' ? JSON.stringify({ terminals }) : processes });
  await assert.rejects(idleAccounts('/herdr/data/herdr-zed', run, 'darwin'), /Close the terminals/);
  terminals = [];
  await assert.rejects(idleAccounts('/herdr/data/herdr-zed', run, 'darwin'), /services are still stopping/);
  processes = '999999 1 node node /another/mods/herdr-zed/reader.js\n999998 1 zsh zsh /herdr/mods/herdr-zed/reader.js\n';
  await idleAccounts('/herdr/data/herdr-zed', run, 'darwin');
  await assert.rejects(idleAccounts('/herdr/data/herdr-zed', async command => ({ stdout: command === 'hc' ? '{"terminals":[]}' : '[123]' }), 'win32'), /services are still stopping/);
});

test('Windows reset process inspection returns only this installation helper PIDs', async () => {
  class Enumerator {
    constructor(rows) { this.rows = rows; this.index = 0; }
    atEnd() { return this.index >= this.rows.length; }
    moveNext() { this.index++; }
    item() { return this.rows[this.index]; }
  }
  const { resetWriterPids } = await evaluateNative('../mods/herdr-zed/reset-processes-windows.js', { Enumerator }, 'resetWriterPids');
  assert.deepEqual(resetWriterPids([
    { ProcessId: 1, Name: 'node.exe', CommandLine: 'node C:\\Herdr\\mods\\herdr-zed\\reset-data.js' },
    { ProcessId: 2, Name: 'node.exe', CommandLine: 'node C:\\Herdr\\mods\\herdr-zed-usage\\analytics-reader.js' },
    { ProcessId: 3, Name: 'node.exe', CommandLine: 'node C:\\Other\\mods\\herdr-zed\\reader.js' },
    { ProcessId: 4, Name: 'node.exe', CommandLine: 'node "C:\\Herdr\\mods\\herdr-zed-tasks\\mcp-server.cjs"' },
  ], 'C:\\Herdr', 1), [2, 4]);
});

test('Windows stop tolerates exited processes and reports live termination failures without command lines', async () => {
  class Enumerator {
    constructor(rows) { this.rows = rows; this.index = 0; }
    atEnd() { return this.index >= this.rows.length; }
    moveNext() { this.index++; }
    item() { return this.rows[this.index]; }
  }
  const { stopResetWriter } = await evaluateNative('../mods/herdr-zed/reset-processes-windows.js', { Enumerator }, 'stopResetWriter');
  const row = { ProcessId: 42, CreationDate: 'original', Terminate: () => { throw Object.assign(new Error('private command'), { number: -2147217406 }); } };
  const connection = rows => ({ ExecQuery(query) {
    assert.equal(query, 'SELECT ProcessId, CreationDate FROM Win32_Process WHERE ProcessId = 42');
    return rows;
  } });
  stopResetWriter(connection([]), row);
  stopResetWriter(connection([{ CreationDate: 'replacement' }]), row);
  assert.throws(() => stopResetWriter(connection([row]), row), /^Error: Could not stop Herdr Zed background process PID 42: WMI error -2147217406\.$/);
  row.Terminate = () => 2;
  assert.throws(() => stopResetWriter(connection([row]), row), /PID 42: return code 2/);
  stopResetWriter(connection([]), row);
  row.Terminate = () => 0;
  stopResetWriter({ ExecQuery() { throw new Error('unnecessary query'); } }, row);
});

test('confirmed reset stops dedicated account sessions and their children, preserving unrelated terminals', async () => {
  let terminals = [
    { address: 't1', state: 'live', argv: ['env', 'CODEX_HOME=/herdr/data/herdr-zed/codex/one', 'codex'] },
    { address: 't2', state: 'live', parent: 't1', argv: ['node', 'watch.js'] },
    { address: 't3', state: 'live', argv: ['codex'] },
    { address: 't4', state: 'live', argv: ['env', 'CODEX_HOME=/another/data/herdr-zed/codex/one', 'codex'] },
  ];
  const killed = [];
  await stopAccountSessions('/herdr/data/herdr-zed', async (_command, args) => {
    if (args[0] === 'kill') { killed.push(args[1]); terminals = terminals.filter(item => item.address !== args[1]); return {}; }
    return { stdout: JSON.stringify({ terminals }) };
  });
  assert.deepEqual(killed, ['t2', 't1']);
  assert.deepEqual(terminals.map(item => item.address), ['t3', 't4']);
});

test('service stop terminates MCP and helpers, then verifies exit before returning', async () => {
  const calls = []; let live = true;
  await stopResetServices('/herdr/data/herdr-zed', async (command, args) => {
    if (command === 'hc') return { stdout: '{"terminals":[]}' };
    calls.push(args.at(-1));
    if (args.at(-1) === 'stop') { live = false; return { stdout: '[123]' }; }
    return { stdout: live ? '[123]' : '[]' };
  }, 'win32');
  assert.deepEqual(calls, ['stop', String(process.pid)]);
});

test('service discovery includes persistent MCP descendants and excludes adjacent installations and reset itself', () => {
  assert.deepEqual(resetProcessPids([
    '100 1 node node /herdr/mods/herdr-zed-tasks/mcp-server.cjs',
    '101 100 sh sh child.sh',
    '102 1 node node /herdr/mods/herdr-zed-system/hardware-reader.js',
    '103 1 node node /herdr/mods/herdr-zed-other-copy/reader.js',
    '104 1 node node /herdr/mods/herdr-zed/reset-data.js',
    '105 1 node node /else/herdr/mods/herdr-zed/reader.js',
    '106 1 node node /herdr/mods/herdr-zed-backup/reader.js',
  ].join('\n'), '/herdr', 104), [100, 102, 103, 106, 101]);
});
