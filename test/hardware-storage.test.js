import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageInventory, storageReadings, readMacStorageTopology, storageIORates } from '../mods/herdr-zed-system/hardware-storage.js';

test('storage groups Windows partitions by physical identity without conflating identical drive models', () => {
  const disks = [0, 1].map(index => ({ device: `\\\\.\\PHYSICALDRIVE${index}`, name: 'Same model', size: 10000, type: 'SSD', serialNum: 'PRIVATE' }));
  const blocks = [['C:', 0], ['D:', 0], ['E:', 1]].map(([mount, index]) => ({ mount, name: mount, device: disks[index].device }));
  const inventory = storageInventory(blocks, disks);
  const readings = ['C:', 'D:', 'E:'].map(mount => ({ mount, fs: mount, type: 'NTFS', size: 4000, available: 1000 }));
  const data = storageReadings(inventory, [...readings, readings[0]], 'c:\\');
  assert.equal(data.drives.length, 2);
  assert.equal(data.volumes.length, 3, 'Duplicate mount reports do not duplicate partitions');
  assert.deepEqual(data.volumes[0].driveIds, data.volumes[1].driveIds);
  assert.notDeepEqual(data.volumes[0].driveIds, data.volumes[2].driveIds);
  assert.equal(data.volumes[0].system, true);
  assert.equal(data.volumes[0].used, 3000);
  assert.ok(!JSON.stringify(inventory).includes('PRIVATE'));
});

test('unmapped, ambiguous and unreadable volumes remain explicit while images and network mounts are excluded', () => {
  const disks = [{ device: 'disk0', name: 'Internal', size: 10000 }, { device: 'disk2', name: 'External', size: 10000 }];
  const blocks = [{ mount: 'C:', device: 'disk0' }, { mount: 'C:', device: 'disk2' },
    { mount: 'Z:', device: 'disk0', physical: 'Network' }, { mount: '/Volumes/Image', protocol: 'Disk Image' }];
  const data = storageReadings(storageInventory(blocks, disks), [
    { mount: 'C:', fs: 'C:', type: 'NTFS', size: 10000, available: 0 },
    { mount: 'D:', fs: 'D:', type: 'NTFS', size: 10000, available: 15000 },
    { mount: 'Z:', fs: 'Z:', type: 'NTFS', size: 10000, available: 100 },
    { mount: '/Volumes/Image', fs: '/dev/disk9s1', type: 'APFS', size: 1000, available: 100 },
  ], 'C:');
  assert.equal(data.volumes.length, 2);
  assert.equal(data.volumes[0].driveIds.length, 2);
  assert.equal(data.volumes[0].percent, 100);
  assert.deepEqual(data.volumes[1].driveIds, []);
  assert.equal(data.volumes[1].used, null);
  assert.equal(storageReadings(storageInventory(blocks, disks), null, 'C:').available, false);
});

test('APFS uses explicit physical stores and one shared pool without adding its capacity for every volume or snapshot', () => {
  const disks = [{ device: 'disk0', name: 'Same model', size: 12000 }, { device: 'disk1', name: 'Same model', size: 12000 }];
  const topology = { Containers: [{ ContainerReference: 'disk3', CapacityCeiling: 10000,
    PhysicalStores: [{ DeviceIdentifier: 'disk0s2' }], Volumes: [
      { DeviceIdentifier: 'disk3s1', Name: 'System' }, { DeviceIdentifier: 'disk3s5', Name: 'Data' },
    ] }] };
  // The package's model-name heuristic can point to the wrong same-model disk. The native store wins.
  const blocks = [{ name: '/dev/disk3s1s1', mount: '/', fsType: 'APFS', device: 'disk1' },
    { name: '/dev/disk3s5', mount: '/System/Volumes/Data', fsType: 'APFS', device: 'disk1' }];
  const inventory = storageInventory(blocks, disks, topology);
  const readings = [
    { fs: '/dev/disk3s1s1', mount: '/', type: 'APFS', size: 10000, available: 3000, used: 1000 },
    { fs: '/dev/disk3s1', mount: '/Volumes/System', type: 'APFS', size: 10000, available: 3000, used: 1000 },
    { fs: '/dev/disk3s5', mount: '/System/Volumes/Data', type: 'APFS', size: 10000, available: 3000, used: 6000 },
  ];
  const data = storageReadings(inventory, readings, '/');
  assert.equal(data.pools.length, 1);
  assert.equal(data.pools[0].total, 10000);
  assert.equal(data.pools[0].used, 7000);
  assert.equal(data.volumes.length, 2);
  assert.equal(data.volumes[0].used, 1000);
  assert.equal(data.volumes[0].mounts.length, 2);
  assert.deepEqual(data.pools[0].driveIds, ['disk:disk0']);
  const unknown = storageReadings(storageInventory(blocks, disks), readings, '/');
  assert.deepEqual(unknown.pools[0].driveIds, [], 'Missing topology must not attach APFS to a model-matched drive');
  readings[2].available = 2000;
  assert.equal(storageReadings(inventory, readings, '/').pools[0].free, null, 'Conflicting quota-limited free space is not invented');
});

test('the optional macOS topology command only reads metadata and handles missing providers', async () => {
  const calls = [];
  const result = await readMacStorageTopology(async (...args) => { calls.push(args); return { stdout: '{"Containers":[]}' }; });
  assert.deepEqual(result, { Containers: [] });
  assert.equal(calls[0][0], '/bin/sh');
  assert.equal(calls[0][1][1], '/usr/sbin/diskutil apfs list -plist | /usr/bin/plutil -convert json -o - -');
  assert.equal(await readMacStorageTopology(async () => { throw new Error('Unavailable'); }), null);
});

test('selection fingerprints follow the same volume and drive across changed mount letters and OS disk numbers', () => {
  const first = storageInventory([{ mount: 'E:', name: 'E:', device: 'disk0', uuid: 'PRIVATE-VOLUME' }],
    [{ device: 'disk0', name: 'External SSD', size: 10000, serialNum: 'PRIVATE-SERIAL' }]);
  const second = storageInventory([{ mount: 'F:', name: 'F:', device: 'disk3', uuid: 'PRIVATE-VOLUME' }],
    [{ device: 'disk3', name: 'External SSD', size: 10000, serialNum: 'PRIVATE-SERIAL' }]);
  const a = storageReadings(first, [{ mount: 'E:', fs: 'E:', size: 10000, available: 3000 }], 'C:');
  const b = storageReadings(second, [{ mount: 'F:', fs: 'F:', size: 10000, available: 3000 }], 'C:');
  assert.equal(a.drives[0].id, b.drives[0].id);
  assert.equal(a.volumes[0].id, b.volumes[0].id);
  assert.ok(!JSON.stringify(first).includes('PRIVATE'));
  const replaced = storageReadings(storageInventory([{ mount: 'E:', device: 'disk0', uuid: 'OTHER-VOLUME' }], []),
    [{ mount: 'E:', fs: 'E:', size: 10000, available: 3000 }], 'C:');
  assert.notEqual(a.volumes[0].id, replaced.volumes[0].id);
});

test('per-disk I/O matches Windows disk indexes and macOS BSD identities and rejects warmup/reset gaps', () => {
  const drives = [{ id: 'drive:a', device: '\\\\.\\PHYSICALDRIVE2' }, { id: 'drive:b', device: 'disk0' }];
  const current = { '2 F:': { read: 1000, write: 600, at: 10 }, native: { device: 'disk0', read: 400, write: 200 } };
  const previous = { '2 F:': { read: 400, write: 200, at: 8 }, native: { read: 200, write: 100 } };
  assert.deepEqual(storageIORates(drives, previous, current, 2).map(row => row.rates), [{ read: 300, write: 200 }, { read: 100, write: 50 }]);
  assert.equal(storageIORates(drives, null, current, 2)[0].rates, null);
  assert.equal(storageIORates(drives, previous, { '2 F:': { read: 1, write: 1, at: 10 } }, 2)[0].rates, null);
  assert.equal(storageIORates(drives, previous, {}, 2)[1].supported, false);
});
