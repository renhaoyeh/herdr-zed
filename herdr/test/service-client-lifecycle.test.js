import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

for (const [file, name, mod] of [
  ['system-monitor', 'SystemMonitor', 'devkits-system'],
  ['usage', 'UsageClient', 'devkits-usage'],
]) test(`${name} stays silent across layout teardown and stops renewing closed subscriptions`, async () => {
  let layout = { content: { mod: 'trading-agents' } };
  const commands = [], timers = [];
  const host = { layout: () => layout, run: command => commands.push(command),
    nextCommand: () => new Promise(() => {}), shared: () => null };
  const Client = (await evaluateNative(`../mods/devkits/components/${file}.js`, host, name))[name];
  const client = new Client({ receiver: 'devkits' });
  client.close();
  assert.deepEqual(commands, [], 'Constructed but uninitialized views never unsubscribe');
  const cx = { spawn: fn => fn(cx), notify() {}, timer: { every: (_ms, tick) => timers.push(tick) } };
  client.init(cx);
  const tick = () => { for (const timer of timers) timer(cx); };
  tick(); client.refresh?.();
  assert.deepEqual(commands, [], 'No service in this layout means no commands');

  layout = { children: [{ content: { mod, props: { view: 'details' } } }] };
  tick();
  assert.deepEqual(commands, [], 'A details view cannot substitute for the service');
  layout = { children: [{ children: [{ content: { mod, props: { view: 'service' } } }] }] };
  tick();
  assert.equal(commands.length, 1, 'Nested service mounts accept subscriptions again');
  assert.equal(JSON.parse(decodeURIComponent(commands[0].split(':').slice(1).join(':'))).active, true);

  layout = { content: { mod: 'trading-agents' } };
  tick(); client.refresh?.(); client.close(); tick();
  assert.equal(commands.length, 1, 'Switching away and closing cannot address a removed provider');
  layout = { content: { mod, props: { view: 'service' } } };
  tick();
  assert.equal(commands.length, 1, 'A closed client stays closed after its provider returns');
  const live = new Client({ receiver: 'devkits' }); live.init(cx); live.close(); live.close(); tick();
  assert.equal(commands.length, 2, 'Closing stops renewal without queueing a command that could outlive the provider');
});
