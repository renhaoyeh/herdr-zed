import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import * as model from '../mods/herdr-zed/components/session-model.js';

const ui = () => {
  const element = { nodes: [] }; let proxy;
  proxy = new Proxy(element, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child') target.nodes.push(args[0]);
      if (key === 'children') target.nodes.push(...args[0]);
      if (key === 'when' && args[0]) args[1](proxy);
      return proxy;
    };
  } });
  return proxy;
};
const uiText = element => element?.nodes ? element.nodes.map(uiText).join(' ') : String(element ?? '');
async function load(options = {}) {
  const memory = options.memory || {}, commands = options.commands || [], live = options.live || [];
  const host = { ...model, div: ui, image: ui, h_flex: ui, shared: key => memory[key],
    setShared: (key, value) => { memory[key] = value; }, run: (...args) => commands.push(args), notify: value => options.notices?.push(value),
    exec: options.exec || (async () => ({ code: 0, stdout: '' })),
    readTextFile: options.readTextFile || (async () => JSON.stringify({ sessionId: '11111111-1111-4111-8111-111111111111' })),
    home: () => '/home/user', terminals: () => live, window: () => ({ platform: options.platform || 'macos' }),
    agents: () => options.agents || [], spaces: () => options.spaces || [], Button: ui, SidebarContent: ui, SidebarGroup: ui, SidebarMenuButton: ui, glyph: ui };
  return { ...(await evaluateNative('../mods/herdr-zed/thread-archive.js', host,
    'threadArchive, historyEligible, historyRestoreCandidate')), host, memory, commands };
}
const command = ['env', 'CLAUDE_CONFIG_DIR=/accounts/work', 'claude', '--model', 'sonnet'];
const project = { id: 'space-1', name: 'workspace', folder: '/work', machine: null };
const terminal = () => ({ address: 't1', created_ms: 123, cwd: '/work', argv: command, status: 'idle', foreground: { pid: 44 } });
const thread = (agents = [{ address: 't1', app: 'claude-code', status: 'idle', program: {} }]) => ({ space: project.id,
  tab: { id: 'tab-1' }, title: 'Fix login', status: 'idle', agents });
const archiveEntry = () => {
  const id = '11111111-1111-4111-8111-111111111111';
  return { id: `claude:${id}:[\"claude\",[\"CLAUDE_CONFIG_DIR=/accounts/work\"]]`, kind: 'claude', sessionId: id,
    accountEnv: ['CLAUDE_CONFIG_DIR=/accounts/work'], executable: 'claude', title: 'Fix login', folder: '/work',
    projectName: 'workspace', argv: model.resumeArgv(command, id), at: 1 };
};

test('history restore matching requires a local matching account, project and live process', async () => {
  const { historyRestoreCandidate } = await load();
  const entry = { kind: 'claude', sessionId: '11111111-1111-4111-8111-111111111111',
    accountEnv: ['CLAUDE_CONFIG_DIR=/accounts/work'], executable: 'claude', folder: '/work' };
  const local = thread();
  assert.equal(historyRestoreCandidate(entry, [local], [terminal()], [project]), true);
  assert.equal(historyRestoreCandidate(entry, [{ ...local, space: 'remote/space-1' }], [terminal()], [project]), false);
  assert.equal(historyRestoreCandidate(entry, [local], [{ ...terminal(), address: 'remote/t1' }], [project]), false);
  assert.equal(historyRestoreCandidate(entry, [local], [terminal()], [{ ...project, machine: 'builder' }]), false);
  assert.equal(historyRestoreCandidate(entry, [local], [{ ...terminal(), argv: [...command.slice(0, 1), 'CLAUDE_CONFIG_DIR=/accounts/other', ...command.slice(2)] }], [project]), false);
});

test('archive preserves the exact safe launch command and keeps Zed history independent', async () => {
  const live = [terminal()], { threadArchive, memory, commands } = await load({ live });
  memory['herdr-zed.archived-threads'] = [{ id: 'task-owned' }];
  const owner = Object.assign({ projects: () => [project] }, threadArchive);
  await owner.archiveThread(thread());
  const entry = memory['herdr-zed.thread-history'][0];
  assert.deepEqual(entry.argv, model.resumeArgv(command, '11111111-1111-4111-8111-111111111111'));
  assert.deepEqual(entry.accountEnv, ['CLAUDE_CONFIG_DIR=/accounts/work']);
  assert.match(entry.id, /accounts\/work/);
  assert.deepEqual(memory['herdr-zed.archived-threads'], [{ id: 'task-owned' }]);
  assert.ok(commands.some(([name]) => name === 'tab.close'));
});

test('a replaced terminal during identity lookup leaves its tab and history untouched', async () => {
  let release;
  const live = [terminal()], { threadArchive, memory, commands } = await load({ live,
    exec: () => new Promise(resolve => { release = resolve; }) });
  const owner = Object.assign({ projects: () => [project] }, threadArchive);
  const archiving = owner.archiveThread(thread());
  await new Promise(resolve => setImmediate(resolve));
  live[0] = { ...terminal(), created_ms: 124 };
  release({ code: 0, stdout: '' });
  await archiving;
  assert.equal(memory['herdr-zed.thread-history'], undefined);
  assert.equal(commands.some(([name]) => name === 'tab.close'), false);
});

test('archive refuses multiple session roots, credential tokens and agent-reported active work', async () => {
  const notices = [], live = [terminal(), { ...terminal(), address: 't2', argv: ['codex'] }], { threadArchive, memory, commands } = await load({ live, notices });
  const owner = Object.assign({ projects: () => [project] }, threadArchive);
  assert.equal(owner.threadBusy(thread([{ address: 't1', app: 'claude-code', status: 'working' }])), true);
  await owner.archiveThread(thread([{ address: 't1', app: 'claude-code', status: 'idle' },
    { address: 't2', app: 'codex', status: 'idle' }]));
  assert.equal(commands.some(([name]) => name === 'tab.close'), false);
  live[0].argv = ['env', 'CLAUDE_API_KEY=literal-secret', 'claude'];
  await owner.archiveThread(thread());
  assert.equal(JSON.stringify(memory).includes('literal-secret'), false);
  assert.equal(commands.some(([name]) => name === 'tab.close'), false);
  assert.ok(notices.length >= 2);
});

test('archive uses the single native root and leaves child-only tabs ineligible', async () => {
  const child = { ...terminal(), address: 't2', created_ms: 456, foreground: { pid: 55 }, parent: 't1' };
  const live = [terminal(), child], reads = [], { threadArchive, memory, commands } = await load({ live,
    readTextFile: async path => { reads.push(path); return JSON.stringify({ sessionId: '11111111-1111-4111-8111-111111111111' }); } });
  const owner = Object.assign({ projects: () => [project] }, threadArchive);
  const both = thread([
    { address: 't1', app: 'claude-code', status: 'idle', program: {} },
    { address: 't2', app: 'claude-code', status: 'idle', program: {} },
  ]);
  assert.equal((await load()).historyEligible(both, live), true);
  await owner.archiveThread(both);
  assert.deepEqual(reads, ['/accounts/work/sessions/44.json']);
  assert.deepEqual(memory['herdr-zed.thread-history'][0].argv, model.resumeArgv(command, '11111111-1111-4111-8111-111111111111'));
  assert.ok(commands.some(([name]) => name === 'tab.close'));

  const childOnly = thread([{ address: 't2', app: 'claude-code', status: 'idle', program: {} }]);
  assert.equal((await load()).historyEligible(childOnly, [child]), false);
  commands.length = 0;
  await owner.archiveThread(childOnly);
  assert.equal(commands.some(([name]) => name === 'tab.close'), false);
});

test('archive retains Codex flags when re-archiving and refuses an initial positional prompt', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const codex = ['env', 'CODEX_HOME=/accounts/codex', 'codex', 'resume', '--no-daemon', '--profile', 'work', id];
  const live = [{ ...terminal(), argv: codex }];
  const { threadArchive, memory, commands } = await load({ live,
    exec: async () => ({ code: 0, stdout: `/sessions/rollout-2026-11-01T00-00-00-${id}.jsonl\n` }) });
  const owner = Object.assign({ projects: () => [project] }, threadArchive);
  const codexThread = thread([{ address: 't1', app: 'codex', status: 'idle', program: {} }]);
  await owner.archiveThread(codexThread);
  assert.deepEqual(memory['herdr-zed.thread-history'][0].argv,
    ['env', 'CODEX_HOME=/accounts/codex', 'codex', 'resume', '--no-daemon', '--profile', 'work', id]);
  assert.ok(commands.some(([name]) => name === 'tab.close'));

  live[0] = { ...terminal(), argv: ['env', 'CLAUDE_CONFIG_DIR=/accounts/work', 'claude', 'Please fix the login bug'] };
  commands.length = 0;
  await owner.archiveThread(thread());
  assert.equal(commands.some(([name]) => name === 'tab.close'), false);
  assert.ok(memory['herdr-zed.thread-history'].every(entry => !entry.argv.includes('Please fix the login bug')));
});

test('restore suppresses duplicate starts, observes startup grace and removes history only for a new verified session', async () => {
  const now = Date.now; let clock = 100000, tick, reads = 0;
  Date.now = () => clock;
  try {
    const memory = { 'herdr-zed.thread-history': [archiveEntry()] }, commands = [], live = [];
    const native = { ...project, tabs: [{ id: 'restored-tab', active: true }] };
    const currentAgent = { address: 'new-terminal', app: 'claude-code', space: project.id, tab: 'restored-tab', status: 'idle' };
    const { threadArchive, host } = await load({ memory, commands, live, spaces: [native], agents: [currentAgent],
      readTextFile: async () => { reads++; return JSON.stringify({ sessionId: archiveEntry().sessionId }); } });
    const owner = Object.assign({ projects: () => [project] }, threadArchive), entry = memory['herdr-zed.thread-history'][0];
    owner.restoreThread(entry); owner.restoreThread(entry);
    assert.equal(commands.filter(([name]) => name === 'tab.new').length, 1);
    const jobs = [];
    const cx = { timer: { every(ms, callback) { assert.equal(ms, 1000); tick = callback; return { cancel() {} }; } },
      spawn(fn) { jobs.push(Promise.resolve().then(() => fn(cx))); }, notify() {} };
    owner.startHistoryRestoreTimer(cx);
    clock += 1000; tick(cx); await Promise.all(jobs.splice(0));
    assert.equal(reads, 0, 'do not inspect identity during the two-second startup grace');
    live.push({ ...terminal(), address: currentAgent.address, created_ms: clock, argv: entry.argv });
    clock += 1000; tick(cx); await Promise.all(jobs.splice(0));
    assert.equal(reads, 1);
    assert.deepEqual(memory['herdr-zed.thread-history'], [], 'remove only after matching new process identity is confirmed');
  } finally { Date.now = now; }
});

test('failed identity verification preserves history, times out to Retry, then allows another start', async () => {
  const now = Date.now; let clock = 200000, tick;
  Date.now = () => clock;
  try {
    const entry = archiveEntry(), memory = { 'herdr-zed.thread-history': [entry] }, commands = [], live = [];
    const native = { ...project, tabs: [{ id: 'restored-tab', active: true }] };
    const currentAgent = { address: 'new-terminal', app: 'claude-code', space: project.id, tab: 'restored-tab', status: 'idle' };
    const notices = [], { threadArchive } = await load({ memory, commands, live, notices, spaces: [native], agents: [currentAgent],
      readTextFile: async () => { throw new Error('session metadata unavailable'); } });
    const owner = Object.assign({ projects: () => [project] }, threadArchive);
    owner.restoreThread(entry);
    const jobs = [], cx = { timer: { every(_ms, callback) { tick = callback; return { cancel() {} }; } },
      spawn(fn) { jobs.push(Promise.resolve().then(() => fn(cx))); }, notify() {} };
    owner.startHistoryRestoreTimer(cx);
    live.push({ ...terminal(), address: currentAgent.address, created_ms: clock, argv: entry.argv });
    clock += 2000; tick(cx); await Promise.all(jobs.splice(0));
    assert.deepEqual(memory['herdr-zed.thread-history'], [entry]);
    assert.ok(notices.some(notice => /Could not verify/.test(notice.title)));
    assert.match(uiText(owner.historyRow(entry, {})), /Retry/);
    owner.restoreThread(entry);
    assert.equal(commands.filter(([name]) => name === 'tab.new').length, 2);
  } finally { Date.now = now; }
});
