import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const list = value => Array.isArray(value) ? value : [];
const label = value => typeof value === 'string' && value.trim() && !/^(unknown|unspecified|n\/a)$/i.test(value.trim()) ? value.trim() : null;
const number = value => value !== null && value !== undefined && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const deviceKey = value => String(value || '').replace(/\\/g, '/').replace(/^\/dev\//, '').toLowerCase();
const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const storageMount = value => {
  const path = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^[a-z]:/i.test(path) ? path.toLowerCase() : path;
};
const excludedBlock = row => /disk image/i.test(row.protocol || '') || /^(network|ram|cd\/dvd)$/i.test(row.physical || '');
const macDisk = value => /^(disk\d+)(?:s\d+)*$/.exec(deviceKey(value))?.[1];
const capacity = (total, free) => {
  total = number(total); free = number(free);
  const valid = total > 0 && free !== null && free <= total;
  return { total: total > 0 ? total : null, free: valid ? free : null,
    used: valid ? total - free : null, percent: valid ? (total - free) / total * 100 : null };
};

// No model-name matching: identical drive models are still distinct physical devices.
export function storageInventory(blocks, disks, apfs = null) {
  blocks = list(blocks);
  const serials = list(disks).map(row => label(row.serialNum));
  const drives = new Map();
  for (const row of list(disks)) {
    const key = deviceKey(row.device);
    if (!key || /disk image/i.test(`${row.type || ''} ${row.interfaceType || ''}`)) continue;
    const serial = label(row.serialNum), unique = serial && serials.filter(value => value === serial).length === 1;
    drives.set(key, { id: unique ? `drive:${fingerprint(serial)}` : `disk:${key}`, device: row.device, model: label(row.name),
      type: row.type === 'HD' ? 'HDD' : label(row.type), protocol: label(row.interfaceType), total: number(row.size) || null });
  }
  for (const row of blocks) {
    const key = deviceKey(row.name);
    if (!key || drives.has(key) || excludedBlock(row) || row.type !== 'disk' || !/^(ssd|hdd)$/i.test(row.physical || '')) continue;
    if (row.device && deviceKey(row.device) !== key) continue;
    drives.set(key, { id: `disk:${key}`, device: row.name, model: label(row.model),
      type: label(row.physical), protocol: label(row.protocol), total: number(row.size) || null });
  }
  const pools = list(apfs?.Containers).flatMap(row => {
    const key = deviceKey(row.ContainerReference);
    if (!/^disk\d+$/.test(key)) return [];
    const owners = list(row.PhysicalStores).map(store => drives.get(macDisk(store.DeviceIdentifier))?.id);
    return [{ id: `apfs:${key}`, device: key, total: number(row.CapacityCeiling) || null,
      driveIds: owners.length && owners.every(Boolean) ? [...new Set(owners)] : [],
      volumes: list(row.Volumes).flatMap(volume => /^disk\d+s\d+$/.test(deviceKey(volume.DeviceIdentifier))
        ? [{ device: deviceKey(volume.DeviceIdentifier), label: label(volume.Name),
          identity: label(volume.APFSVolumeUUID) ? fingerprint(volume.APFSVolumeUUID) : null }] : []) }];
  });
  const bindings = blocks.filter(row => row.mount && !excludedBlock(row)).map(row => ({
    mount: storageMount(row.mount), fs: deviceKey(row.name || row.identifier), label: label(row.label),
    identity: label(row.uuid) ? fingerprint(row.uuid) : null,
    driveId: /apfs/i.test(row.fsType || '') ? null : drives.get(deviceKey(row.device || row.name))?.id || null,
  }));
  return { drives: [...drives.values()], pools, bindings,
    excludedMounts: blocks.filter(excludedBlock).filter(row => row.mount).map(row => storageMount(row.mount)) };
}

// Capacity is queried separately from identity. Shared pools never become summed disk usage.
export function storageReadings(inventory, readings, systemMount) {
  inventory ||= { drives: [], pools: [], bindings: [], excludedMounts: [] };
  const volumes = new Map(), system = storageMount(systemMount);
  for (const row of list(readings)) {
    const mount = storageMount(row.mount), fs = deviceKey(row.fs), type = label(row.type);
    if (!row.mount || inventory.excludedMounts.includes(mount)
      || /^(tmpfs|devtmpfs|devfs|overlay|squashfs|nfs4?|smbfs|cifs|ramfs|autofs|iso9660|udf)$/i.test(type || '')) continue;
    const matches = inventory.bindings.filter(binding => binding.mount === mount);
    // Unknown local volumes stay visible without inventing their physical owner.
    if (!matches.length && !/^[a-z]:$/i.test(fs) && !String(row.fs || '').startsWith('/dev/')) continue;
    let pool = null, poolVolume = null;
    for (const candidate of inventory.pools) {
      const volume = candidate.volumes.find(item => fs === item.device || new RegExp(`^${item.device}(?:s\\d+)+$`).test(fs));
      if (volume) { pool = candidate; poolVolume = volume; break; }
    }
    const shared = /apfs/i.test(type || '') || Boolean(pool);
    const poolId = pool?.id || (shared ? `apfs:${/^disk\d+/.exec(fs)?.[0] || mount}` : null);
    const driveIds = pool ? pool.driveIds : shared ? [] : [...new Set(matches.map(binding => binding.driveId).filter(Boolean))];
    const identity = poolVolume?.identity || matches.find(binding => binding.identity)?.identity;
    const id = identity ? `volume:${identity}` : `volume:${poolVolume?.device || fs || mount}${driveIds.length ? `@${driveIds.join('+')}` : ''}`;
    const usage = capacity(row.size, row.available);
    const volume = { id, mount: row.mount, mounts: [row.mount], label: poolVolume?.label || matches.find(binding => binding.label)?.label || null,
      fs: row.fs || null, type, driveIds, poolId, ...usage,
      used: shared ? number(row.used) : usage.used, system: mount === system };
    const existing = volumes.get(id);
    if (existing) {
      existing.mounts = [...new Set([...existing.mounts, row.mount])];
      existing.system ||= volume.system;
      if (volume.system) Object.assign(existing, { ...volume, mounts: existing.mounts });
    } else volumes.set(id, volume);
  }
  const mounted = [...volumes.values()];
  const pools = [...new Set(mounted.map(volume => volume.poolId).filter(Boolean))].map(id => {
    const info = inventory.pools.find(pool => pool.id === id), members = mounted.filter(volume => volume.poolId === id);
    const totals = [...new Set(members.map(volume => volume.total).filter(value => value > 0))];
    const frees = [...new Set(members.map(volume => volume.free).filter(value => value !== null))];
    return { id, device: info?.device || id.slice(5), driveIds: info?.driveIds || [],
      ...capacity(info?.total || (totals.length === 1 ? totals[0] : null), frees.length === 1 ? frees[0] : null) };
  });
  return { available: Array.isArray(readings), drives: inventory.drives, volumes: mounted, pools };
}

export function storageIORates(drives, previous, current, seconds) {
  return list(drives).map(drive => {
    const win = /physicaldrive(\d+)$/i.exec(drive.device || '');
    const matches = Object.entries(current || {}).filter(([id, row]) => win
      ? /^(\d+)(?:\s|$)/.exec(id)?.[1] === win[1] : row.device && deviceKey(row.device) === deviceKey(drive.device));
    const [id, row] = matches.length === 1 ? matches[0] : [];
    const old = previous?.[id], elapsed = row?.at !== undefined ? row.at - old?.at : seconds;
    const valid = old && elapsed > 0 && elapsed <= 30 && Number.isFinite(row.read) && Number.isFinite(row.write)
      && Number.isFinite(old.read) && Number.isFinite(old.write) && row.read >= old.read && row.write >= old.write;
    return { ...drive, supported: matches.length === 1,
      rates: valid ? { read: (row.read - old.read) / elapsed, write: (row.write - old.write) / elapsed } : null };
  });
}

export async function readMacStorageTopology(run = execute) {
  try {
    // Both commands are finite metadata readers. No shell arguments come from device names.
    const result = await run('/bin/sh', ['-c', '/usr/sbin/diskutil apfs list -plist | /usr/bin/plutil -convert json -o - -'],
      { timeout: 2500, maxBuffer: 4 * 1024 * 1024 });
    const data = JSON.parse(result.stdout);
    return Array.isArray(data.Containers) ? data : null;
  } catch { return null; }
}
