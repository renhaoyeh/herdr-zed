import { cpus, totalmem, uptime, loadavg } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macTopology } from './components/system-monitor-topology.js';
import { readWindowsHardware, windowsReadings } from './hardware-windows.js';
import { readMacSensors } from './hardware-sensors.js';
import { readPackageHardware } from './hardware-package.js';
import { storageIORates } from './hardware-storage.js';

const run = promisify(execFile);
const command = async (bin, args) => (await run(bin, args, { timeout: 1500, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })).stdout;
const optional = task => task.catch(() => null);
const field = (text, name) => Number(new RegExp(`^\\s*"${name}" = (\\d+)`, 'm').exec(text || '')?.[1]);

export function cpuSnapshot(processors) {
  return processors.reduce((sum, cpu) => ({ count: sum.count + 1,
    idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
  }), { count: 0, idle: 0, total: 0 });
}

// Cumulative CPU times must be compared across samples, never against system uptime.
export function cpuPercent(previous, current) {
  if (!previous || !current.count || previous.count !== current.count) return null;
  const total = current.total - previous.total, idle = current.idle - previous.idle;
  if (!(total > 0) || !(idle >= 0) || idle > total) return null;
  return 100 * (1 - idle / total);
}

export function coreSnapshots(processors) {
  return processors.map(cpu => ({ count: 1, idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((a, b) => a + b, 0) }));
}

export function corePercentages(previous, current) {
  return current.map((core, index) => previous?.length === current.length ? cpuPercent(previous[index], core) : null);
}

export function parseGPUs(text, totalMemory = null) {
  return (text || '').split(/(?=^\+-o )/m).flatMap(block => {
    const stats = /"PerformanceStatistics" = (\{[^\n]+\})/.exec(block)?.[1];
    if (!stats) return [];
    const value = key => Number(new RegExp(`"${key}"=(\\d+)`).exec(stats)?.[1]);
    const percent = value('Device Utilization %');
    const alternate = value('GPU Activity\\(%\\)');
    const used = Number.isFinite(percent) ? percent : alternate;
    const unified = /(?:class |"IOClass" = ")AGXAccelerator/.test(block);
    const vram = field(block, 'VRAM,totalMB') * 1024 ** 2;
    const memoryUsed = unified ? value('In use system memory') : null;
    return [{ name: /"model" = "([^"]+)"/.exec(block)?.[1] || 'GPU',
      percent: Number.isFinite(used) ? Math.min(100, used) : null,
      renderer: Number.isFinite(value('Renderer Utilization %')) ? value('Renderer Utilization %') : null,
      tiler: Number.isFinite(value('Tiler Utilization %')) ? value('Tiler Utilization %') : null,
      ...(unified || vram > 0 ? { memory: { type: unified ? 'unified' : 'dedicated',
        total: unified ? totalMemory : vram, used: Number.isFinite(memoryUsed) ? memoryUsed : null } } : {}) }];
  });
}

export function parseDiskCounters(text) {
  const disks = {};
  for (const block of (text || '').split(/(?=^\+-o IOBlockStorageDriver)/m)) {
    // Mounted DMGs (including simulators) repeat physical I/O; count hardware drivers only.
    if (/disk image/i.test(block)) continue;
    const id = /IOBlockStorageDriver[^\n]*id (0x[\da-f]+)/i.exec(block)?.[1];
    const read = Number(/"Bytes \(Read\)"=(\d+)/.exec(block)?.[1]);
    const write = Number(/"Bytes \(Write\)"=(\d+)/.exec(block)?.[1]);
    const device = /"BSD Name"\s*=\s*"(disk\d+)"/.exec(block)?.[1];
    if (id && Number.isFinite(read) && Number.isFinite(write)) disks[id] = { read, write, ...(device ? { device } : {}) };
  }
  return Object.keys(disks).length ? disks : null;
}

export function counterRate(previous, current, seconds, keys) {
  if (!previous || !current || !(seconds > 0) || seconds > 30) return null;
  const rates = {};
  for (const key of keys) {
    const delta = current[key] - previous[key];
    if (!Number.isFinite(delta) || delta < 0) return null;
    rates[key] = delta / seconds;
  }
  return rates;
}

export function diskRates(previous, current, seconds) {
  if (!previous || !current) return null;
  const rates = Object.keys(current).flatMap(id => counterRate(previous[id], current[id], seconds, ['read', 'write']) || []);
  return rates.length ? rates.reduce((sum, rate) => ({ read: sum.read + rate.read, write: sum.write + rate.write }), { read: 0, write: 0 }) : null;
}

export async function readHardware(previous = null, options = {}) {
  const processors = cpus(), sample = { ...cpuSnapshot(processors), perCore: coreSnapshots(processors), at: uptime() };
  const seconds = sample.at - previous?.at, platform = process.platform;
  const packageTask = readPackageHardware(previous || {});
  if (platform === 'win32') {
    const [common, raw] = await Promise.all([packageTask, optional(readWindowsHardware(previous, options))]);
    sample.packageInventory = common.inventory;
    const fallback = { cpu: cpuPercent(previous, sample), coreUsage: corePercentages(previous?.perCore, sample.perCore),
      cpuName: processors[0]?.model || common.inventory.cpu?.name || 'CPU', cores: processors.length,
      physical: common.inventory.cpu?.physical, sockets: common.inventory.cpu?.sockets,
      gpuNames: common.inventory.gpus.map(gpu => gpu.name) };
    const result = windowsReadings(raw || {}, previous || {}, fallback);
    sample.network = common.network;
    const network = common.network ? { ...common.network, rates: previous?.network?.name === common.network.name
      ? counterRate(previous.network, common.network, common.network.at - previous.network.at, ['received', 'sent']) : null } : null;
    return { ...result, sample: { ...sample, ...result.sample, network: sample.network, topology: result.topology },
      memory: common.memory, battery: common.battery, network, storage: common.storage,
      diskIO: storageIORates(common.storage.drives, previous?.disks, result.sample.disks),
      gpus: result.gpus.length ? result.gpus : common.inventory.gpus,
      disk: common.disk ? { ...common.disk, rates: result.diskRates } : null,
      sensorStatus: options.sensors ? result.sensors.length ? null : 'No supported sensor provider returned readings. Windows sensor availability depends on hardware and drivers.' : 'Enable Sensors in Settings to collect temperature, fan and power readings.',
      platform, load: null, updatedAt: Date.now() };
  }
  const keepTopology = previous?.topology?.logical === processors.length;
  const [common, gpuText, diskText, cpuTree, sensorData, extraMemory, extraBattery, pressureText] = await Promise.all([
    packageTask,
    optional(platform === 'darwin' ? command('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']) : Promise.resolve(null)),
    optional(platform === 'darwin' ? command('/usr/sbin/ioreg', ['-r', '-d', '2', '-c', 'IOBlockStorageDriver']) : Promise.resolve(null)),
    optional(platform === 'darwin' && !keepTopology ? command('/usr/sbin/ioreg', ['-p', 'IODeviceTree', '-r', '-n', 'cpus', '-d', '2', '-l']) : Promise.resolve(null)),
    platform === 'darwin' && options.sensors ? readMacSensors() : Promise.resolve({ sensors: [], sensorStatus: 'Enable Sensors in Settings to collect temperature, fan and power readings.' }),
    optional(platform === 'darwin' ? command('/usr/bin/vm_stat', []) : Promise.resolve(null)),
    optional(platform === 'darwin' ? command('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'AppleSmartBattery']) : Promise.resolve(null)),
    optional(platform === 'darwin' ? command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']) : Promise.resolve(null)),
  ]);
  sample.packageInventory = common.inventory;
  // The package gives used RAM; the native supplement only adds its missing breakdown and pressure.
  if (common.memory && extraMemory) {
    const pageSize = Number(/page size of (\d+) bytes/.exec(extraMemory)?.[1]);
    const pages = name => Number(new RegExp(`^${name}:\\s+(\\d+)\\.`, 'm').exec(extraMemory)?.[1]) * pageSize;
    if (pageSize > 0) Object.assign(common.memory, { apps: Math.max(0, pages('Anonymous pages') - pages('Pages purgeable')),
      wired: pages('Pages wired down'), compressed: pages('Pages occupied by compressor') });
  }
  if (common.memory) common.memory.pressure = ({ 1: 'Normal', 2: 'Warning', 4: 'Critical' })[Number(pressureText)] || null;
  const temperature = field(extraBattery, 'Temperature') / 100;
  if (common.battery && temperature > 0 && temperature < 80) common.battery.temperature = temperature;
  sample.network = common.network;
  sample.disks = parseDiskCounters(diskText);
  const cpu = common.inventory.cpu;
  const cpuInfo = `hw.physicalcpu: ${cpu?.physical || ''}\nhw.packages: ${cpu?.sockets || ''}`;
  sample.topology = keepTopology ? previous.topology : macTopology(cpuInfo, cpuTree, processors.length);
  const network = common.network ? { ...common.network, rates: previous?.network?.name === common.network.name
    ? counterRate(previous.network, common.network, common.network.at - previous.network.at, ['received', 'sent']) : null } : null;
  const nativeGPUs = parseGPUs(gpuText, common.memory?.total || totalmem());
  const gpus = nativeGPUs.length ? nativeGPUs.map(gpu => {
    const inventory = common.inventory.gpus.find(row => row.name === gpu.name);
    return { ...inventory, ...gpu, ...(gpu.memory || !inventory?.memory ? {} : { memory: inventory.memory }) };
  }) : common.inventory.gpus;
  return { sample, cpu: cpuPercent(previous, sample), cpuName: processors[0]?.model || cpu?.name || 'CPU', cores: processors.length,
    coreUsage: corePercentages(previous?.perCore, sample.perCore), topology: sample.topology,
    load: loadavg(), memory: common.memory, gpus, storage: common.storage,
    diskIO: storageIORates(common.storage.drives, previous?.disks, sample.disks, seconds),
    disk: common.disk ? { ...common.disk, rates: diskRates(previous?.disks, sample.disks, seconds) } : null,
    network, battery: common.battery, ...sensorData, platform, updatedAt: Date.now() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deadline = setTimeout(() => process.exit(1), 15000);
  try { console.log(JSON.stringify(await readHardware(JSON.parse(process.argv[2] || 'null'), JSON.parse(process.argv[3] || '{}')))); }
  catch { process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
