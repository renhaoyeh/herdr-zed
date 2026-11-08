export const hardwareModules = [
  { id: 'cpu', name: 'CPU', description: 'Total usage or selected logical cores' },
  { id: 'gpu', name: 'GPU', description: 'Graphics processor usage' },
  { id: 'ram', name: 'RAM', description: 'Used RAM and pressure' },
  { id: 'disk', name: 'Disk activity', description: 'Physical disk read and write speeds' },
  { id: 'network', name: 'Network', description: 'Download and upload speeds' },
  { id: 'storage', name: 'Storage', description: 'System volume capacity and free space' },
  { id: 'battery', name: 'Battery', description: 'Charge level and power source, when present' },
  { id: 'sensors', name: 'Sensors', description: 'Optional CPU/GPU/SSD temperatures, fans and power' },
];

export function hardwarePreferences(saved = {}) {
  const ids = hardwareModules.map(module => module.id);
  return {
    visible: Object.fromEntries(ids.map(id => [id, typeof saved?.visible?.[id] === 'boolean' ? saved.visible[id] : !['storage', 'sensors'].includes(id)])),
    order: [...new Set([...(Array.isArray(saved?.order) ? saved.order.filter(id => ids.includes(id)) : []), ...ids])],
    interval: [1, 3, 5, 10].includes(saved?.interval) ? saved.interval : 3,
    cpuGraph: ['total', 'logical', 'groups'].includes(saved?.cpuGraph) ? saved.cpuGraph : 'logical',
    cores: Array.isArray(saved?.cores) ? [...new Set(saved.cores.filter(id => Number.isInteger(id) && id >= 0))] : null,
  };
}

export function selectedHardwareCores(config, count) {
  return Array.from({ length: count || 0 }, (_, index) => index).filter(index => config.cores === null || config.cores.includes(index));
}

export function hardwareBytes(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  const unit = value >= 1024 ** 4 ? 4 : value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export const hardwarePercent = value => Number.isFinite(value) ? `${Math.round(value)}%` : '—';
export const hardwareSpeed = value => Number.isFinite(value) ? `${hardwareBytes(value)}/s` : '—';
export const hardwarePower = battery => !battery ? 'Not detected' : battery.charging ? 'Charging' : battery.plugged === true ? 'Plugged in' : battery.plugged === false ? 'On battery' : 'Power source unavailable';

export function hardwareSensorSummary(data) {
  const temperatures = (data?.sensors || []).filter(row => row.type === 'Temperature' && Number.isFinite(row.value) && row.value > 0 && row.value <= 150);
  const highest = pattern => {
    const values = temperatures.filter(row => pattern.test(`${row.name} ${row.parent || ''} ${row.id}`)).map(row => row.value);
    return values.length ? Math.max(...values) : null;
  };
  return { cpu: highest(/\bCPU\b|\/intelcpu\/|\/amdcpu\//i), gpu: highest(/\bGPU\b|nvidia:|\/gpu-/i), ssd: highest(/\bSSD\b|\bNAND\b|\/hdd\//i) };
}

export function hardwarePoint(data) {
  return { at: data.updatedAt, cpu: data.cpu, cpuTopology: data.topology?.processors?.map(cpu => cpu.id).join('|'),
    ...Object.fromEntries((data.coreUsage || []).map((value, index) => [`core:${index}`, value])),
    gpu: data.gpus?.reduce((best, gpu) => Number.isFinite(gpu.percent) ? Math.max(best ?? 0, gpu.percent) : best, null),
    ram: data.memory?.percent ?? null, storage: data.disk?.percent ?? null, battery: data.battery?.percent ?? null,
    read: data.disk?.rates?.read ?? null, write: data.disk?.rates?.write ?? null,
    received: data.network?.rates?.received ?? null, sent: data.network?.rates?.sent ?? null,
    sensors: hardwareSensorSummary(data).cpu ?? hardwareSensorSummary(data).gpu ?? hardwareSensorSummary(data).ssd,
    'sensor:cpu': hardwareSensorSummary(data).cpu, 'sensor:gpu': hardwareSensorSummary(data).gpu, 'sensor:ssd': hardwareSensorSummary(data).ssd };
}

export function appendHardwareHistory(history, data) {
  const cutoff = data.updatedAt - 180000;
  return [...(history || []).filter(point => point.at > cutoff && point.at < data.updatedAt), hardwarePoint(data)].slice(-180);
}

// Use a fixed time axis. Missing samples split paths rather than inventing zero usage.
export function hardwareChartPoints(history, key, now, maximum) {
  const max = maximum || Math.max(1, ...history.map(point => point[key]).filter(Number.isFinite));
  const points = [];
  let previous;
  for (const point of history.filter(point => point.at >= now - 180000 && point.at <= now)) {
    const x = Math.max(0, Math.min(100, (point.at - now + 180000) / 1800));
    if (previous && point.at - previous.at > 30000) points.push({ x, y: null });
    points.push({ x, y: Number.isFinite(point[key]) ? 100 - Math.max(0, Math.min(100, point[key] / max * 100)) : null });
    previous = point;
  }
  return points;
}
