import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, scan, compactEvents } from '../mods/herdr-zed-agents/usage/analytics-reader.js';
import { summarize, localDay } from '../mods/herdr-zed-agents/usage/analytics-model.js';
import { estimateCost, costLabel, pricingDate } from '../mods/herdr-zed-agents/usage/analytics-pricing.js';

const stamp = new Date(2026, 10, 6, 12).toISOString();
const meta = { type: 'session_meta', payload: { id: 'one', cwd: '/project' } };
const token = (input, cached, output) => ({ timestamp: stamp, payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output },
} } });
const write = (file, records) => writeFile(file, records.map(o => JSON.stringify(o)).join('\n') + '\n');

test('Codex counts cumulative differences, skips repeated snapshots and separates cached input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analytics-')), path = join(root, 'one.jsonl');
  await write(path, [meta, { type: 'turn_context', payload: { model: 'test-model' } }, token(100, 80, 10), token(100, 80, 10), token(150, 100, 20)]);
  const events = await parseTranscript(path, 'codex'), result = summarize(events, 1, new Date(stamp));
  assert.equal(events.length, 2);
  assert.deepEqual(result.totals, { input: 50, output: 20, cacheRead: 100, cacheWrite: 0, reasoning: 0, total: 170 });
  assert.equal(result.model[0].label, 'test-model'); assert.equal(result.sessions, 1);
  assert.equal(result.daily[0].label, localDay(new Date(stamp)));
  assert.deepEqual(summarize(compactEvents(events), 1, new Date(stamp)).totals, result.totals);
});

test('Claude replaces streamed message revisions and includes cache creation without counting thinking twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analytics-')), path = join(root, 'one.jsonl');
  const response = output => ({ type: 'assistant', timestamp: stamp, sessionId: 'claude-one', cwd: '/project',
    message: { id: 'message-one', model: 'claude-test', usage: { input_tokens: 2, output_tokens: output,
      cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens_details: { thinking_tokens: 5 } } } });
  await write(path, [response(6), response(20)]);
  const events = await parseTranscript(path, 'claude');
  assert.equal(events.length, 1); assert.equal(events[0].total, 132); assert.equal(events[0].reasoning, 5);
});

test('scan deduplicates copied transcripts, reuses cache, handles append and incomplete final lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analytics-')), cache = join(root, 'cache.json');
  await mkdir(join(root, 'sessions')); const a = join(root, 'sessions', 'a.jsonl'), b = join(root, 'sessions', 'b.jsonl');
  await write(a, [meta, token(100, 80, 10)]); await write(b, [meta, token(100, 80, 10)]);
  const sources = [{ directory: root, provider: 'codex', account: 'Test' }];
  const first = await scan(sources, cache); assert.equal(first.events.length, 1); assert.equal(first.fileCount, 2);
  assert.deepEqual((await scan(sources, cache)).events, first.events);
  await write(a, [meta, token(100, 80, 10), token(150, 100, 20)]);
  await writeFile(a, (await readFile(a, 'utf8')) + '{"type":');
  const next = await scan(sources, cache); assert.equal(next.events.length, 2);
  assert.equal(summarize(next.events, 1, new Date(stamp)).totals.total, 170);
});

test('ranges use local calendar days, fill missing days and compose filters', () => {
  const now = new Date(2026, 10, 6, 12), timestamp = new Date(2026, 10, 5, 0).getTime();
  const events = [{ timestamp, day: localDay(new Date(timestamp)), model: 'a', project: 'p', account: 'c', session: 's', total: 10 }];
  assert.equal(summarize(events, 1, now).totals.total, 0);
  const week = summarize(events, 7, now); assert.equal(week.daily.length, 7); assert.equal(week.totals.total, 10);
  assert.equal(summarize(events, 7, now, { model: 'b' }).totals.total, 0);
  assert.equal(summarize(events, 0, now, { project: 'p', account: 'c' }).sessions, 1);
});

test('provider filters survive compaction and apply to costs, daily totals and every table', () => {
  const now = new Date(stamp), day = localDay(now);
  const base = { timestamp: now.getTime(), day, project: '/shared', account: 'Shared', session: 'shared' };
  const codex = { ...base, provider: 'codex', model: 'gpt-6.1-sol', input: 1e6, total: 1e6 };
  const claude = { ...base, provider: 'claude', model: 'claude-sonnet-4-6', output: 1e6, total: 1e6 };
  const compact = compactEvents([codex, claude]);
  assert.deepEqual(compact.map(event => event.provider), ['codex', 'claude']);
  assert.equal(summarize(compact, 1, now).totals.total, 2e6);
  assert.equal(summarize(compact, 1, now).cost.usd, 17);
  for (const provider of ['codex', 'claude']) {
    const stats = summarize(compact, 1, now, { provider, project: '/shared', day });
    assert.deepEqual(stats, summarize(compact.filter(event => event.provider === provider), 1, now));
    assert.equal(stats.totals.total, 1e6);
    assert.equal(stats.daily[0].total, 1e6);
    assert.equal(stats.sessions, 1);
    for (const key of ['model', 'project', 'account', 'session']) assert.deepEqual(stats[key][0].cost, stats.cost);
  }
  // Identical metadata must still retain separate provider aggregates.
  assert.equal(compactEvents([codex, { ...codex, provider: 'claude' }]).length, 2);
  assert.equal(summarize(compact, 1, now, { provider: 'claude', model: codex.model }).totals.total, 0);
});

test('projects group transcript subfolders by their nearest Git root, including worktrees', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'analytics-')));
  const project = join(root, 'project'); await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(project, '.git'), 'gitdir: unused-reference');
  await mkdir(join(root, 'sessions'));
  await write(join(root, 'sessions', 'one.jsonl'), [{ ...meta, payload: { ...meta.payload, cwd: join(project, 'src') } }, token(100, 80, 10)]);
  const result = await scan([{ directory: root, provider: 'codex', account: 'Test' }]);
  assert.equal(result.events[0].project.toLowerCase(), project.toLowerCase());
});

test('native statistics view switches providers, changes ranges and clears grouped filters', async () => {
  const source = await readFile(new URL('../mods/herdr-zed-agents/usage/analytics.js', import.meta.url), 'utf8');
  const nodes = new Map(), texts = [];
  const element = () => {
    const state = {};
    const proxy = new Proxy(state, { get: (_target, key) => (...args) => {
      if (key === 'when') { if (args[0]) args[1](proxy); }
      else if (key === 'id') nodes.set(args[0], state);
      else if (key === 'on_click') state.click = args[0];
      else if (key === 'child' && typeof args[0] === 'string') texts.push(args[0]);
      return proxy;
    } });
    return proxy;
  };
  let closed = false;
  const host = { div: element, image: element, h_flex: element, v_flex: element, theme: () => ({}), summarize, costLabel, pricingDate,
    props: () => ({ overlay: 'statistics' }), closeOverlay: () => { closed = true; },
    Button: id => element().id(id), DialogContent: id => element().id(id), DialogTitle: element,
    DialogDescription: element, DialogFooter: element };
  const Type = new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace('export default class', 'return class'))(...Object.values(host));
  const view = new Type(); view.days = 30; view.tab = 'model'; view.page = 0; view.filters = {};
  const day = localDay(new Date());
  view.data = { events: [
    { timestamp: Date.now(), day, provider: 'codex', model: 'test-model', project: '/p', account: 'Test', session: 's', total: 123 },
    { timestamp: Date.now(), day, provider: 'claude', model: 'claude-sonnet-4-6', project: '/p', account: 'Claude', session: 'c', input: 1e6, total: 1e6 },
  ], fileCount: 2, updatedAt: Date.now() };
  view.render(); assert.ok(nodes.has('token-statistics')); assert.ok(texts.includes('test-model'));
  assert.ok(texts.includes('Est. cost · USD')); assert.ok(nodes.has('analytics-total-cost'));
  const cx = { notify() {} };
  nodes.get('analytics-provider-codex').click(null, cx); assert.deepEqual(view.filters, { provider: 'codex' });
  texts.length = 0; view.render();
  assert.ok(texts.includes('test-model')); assert.ok(!texts.includes('claude-sonnet-4-6'));
  nodes.get('analytics-range-7').click(null, cx); assert.equal(view.days, 7);
  nodes.get('analytics-row-0').click(null, cx); assert.deepEqual(view.filters, { provider: 'codex', model: 'test-model' });
  view.filters = { ...view.filters, account: 'Test', project: '/p', day }; view.page = 3;
  nodes.get('analytics-provider-claude').click(null, cx);
  assert.deepEqual(view.filters, { provider: 'claude', project: '/p', day });
  assert.equal(view.page, 0); assert.equal(view.days, 7);
  texts.length = 0; view.render();
  assert.ok(texts.includes('claude-sonnet-4-6')); assert.ok(!texts.includes('test-model')); assert.ok(texts.includes('$3.00'));
  nodes.get('analytics-provider-all').click(null, cx);
  assert.deepEqual(view.filters, { project: '/p', day });
  texts.length = 0; view.render(); assert.ok(texts.includes('test-model')); assert.ok(texts.includes('claude-sonnet-4-6'));
  nodes.get('analytics-provider-claude').click(null, cx);
  view.render(); nodes.get('analytics-clear').click(null, cx); assert.deepEqual(view.filters, {});
  nodes.get('analytics-tab-session').click(null, cx); assert.equal(view.tab, 'session');
  nodes.get('analytics-done').click(); assert.ok(closed);
});

test('estimates separate token categories, dated models and cache TTL without double counting reasoning', () => {
  const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0, reasoning: 1e6 };
  assert.equal(estimateCost({ ...usage, model: 'gpt-5.2-codex' }), 15.925);
  assert.equal(estimateCost({ ...usage, model: 'gpt-6.1-sol' }), 12.1);
  assert.equal(estimateCost({ ...usage, model: 'claude-opus-4-5-20251101', cacheWrite: 2e6, cacheWrite1h: 1e6 }), 46.75);
  for (const model of ['Unknown model', 'opus', 'gpt-6.1-sol-preview', 'claude-opus-99', '__proto__']) {
    assert.equal(estimateCost({ ...usage, model }), null);
  }
  assert.equal(estimateCost({ ...usage, model: 'gpt-5.2-codex', cacheWrite: 100 }), null);
  assert.equal(costLabel({ usd: 0.001, pricedTokens: 10, unpricedTokens: 0 }), '<$0.01');
  assert.equal(costLabel({ usd: 0, pricedTokens: 0, unpricedTokens: 10 }), '');
  assert.equal(costLabel({ usd: 0, pricedTokens: 0, unpricedTokens: 0 }), '$0.00');
});

test('mixed-model costs survive compaction and aggregate through every grouping and filter', () => {
  const timestamp = Date.parse(stamp), day = localDay(new Date(stamp));
  const base = { timestamp, day, project: '/p', account: 'A', session: 's' };
  const events = [
    { ...base, model: 'claude-sonnet-4-6', input: 1e6, cacheWrite: 2e6, cacheWrite1h: 1e6, total: 3e6 },
    { ...base, model: 'gpt-6.1-sol', output: 1e6, total: 1e6 },
    { ...base, model: 'unknown', total: 100 },
  ];
  const stats = summarize(events, 1, new Date(stamp));
  assert.deepEqual(stats.cost, { usd: 22.75, pricedTokens: 4e6, unpricedTokens: 100 });
  assert.equal(costLabel(stats.cost), '$22.75');
  for (const key of ['project', 'account', 'session']) assert.deepEqual(stats[key][0].cost, stats.cost);
  assert.deepEqual(stats.daily[0].cost, stats.cost);
  assert.deepEqual(summarize(compactEvents(events), 1, new Date(stamp)).cost, stats.cost);
  assert.equal(summarize(events, 1, new Date(stamp), { model: 'gpt-6.1-sol' }).cost.usd, 10);
  assert.equal(summarize(events, 1, new Date(stamp), { model: 'unknown' }).cost.pricedTokens, 0);
});

test('Claude preserves one-hour cache creation through transcript parsing and compaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analytics-')), path = join(root, 'one.jsonl');
  await write(path, [{ type: 'assistant', timestamp: stamp, sessionId: 's', message: { id: 'm', model: 'claude-sonnet-4-6',
    usage: { cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 150 } } } }]);
  const events = await parseTranscript(path, 'claude');
  assert.equal(events[0].cacheWrite1h, 150);
  assert.equal(events[0].total, 200);
  assert.equal(compactEvents(events)[0].cacheWrite1h, 150);
  assert.equal(estimateCost(events[0]), (50 * 3.75 + 150 * 6) / 1e6);
});
