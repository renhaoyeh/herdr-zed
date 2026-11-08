import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageMemory, packageMemoryInfo, packageBattery, packageDiskInfo, readPackageHardware } from '../mods/devkits-system/hardware-package.js';

test('package RAM uses active memory rather than cache-inclusive used memory and preserves reported module types', () => {
  const info = packageMemoryInfo([{ size: 24 * 1024 ** 3, type: 'LPDDR5', manufacturer: 'Micron Technology Inc.', partNum: ' MT-24G ', serialNum: 'PRIVATE', clockSpeed: null },
    { size: 0, type: 'Unknown', manufacturer: 'Unused' }]);
  assert.deepEqual(info, { type: 'LPDDR5', manufacturer: 'Micron Technology Inc.', model: 'MT-24G', speed: null });
  const data = packageMemory({ total: 1000, used: 950, active: 400, swaptotal: 100, swapused: 10 }, info);
  assert.equal(data.used, 400);
  assert.equal(data.percent, 40);
  assert.deepEqual(data.swap, { total: 100, used: 10 });
  assert.equal(packageMemory({ total: 1000, active: -1 }), null);
  assert.equal(packageMemoryInfo([{ size: 1000, type: 'Unknown' }]).type, null);
  assert.equal(packageMemoryInfo([{ size: 1000, partNum: 'Unknown' }]).model, null);
});

test('package disk inventory joins the system volume to its physical drive on macOS and Windows', () => {
  const blocks = [{ name: '/dev/disk9', model: 'External SSD' }, { name: '/dev/disk0', device: '/dev/disk0', model: 'APPLE SSD AP0512Z', physical: 'SSD' },
    { name: '/dev/disk3s1s1', mount: '/', device: '/dev/disk0', protocol: 'Apple Fabric' }];
  assert.deepEqual(packageDiskInfo(blocks, [{ device: 'disk0', name: 'APPLE SSD AP0512Z', type: 'NVMe' }], '/'),
    { model: 'APPLE SSD AP0512Z', type: 'NVMe', protocol: 'Apple Fabric' });
  const drives = [{ name: 'C:', mount: 'C:', device: '\\\\.\\PHYSICALDRIVE1' }];
  const disks = [{ device: '\\\\.\\PHYSICALDRIVE0', name: 'Other drive' },
    { device: '\\\\.\\PHYSICALDRIVE1', name: 'System SSD', type: 'SSD', interfaceType: 'NVMe' }];
  assert.equal(packageDiskInfo(drives, disks, 'C:\\').model, 'System SSD');
  assert.equal(packageDiskInfo([], disks, 'C:').model, null);
  assert.equal(packageDiskInfo([{ mount: '/', protocol: 'Disk Image' }], [], '/').model, null);
});

test('package battery readings preserve absent batteries and unknown power source', () => {
  assert.equal(packageBattery({ hasBattery: false, percent: 0 }), null);
  assert.deepEqual(packageBattery({ hasBattery: true, percent: 80, designedCapacity: 1000, maxCapacity: 900, cycleCount: 23 }),
    { percent: 80, charging: null, plugged: null, cycles: 23, health: 90, temperature: null });
  assert.equal(packageBattery({ hasBattery: true, percent: -1 }), null);
});

test('common hardware comes from the package, caches inventory and keeps one active interface without storing serials', async () => {
  const calls = [];
  const values = {
    mem: { total: 1000, active: 400, swaptotal: 0, swapused: 0 }, battery: { hasBattery: false },
    fsSize: [{ mount: '/', size: 10000, used: 100, available: 3000 }],
    networkInterfaceDefault: 'en0', networkStats: [{ iface: 'en0', rx_bytes: 1024, tx_bytes: 2048 }],
    cpu: { brand: 'Fixture CPU', physicalCores: 4, processors: 1 },
    memLayout: [{ size: 1000, type: 'DDR5', manufacturer: 'Fixture', partNum: 'Fixture RAM', serialNum: 'PRIVATE' }],
    blockDevices: [{ mount: '/', device: '/dev/disk0' }], diskLayout: [{ device: 'disk0', name: 'Fixture SSD', type: 'NVMe', serialNum: 'PRIVATE' }],
    graphics: { controllers: [{ model: 'Fixture GPU', vram: 12288, vramDynamic: false }] },
  };
  const provider = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, async (...args) => { calls.push([key, ...args]); return value; }]));
  const first = await readPackageHardware({}, provider, '/');
  const second = await readPackageHardware({ packageInventory: first.inventory }, provider, '/');
  assert.equal(calls.filter(([key]) => key === 'memLayout').length, 1);
  assert.equal(calls.filter(([key]) => key === 'blockDevices').length, 1);
  assert.equal(calls.filter(([key]) => key === 'mem').length, 2);
  assert.deepEqual(calls.filter(([key]) => key === 'networkStats'), [['networkStats', 'en0'], ['networkStats', 'en0']]);
  assert.equal(second.disk.model, 'Fixture SSD');
  assert.equal(second.memory.model, 'Fixture RAM');
  assert.equal(second.disk.percent, 70, 'APFS uses the shared container free space rather than just the sealed root volume size');
  assert.equal(second.inventory.gpus[0].memory.total, 12 * 1024 ** 3);
  assert.ok(!JSON.stringify(first.inventory).includes('PRIVATE'));
  assert.equal(second.network.name, 'en0');
  provider.mem = async () => { throw new Error('Unavailable'); };
  const partial = await readPackageHardware({ packageInventory: first.inventory }, provider, '/');
  assert.equal(partial.memory, null);
  assert.equal(partial.disk.model, 'Fixture SSD');
});
