import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentCommand } from '../mods/devkits/model.js';
import { taskStatus, reconcileBoardRecords } from '../mods/devkits-tasks/agent-board-model.js';

async function evidenceHost(options = {}) {
  const source = await readFile(new URL('../mods/devkits-tasks/agent-task-evidence.js', import.meta.url), 'utf8');
  const store = {}, requests = [], tasks = [];
  let hasMessage = false, fileExists = true, pid = 42;
  const services = {
    hc: async args => { requests.push(['hc', args]); return { code: 0, stdout: JSON.stringify({ argv: options.argv || ['codex'], foreground: { pid } }) }; },
    exec: async (command, args) => {
      requests.push([command, args]);
      if (command === 'node' && args[0].endsWith('/agent-session-windows.js')) return { code: 0, stdout: JSON.stringify({ file: fileExists ? 'C:\\Profile with spaces\\sessions\\rollout-example.jsonl' : null }) };
      if (command === 'node') return { code: 0, stdout: JSON.stringify({ hasInput: hasMessage, needsInput: false, cursor: { offset: 1 } }) };
        return { code: 0, stdout: fileExists ? 'p42\nn/home/sessions/rollout-example.jsonl\n' : '' };
    },
    readTextFile: async () => null, home: () => '/home', appHome: () => '/app', window: () => ({ platform: options.platform || 'macos' }),
  };
  const host = { agentCommand, ...services, shared: key => store[key], setShared: (key, value) => { store[key] = structuredClone(value); } };
  const module = new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
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

test('Windows finds a wrapped Codex conversation, retains empty startup as Todo and moves submitted work to Doing', async () => {
  const h = await evidenceHost({ platform: 'windows' });
  let agent = { address: 't1', app: 'codex', status: 'working', seq: 1 };
  const terminals = [{ address: 't1', foreground: { pid: 42 } }];
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  assert.equal(taskStatus({ source: 'thread' }, h.withTaskInputEvidence([agent], terminals)), 'todo');
  const discovery = h.requests.find(([, args]) => args[0].endsWith('/agent-session-windows.js'))[1];
  assert.equal(discovery[1], '42');
  assert.equal(discovery[2], 'codex');
  assert.equal(discovery[3], '/home/.codex');
  assert.ok(!h.requests.some(([command]) => ['sh', 'powershell'].includes(command)));
  h.setHasMessage(true); agent = { ...agent, seq: 2 };
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  assert.equal(taskStatus({ source: 'thread' }, h.withTaskInputEvidence([agent], terminals)), 'doing');
  assert.equal(h.requests.filter(([, args]) => args[0].endsWith('/agent-session-windows.js')).length, 1, 'Cache the exact transcript instead of discovering it every poll');
  assert.equal(h.requests.filter(([, args]) => args[0].endsWith('/agent-task-events.cjs'))[1][1][1], 'C:\\Profile with spaces\\sessions\\rollout-example.jsonl');
});

test('Windows Claude discovery respects its account directory and leaves missing conversations unresolved', async () => {
  const directory = 'C:\\Users\\Zoë\\Claude profiles\\Work';
  const h = await evidenceHost({ platform: 'windows', argv: ['env', `CLAUDE_CONFIG_DIR=${directory}`, 'claude'] });
  const agent = { address: 't1', app: 'claude-code' };
  assert.equal((await h.probeTaskState(agent, {}, h.services)).hasInput, false);
  const args = h.requests.find(([, args]) => args[0].endsWith('/agent-session-windows.js'))[1];
  assert.equal(args[3], directory);
  assert.equal(args[2], 'claude');
  h.setFileExists(false);
  assert.equal((await h.probeTaskState(agent, {}, h.services)).hasInput, null);
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
  assert.equal(h.withTaskInputEvidence([agent], terminals)[0].hasInput, null);
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  assert.equal(h.withTaskInputEvidence([agent], terminals)[0].hasInput, false);
  h.observeTaskInput([], terminals, h.cx);
  assert.deepEqual(h.store['devkits.task-input-evidence'], {});
});

test('startup discovery retries an unresolved idle session and preserves known completed work', async () => {
  const h = await evidenceHost({ platform: 'windows' });
  const agent = { address: 't1', app: 'codex', status: 'idle', seq: 0 };
  const terminals = [{ address: 't1', foreground: { pid: 42 } }];
  h.setFileExists(false);
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  const evidence = h.withTaskInputEvidence([agent], terminals);
  assert.equal(evidence[0].hasInput, null);
  const previous = { gid: 'task', source: 'thread', hasInput: true, seenWorking: true, status: 'done' };
  const status = taskStatus(previous, evidence, true);
  const next = reconcileBoardRecords({ task: previous }, [{ ...previous, status, agents: evidence }]).task;
  assert.equal(next.status, 'done'); assert.equal(next.hasInput, true); assert.equal(next.seenWorking, true);
  const count = h.requests.length;
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  assert.equal(h.requests.length, count, 'Missing discovery is throttled');
  h.setFileExists(true); h.setHasMessage(true);
  h.store['devkits.task-input-evidence'].t1.at -= 5001;
  h.observeTaskInput([agent], terminals, h.cx); await h.settle();
  assert.equal(h.withTaskInputEvidence([agent], terminals)[0].hasInput, true, 'Recovery does not require an agent status change');
});
