import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { terminalArgv, unwrapTerminalArgv } from '../components/session-shell.js';

const prompt = 'x'.repeat(12000) + '\r\n請讀取 C:\\Users\\RickYeh\\MCP-SETUP.md  user\'s “guide” ’‘\t$HOME `test`';

test('Windows launch identity retains long prompts and literal punctuation', () => {
  const args = ['env', 'CODEX_HOME=C:\\test folder', 'codex', '--', prompt];
  assert.deepEqual(unwrapTerminalArgv(terminalArgv(args, 'windows')), args);
  assert.deepEqual(terminalArgv(args, 'linux'), args);
});

test('Windows shell passes prompts beyond 8 KB without truncation or expansion', { skip: process.platform !== 'win32' }, () => {
  // printf is a shell builtin: no agents, accounts, or interactive windows.
  const argv = terminalArgv(['env', 'printf', '%s', prompt], 'windows');
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout, prompt);
});
