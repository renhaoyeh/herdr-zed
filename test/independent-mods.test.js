import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { boardKey, taskActions } from '../mods/herdr-zed-tasks/agent-board-model.js';

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
  const project = { id: 'original', name: 'Original', folder: '/original' };
  const sourceContext = { ...base, globalThis: { window: { sessionStorage: storage() } } };
  const { importTarget, importRequest } = await evaluateNative(`../mods/herdr-zed-${provider}/import-target.js`, {}, 'importTarget, importRequest');
  const importer = importTarget({ packages: [{ mod: 'herdr-zed-tasks', title: 'Tasks', enabled: true,
    provides: { importer: { accepts: ['task-snapshot'], view: 'import-draft' } } }] });
  Object.assign(sourceContext, await evaluateNative('../components/task-source-model.js', sourceContext, 'filterTasks, sourceTaskSnapshot'));
  const { TaskSourceController } = await evaluateNative('../components/task-source.js', sourceContext, 'TaskSourceController');
  const source = { key: provider, ...(provider === 'mantisbt' ? { server: true, normalizeUrl: url => url.replace(/\/+$/, '') } : {}) };
  const browser = new TaskSourceController({ source, onImport: snapshot => {
    const request = importRequest(importer, { source: provider, context: project, snapshot });
    overlays.push(request); drafts.push(request.props);
  } });
  const task = { gid: 'same-id', name: 'Source task', notes: 'Original description', url: 'https://tracker.test/task/same-id',
    priority: 'High', customFields: [{ gid: 'effort', name: 'Estimate', type: 'number', value: 0, displayValue: '0', token: 'private' }],
    parent: { gid: 'parent', name: 'Parent', url: 'https://tracker.test/parent', token: 'private' },
    comments: [{ author: 'Amy', text: 'Keep this context', token: 'private' }], token: 'private' };
  browser.detail = task; browser.server = 'https://tracker.test/';
  assert.equal(browser.import(), true);
  assert.equal(tasks.length, 0, 'The producer does not create a local task');
  assert.equal(drafts.length, 1); assert.equal(drafts[0].context.folder, '/original');
  assert.equal(drafts[0].snapshot.source, provider);
  assert.equal(JSON.stringify(drafts).includes('private'), false, 'Credentials and arbitrary UI/connection fields never cross the import boundary');
  assert.deepEqual(JSON.parse(JSON.stringify(drafts[0])), drafts[0]);
  const composerHost = { ...base, boardKey, taskActions, liveAgents: () => [], InputState: input, TextareaState: input, SelectState: class {},
    openTasks() {}, importedTask: () => null, createLocalTask: (_project, name, notes, fields) => { const result = { gid: 'local:1', source: 'local', name, notes, ...fields }; tasks.push(result); return result; },
  };
  const { TaskComposer } = await evaluateNative('../mods/herdr-zed-tasks/task-composer.js', composerHost, 'TaskComposer');
  const composer = new TaskComposer(); composer.init({ project: drafts[0].context, importTask: drafts[0].snapshot, overlay: 'composer' }, cx);
  assert.equal(tasks.length, 0);
  composer.title.set_value('My title'); composer.description.set_value('Edited instructions'); composer.submit([]);
  assert.equal(tasks.length, 1); assert.equal(tasks[0].source, 'local'); assert.equal(tasks[0].status, 'todo');
  assert.equal(tasks[0][provider].gid, 'same-id'); assert.equal(tasks[0][provider].parent.name, 'Parent');
  assert.equal(tasks[0][provider].comments[0].text, 'Keep this context'); assert.equal(tasks[0].notes, 'Edited instructions');
  assert.equal(tasks[0][provider].fields.priority, 'High');
  assert.deepEqual(tasks[0][provider].customFields, [{ gid: 'effort', name: 'Estimate', type: 'number', value: 0, displayValue: '0' }]);
  if (provider === 'mantisbt') assert.equal(tasks[0].mantisbt.server, 'https://tracker.test');
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
      layout: () => ({ content: { mod: 'herdr-zed-system', props: { view: 'service' } } }),
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
  const providerHost = endpoint('herdr-zed-system');
  Object.assign(providerHost, await evaluateNative('../components/system-monitor-model.js', providerHost,
    'hardwareModules, hardwarePreferences, selectedHardwareCores, hardwareBytes, hardwarePercent, hardwareSpeed, hardwarePower, hardwarePoint, hardwareSensorSummary, appendHardwareHistory, hardwareChartPoints, hardwareChartScale, hardwareDisplayItems, hardwareDisplayHistory'));
  Object.assign(providerHost, await evaluateNative('../components/system-monitor-topology.js', providerHost, 'processorLabel, topologyGroups, topologyLabel'));
  Object.assign(providerHost, await evaluateNative('../components/system-monitor.js', providerHost, exports));
  providerHost.SystemClient = providerHost.SystemMonitor;
  Object.assign(providerHost, await evaluateNative('../mods/herdr-zed-system/monitor.js', providerHost, 'SystemMonitorCore'));
  Object.assign(providerHost, { View: class {}, props: () => ({ view: 'service' }), releaseWorkspacePanel() {} });
  const { SystemMod } = await evaluateNative('../mods/herdr-zed-system/main.js', providerHost, 'SystemMod');
  const service = new SystemMod(), serviceCx = context(); service.init(null, serviceCx);
  assert.equal(commands.length, 0, 'No reader runs without consumers');
  const clientHost = { ...providerHost, ...endpoint('herdr-zed') };
  const { SystemMonitor } = await evaluateNative('../components/system-monitor.js', clientHost, 'SystemMonitor');
  const client = new SystemMonitor({ receiver: 'herdr-zed' }); client.init(context()); await flush();
  service.monitor.poll(serviceCx); assert.equal(commands.length, 1);
  // Details owns a separate context/storage and registers another consumer instead of sampling.
  const detailHost = { ...providerHost, ...endpoint('herdr-zed-system'), props: () => ({ view: 'details' }) };
  detailHost.SystemMonitor = (await evaluateNative('../components/system-monitor.js', detailHost, 'SystemMonitor')).SystemMonitor;
  const Detail = (await evaluateNative('../mods/herdr-zed-system/main.js', detailHost, 'SystemMod')).SystemMod;
  const details = new Detail(); details.init(null, context()); await flush();
  assert.equal(commands.length, 1, 'Opening details cannot launch another reader');
  assert.match(commands[0][1][0], /mods\/herdr-zed-system\/hardware-reader.js$/);
  finish({ code: 0, stdout: JSON.stringify(data) }); await flush();
  for (const tick of serviceCx.timer.callbacks) tick(serviceCx); await flush();
  assert.equal(client.snapshot().data.cpu, 42); assert.equal(details.monitor.hardware.cpu, 42);
  assert.equal(client.snapshot().data.sample, undefined, 'Private reader state is not broadcast');
  assert.equal(typeof client.refresh, 'undefined'); assert.deepEqual(sharedWrites, []);
  client.close(); details.close(); await flush(); now += 10000;
  for (const tick of serviceCx.timer.callbacks.slice().reverse()) tick(serviceCx); await flush();
  assert.equal(commands.length, 1, 'Closing all consumers stops service sampling');
  const history = service.monitor.hardwareHistory;
  clientHost.run('herdr-zed-system.reset'); await flush();
  assert.deepEqual(sharedWrites, [['herdr-zed.system-monitor', providerHost.hardwarePreferences()]]);
  assert.equal(service.monitor.hardwareHistory, history, 'Reset preserves warm readings and history');
  assert.equal(commands.length, 1, 'Reset does not start a reader');
  assert.deepEqual(errors, []);
});
