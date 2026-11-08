// Shared: edit mods/devkits/components/system-monitor.js, then npm run sync:shared.
import { div, svg, PathBuilder } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { shared, openOverlay, run, nextCommand } from 'herdr';
import { Button } from './button.js';
import { hardwareModules, hardwarePreferences, selectedHardwareCores, hardwareBytes, hardwarePercent, hardwareSpeed, hardwarePower, hardwareSensorSummary, hardwarePoint, hardwareChartPoints } from './system-monitor-model.js';
import { processorLabel } from './system-monitor-topology.js';
const hardwareConfig = () => hardwarePreferences(shared('devkits.system-monitor'));
export const systemClientPrefix = 'system-client:';
export const systemSnapshotPrefix = 'system-snapshot:';
export const systemCommand = (prefix, value) => prefix + encodeURIComponent(JSON.stringify(value));
export function systemMessage(command, prefix) {
  if (!command.startsWith(prefix)) return null;
  try { return JSON.parse(decodeURIComponent(command.slice(prefix.length))); } catch { return null; }
}
const hardwareColors = t => ({ cpu: t.ansi4 || t.done, gpu: t.ansi5 || t.done, ram: t.ansi6 || t.working,
  storage: t.ansi3 || t.blocked, disk: t.ansi4 || t.done, network: t.working, battery: t.working, sensors: t.ansi3 || t.blocked });
const hardwareAvailable = (module, data) => module !== 'battery' || Boolean(data?.battery);
const hardwareTitle = id => hardwareModules.find(module => module.id === id)?.name || id;
const primaryHardwareGPU = data => (data?.gpus || []).reduce((best, gpu) =>
  !best || (gpu.percent ?? -1) > (best.percent ?? -1) ? gpu : best, null);
const hardwareShortSpeed = value => hardwareSpeed(value).replace(/\.0(?= )/, '').replace(/ ([KMGT])B/, '$1').replace(' B/', 'B/');
const hardwareStatusValue = (id, data) => {
  if (!data) return '—';
  if (id === 'disk') return `R${hardwareShortSpeed(data.disk?.rates?.read)} W${hardwareShortSpeed(data.disk?.rates?.write)}`;
  if (id === 'network') return `↓${hardwareShortSpeed(data.network?.rates?.received)} ↑${hardwareShortSpeed(data.network?.rates?.sent)}`;
  if (id === 'sensors') {
    const summary = hardwareSensorSummary(data), value = summary.cpu ?? summary.gpu ?? summary.ssd;
    return Number.isFinite(value) ? `${Math.round(value)}°C` : '—';
  }
  return hardwarePercent(hardwarePoint(data)[id]);
};
const hardwareValue = (id, data) => {
  if (!data) return '—';
  if (id === 'sensors') {
    const summary = hardwareSensorSummary(data), value = summary.cpu ?? summary.gpu ?? summary.ssd;
    return Number.isFinite(value) ? `${value.toFixed(1)} °C` : data.sensors?.length ? `${data.sensors.length} readings` : '—';
  }
  if (id === 'disk') return `R ${hardwareSpeed(data.disk?.rates?.read)}   W ${hardwareSpeed(data.disk?.rates?.write)}`;
  if (id === 'network') return `↓ ${hardwareSpeed(data.network?.rates?.received)}   ↑ ${hardwareSpeed(data.network?.rates?.sent)}`;
  return hardwarePercent(hardwarePoint(data)[id]);
};
const hardwareSubtitle = (id, data) => {
  if (!data) return 'Waiting for system data';
  if (id === 'cpu') return `${data.cpuName || 'CPU'} · ${data.cores || '—'} cores`;
  if (id === 'gpu') return data.gpus?.map(gpu => gpu.name).join(' · ') || 'Not available';
  if (id === 'ram') return data.memory ? `${hardwareBytes(data.memory.used)} / ${hardwareBytes(data.memory.total)}${data.memory.pressure ? ` · ${data.memory.pressure}` : ''}` : 'Unavailable';
  if (id === 'storage') return data.disk ? `${hardwareBytes(data.disk.free)} available of ${hardwareBytes(data.disk.total)}` : 'Unavailable';
  if (id === 'disk') return 'Read / write · physical disks';
  if (id === 'network') return `${data.network?.name || 'No active interface'} · download / upload`;
  if (id === 'sensors') {
    const summary = hardwareSensorSummary(data);
    return [['CPU', summary.cpu], ['GPU', summary.gpu], ['SSD', summary.ssd]].filter(([, value]) => Number.isFinite(value))
      .map(([label, value]) => `${label} ${Math.round(value)}°`).join(' · ')
      || (data.sensors?.length ? `${data.sensors.length} sensor readings` : data.sensorStatus || 'No readings available');
  }
  return hardwarePower(data.battery);
};

function hardwareChart(id, history, module, t, height = 64, keyOverride = null) {
  const colors = hardwareColors(t), rate = module === 'disk' || module === 'network';
  const keys = keyOverride ? [keyOverride] : module === 'disk' ? ['read', 'write'] : module === 'network' ? ['received', 'sent'] : [module];
  const maximum = rate ? Math.max(1, ...history.flatMap(point => keys.map(key => point[key])).filter(Number.isFinite)) : module === 'sensors' ? 130 : 100;
  const now = history.at(-1)?.at || Date.now();
  const root = div().id(id).relative().w_full().h(height).flex_none().overflow_hidden()
    .accessibility_label(`${hardwareTitle(module)} history over the last 3 minutes`);
  if (height > 24) root.children([25, 50, 75].map(y => div().absolute().left(0).right(0).top(`${y}%`).h(1).bg(t.border).opacity(0.5)));
  if (!globalThis.window?.paint_path) return root;
  for (const [index, key] of keys.entries()) {
    const points = hardwareChartPoints(history, key, now, maximum);
    let segments = [], segment = [];
    for (const point of points) {
      if (point.y === null) { if (segment.length) segments.push(segment); segment = []; }
      else segment.push(point);
    }
    if (segment.length) segments.push(segment);
    const color = index ? t.ansi5 || t.blocked : colors[module];
    for (const points of segments.filter(points => points.length > 1)) {
      const line = PathBuilder.stroke(height > 24 ? 2 : 1.5);
      const fill = PathBuilder.fill().move_to(`${points[0].x}%`, '100%');
      points.forEach((point, index) => {
        (index ? line.line_to(`${point.x}%`, `${point.y}%`) : line.move_to(`${point.x}%`, `${point.y}%`));
        fill.line_to(`${point.x}%`, `${point.y}%`);
      });
      fill.line_to(`${points.at(-1).x}%`, '100%').close();
      const fillColor = /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color || '') ? `${color.slice(0, 7)}20` : color;
      root.child(globalThis.window.paint_path(fill.build(), fillColor).absolute().size_full());
      root.child(globalThis.window.paint_path(line.build(), color).absolute().size_full());
    }
  }
  return root;
}

function hardwareCoreBars(id, data, config, t, height = 24) {
  const cores = selectedHardwareCores(config, data?.cores), color = hardwareColors(t).cpu;
  return h_flex().id(id).h(height).w_full().gap(cores.length > 32 ? 0 : cores.length > 16 ? 1 : 3).items_end().children(cores.map(index => {
    const value = data?.coreUsage?.[index];
    return div().id(`${id}-${index}`).flex_1().min_w(0).h_full().relative().bg(t.border)
      .accessibility_label(`${processorLabel(data?.topology?.processors?.[index], index)}: ${hardwarePercent(value)}`)
      .when(Number.isFinite(value), el => el.child(div().absolute().bottom(0).w_full().h(`${Math.max(1, value)}%`)
        .bg(data?.topology?.processors?.[index]?.type === 'E' ? t.working : color)));
  }));
}

function hardwareUsageBar(id, percent, module, t, chart = null) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  return h_flex().id(id).w(116).flex_none().gap(6).items_center()
    .accessibility_label(`${hardwareTitle(module)} usage: ${hardwarePercent(value)}`)
    .child(chart || h_flex().id(`${id}-segments`).flex_1().h(12).gap(1).children(Array.from({ length: 20 }, (_, index) =>
      div().id(`${id}-${index}`).flex_1().h_full().relative().bg(t.border)
        .when(value !== null && value > index * 5, el => el.child(div().id(`${id}-${index}-fill`).absolute().left(0).h_full()
          .w(`${Math.min(100, (value - index * 5) * 20)}%`).bg(hardwareColors(t)[module]))))))
    .child(div().flex_none().text_size(10).font_family('Geist Mono').text_color(hardwareColors(t)[module]).child(hardwarePercent(value)));
}

export class SystemMonitor {
  constructor({ active = () => true, openDetails, receiver, onSnapshot } = {}) {
    this.active = active; this.openDetails = openDetails; this.receiver = receiver; this.onSnapshot = onSnapshot;
    this.clientId = `system:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }
  init(cx) {
    cx.spawn(async cx => {
      for (;;) {
        const snapshot = systemMessage(await nextCommand(), systemSnapshotPrefix);
        if (!snapshot) continue;
        if (snapshot.updatedAt === this.hardwareCheckedAt) continue;
        this.receive(snapshot);
        if (this.active()) cx.notify();
      }
    });
    this.poll(cx, false); cx.timer.every(1000, cx => this.poll(cx));
  }
  receive(snapshot) {
    this.hardware = snapshot.data; this.hardwareHistory = snapshot.history;
    this.hardwareError = snapshot.error; this.hardwareCheckedAt = snapshot.updatedAt;
    this.onSnapshot?.(snapshot);
  }
  poll() {
    if (!this.receiver) return;
    run('devkits-system.' + systemCommand(systemClientPrefix, {
      id: this.clientId, receiver: this.receiver, active: Boolean(this.active()),
    }));
  }
  close() {
    if (this.receiver) run('devkits-system.' + systemCommand(systemClientPrefix, { id: this.clientId, receiver: this.receiver, active: false }));
  }
  snapshot() {
    const config = hardwareConfig();
    return { data: this.hardware, history: this.hardwareHistory || [], error: Boolean(this.hardwareError), updatedAt: this.hardwareCheckedAt,
      widgets: config.order.filter(id => config.visible[id] && hardwareAvailable(id, this.hardware)) };
  }
  open(page = 'overview') {
    if (this.openDetails) return this.openDetails(page);
    return openOverlay({ mod: 'devkits-system', kind: 'dialog', frame: 'none', width: 0.9, height: 0.82, props: { view: 'details', page } });
  }
  renderInline(t, { id = 'system-inline' } = {}) {
    const root = h_flex().id(id).flex_1().min_w(0).h_full().items_center().gap(2);
    const config = hardwareConfig();
    const data = this.hardware, ids = config.order.filter(id => config.visible[id] && hardwareAvailable(id, data));
    const prefix = id;
    const labels = { cpu: 'CPU', gpu: 'GPU', ram: 'RAM', disk: 'I/O', network: '', storage: 'Disk', battery: 'BAT', sensors: 'TEMP' };
    return root.accessibility_label('System monitor')
      .child(h_flex().id(`${id}-metrics`).min_w(0).h_full().overflow_x_scroll().items_center()
        .children(ids.map(id => Button(`${prefix}-${id}`, t, { variant: 'ghost' }).h_full().px(6).gap(4).text_size(11)
          .accessibility_label(`${hardwareTitle(id)}: ${hardwareValue(id, data)}. Open details`)
          .on_click(() => this.open(id))
          .when(Boolean(labels[id]), el => el.child(div().text_color(t.muted).child(labels[id])))
          .child(div().font_family('Geist Mono').text_color(t.foreground).child(hardwareStatusValue(id, data))))))
      .child(div().flex_1());
  }

  renderWidgets(t, { id: prefix = 'system', style = 'compact', cpuMode = 'total', onWidgetSize } = {}) {
    const data = this.hardware, config = hardwareConfig(), history = this.hardwareHistory || [];
    const colors = hardwareColors(t);
    const ids = config.order.filter(id => config.visible[id] && hardwareAvailable(id, data));
    return v_flex().id(`${prefix}-widgets`).w_full().gap(0).children(ids.map(id => {
        const rates = id === 'disk' || id === 'network';
        const capacityRow = id === 'ram' || id === 'disk' || id === 'gpu' || id === 'storage';
        const gpu = id === 'gpu' ? primaryHardwareGPU(data) : null;
        const coreMode = id === 'cpu' && cpuMode === 'cores';
        const usageBar = ['cpu', 'ram', 'gpu', 'storage'].includes(id);
        const percent = this.hardwareError ? null : id === 'cpu' ? data?.cpu : id === 'ram' ? data?.memory?.percent : id === 'gpu' ? gpu?.percent : data?.disk?.percent;
        const title = ({ ram: data?.memory?.type ? `RAM · ${data.memory.type}` : 'RAM', disk: data?.disk?.model ? `Disk I/O · ${data.disk.model}` : 'Disk I/O', storage: 'Storage', network: 'Network', battery: 'Battery' })[id] || id.toUpperCase();
        const capacity = id === 'ram' ? data?.memory?.total : id === 'disk' || id === 'storage' ? data?.disk?.total : gpu?.memory?.total;
        const model = id === 'cpu' ? data?.cpuName : id === 'ram'
          ? [data?.memory?.manufacturer, data?.memory?.model, data?.memory?.speed].filter(Boolean).join(' · ')
          : id === 'gpu' ? gpu?.name : id === 'storage' ? data?.disk?.model : null;
        const value = this.hardwareError ? 'Unavailable' : !data ? 'Loading…' : id === 'cpu' && data.cpu === null ? 'Sampling…'
          : capacityRow ? `${hardwareBytes(capacity).replace(/\.0(?= )/, '')}${id === 'gpu' && Number.isFinite(capacity)
            ? gpu.memory.type === 'unified' ? ' unified' : gpu.memory.type === 'shared' ? ' shared' : ' VRAM' : ''}` : hardwareValue(id, data);
        const subtitle = coreMode ? `${selectedHardwareCores(config, data?.cores).length} of ${data?.cores || '—'} cores`
          : id === 'cpu' ? 'Overall usage'
          : id === 'ram' && data?.memory ? `${hardwareBytes(data.memory.used)} used`
          : id === 'gpu' && gpu ? 'Usage'
          : id === 'storage' && data?.disk ? `${hardwareBytes(data.disk.used)} used`
          : id === 'disk' ? hardwareValue(id, data) : hardwareSubtitle(id, data);
        const card = Button(`${prefix}-${id}`, t, { variant: 'ghost' }).w_full().h_auto().py(style === 'compact' ? 4 : 6).px(12).flex_col().items_stretch().gap(3)
          .accessibility_label(`${title}: ${value}${capacityRow ? ` total. ${subtitle}` : ''}. Open ${hardwareTitle(id)} details`).on_click(() => this.open(id))
          .child(h_flex().w_full().h(16).flex_none().items_center().gap(8)
            .child(div().min_w(0).truncate().text_size(11).font_medium().text_color(t.foreground).child(title))
            .child(div().flex_1())
            .when(id !== 'cpu' || this.hardwareError || !data || data.cpu === null, el => el.child(div().id(`${prefix}-${id}-value`).flex_none().text_size(rates && !capacityRow ? 10 : 12).font_family('Geist Mono').text_color(colors[id]).child(value))))
          .when(['cpu', 'ram', 'gpu', 'storage'].includes(id), el => el.child(div().id(`${prefix}-${id}-model`).w_full().h(14).flex_none().text_left().truncate().text_size(10).text_color(t.muted)
            .child(model || (data ? 'Model not reported' : 'Waiting for system data'))))
          .when(style === 'graph' || capacityRow || id === 'cpu', el => el.child(h_flex().id(`${prefix}-${id}-usage`).w_full().h(16).flex_none().gap(10).items_center()
            .child(div().id(`${prefix}-${id}-subtitle`).flex_1().min_w(0).text_left().truncate().text_size(10).text_color(t.muted)
              .child(subtitle))
            .when(usageBar, el => el.child(hardwareUsageBar(`${prefix}-${id}-bar`, percent, id, t, coreMode
              ? hardwareCoreBars(`${prefix}-core-bars`, data, config, t, 12).flex_1().flex_basis(0).min_w(0) : null)))
            .when(!usageBar && style === 'graph', el => el.child(div().w(84).flex_none().child(coreMode ? hardwareCoreBars(`${prefix}-core-bars`, data, config, t, 16)
              : hardwareChart(`${prefix}-chart-${id}`, history, id, t, 16))))));
        return onWidgetSize ? v_flex().id(`${prefix}-${style}-${cpuMode}-${id}-layout`).w_full().h_auto().flex_none()
          .on_size_change((size, cx) => onWidgetSize(id, size, cx)).child(card) : card;
      }));
  }

}

export { hardwareColors, hardwareAvailable, hardwareTitle, primaryHardwareGPU, hardwareValue, hardwareSubtitle, hardwareChart };
