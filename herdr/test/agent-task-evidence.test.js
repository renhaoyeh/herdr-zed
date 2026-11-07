import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentCommand } from '../mods/devkits/model.js';

async function evidenceHost() {
  const source = await readFile(new URL('../mods/devkits/agent-task-evidence.js', import.meta.url), 'utf8');
  const store = {}, requests = [], tasks = [];
  let hasMessage = false, fileExists = true, pid = 42;
  const services = {
    hc: async args => { requests.push(['hc', args]); return { code: 0, stdout: JSON.stringify({ argv: ['codex'], foreground: { pid } }) }; },
    exec: async (command, args) => {
      requests.push([command, args]);
      if (command === 'node') return { code: 0, stdout: JSON.stringify({ hasInput: hasMessage, needsInput: false, cursor: { offset: 1 } }) };
        return { code: 0, stdout: fileExists ? 'p42\nn/home/sessions/rollout-example.jsonl\n' : '' };
    },
    readTextFile: async () => null, home: () => '/home', appHome: () => '/app',
  };
  const host = { agentCommand, ...services, shared: key => store[key], setShared: (key, value) => { store[key] = structuredClone(value); } };
  const module = new Function(...Object.keys(host), source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { probeTaskState, observeTaskInput, withTaskInputEvidence };')(...Object.values(host));
  return { ...module, services, store, requests, tasks, setHasMessage: value => { hasMessage = value; },
    setFileExists: value => { fileExists = value; }, setPid: value => { pid = value; },
    cx: { spawn: fn => tasks.push(fn({ notify() {} })) }, settle: async () => { await Promise.all(tasks.splice(0)); } };
}

test('task evidence reads structured user-message events, never terminal input or initialization turns', async () => {
  const host = await evidenceHost(), agent = { address: 't1', app: 'codex', status: 'idle', seq: 1, turn: 1 };
  assert.equal((await host.probeTaskState(agent, {}, host.services)).hasInput, false);
  host.setHasMessage(true);
  assert.equal((await host.probeTaskState(agent, {}, host.services)).hasInput, true);
  const scans = host.requests.filter(([command]) => command === 'node');
  assert.ok(scans.every(([, args]) => args[0].endsWith('/agent-task-events.cjs')));
  assert.ok(!host.requests.some(([, args]) => args.includes('send') || args.includes('keys')));
  host.setFileExists(false);
  assert.equal((await host.probeTaskState(agent, {}, host.services)).hasInput, null);
});

test('empty idle threads remain without input, then real input is detected and cached for the session only', async () => {
  const h = await evidenceHost();
  let agent = { address: 't1', app: 'codex', status: 'idle', seq: 1 }, terminals = [{ address: 't1', foreground: { pid: 42 } }];
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  assert.equal(h.withTaskInputEvidence([agent], terminals)[0].hasInput, false);
  h.setHasMessage(true); agent = { ...agent, status: 'working', seq: 2 };
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  assert.equal(h.withTaskInputEvidence([agent], terminals)[0].hasInput, true);
  agent = { ...agent, status: 'done', seq: 3 };
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  const count = h.requests.length;
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  assert.equal(h.requests.length, count);
  // A new agent process in the same terminal must not inherit the previous session's evidence.
  h.setPid(43); h.setHasMessage(false); terminals = [{ address: 't1', foreground: { pid: 43 } }];
  assert.equal(h.withTaskInputEvidence([agent], terminals)[0].hasInput, false);
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  assert.equal(h.withTaskInputEvidence([agent], terminals)[0].hasInput, false);
  h.observeTaskInput([], terminals, h.cx);
  assert.deepEqual(h.store['devkits.task-input-evidence'], {});
});
