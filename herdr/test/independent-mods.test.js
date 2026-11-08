import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { boardKey, taskActions } from '../mods/devkits-tasks/agent-board-model.js';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
};
const input = { new: () => { let value = ''; return { value: () => value, set_value(next) { value = next; }, on() {}, focus() {}, set_auto_grow() {} }; } };
const cx = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {} };

for (const provider of ['asana', 'mantisbt']) test(`${provider} runs across module contexts and imports only a confirmed local Tasks draft`, async () => {
  const sessionStorage = storage(), memory = {}, overlays = [], closed = [], tasks = [], drafts = [];
  const base = {
    globalThis: { window: { sessionStorage } }, shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); },
    openOverlay: spec => { overlays.push(spec); return 'source-overlay'; }, closeOverlay: id => closed.push(id),
  };
  const channelNames = 'createSourceChannel, sourceChannel, sourceChannels, publishSourceEvent, consumeSourceEvents, closeSourceChannel, sourceModuleOptions';
  const host = { ...base, folderKey: value => value.replace(/\/+$/, ''), notify: message => assert.fail(message.body) };
  Object.assign(host, await evaluateNative('../mods/devkits/components/source-channel.js', host, channelNames));
  const { TaskSources } = await evaluateNative('../mods/devkits-tasks/task-sources.js', host, 'TaskSources');
  const project = { id: 'original', name: 'Original', folder: '/original' };
  const consumer = new TaskSources((context, snapshot) => drafts.push({ context, snapshot }));
  consumer.open(project, provider);
  const target = { ...overlays.at(-1).props, overlay: 'source-overlay' };
  assert.equal(overlays.at(-1).mod, `devkits-${provider}`);
  // The provider gets serialized props, never a function or native view belonging to Devkits.
  assert.deepEqual(JSON.parse(JSON.stringify(target)), target);
  const sourceContext = { ...base, globalThis: { window: { sessionStorage: storage() } } };
  Object.assign(sourceContext, await evaluateNative('../mods/devkits/components/source-channel.js', sourceContext, channelNames));
  Object.assign(sourceContext, await evaluateNative('../mods/devkits/components/task-source-model.js', sourceContext, 'filterTasks, sourceTaskSnapshot'));
  const { TaskSourceController } = await evaluateNative('../mods/devkits/components/task-source.js', sourceContext, 'TaskSourceController');
  const source = { key: provider, ...(provider === 'mantisbt' ? { server: true, normalizeUrl: url => url.replace(/\/+$/, '') } : {}) };
  const browser = new TaskSourceController(sourceContext.sourceModuleOptions(source, target));
  const binding = { gid: 'p1', name: 'Tracker', ...(provider === 'mantisbt' ? { server: 'https://tracker.test' } : {}) };
  browser.setBinding('/original', binding);
  const task = { gid: 'same-id', name: 'Source task', notes: 'Original description', url: 'https://tracker.test/task/same-id',
    parent: { gid: 'parent', name: 'Parent', url: 'https://tracker.test/parent', token: 'private' },
    comments: [{ author: 'Amy', text: 'Keep this context', token: 'private' }], token: 'private' };
  browser.detail = task; browser.server = 'https://tracker.test/';
  assert.equal(browser.import(), true);
  sourceContext.publishSourceEvent(target.channel, { type: 'close' });
  assert.equal(tasks.length, 0); assert.equal(drafts.length, 0, 'The producer does not create a local task');
  consumer.poll(cx); consumer.poll(cx);
  assert.equal(drafts.length, 1); assert.equal(drafts[0].context.folder, '/original');
  assert.equal(drafts[0].snapshot.source, provider);
  assert.equal(JSON.stringify(drafts).includes('private'), false, 'Credentials and arbitrary UI/connection fields never cross the import boundary');
  assert.deepEqual(memory[`devkits.${provider}-projects`]['["","/original"]'], binding);
  assert.equal(host.sourceChannels('devkits-tasks').length, 0);
  const composerHost = { ...base, boardKey, taskActions, liveAgents: () => [], InputState: input, TextareaState: input, SelectState: class {},
    createLocalTask: (_project, name, notes, fields) => { const result = { gid: 'local:1', source: 'local', name, notes, ...fields }; tasks.push(result); return result; },
  };
  const { TaskComposer } = await evaluateNative('../mods/devkits-tasks/task-composer.js', composerHost, 'TaskComposer');
  const composer = new TaskComposer(); composer.init({ project: drafts[0].context, importTask: drafts[0].snapshot, overlay: 'composer' }, cx);
  assert.equal(tasks.length, 0);
  composer.title.set_value('My title'); composer.description.set_value('Edited instructions'); composer.submit([]);
  assert.equal(tasks.length, 1); assert.equal(tasks[0].source, 'local'); assert.equal(tasks[0].status, 'todo');
  assert.equal(tasks[0][provider].gid, 'same-id'); assert.equal(tasks[0][provider].parent.name, 'Parent');
  assert.equal(tasks[0][provider].comments[0].text, 'Keep this context'); assert.equal(tasks[0].notes, 'Edited instructions');
  if (provider === 'mantisbt') assert.equal(tasks[0].mantisbt.server, 'https://tracker.test');
});

test('closing a source window consumes its request without importing, while other project requests remain independent', async () => {
  const sessionStorage = storage(), overlays = [], imported = [], memory = {};
  const host = { globalThis: { window: { sessionStorage } }, shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); }, folderKey: path => path,
    openOverlay: spec => overlays.push(spec), notify: message => assert.fail(message.body) };
  Object.assign(host, await evaluateNative('../mods/devkits/components/source-channel.js', host,
    'createSourceChannel, sourceChannels, consumeSourceEvents, closeSourceChannel, publishSourceEvent'));
  const { TaskSources } = await evaluateNative('../mods/devkits-tasks/task-sources.js', host, 'TaskSources');
  const consumer = new TaskSources((project, task) => imported.push([project.folder, task.gid]));
  consumer.open({ id: 'a', folder: '/a' }, 'asana'); consumer.open({ id: 'b', folder: '/b' }, 'asana');
  host.publishSourceEvent(overlays[0].props.channel, { type: 'close' });
  host.publishSourceEvent(overlays[1].props.channel, { type: 'import', snapshot: { source: 'asana', gid: 'same-id' } });
  consumer.poll(cx);
  assert.deepEqual(imported, [['/b', 'same-id']]);
});

test('SYSTEM samples in its service only and broadcasts snapshots to isolated mod contexts without persisting data', async t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const endpoints = [], commands = [], errors = [], sharedWrites = [];
  const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
  const data = { cpu: 42, cores: 2, updatedAt: now, sample: { internal: true } };
  let finish;
  const endpoint = mod => {
    const endpoint = { mod, waiting: null }; endpoints.push(endpoint);
    return { globalThis: { window: { sessionStorage: storage() } }, shared: () => null, setShared: (...args) => sharedWrites.push(args),
      appHome: () => '/herdr', Button() {}, glyph() {},
      nextCommand: () => new Promise(resolve => { endpoint.waiting = resolve; }),
      run: command => { const dot = command.indexOf('.'), receiver = command.slice(0, dot), message = command.slice(dot + 1);
        for (const target of endpoints) if (target.mod === receiver && target.waiting) { const resolve = target.waiting; target.waiting = null; resolve(message); }
      },
      exec: (...args) => { commands.push(args); return new Promise(resolve => { finish = resolve; }); },
    };
  };
  const context = () => ({ ...cx, timer: { callbacks: [], every(_ms, tick) { this.callbacks.push(tick); } },
    spawn(task) { task(this).catch(error => errors.push(error)); } });
  const exports = 'SystemMonitor, systemClientPrefix, systemSnapshotPrefix, systemCommand, systemMessage, hardwareColors, hardwareAvailable, hardwareTitle, primaryHardwareGPU, hardwareValue, hardwareSubtitle, hardwareChart';
  const providerHost = endpoint('devkits-system');
  Object.assign(providerHost, await evaluateNative('../mods/devkits/components/system-monitor-model.js', providerHost,
    'hardwareModules, hardwarePreferences, selectedHardwareCores, hardwareBytes, hardwarePercent, hardwareSpeed, hardwarePower, hardwarePoint, hardwareSensorSummary, appendHardwareHistory, hardwareChartPoints'));
  Object.assign(providerHost, await evaluateNative('../mods/devkits/components/system-monitor-topology.js', providerHost, 'processorLabel, topologyGroups, topologyLabel'));
  Object.assign(providerHost, await evaluateNative('../mods/devkits/components/system-monitor.js', providerHost, exports));
  providerHost.SystemClient = providerHost.SystemMonitor;
  Object.assign(providerHost, await evaluateNative('../mods/devkits-system/monitor.js', providerHost, 'SystemMonitorCore'));
  Object.assign(providerHost, { View: class {}, props: () => ({ view: 'service' }) });
  const { SystemMod } = await evaluateNative('../mods/devkits-system/main.js', providerHost, 'SystemMod');
  const service = new SystemMod(), serviceCx = context(); service.init(null, serviceCx);
  assert.equal(commands.length, 0, 'No reader runs without consumers');
  const clientHost = { ...providerHost, ...endpoint('devkits') };
  const { SystemMonitor } = await evaluateNative('../mods/devkits/components/system-monitor.js', clientHost, 'SystemMonitor');
  const client = new SystemMonitor({ receiver: 'devkits' }); client.init(context()); await flush();
  service.monitor.poll(serviceCx); assert.equal(commands.length, 1);
  // Details owns a separate context/storage and registers another consumer instead of sampling.
  const detailHost = { ...providerHost, ...endpoint('devkits-system'), props: () => ({ view: 'details' }) };
  detailHost.SystemMonitor = (await evaluateNative('../mods/devkits/components/system-monitor.js', detailHost, 'SystemMonitor')).SystemMonitor;
  const Detail = (await evaluateNative('../mods/devkits-system/main.js', detailHost, 'SystemMod')).SystemMod;
  const details = new Detail(); details.init(null, context()); await flush();
  assert.equal(commands.length, 1, 'Opening details cannot launch another reader');
  assert.match(commands[0][1][0], /mods\/devkits-system\/hardware-reader.js$/);
  finish({ code: 0, stdout: JSON.stringify(data) }); await flush();
  for (const tick of serviceCx.timer.callbacks) tick(serviceCx); await flush();
  assert.equal(client.snapshot().data.cpu, 42); assert.equal(details.monitor.hardware.cpu, 42);
  assert.equal(client.snapshot().data.sample, undefined, 'Private reader state is not broadcast');
  assert.equal(typeof client.refresh, 'undefined'); assert.deepEqual(sharedWrites, []);
  client.close(); details.close(); await flush(); now += 10000;
  for (const tick of serviceCx.timer.callbacks.slice().reverse()) tick(serviceCx); await flush();
  assert.equal(commands.length, 1, 'Closing all consumers stops service sampling');
  const history = service.monitor.hardwareHistory;
  clientHost.run('devkits-system.reset'); await flush();
  assert.deepEqual(sharedWrites, [['devkits.system-monitor', providerHost.hardwarePreferences()]]);
  assert.equal(service.monitor.hardwareHistory, history, 'Reset preserves warm readings and history');
  assert.equal(commands.length, 1, 'Reset does not start a reader');
  assert.deepEqual(errors, []);
});
