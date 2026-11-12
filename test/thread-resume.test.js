import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import * as model from '../mods/herdr-zed/components/session-model.js';
import * as identity from '../mods/herdr-zed/thread-identity.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const KEY = identity.RESUME_RECORDS_KEY;
const command = ['env', 'CLAUDE_CONFIG_DIR=/accounts/work', 'claude', '--model', 'sonnet'];
const resumed = [...command, '--resume', ID];

// Herdr-shaped fixtures: one space with one agent tab (tab-1, terminal t1) running Claude.
const space = (tabs = [tab()]) => ({ id: 'space-1', index: 1, name: 'workspace', named: true, folder: '/work', machine: null,
  branch: null, active: true, status: null, tabs });
const tab = (id = 'tab-1', panes = 1) => ({ id, index: 1, name: '1', named: false, active: true, status: null, panes, zoomed: false,
  settled: false, settled_at: null, changed_at: null, working_since: null });
const agentTerminal = (overrides = {}) => ({ address: 't1', argv: command, created_ms: 100, state: 'live', status: 'idle',
  foreground: { pid: 44, name: 'claude', argv: ['claude'] }, program: { key: 'claude', name: 'Claude Code', agent: true, shell: false }, cwd: '/work', ...overrides });
const agentRow = (overrides = {}) => ({ address: 't1', pane: 'p1', space: 'space-1', space_name: 'workspace', tab: 'tab-1', tab_index: 1,
  tab_name: '1', status: 'idle', app: 'claude-code', program: { key: 'claude', name: 'Claude Code', agent: true, shell: false },
  title: 'Fix login', seq: 1, pinned: false, focused: true, ...overrides });
const shellTerminal = (address = 't1', created = 5000) => ({ address, argv: ['/bin/zsh', '-l'], created_ms: created, state: 'live', status: null,
  foreground: { pid: 77, name: 'zsh', argv: ['zsh', '-l'] }, program: { key: 'shell', name: 'zsh', shell: true, agent: false }, cwd: '/work' });
const record = (overrides = {}) => ({ tabId: 'tab-1', space: 'space-1', folder: '/work', machine: null, kind: 'claude', sessionId: ID,
  command, title: 'Fix login', updatedAt: 1000, address: 't1', pid: 44, ...overrides });

function makeWorld(overrides = {}) {
  return { spaces: [space()], agents: [agentRow()], terminals: [agentTerminal()], panes: [],
    machines: [{ name: null, layout: 'ready' }], ...overrides };
}

const evaluate = () => evaluateNative('../mods/herdr-zed/thread-resume.js', {
  ...model, ...identity,
  shared: undefined, setShared: undefined, run: undefined, notify: undefined, exec: undefined, readTextFile: undefined, home: undefined,
  appHome: undefined, window: undefined, machines: undefined, spaces: undefined, agents: undefined, terminals: undefined, panes: undefined,
}, 'createThreadResume, planRecords, refreshRecords, isPlainShell, autoResumeEnabled, RESUME_REFRESH_MS, RESUME_TIMEOUT_MS');

// Fake Herdr API: `world` is read live, so a test can change spaces, agents and terminals between ticks.
function makeApi(world, options = {}) {
  const memory = options.memory || {}, commands = [], notices = [], writes = [], reads = [];
  const api = {
    shared: key => memory[key],
    setShared: (key, value) => { writes.push(key); memory[key] = value; },
    run: (name, args) => { commands.push([name, args]); return null; },
    notify: notice => { notices.push(notice); return 'id'; },
    exec: async (...args) => { reads.push(args); return options.exec ? options.exec(...args) : { code: 0, stdout: '' }; },
    readTextFile: options.readTextFile || (async () => JSON.stringify({ sessionId: ID })),
    home: () => '/home/user', appHome: () => '/appdata',
    window: () => ({ platform: options.platform || 'macos' }),
    machines: () => world.machines, spaces: () => world.spaces, agents: () => world.agents,
    terminals: () => world.terminals, panes: () => world.panes,
  };
  return { api, memory, commands, notices, writes, reads };
}

test('records the resumable identity of an agent tab and refreshes it on the gentle timer', async () => {
  const { createThreadResume, RESUME_REFRESH_MS } = await evaluate();
  assert.equal(RESUME_REFRESH_MS, 10000);
  const world = makeWorld(), reads = [];
  const { api, memory, writes } = makeApi(world, { readTextFile: async path => { reads.push(path); return JSON.stringify({ sessionId: ID }); } });
  const resume = createThreadResume(api);
  await resume.tick(1000);
  assert.deepEqual(memory[KEY]['tab-1'], record({ updatedAt: 1000 }));
  assert.deepEqual(reads, ['/accounts/work/sessions/44.json']);
  await resume.tick(5000);
  assert.equal(reads.length, 1, 'identity is not looked up again within the refresh interval');
  await resume.tick(12000);
  assert.equal(reads.length, 2);
  assert.equal(memory[KEY]['tab-1'].updatedAt, 1000, 'an unchanged identity keeps its record');
  assert.equal(writes.length, 1, 'shared state is written only when the identity changes');
});

test('after a reboot, a lost agent terminal is resumed in a new tab and the stale tab closes only once the new one shows the session', async () => {
  const { createThreadResume } = await evaluate();
  const world = makeWorld({ agents: [], terminals: [shellTerminal()] });
  const { api, memory, commands, notices } = makeApi(world, { memory: { [KEY]: { 'tab-1': record() } } });
  const resume = createThreadResume(api);
  await resume.tick(6000);
  assert.deepEqual(commands, [['tab.new', { space: 'space-1', folder: '/work', name: 'Fix login', argv: resumed }]],
    'the conversation opens in a new tab with the same space, folder and title');
  assert.equal(commands.some(([name]) => name === 'tab.close'), false, 'the stale tab stays until the new one shows');

  world.spaces = [space([tab('tab-1'), tab('tab-2')])];
  world.panes = [{ pane: 'p2', terminal: 't2', tab: 'tab-2' }];
  world.agents = [agentRow({ address: 't2', tab: 'tab-2', pane: 'p2' })];
  world.terminals = [shellTerminal(), agentTerminal({ address: 't2', argv: resumed, created_ms: 6500 })];
  await resume.tick(8000);
  assert.deepEqual(commands.filter(([name]) => name === 'tab.close'), [['tab.close', { id: 'tab-1' }]]);
  assert.equal(commands.filter(([name]) => name === 'tab.new').length, 1, 'one attempt per session');
  assert.equal(memory[KEY]['tab-1'], undefined, 'the stale record is replaced, not kept');
  assert.deepEqual(memory['herdr-zed.threads']['tab-2'], { profile: null, source: 'herdr-zed', replaces: 'tab-1' },
    'the new tab says which tab it continues, so a task linked to the old tab follows it');
  assert.equal(notices.length, 1);
  assert.match(notices[0].title, /Resumed 1 conversation/);
  assert.match(notices[0].body, /Fix login/);
});

test('a resume whose new tab never shows the session times out, keeps the stale tab and says so', async () => {
  const { createThreadResume, RESUME_TIMEOUT_MS } = await evaluate();
  const world = makeWorld({ agents: [], terminals: [shellTerminal()] });
  const { api, commands, notices } = makeApi(world, { memory: { [KEY]: { 'tab-1': record() } } });
  const resume = createThreadResume(api);
  await resume.tick(6000);
  await resume.tick(6000 + RESUME_TIMEOUT_MS + 1);
  assert.equal(commands.some(([name]) => name === 'tab.close'), false);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, 'warning');
  assert.match(notices[0].body, /Not resumed: Fix login/);
});

test('threads closed, archived, exited in place, or with unknown or prompt-bearing launches are not resumed', async () => {
  const { createThreadResume } = await evaluate();

  // Closing the tab removes its record.
  let world = makeWorld({ agents: [], terminals: [shellTerminal()], spaces: [space([])] });
  let made = makeApi(world, { memory: { [KEY]: { 'tab-1': record() } } });
  await createThreadResume(made.api).tick(6000);
  assert.equal(made.memory[KEY]['tab-1'], undefined);
  assert.equal(made.commands.length, 0);

  // The person exited the agent inside the shell while this session watched it: the shell predates the record, so it is
  // not a reboot and the record is dropped.
  world = makeWorld();
  made = makeApi(world, { memory: { [KEY]: { 'tab-1': record() } } });
  const watcher = createThreadResume(made.api);
  await watcher.tick(2000);
  world.agents = []; world.terminals = [shellTerminal('t1', 500)];
  await watcher.tick(4000);
  assert.equal(made.memory[KEY]['tab-1'], undefined);
  assert.equal(made.commands.length, 0);

  // Unknown session id: the thread is left alone and listed once.
  world = makeWorld({ agents: [], terminals: [shellTerminal()] });
  made = makeApi(world, { memory: { [KEY]: { 'tab-1': record({ sessionId: null }) } } });
  const resumer = createThreadResume(made.api);
  await resumer.tick(6000);
  await resumer.tick(8000);
  assert.equal(made.commands.length, 0);
  assert.equal(made.notices.length, 1, 'listed once');
  assert.match(made.notices[0].body, /Fix login: session not identified/);

  // A positional prompt would be sent again on resume: refused and listed.
  const prompted = ['env', 'CLAUDE_CONFIG_DIR=/accounts/work', 'claude', 'Please fix the login bug'];
  world = makeWorld({ agents: [], terminals: [shellTerminal()] });
  made = makeApi(world, { memory: { [KEY]: { 'tab-1': record({ command: prompted }) } } });
  await createThreadResume(made.api).tick(6000);
  assert.equal(made.commands.length, 0);
  assert.match(made.notices[0].body, /started with a prompt/);
});

test('a shell older than its record is kept, not dropped, when this session never saw the agent in it', async () => {
  const { createThreadResume } = await evaluate();
  // Startup after a restart: the shell may keep its original creation time, so nothing is decided from that alone.
  const world = makeWorld({ agents: [], terminals: [shellTerminal('t1', 500)] });
  const { api, memory, commands } = makeApi(world, { memory: { [KEY]: { 'tab-1': record() } } });
  await createThreadResume(api).tick(6000);
  assert.deepEqual(memory[KEY]['tab-1'], record());
  assert.equal(commands.length, 0);
});

test('a live agent in the tab is never resumed over', async () => {
  const { createThreadResume } = await evaluate();
  const world = makeWorld({ terminals: [shellTerminal()] });
  const { api, commands } = makeApi(world, { memory: { [KEY]: { 'tab-1': record() } } });
  await createThreadResume(api).tick(6000);
  assert.equal(commands.length, 0);
});

test('Windows identity comes from the shared Windows helper for Claude and Codex', async () => {
  const { createThreadResume } = await evaluate();
  const claudeFile = `C:\\Users\\me\\.claude\\projects\\C--work\\${ID}.jsonl`;
  const world = makeWorld();
  const made = makeApi(world, { platform: 'windows', exec: async () => ({ code: 0, stdout: JSON.stringify({ file: claudeFile }) }) });
  await createThreadResume(made.api).tick(1000);
  assert.equal(made.memory[KEY]['tab-1'].sessionId, ID);
  assert.deepEqual(made.reads, [['node', ['/appdata/mods/herdr-zed/components/agent-session-windows.js', '44', 'claude', '/accounts/work']]],
    'no Unix lookup on Windows');

  const codexRow = agentRow({ app: 'codex', program: { key: 'codex', name: 'Codex', agent: true } });
  const codexTerminal = agentTerminal({ argv: ['env', 'CODEX_HOME=/accounts/codex', 'codex', '--no-daemon'], foreground: { pid: 55, name: 'codex', argv: ['codex'] } });
  const codexFile = `C:\\Users\\me\\.codex\\sessions\\2026\\11\\01\\rollout-2026-11-01T00-00-00-${ID2}.jsonl`;
  const second = makeApi(makeWorld({ agents: [codexRow], terminals: [codexTerminal] }),
    { platform: 'windows', exec: async () => ({ code: 0, stdout: JSON.stringify({ file: codexFile }) }) });
  await createThreadResume(second.api).tick(1000);
  assert.equal(second.memory[KEY]['tab-1'].sessionId, ID2);
  assert.equal(second.memory[KEY]['tab-1'].kind, 'codex');
  assert.deepEqual(second.reads[0][1], ['/appdata/mods/herdr-zed/components/agent-session-windows.js', '55', 'codex', '/accounts/codex']);
});

test('the preference turns resumption off, while identities are still recorded', async () => {
  const { createThreadResume, autoResumeEnabled } = await evaluate();
  assert.equal(autoResumeEnabled(undefined), true);
  assert.equal(autoResumeEnabled(true), true);
  assert.equal(autoResumeEnabled(false), false);

  const world = makeWorld();
  const made = makeApi(world, { memory: { 'herdr-zed.auto-resume': false } });
  const resume = createThreadResume(made.api);
  await resume.tick(1000);
  assert.equal(made.memory[KEY]['tab-1'].sessionId, ID, 'identity is recorded with the preference off');

  world.agents = []; world.terminals = [shellTerminal()];
  await resume.tick(6000);
  assert.equal(made.commands.length, 0, 'nothing is resumed');
  assert.equal(made.notices.length, 0, 'and nothing is announced');
  assert.equal(made.memory[KEY]['tab-1'].sessionId, ID, 'the record is kept for when it is turned on');
});

test('nothing happens until the local layout and its spaces have loaded', async () => {
  const { createThreadResume } = await evaluate();
  const world = makeWorld({ machines: [{ name: null, layout: 'loading' }], agents: [], terminals: [shellTerminal()] });
  const made = makeApi(world, { memory: { [KEY]: { 'tab-1': record() } } });
  await createThreadResume(made.api).tick(6000);
  assert.equal(made.commands.length, 0);
  assert.equal(made.writes.length, 0);
  assert.equal(made.memory[KEY]['tab-1'].updatedAt, 1000);
});

test('the plain-shell heuristic accepts only an idle shell and rejects agents and running commands', async () => {
  const { isPlainShell } = await evaluate();
  assert.equal(isPlainShell(shellTerminal()), true);
  assert.equal(isPlainShell(agentTerminal()), false, 'an agent terminal is not a shell');
  assert.equal(isPlainShell({ ...shellTerminal(), report: { app: 'claude-code' } }), false);
  assert.equal(isPlainShell({ ...shellTerminal(), foreground: { pid: 77, name: 'sh', argv: ['sh', '-c', 'npm test'] } }), false);
  assert.equal(isPlainShell({ ...shellTerminal(), foreground: undefined }), false);
  assert.equal(isPlainShell({ ...shellTerminal(), state: 'finished' }), false);
});

test('archived conversations are removed from the resume records by the identity helper', () => {
  const kept = { 'tab-2': record({ tabId: 'tab-2' }) };
  assert.deepEqual(identity.recordsWithout({ 'tab-1': record(), ...kept }, 'tab-1'), kept);
  assert.deepEqual(identity.recordsWithout(undefined, 'tab-1'), {});
});
