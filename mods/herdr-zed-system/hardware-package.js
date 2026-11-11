import systeminformation from './vendor/systeminformation/lib/index.js';
import { uptime } from 'node:os';
import { storageInventory, storageReadings, storageMount, readMacStorageTopology } from './hardware-storage.js';

const list = value => Array.isArray(value) ? value : [];
const optional = task => task.catch(() => null);
const label = value => typeof value === 'string' && value.trim() && !/^(unknown|unspecified|n\/a)$/i.test(value.trim()) ? value.trim() : null;
const join = values => [...new Set(values.filter(Boolean))].join(' / ') || null;
const inventoryVersion = 'systeminformation@5.33.19:4';

export function packageMemory(raw, info = {}) {
  if (!(raw?.total > 0) || !Number.isFinite(raw.active) || raw.active < 0) return null;
  const used = Math.min(raw.total, raw.active);
  return { ...info, total: raw.total, used, percent: used / raw.total * 100,
    swap: Number.isFinite(raw.swaptotal) && Number.isFinite(raw.swapused) ? { total: raw.swaptotal, used: raw.swapused } : null };
}

export function packageMemoryInfo(rows) {
  const modules = list(rows).filter(row => row.size > 0);
  return { type: join(modules.map(row => label(row.type))), manufacturer: join(modules.map(row => label(row.manufacturer))),
    model: join(modules.map(row => label(row.partNum))),
    speed: join(modules.map(row => row.clockSpeed > 0 ? `${row.clockSpeed} MHz` : null)) };
}

export function packageDiskInfo(blocks, disks, mount) {
  const path = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const device = value => path(value).replace(/^\/dev\//, '');
  const root = list(blocks).find(row => row.mount && path(row.mount) === path(mount));
  if (!root || /disk image/i.test(root.protocol || '')) return { model: null, type: null, protocol: null };
  const id = device(root.device || root.name);
  const layout = list(disks).find(row => id && device(row.device) === id);
  const physical = layout || list(blocks).find(row => id && device(row.name) === id);
  return { model: label(layout?.name) || label(physical?.model) || label(root.model),
    type: label(physical?.physical || physical?.type || root.physical), protocol: label(root.protocol || physical?.interfaceType) };
}

export function packageBattery(raw) {
  if (!raw?.hasBattery || !Number.isFinite(raw.percent) || raw.percent < 0 || raw.percent > 100) return null;
  return { percent: raw.percent, charging: typeof raw.isCharging === 'boolean' ? raw.isCharging : null,
    plugged: typeof raw.acConnected === 'boolean' ? raw.acConnected : null,
    cycles: Number.isFinite(raw.cycleCount) && raw.cycleCount >= 0 ? raw.cycleCount : null,
    health: raw.designedCapacity > 0 && raw.maxCapacity > 0 ? Math.min(100, raw.maxCapacity / raw.designedCapacity * 100) : null,
    temperature: null };
}

export async function readPackageHardware(previous = {}, provider = systeminformation, mount = process.platform === 'win32' ? process.env.SystemDrive || 'C:' : '/') {
  const [memory, battery, volumes, iface] = await Promise.all([
    optional(provider.mem()), optional(provider.battery()), optional(provider.fsSize()), optional(provider.networkInterfaceDefault()),
  ]);
  const signature = Array.isArray(volumes) ? JSON.stringify(volumes.map(row => [storageMount(row.mount), row.fs, row.type]).sort()) : previous.packageInventory?.storageSignature;
  let inventory = previous.packageInventory;
  const macTopology = () => process.platform === 'darwin' && provider === systeminformation ? readMacStorageTopology() : Promise.resolve(null);
  if (inventory?.version !== inventoryVersion || Date.now() - inventory.checkedAt >= 300000) {
      const [cpu, modules, blocks, disks, graphics, apfs] = await Promise.all([
        optional(provider.cpu()), optional(provider.memLayout()), optional(provider.blockDevices()), optional(provider.diskLayout()), optional(provider.graphics()),
        macTopology(),
      ]);
      inventory = { version: inventoryVersion, checkedAt: Date.now(), storageSignature: signature, cpu: cpu ? { name: cpu.brand || cpu.manufacturer,
        physical: cpu.physicalCores, sockets: cpu.processors } : null,
      memory: packageMemoryInfo(modules), disk: packageDiskInfo(blocks, disks, mount),
      storage: storageInventory(blocks, disks, apfs),
      gpus: list(graphics?.controllers).map(gpu => ({ name: label(gpu.model) || 'GPU', percent: null, renderer: null, tiler: null,
        ...(!gpu.vramDynamic && gpu.vram > 0 ? { memory: { type: 'dedicated', total: gpu.vram * 1024 ** 2, used: null } } : {}) })) };
  } else if (signature !== inventory.storageSignature) {
    const [blocks, disks, apfs] = await Promise.all([optional(provider.blockDevices()), optional(provider.diskLayout()), macTopology()]);
    inventory = { ...inventory, storageSignature: signature, disk: packageDiskInfo(blocks, disks, mount), storage: storageInventory(blocks, disks, apfs) };
  }
  const stats = iface ? list(await optional(provider.networkStats(iface))).find(row => row.iface === iface) : null;
  const network = stats && Number.isFinite(stats.rx_bytes) && stats.rx_bytes >= 0 && Number.isFinite(stats.tx_bytes) && stats.tx_bytes >= 0
    ? { name: iface, received: stats.rx_bytes, sent: stats.tx_bytes, at: uptime() } : null;
  const volume = list(volumes).find(row => storageMount(row.mount) === storageMount(mount));
  const storage = storageReadings(inventory.storage, volumes, mount);
  const systemVolume = storage.volumes.find(row => row.system);
  const owner = systemVolume?.driveIds.length === 1 ? storage.drives.find(drive => drive.id === systemVolume.driveIds[0]) : null;
  const diskInfo = owner ? { model: owner.model, type: owner.type, protocol: owner.protocol }
    : systemVolume ? { model: null, type: null, protocol: null } : inventory.disk;
  const total = volume?.size, free = volume?.available;
  const disk = total > 0 && Number.isFinite(free) && free >= 0 && free <= total
    ? { ...diskInfo, mount: volume.mount, total, free, used: total - free, percent: (total - free) / total * 100 } : null;
  return { inventory, storage, memory: packageMemory(memory, inventory.memory), battery: packageBattery(battery), disk, network };
}
