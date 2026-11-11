import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { windowsCPUPercent, windowsReadings, windowsGPUUsage, parseNvidiaSensors, readWindowsHardware } from '../mods/herdr-zed-system/hardware-windows.js';
import { macTopology, windowsTopology, topologyGroups, topologyLabel } from '../mods/herdr-zed-system/components/system-monitor-topology.js';

test('Windows per-processor CPU counters preserve 64-bit precision and reject stale/reset samples', () => {
  const old = { idle: '100000000000000000', time: '130000000000000000' };
  assert.equal(windowsCPUPercent(old, { idle: '100000000015000000', time: '130000000030000000' }), 50);
  assert.equal(windowsCPUPercent(null, old), null);
  assert.equal(windowsCPUPercent(old, old), null);
  assert.equal(windowsCPUPercent(old, { idle: '1', time: '130000000030000000' }), null);
  assert.equal(windowsCPUPercent(old, { idle: '100000000015000000', time: '130000000999000000' }), null);
});

test('P/E topology follows OS identities and distinguishes SMT threads from physical cores', () => {
  const sets = [
    { group: 0, logical: 0, core: 0, efficiency: 8 },
    { group: 0, logical: 1, core: 0, efficiency: 8 },
    { group: 0, logical: 2, core: 1, efficiency: 0 },
    { group: 1, logical: 0, core: 0, efficiency: 0 },
  ];
  const result = windowsTopology(sets, ['0,0', '0,1', '0,2', '1,0']);
  assert.deepEqual(result.processors.map(cpu => cpu.type), ['P', 'P', 'E', 'E']);
  assert.equal(result.physical, 3);
  assert.equal(result.logical, 4);
  assert.match(topologyLabel(result), /3 cores · 4 logical processors · 1P \+ 2E/);
  assert.deepEqual(topologyGroups(result, [1, 3]).map(group => group.processors.map(cpu => cpu.id)), [['0,1'], ['1,0']]);
  assert.ok(windowsTopology(sets.map(cpu => ({ ...cpu, efficiency: 0 })), ['0,0','0,1']).processors.every(cpu => cpu.type === null));
  const mac = macTopology('hw.physicalcpu: 2\nhw.packages: 1', `
  +-o cpu0@0
    "logical-cpu-id" = 0
    "cluster-type" = <"E">
  +-o cpu1@100
    "logical-cpu-id" = 1
    "cluster-type" = <"P">`, 2);
  assert.deepEqual(mac.processors.map(cpu => cpu.type), ['E', 'P']);
  assert.equal(mac.sockets, 1);
  assert.ok(macTopology('', '', 2).processors.every(cpu => cpu.type === null));
});

test('Windows native supplement normalizes physical disk counters without total duplication or hotplug spikes', () => {
  const previous = { disks: { '0 C:': { read: 1000, write: 500, at: 100 } } };
  const raw = { disks: [{ id: '0 C:', read: '4000', write: '6500', at: 103 }, { id: '1 D:', read: '99999999', write: '99999', at: 103 }] };
  assert.deepEqual(windowsReadings(raw, previous).diskRates, { read: 1000, write: 2000 });
  assert.equal(windowsReadings({ disks: [{ id: '0 C:', read: '100', write: '100', at: 103 }] }, previous).diskRates, null);
});

test('Windows GPU uses the busiest physical engine, summing process instances rather than summing unrelated engines', () => {
  const id = suffix => `pid_99_luid_0x00000000_0x00001234_phys_0_eng_${suffix}`;
  const data = windowsGPUUsage([
    { id: id('0_engtype_3D'), percent: 25 },
    { id: id('0_engtype_3D').replace('pid_99', 'pid_100'), percent: 30 },
    { id: id('1_engtype_Compute'), percent: 75 },
  ], ['GPU fixture']);
  assert.equal(data[0].percent, 75);
  assert.equal(data[0].name, 'GPU fixture');
  assert.deepEqual(windowsGPUUsage([], ['GPU fixture']), []);
  const sensors = parseNvidiaSensors('00000000:01:00.0, NVIDIA fixture, 62, 45.5, 30\n00000000:02:00.0, Other, N/A, N/A, N/A');
  assert.equal(sensors.length, 3);
  assert.equal(sensors.find(row => row.type === 'Fan').unit, '%');
  assert.equal(windowsReadings({ sensors }).sensors.find(row => row.type === 'Fan').unit, '%');
});

test('Windows helper uses a finite, hidden, read-only PowerShell command with safe UTF-16 transport', async () => {
  const calls = [];
  const raw = await readWindowsHardware(null, {}, async (command, args, options) => {
    calls.push([command, args, options]);
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-NonInteractive') && args.includes('-EncodedCommand'));
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(script.startsWith('$Topology=$true\n$Sensors=$false'));
    assert.ok(script.includes('GetSystemCpuSetInformation'));
    assert.ok(!/Read-Cim 'Win32_(PhysicalMemory|Battery|VideoController)'|Get-NetIPConfiguration/.test(script), 'Common information is read by systeminformation');
    assert.ok(!/SetProcess|SetThread|Set-CimInstance|Set-Net|Restart-|Stop-Process|ExecutionPolicy|RunAs/.test(script));
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0);
    return { stdout: '\uFEFF{"cpu":[],"metadata":{"name":"CPU 中文"}}' };
  });
  assert.equal(calls.length, 1);
  assert.equal(raw.metadata.name, 'CPU 中文');
});

test('Windows GPU memory joins DXGI capacities above 4 GB by adapter identity, keeping shared memory separate', () => {
  const id = 'luid_0x00000000_0x00001234_phys_0';
  const adapters = [{ id, name: 'Discrete GPU', dedicated: 12 * 1024 ** 3, shared: 16 * 1024 ** 3 },
    { id: 'luid_0x00000000_0x00005678_phys_0', name: 'Integrated GPU', dedicated: 0, shared: 8 * 1024 ** 3 }];
  const data = windowsGPUUsage([{ id: `pid_9_${id}_eng_0_engtype_3D`, percent: 42 }], [], adapters,
    [{ id, dedicatedUsed: 6 * 1024 ** 3, sharedUsed: 1024 }]);
  assert.equal(data[0].name, 'Discrete GPU');
  assert.deepEqual(data[0].memory, { type: 'dedicated', total: 12 * 1024 ** 3, used: 6 * 1024 ** 3,
    sharedTotal: 16 * 1024 ** 3, sharedUsed: 1024 });
  assert.equal(data[1].memory.type, 'shared');
  assert.equal(data[1].memory.total, 8 * 1024 ** 3);
  assert.equal(data[1].percent, null, 'Idle/missing engine counters must not fabricate zero utilization');
  const cached = windowsReadings({}, { windowsMetadata: { gpuAdapters: adapters } });
  assert.equal(cached.gpus[0].memory.total, 12 * 1024 ** 3);
});

test('SMC reader only contains read operations and never a write/fan-control command', async () => {
  const source = await readFile(new URL('../mods/herdr-zed-system/hardware-smc.c', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/input\.command = (\d+)/g)].map(match => Number(match[1])), [9, 5]);
  assert.ok(!/IOConnectSet|IORegistryEntrySet|kSMCWrite|setFan|write_value/.test(source));
});

test('Windows live helper returns supported readings without requiring elevation', { skip: process.platform !== 'win32' }, async () => {
  const raw = await readWindowsHardware(null);
  assert.ok(Array.isArray(raw.cpu) && Array.isArray(raw.disks));
  assert.ok(raw.cpu.length > 0);
});
