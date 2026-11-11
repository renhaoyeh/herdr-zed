import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalWorking } from '../mods/devkits/components/session-model.js';

const terminal = (name, argv = [name]) => ({ state: 'live', foreground: { pid: 42, name, argv } });

test('foreground commands run until the terminal returns to an interactive shell', () => {
  for (const name of ['bun', 'node', 'npm', 'sleep', 'nvim', 'make']) {
    assert.equal(terminalWorking(terminal(name)), true, name);
    assert.equal(terminalWorking({ ...terminal(name), program: { shell: true, name: 'zsh' } }), true);
  }
  for (const [name, argv] of [['zsh', ['/bin/zsh', '-li']], ['bash', ['/bin/bash', '--login']],
    ['fish', ['fish']], ['pwsh', ['pwsh.exe', '-NoLogo']], ['cmd.exe', ['cmd.exe', '/k']]]) {
    assert.equal(terminalWorking(terminal(name, argv)), false, name);
  }
});

test('shell command wrappers run, then stop after exec replaces them with a prompt', () => {
  for (const [name, argv] of [['zsh', ['/bin/zsh', '-lic', 'npm test']], ['sh', ['sh', '-c', 'make']],
    ['bash', ['bash', '/tmp/build.sh']], ['pwsh', ['pwsh', '-Command', 'npm test']],
    ['powershell.exe', ['powershell.exe', '-File', 'build.ps1']], ['cmd.exe', ['cmd.exe', '/c', 'npm test']]]) {
    assert.equal(terminalWorking(terminal(name, argv)), true, argv.join(' '));
  }
  const run = { argv: ['sh', '-c', 'npm test; exec zsh -l'], ...terminal('zsh', ['/bin/zsh', '-l']) };
  assert.equal(terminalWorking(run), false);
});

test('agent reports override foreground processes, including blocked and finished turns', () => {
  for (const status of ['working', 'idle', 'blocked', 'done']) {
    assert.equal(terminalWorking({ ...terminal('codex'), status }), status === 'working');
  }
  assert.equal(terminalWorking({ ...terminal('codex'), program: { agent: true } }), false);
});

test('finished terminals and missing process information never imply work', () => {
  for (const value of [null, {}, { state: 'live' }, { foreground: { name: 'bun' } },
    { ...terminal('bun'), state: 'finished', status: 'working' }, { foreground: { pid: 42 } }]) {
    assert.equal(terminalWorking(value), false);
  }
});
