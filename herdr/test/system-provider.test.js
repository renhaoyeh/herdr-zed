import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

function element(calls) {
  return { size_full() { calls.push(['size_full']); return this; }, min_h(value) { calls.push(['min_h', value]); return this; },
    overflow_y_scroll() { calls.push(['overflow_y_scroll']); return this; }, child(value) { calls.push(['child', value]); return this; } };
}

test('SYSTEM widgets scroll inside the bounded native sidebar while inline keeps its compact click renderer', async () => {
  const calls = [], rendered = [], target = { view: 'widgets' }, root = element(calls);
  const monitor = { init() {}, renderWidgets: (...args) => { rendered.push(['widgets', ...args]); return 'widgets'; },
    renderInline: (...args) => { rendered.push(['inline', ...args]); return 'inline'; }, renderDetails() { return 'details'; } };
  const { SystemMod } = await evaluateNative(new URL('../mods/devkits-system/main.js', import.meta.url), {
    View: class {}, div: () => root, props: () => target, theme: () => 'theme', openOverlay() {}, run() {}, nextCommand() {},
    SystemMonitorCore: class { constructor() { return monitor; } }, hardwarePreferences: () => ({}), SystemMonitor: class {},
    systemClientPrefix: 'client:', systemSnapshotPrefix: 'snapshot:', systemCommand: () => '', systemMessage: () => null,
  }, 'SystemMod');
  const mod = new SystemMod(); mod.view = 'widgets'; mod.monitor = monitor;
  mod.render();
  assert.deepEqual(calls, [['size_full'], ['min_h', 0], ['overflow_y_scroll'], ['child', 'widgets']]);
  assert.deepEqual(rendered.at(-1), ['widgets', 'theme', { id: 'system-widgets', style: 'compact', cpuMode: 'total' }]);

  calls.length = 0; target.view = 'inline'; mod.view = 'inline';
  assert.equal(mod.render(), 'inline');
  assert.deepEqual(calls, [], 'inline stays a single compact horizontal renderer without a sidebar scroll wrapper');
  assert.deepEqual(rendered.at(-1), ['inline', 'theme', { id: 'system-inline' }]);
});
