import { systemDisplayPreferences, systemSidebarHeight } from '../mods/devkits/system-display-model.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuSnapshot, cpuPercent, readHardware, parseGPUs, parseDiskCounters, counterRate, diskRates, coreSnapshots, corePercentages } from '../mods/devkits-system/hardware-reader.js';
import { hardwarePreferences, selectedHardwareCores, appendHardwareHistory, hardwareChartPoints, hardwareChartScale, hardwareSensorSummary, hardwareDisplayItems, hardwareDisplayHistory, hardwarePoint } from '../mods/devkits-system/components/system-monitor-model.js';

test('CPU uses elapsed busy time across every core, with an initial warmup sample', () => {
  const before = cpuSnapshot([{ times: { user: 30, sys: 10, idle: 60 } }, { times: { user: 20, sys: 10, idle: 70 } }]);
  const after = cpuSnapshot([{ times: { user: 50, sys: 20, idle: 130 } }, { times: { user: 50, sys: 20, idle: 130 } }]);
  assert.deepEqual(before, { count: 2, idle: 130, total: 200 });
  assert.equal(cpuPercent(null, after), null);
  assert.equal(cpuPercent(before, after), 35);
  assert.equal(cpuPercent(before, before), null);
  assert.equal(cpuPercent(after, before), null);
  assert.equal(cpuPercent(before, { ...after, count: 4 }), null);
  assert.equal(cpuPercent(before, { ...after, idle: 1000 }), null);
  assert.equal(cpuPercent(before, { ...after, idle: before.idle }), 100);
  assert.equal(cpuPercent(before, { ...after, idle: before.idle + 200 }), 0);
});

test('GPU reads real IOAccelerator counters and preserves missing utilization', () => {
  const text = `+-o AGXAccelerator <class IOAccelerator>
    "model" = "Apple M4"
    "PerformanceStatistics" = {"Device Utilization %"=17,"Renderer Utilization %"=12,"Tiler Utilization %"=3}
+-o Other <class IOAccelerator>
    "model" = "Other GPU"
    "PerformanceStatistics" = {"Allocated memory"=8192}`;
  assert.deepEqual(parseGPUs(text), [{ name: 'Apple M4', percent: 17, renderer: 12, tiler: 3 },
    { name: 'Other GPU', percent: null, renderer: null, tiler: null }]);
  assert.deepEqual(parseGPUs(null), []);
  assert.equal(parseGPUs('"PerformanceStatistics" = {"GPU Activity(%)"=9}')[0].percent, 9);
});

test('Apple GPU labels the unified pool and keeps driver memory usage separate from total RAM usage', () => {
  const text = `+-o AGXAcceleratorG16G <class AGXAcceleratorG16G>
    "model" = "Apple M4"
    "PerformanceStatistics" = {"Device Utilization %"=17,"Alloc system memory"=8192,"In use system memory"=4096}`;
  assert.deepEqual(parseGPUs(text, 24 * 1024 ** 3)[0].memory,
    { type: 'unified', total: 24 * 1024 ** 3, used: 4096 });
  assert.equal(parseGPUs(text.replace(',"In use system memory"=4096', ''), 24 * 1024 ** 3)[0].memory.used, null);
  assert.equal(parseGPUs('+-o Other <class IOAccelerator>\n"PerformanceStatistics" = {"Device Utilization %"=5}', 24 * 1024 ** 3)[0].memory, undefined);
});

test('disk I/O excludes disk images and uses elapsed counter deltas without hotplug spikes', () => {
  const text = `+-o IOBlockStorageDriver <class IOBlockStorageDriver, id 0x123, active>
    "Statistics" = {"Bytes (Read)"=1000,"Bytes (Write)"=2000}
  +-o APPLE SSD Media
+-o IOBlockStorageDriver <class IOBlockStorageDriver, id 0x456, active>
    "Statistics" = {"Bytes (Read)"=999999,"Bytes (Write)"=999999}
  +-o Apple Disk Image Media`;
  const current = parseDiskCounters(text);
  assert.deepEqual(current, { '0x123': { read: 1000, write: 2000 } });
  assert.deepEqual(diskRates({ '0x123': { read: 400, write: 800 } }, { ...current, fresh: { read: 99999, write: 99999 } }, 3),
    { read: 200, write: 400 });
  assert.equal(diskRates(null, current, 3), null);
  assert.equal(counterRate({ read: 2000 }, { read: 1000 }, 3, ['read']), null);
  assert.equal(counterRate({ read: 1000 }, { read: 2000 }, 0, ['read']), null);
  assert.equal(counterRate({ read: 1000 }, { read: 2000 }, 60, ['read']), null);
});

test('the local hardware reader returns CPU counters and bounded physical memory', async () => {
  const first = await readHardware();
  assert.equal(first.cpu, null);
  assert.ok(first.sample.count > 0 && first.sample.total > 0);
  assert.equal(first.coreUsage.length, first.cores);
  assert.ok(first.memory.total > 0 && first.memory.percent >= 0 && first.memory.percent <= 100);
  const second = await readHardware(first.sample);
  assert.ok(second.cpu === null || second.cpu >= 0 && second.cpu <= 100);
});

test('per-core CPU deltas preserve real core count and handle topology changes', () => {
  const before = coreSnapshots([{ times: { idle: 50, user: 50 } }, { times: { idle: 80, user: 20 } }]);
  const after = coreSnapshots([{ times: { idle: 100, user: 100 } }, { times: { idle: 100, user: 100 } }]);
  assert.deepEqual(corePercentages(before, after), [50, 80]);
  assert.deepEqual(corePercentages(null, after), [null, null]);
  assert.deepEqual(corePercentages(before.slice(0, 1), after), [null, null]);
});

test('monitor preferences retain module visibility, order and core choices across machine changes', () => {
  const defaultOrder = ['cpu', 'ram', 'gpu', 'storage', 'network', 'disk', 'battery', 'sensors'];
  assert.deepEqual(hardwarePreferences().order, defaultOrder);
  assert.deepEqual(hardwarePreferences().visible, { cpu: true, ram: true, gpu: true, storage: true, network: false, disk: false, battery: false, sensors: false });
  assert.equal(hardwarePreferences().cpuGraph, 'groups');
  const savedOrder = ['cpu', 'gpu', 'ram', 'disk', 'network', 'storage', 'battery', 'sensors'];
  assert.deepEqual(hardwarePreferences({ order: savedOrder }).order, savedOrder);
  const config = hardwarePreferences({ visible: { cpu: false, battery: true }, order: ['battery', 'cpu', 'cpu', 'foreign'],
    interval: 5, style: 'compact', cpuMode: 'cores', cores: [0, 2, 2, 9, -1, '1'] });
  assert.equal(config.visible.cpu, false);
  assert.equal(config.visible.battery, true);
  assert.deepEqual(config.order.slice(0, 2), ['battery', 'cpu']);
  assert.equal(config.order.length, 8);
  assert.deepEqual(selectedHardwareCores(config, 4), [0, 2]);
  assert.deepEqual(selectedHardwareCores(config, 10), [0, 2, 9]);
  assert.deepEqual(selectedHardwareCores(hardwarePreferences(), 3), [0, 1, 2]);
  assert.deepEqual(selectedHardwareCores(hardwarePreferences({ cores: [] }), 3), []);
  assert.equal(hardwarePreferences({ interval: -1 }).interval, 3);
  assert.equal(Object.hasOwn(hardwarePreferences(null), 'cpuMode'), false);
});

test('the host uses current system display preferences and current defaults', () => {
  const defaults = systemDisplayPreferences();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.sidebar.visible, true); assert.equal(defaults.status.visible, false);
  assert.equal(defaults.sidebar.heightMode, 'auto');
  assert.equal(defaults.sidebar.rows, 6);
  assert.equal(defaults.sidebar.style, 'compact');
  assert.equal(defaults.sidebar.cpuMode, 'cores');
  const saved = systemDisplayPreferences({ sidebar: { visible: true, style: 'inline' }, status: { visible: true } });
  assert.equal(saved.sidebar.visible, true); assert.equal(saved.status.visible, true); assert.equal(saved.sidebar.style, 'compact');
  assert.equal(systemDisplayPreferences({ sidebar: { heightMode: 'auto' } }).sidebar.heightMode, 'auto');
  assert.equal(systemDisplayPreferences({ sidebar: { heightMode: 'rows' } }).sidebar.heightMode, 'rows');
  const unsupportedHeight = systemDisplayPreferences({ sidebar: { heightMode: 'fixed', height: 350 } }).sidebar;
  assert.equal(unsupportedHeight.heightMode, 'auto'); assert.equal(unsupportedHeight.rows, 6);
  assert.equal(Object.hasOwn(unsupportedHeight, 'height'), false);
  assert.equal(systemSidebarHeight(380, 180), 180); assert.equal(systemSidebarHeight(380, 70), 70);
});

test('System display visibility preserves its locations and disabled state', () => {
  const hidden = systemDisplayPreferences({ sidebar: { visible: false }, status: { visible: false } });
  assert.equal(hidden.enabled, true);
  const disabled = systemDisplayPreferences({ enabled: false, sidebar: { visible: true, style: 'compact' }, status: { visible: true } });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.sidebar.visible, true);
  assert.equal(disabled.status.visible, true);
  assert.equal(disabled.sidebar.style, 'compact');
  assert.equal(systemDisplayPreferences({ ...disabled, enabled: true }).enabled, true);
});

test('monitor history uses elapsed time, preserves missing data and bounds memory use', () => {
  const history = appendHardwareHistory([{ at: 0, cpu: 50 }, { at: 100000, cpu: 20 }], { updatedAt: 200000, cpu: null });
  assert.equal(history.length, 2);
  const points = hardwareChartPoints(history, 'cpu', 200000, 100);
  assert.equal(points[0].y, 80);
  assert.equal(points[1].y, null);
  assert.ok(points[0].x > 0 && points[0].x < 100);
  assert.equal(points.at(-1).x, 100);
  assert.equal(points.length, 3, 'A long pause splits the history instead of drawing invented continuity');
  assert.equal(appendHardwareHistory(Array.from({ length: 200 }, (_, index) => ({ at: 200000 + index })), { updatedAt: 200201 }).length, 180);
});

test('sensor summaries identify CPU/GPU/SSD independently and never substitute battery temperature', () => {
  const sensors = [
    { id: 'a', name: 'CPU efficiency sensor 1', type: 'Temperature', value: 60 },
    { id: 'b', name: 'CPU performance sensor 1', type: 'Temperature', value: 70 },
    { id: 'c', name: 'GPU sensor 1', type: 'Temperature', value: 55 },
    { id: 'd', name: 'SSD NAND temperature', type: 'Temperature', value: 42 },
    { id: 'e', name: 'Battery temperature', type: 'Temperature', value: 90 },
  ];
  assert.deepEqual(hardwareSensorSummary({ sensors }), { cpu: 70, gpu: 55, ssd: 42 });
  assert.deepEqual(hardwareSensorSummary({ sensors: sensors.slice(-1) }), { cpu: null, gpu: null, ssd: null });
});

test('chart scales preserve percentage units and use only recent finite readings for rates and temperatures', () => {
  const history = [{ at: 0, read: 2 ** 40, 'sensor:gpu': 145 },
    { at: 195000, read: 1500, write: null, 'sensor:gpu': 47 },
    { at: 200000, read: NaN, write: 0, 'sensor:gpu': 106 },
    { at: 300000, read: 2 ** 40, 'sensor:gpu': 145 }];
  assert.equal(hardwareChartScale(history, ['read', 'write'], 'disk', 200000), 2048);
  assert.equal(hardwareChartScale([], ['received', 'sent'], 'network', 200000), 1024);
  assert.equal(hardwareChartScale(history, ['sensor:cpu', 'sensor:gpu'], 'sensors', 200000), 110);
  assert.equal(hardwareChartScale([], ['sensor:cpu'], 'sensors', 200000), 100);
  assert.equal(hardwareChartScale(history, ['cpu'], 'cpu', 200000), 100);
});

test('selected volume and I/O cards keep separate values, identities and history without substituting missing devices', () => {
  const config = hardwarePreferences({ order: ['storage', 'disk', 'sensors'],
    visible: { cpu: false, ram: false, gpu: false, disk: true, sensors: true },
    storageVolumes: ['volume:c', 'volume:d'], ioDisks: ['drive:b'], temperatureGroups: ['gpu'] });
  const data = { updatedAt: 100000, disk: { percent: 20, rates: { read: 999, write: 999 } },
    storage: { drives: [{ id: 'drive:a', model: 'A' }], pools: [], volumes: [
      { id: 'volume:c', mount: 'C:', driveIds: ['drive:a'], total: 1000, used: 200, free: 800, percent: 20 },
      { id: 'volume:d', mount: 'D:', driveIds: ['drive:a'], total: 1000, used: 800, free: 200, percent: 80 },
    ] }, diskIO: [{ id: 'drive:b', model: 'B', rates: { read: 42, write: 24 } }],
    sensors: [{ name: 'CPU', type: 'Temperature', value: 70 }, { name: 'GPU', type: 'Temperature', value: 40 }] };
  const items = hardwareDisplayItems(data, config);
  assert.equal(items.length, 4);
  assert.equal(new Set(items.map(item => item.key)).size, 4);
  assert.equal(items[1].data.disk.percent, 80);
  assert.equal(items[2].data.disk.rates.read, 42);
  assert.deepEqual(hardwareSensorSummary(items[3].data), { gpu: 40 });
  const history = [hardwarePoint(data)];
  assert.equal(hardwareDisplayHistory(history, items[1])[0].storage, 80);
  assert.equal(hardwareDisplayHistory(history, items[2])[0].read, 42);
  assert.equal(hardwareDisplayHistory([{ at: 1, storage: 20, read: 999 }], items[1])[0].storage, null);
  assert.equal(hardwareDisplayHistory(history, items[3])[0]['sensor:cpu'], null);
  data.storage.volumes[1] = { ...data.storage.volumes[1], id: 'volume:replacement' };
  const missing = hardwareDisplayItems(data, config)[1];
  assert.equal(missing.data.disk.percent, null);
  assert.equal(missing.label, 'Storage · Unavailable volume');
  assert.equal(data.disk.percent, 20);
  assert.equal(hardwarePreferences().storageVolumes, null);
  assert.equal(hardwarePreferences().ioDisks, null);
});

test('macOS SMC probe returns typed read-only readings or an explicit capability status', { skip: process.platform !== 'darwin' }, async () => {
  const { readMacSensors } = await import('../mods/devkits-system/hardware-sensors.js');
  const result = await readMacSensors();
  assert.ok(Array.isArray(result.sensors));
  if (!result.sensors.length) assert.equal(typeof result.sensorStatus, 'string');
  for (const sensor of result.sensors) {
    assert.ok(Number.isFinite(sensor.value));
    assert.ok(['Temperature', 'Fan', 'Power'].includes(sensor.type));
    assert.equal(sensor.source, 'Apple SMC');
    if (sensor.type === 'Temperature') assert.ok(sensor.value > 0 && sensor.value < 131);
  }
});
