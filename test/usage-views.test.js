import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sessions from '../components/session-model.js';
import { evaluateNative } from './source-harness.js';

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const now = Date.now();
const windows = [{ bucket: 'codex', name: 'Codex', slot: 'five_hour', minutes: 300, usedPercent: 42, resetsAt: now / 1000 + 1800 }];
const snapshot = { contexts: { null: { machine: null, loading: false, error: null,
  choices: [
    { key: 'codex', name: 'Codex · Work', provider: 'codex', agent: { key: 'codex', name: 'Codex', icon: 'codex' } },
    { key: 'claude', name: 'Claude · Team', provider: 'claude', agent: { key: 'claude', name: 'Claude', icon: 'claude' } },
  ],
  usage: [{ key: 'codex', plan: 'plus', email: 'me@example.com', fetchedAt: now, windows }] } } };

// Records what each rendered view creates: element ids, text children and the click handler of each id.
async function harness(memory = { 'herdr-zed.usage.snapshot': snapshot }) {
  const nodes = new Map(), texts = [], opened = [], runs = [], writes = [], ticks = [];
  let current = {};
  const element = () => {
    const target = {};
    const proxy = new Proxy(target, { get: (_target, key) => (...args) => {
      if (key === 'when') { if (args[0]) args[1](proxy); }
      else if (key === 'id') nodes.set(args[0], target);
      else if (key === 'on_click') target.click = args[0];
      else if (key === 'child' && typeof args[0] === 'string') texts.push(args[0]);
      return proxy;
    } });
    return proxy;
  };
  const cx = { notify() {}, focus_handle: () => ({ focus() {} }), timer: { every: (ms, tick) => ticks.push(tick) }, spawn() {} };
  const base = { ...sessions, div: element, v_flex: element, h_flex: element, glyph: element, AgentIcon: element,
    Button: id => element().id(id), Progress: id => element().id(id),
    DialogContent: id => element().id(id), DialogTitle: element, DialogDescription: element, DialogFooter: element,
    DialogHeader: (_theme, title, { id }) => { texts.push(title); return element().id(id); },
    shared: key => clone(memory[key]), setShared: (key, value) => { memory[key] = clone(value); writes.push(key); },
    openOverlay: spec => { opened.push(spec); return spec; }, closeOverlay() {}, run: command => runs.push(command),
    layout: () => ({ content: { mod: 'herdr-zed-agents', props: { view: 'service' } } }),
    spaces: () => [], theme: () => ({}), props: () => current,
  };
  const { UsageClient } = await evaluateNative('../components/usage.js', base, 'UsageClient');
  const { UsageDetails } = await evaluateNative('../mods/herdr-zed-agents/usage/details.js', base, 'UsageDetails');
  const host = { ...base, View: class {}, AccountLogin: class {}, AgentClient: class {}, AgentsService: class {}, UsageService: class {},
    Analytics: class {}, UsageClient, UsageDetails, newTerminalCommand: () => '', discoverAgents: async () => [],
    autoLauncherKey: 'auto', folderKey: () => '', sessionMenu: {}, accountActions: {}, agentProfiles: {}, mcpSetupSettings: {},
    devkitsSettings: {}, eccSettings: {}, sharedMcpSettings: {}, globalRulesSettings: {}, agentSelection: {} };
  const { AgentsMod } = await evaluateNative('../mods/herdr-zed-agents/main.js', host, 'AgentsMod');
  // Each mount is a fresh view instance, as the shell creates one per surface or dialog.
  const mount = (view, extra = {}) => { current = { view, overlay: `${view}-overlay`, ...extra }; texts.length = 0; nodes.clear();
    const mod = new AgentsMod(); mod.init({}, cx); return mod.render(cx); };
  return { mount, nodes, texts, opened, runs, cx, writes, ticks, memory };
}

test('the sidebar Usage surface renders each account whose quota can be read, opens details and the token statistics dialog', async () => {
  const h = await harness();
  h.mount('usage-sidebar');
  assert.ok(h.texts.includes('Work'));
  assert.ok(!h.texts.includes('Team'), 'an account without a readable quota is not listed');
  assert.ok(!h.nodes.has('usage-claude'), 'no row for it');
  assert.ok(!h.texts.some(text => text === 'Not supported' || text === 'No quota' || text === 'Unavailable'), 'no status noise');
  assert.ok(h.nodes.has('usage-codex') && h.nodes.has('usage-meter-codex-300') && h.nodes.has('open-token-statistics'));
  assert.ok(!h.nodes.has('usage-add-account'), 'the link shows only when nothing is readable');
  h.nodes.get('usage-codex').click(null, h.cx);
  assert.equal(h.opened.at(-1).props.view, 'usage-details');
  assert.equal(h.opened.at(-1).props.account.name, 'Codex · Work');
  h.nodes.get('open-token-statistics').click(null, h.cx);
  assert.deepEqual(h.opened.at(-1).props, { view: 'token-statistics' });
  assert.ok(h.runs.some(command => command.startsWith('herdr-zed-agents.')), 'the view registers a lease with the Usage service');
});

test('the status bar Usage surface renders one item per account with a readable quota and opens its details', async () => {
  const h = await harness();
  h.mount('usage-status');
  assert.ok(h.nodes.has('status-usage-codex'));
  assert.ok(!h.nodes.has('status-usage-claude'), 'an account without a readable quota has no item');
  assert.ok(h.texts.includes('Work'));
  assert.ok(h.texts.includes('5h 42%'));
  h.nodes.get('status-usage-codex').click(null, h.cx);
  assert.equal(h.opened.at(-1).props.view, 'usage-details');
});

test('the usage details dialog renders the account windows without throwing', async () => {
  const h = await harness();
  const account = { name: 'Work', supported: true, error: null, fetchedAt: now, windows };
  h.mount('usage-details', { account });
  assert.ok(h.texts.includes('Work'));
  assert.ok(h.texts.some(text => text.includes('42% used')));
  assert.ok(h.nodes.has('usage-details-close'), 'the header X closes it; there is no Done footer');
  assert.ok(!h.nodes.has('usage-details-done'));
});

test('Usage views render without a snapshot: one muted line and a link to add an account, and an empty status item', async () => {
  const h = await harness({});
  h.mount('usage-sidebar');
  assert.ok(h.nodes.has('account-usage-list'));
  assert.ok(h.texts.includes('No usage to show'));
  assert.ok(h.nodes.has('usage-add-account'));
  h.nodes.get('usage-add-account').click(null, h.cx);
  assert.equal(h.runs.at(-1), 'herdr-zed.settings:agents', 'the link opens the Agents Settings page');
  h.mount('usage-status');
  assert.equal(h.nodes.has('status-usage-codex'), false);
  assert.equal(h.texts.includes('Account usage'), false, 'the status item draws no group when nothing is readable');
});

test('the status reading reports to the shell when it has nothing to show, from its timer and only when that changes', async () => {
  const memory = { 'herdr-zed.usage.snapshot': snapshot };
  const h = await harness(memory);
  const key = 'herdr-zed.surface-empty.agents.usage-status';
  const tickAll = () => h.ticks.forEach(tick => tick(h.cx));
  const writesTo = () => h.writes.filter(name => name === key).length;
  h.mount('usage-status');
  assert.equal(memory[key], false, 'a readable account shows the reading');
  const written = writesTo();
  tickAll();
  assert.equal(writesTo(), written, 'no write while nothing changes');
  memory['herdr-zed.usage.snapshot'] = { contexts: { null: { ...snapshot.contexts.null, usage: [] } } };
  tickAll();
  assert.equal(memory[key], true, 'no readable quota reports the reading empty');
  assert.equal(writesTo(), written + 1);
  tickAll();
  assert.equal(writesTo(), written + 1, 'the same value is not written again');
  memory['herdr-zed.usage.snapshot'] = snapshot;
  tickAll();
  assert.equal(memory[key], false);
  assert.equal(writesTo(), written + 2);
});
