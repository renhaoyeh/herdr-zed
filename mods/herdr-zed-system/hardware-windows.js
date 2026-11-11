import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsTopology } from './components/system-monitor-topology.js';

const execute = promisify(execFile);
const list = value => Array.isArray(value) ? value : value ? [value] : [];
const counter = value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function windowsCPUPercent(previous, current) {
  if (!previous || !current) return null;
  try {
    const total = BigInt(current.time) - BigInt(previous.time), idle = BigInt(current.idle) - BigInt(previous.idle);
    if (total <= 0n || total > 300000000n || idle < 0n || idle > total) return null;
    return 100 * (1 - Number(idle) / Number(total));
  } catch { return null; }
}

export function windowsGPUUsage(engines, names = [], descriptions = [], memory = []) {
  const adapters = new Map();
  for (const row of list(engines)) {
    const match = /(luid_(?:0x[\da-f]+_){2}phys_\d+)_eng_(\d+)_engtype_(.+)$/i.exec(row.id || '');
    if (!match || !Number.isFinite(row.percent) || row.percent < 0) continue;
    const adapter = match[1].toLowerCase(), engine = `${match[2]}:${match[3]}`;
    if (!adapters.has(adapter)) adapters.set(adapter, new Map());
    const values = adapters.get(adapter);
    values.set(engine, (values.get(engine) || 0) + row.percent);
  }
  for (const adapter of list(descriptions)) if (adapter.id && !adapters.has(adapter.id)) adapters.set(adapter.id, new Map());
  return [...adapters.entries()].map(([id, engines], index) => {
    const description = list(descriptions).find(row => row.id?.toLowerCase() === id.toLowerCase());
    const usage = list(memory).find(row => row.id?.toLowerCase() === id.toLowerCase());
    const dedicated = counter(description?.dedicated), shared = counter(description?.shared);
    return { id, name: description?.name || (names.length === 1 ? names[0] : `GPU adapter ${index}`),
      percent: engines.size ? Math.min(100, Math.max(...engines.values())) : null, renderer: null, tiler: null,
      ...(dedicated > 0 || shared > 0 ? { memory: { type: dedicated > 0 ? 'dedicated' : 'shared',
        total: dedicated > 0 ? dedicated : shared, used: counter(dedicated > 0 ? usage?.dedicatedUsed : usage?.sharedUsed),
        sharedTotal: shared, sharedUsed: counter(usage?.sharedUsed) } } : {}) };
  });
}

export function parseNvidiaSensors(text) {
  return (text || '').trim().split('\n').flatMap(line => {
    const fields = line.split(',').map(value => value.trim());
    if (fields.length !== 5) return [];
    const [id, name, temperature, power, fan] = fields;
    return [[temperature, 'Temperature', '°C', 'GPU temperature'], [power, 'Power', 'W', 'GPU power'], [fan, 'Fan', '%', 'GPU fan']]
      .filter(([value]) => value !== '' && Number.isFinite(Number(value)))
      .map(([value, type, unit, label]) => ({ id: `nvidia:${id}:${type}`, name: `${name} · ${label}`, type, unit, value: Number(value), source: 'NVIDIA driver' }));
  });
}

export function windowsReadings(raw, previous = {}, fallback = {}) {
  const metadata = raw.metadata ? { ...raw.metadata, cpuSets: list(raw.cpuSets) } : { ...previous.windowsMetadata };
  if (fallback.cpuName) metadata.name = fallback.cpuName;
  if (fallback.physical > 0) metadata.physical = fallback.physical;
  if (fallback.sockets > 0) metadata.sockets = fallback.sockets;
  if (fallback.gpuNames) metadata.gpuNames = fallback.gpuNames;
  const rows = list(raw.cpu).filter(row => /^\d+,\d+$/.test(row.id || '')).sort((a, b) => {
    const [ag, al] = a.id.split(',').map(Number), [bg, bl] = b.id.split(',').map(Number);
    return ag - bg || al - bl;
  });
  const cpuTimes = Object.fromEntries(rows.map(row => [row.id, { idle: row.idle, time: row.time }]));
  const coreUsage = rows.map(row => windowsCPUPercent(previous.windowsCPU?.[row.id], row));
  const cpu = coreUsage.length && coreUsage.every(Number.isFinite) ? coreUsage.reduce((a, b) => a + b, 0) / coreUsage.length : null;
  const processors = rows.length ? rows.map(row => row.id) : Array.from({ length: fallback.cores || 0 }, (_, index) => `index:${index}`);
  const topology = windowsTopology(metadata.cpuSets, processors, metadata);
  const disks = Object.fromEntries(list(raw.disks).flatMap(row => {
    const read = counter(row.read), write = counter(row.write);
    return row.id && row.id !== '_Total' && read !== null && write !== null && Number.isFinite(row.at) ? [[row.id, { read, write, at: row.at }]] : [];
  }));
  const rates = Object.entries(disks).flatMap(([id, row]) => {
    const old = previous.disks?.[id], seconds = row.at - old?.at;
    if (!old || !(seconds > 0) || seconds > 30 || row.read < old.read || row.write < old.write) return [];
    return [{ read: (row.read - old.read) / seconds, write: (row.write - old.write) / seconds }];
  });
  const diskRates = rates.length ? rates.reduce((sum, row) => ({ read: sum.read + row.read, write: sum.write + row.write }), { read: 0, write: 0 }) : null;
  return { sample: { windowsCPU: cpuTimes, windowsMetadata: Object.keys(metadata).length ? metadata : null, disks },
    cpu: rows.length ? cpu : fallback.cpu, cores: rows.length || fallback.cores,
    coreUsage: rows.length ? coreUsage : fallback.coreUsage, topology, cpuName: metadata.name || fallback.cpuName,
    diskRates, gpus: windowsGPUUsage(raw.gpuEngines, metadata.gpuNames, metadata.gpuAdapters, raw.gpuMemory),
    sensors: list(raw.sensors).filter(row => Number.isFinite(row.value) && ['Temperature', 'Fan', 'Power'].includes(row.type)).map(row => ({ ...row,
      unit: row.unit || (row.type === 'Temperature' ? '°C' : row.type === 'Fan' ? 'RPM' : 'W') })).filter(row =>
        row.type === 'Temperature' ? row.value > 0 && row.value <= 150
          : row.type === 'Fan' ? row.value >= 0 && row.value <= (row.unit === '%' ? 100 : 50000) : row.value >= 0 && row.value <= 5000) };
}

export async function readWindowsHardware(previous, options = {}, run = execute) {
  const content = await readFile(new URL('./hardware-windows.ps1', import.meta.url), 'utf8');
  const script = `$Topology=${previous?.windowsMetadata && Object.hasOwn(previous.windowsMetadata, 'cpuSets') ? '$false' : '$true'}\n$Sensors=${options.sensors ? '$true' : '$false'}\n${content.replace(/^param[^\n]*\n/, '')}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const raw = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (options.sensors) {
    try {
      const nvidia = await run('nvidia-smi.exe', ['--query-gpu=pci.bus_id,name,temperature.gpu,power.draw,fan.speed', '--format=csv,noheader,nounits'],
        { timeout: 1500, maxBuffer: 1024 * 1024, windowsHide: true });
      raw.sensors = [...list(raw.sensors), ...parseNvidiaSensors(nvidia.stdout)];
    } catch { /* Optional driver endpoint; never start/install a service. */ }
  }
  return raw;
}
