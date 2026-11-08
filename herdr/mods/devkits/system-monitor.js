import { div, PathBuilder } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, appHome, closeOverlay, shared, setShared } from 'herdr';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { ToggleGroup, ToggleGroupItem } from './components/toggle-group.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { glyph } from './components/icon.js';
import { hardwareModules, hardwarePreferences, selectedHardwareCores, hardwareBytes, hardwarePercent, hardwareSpeed, hardwarePower, hardwarePoint, hardwareSensorSummary, appendHardwareHistory, hardwareChartPoints } from './hardware-model.js';
import { topologyGroups, topologyLabel, processorLabel } from './hardware-topology.js';
import { moveOption } from './model.js';

let hardwareCache = null, hardwareRequest = null;
const hardwareConfig = () => hardwarePreferences(shared('devkits.system-monitor'));
const hardwareColors = t => ({ cpu: t.ansi4 || t.done, gpu: t.ansi5 || t.done, ram: t.ansi6 || t.working,
  storage: t.ansi3 || t.blocked, disk: t.ansi4 || t.done, network: t.working, battery: t.working, sensors: t.ansi3 || t.blocked });
const hardwareCached = () => {
  try { return JSON.parse(globalThis.window?.sessionStorage?.getItem('devkits.hardware-live') || 'null') || hardwareCache; }
  catch { return hardwareCache; }
};
const cacheHardware = value => {
  hardwareCache = value;
  try { globalThis.window?.sessionStorage?.setItem('devkits.hardware-live', JSON.stringify(value)); } catch {}
};
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

// Data and reusable renderers. The consumer owns mounting, layout and presentation preferences.
export class SystemMonitor {
  constructor({ active = () => true, details = false, page, overlay, openDetails } = {}) {
    this.active = active;
    this.details = details;
    this.overlay = overlay;
    this.hardwarePage = page;
    this.openDetails = openDetails;
  }

  snapshot() {
    const config = hardwareConfig();
    return { data: this.hardware, history: this.hardwareHistory || [], error: Boolean(this.hardwareError), updatedAt: this.hardwareCheckedAt,
      widgets: config.order.filter(id => config.visible[id] && hardwareAvailable(id, this.hardware)) };
  }

  init(cx) {
    if (this.started) return;
    this.started = true;
    if (this.details) {
      this.handle = cx.focus_handle();
      this.handle.focus();
    }
    this.poll(cx, false);
    cx.timer.every(1000, cx => this.poll(cx));
  }

  poll(cx, notify = true) {
    if (!this.active()) return;
    const config = hardwareConfig();
    const cached = hardwareCached();
    if (cached && cached.sensorCollection === config.visible.sensors && Date.now() - cached.checkedAt < config.interval * 1000) {
      if (this.hardwareCheckedAt !== cached.checkedAt) {
        this.hardware = cached.data; this.hardwareSample = cached.sample; this.hardwareHistory = cached.history;
        this.hardwareError = cached.error; this.hardwareCheckedAt = cached.checkedAt;
        if (notify) cx.notify();
      }
      return;
    }
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.hardwareLoading) return;
    this.hardwareLoading = true;
    cx.spawn(async cx => {
      if (!hardwareRequest) hardwareRequest = (async () => {
        const cached = hardwareCached();
        try {
          const sensorCollection = hardwareConfig().visible.sensors;
          const result = await exec('node', [`${appHome()}/mods/devkits/hardware-reader.js`, JSON.stringify(cached?.sample || this.hardwareSample || null), JSON.stringify({ sensors: sensorCollection })]);
          if (result.code !== 0) throw new Error('Hardware unavailable');
          const data = JSON.parse(result.stdout);
          const checkedAt = Date.now();
          if (!data || typeof data !== 'object') throw new Error('Hardware unavailable');
          data.updatedAt ||= checkedAt;
          return { data, sample: data.sample, history: appendHardwareHistory(cached?.history, data), checkedAt, sensorCollection, error: false };
        } catch {
          const checkedAt = Date.now();
          return { data: null, sample: null, history: appendHardwareHistory(cached?.history, { updatedAt: checkedAt }), checkedAt, sensorCollection: hardwareConfig().visible.sensors, error: true };
        }
      })().then(result => { cacheHardware(result); return result; }).finally(() => { hardwareRequest = null; });
      try {
        const cached = await hardwareRequest;
        this.hardware = cached.data; this.hardwareSample = cached.sample; this.hardwareHistory = cached.history;
        this.hardwareError = cached.error; this.hardwareCheckedAt = cached.checkedAt;
      } finally { this.hardwareLoading = false; cx.notify(); }
    });
  }

  saveHardwarePreference(patch, cx) {
    const current = hardwareConfig();
    setShared('devkits.system-monitor', hardwarePreferences({ ...current, ...patch }));
    cx.notify();
  }

  cancelHardwareDrag(cx) {
    if (!this.hardwareDrag) return;
    this.hardwareDrag = null; this.hardwareDrop = null; cx.notify();
  }

  open(page = 'overview') { return this.openDetails?.(page); }

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

  renderWidgets(t, { id: prefix = 'system', style = 'graph', cpuMode = 'total' } = {}) {
    const data = this.hardware, config = hardwareConfig(), history = this.hardwareHistory || [];
    const colors = hardwareColors(t);
    const ids = config.order.filter(id => config.visible[id] && hardwareAvailable(id, data));
    return v_flex().id(`${prefix}-widgets`).w_full().gap(0).children(ids.map(id => {
        const rates = id === 'disk' || id === 'network';
        const capacityRow = id === 'ram' || id === 'disk' || id === 'gpu';
        const gpu = id === 'gpu' ? primaryHardwareGPU(data) : null;
        const coreMode = id === 'cpu' && cpuMode === 'cores';
        const title = ({ ram: data?.memory?.type ? `RAM · ${data.memory.type}` : 'RAM', disk: data?.disk?.model ? `Disk I/O · ${data.disk.model}` : 'Disk I/O', storage: 'Storage', network: 'Network', battery: 'Battery' })[id] || id.toUpperCase();
        const capacity = id === 'ram' ? data?.memory?.total : id === 'disk' ? data?.disk?.total : gpu?.memory?.total;
        const value = this.hardwareError ? 'Unavailable' : !data ? 'Loading…' : id === 'cpu' && data.cpu === null ? 'Sampling…'
          : capacityRow ? `${hardwareBytes(capacity).replace(/\.0(?= )/, '')}${id === 'gpu' && Number.isFinite(capacity)
            ? gpu.memory.type === 'unified' ? ' unified' : gpu.memory.type === 'shared' ? ' shared' : ' VRAM' : ''}` : hardwareValue(id, data);
        const subtitle = coreMode ? `${selectedHardwareCores(config, data?.cores).length} of ${data?.cores || '—'} cores`
          : id === 'ram' && data?.memory ? `${hardwareBytes(data.memory.used)} used · ${hardwarePercent(data.memory.percent)}`
          : id === 'gpu' && gpu ? `${gpu.name} · ${hardwarePercent(gpu.percent)}`
          : id === 'disk' ? hardwareValue(id, data) : hardwareSubtitle(id, data);
        return Button(`${prefix}-${id}`, t, { variant: 'ghost' }).w_full().h_auto().py(style === 'compact' ? 4 : 6).px(12).flex_col().items_stretch().gap(3)
          .accessibility_label(`${title}: ${value}${capacityRow ? ` total. ${subtitle}` : ''}. Open ${hardwareTitle(id)} details`).on_click(() => this.open(id))
          .child(h_flex().w_full().items_center().gap(8)
            .child(div().min_w(0).truncate().text_size(11).font_medium().text_color(t.foreground).child(title))
            .child(div().flex_1())
            .child(div().id(`${prefix}-${id}-value`).flex_none().text_size(rates && !capacityRow ? 10 : 12).font_family('Geist Mono').text_color(colors[id]).child(value)))
          .when(style === 'graph' || capacityRow, el => el.child(h_flex().w_full().gap(10).items_center()
            .child(div().id(`${prefix}-${id}-subtitle`).flex_1().min_w(0).text_left().truncate().text_size(10).text_color(t.muted)
              .child(subtitle))
            .when(style === 'graph', el => el.child(div().w(84).flex_none().child(coreMode ? hardwareCoreBars(`${prefix}-core-bars`, data, config, t, 16)
              : hardwareChart(`${prefix}-chart-${id}`, history, id, t, 16))))))
          .when(style === 'compact' && coreMode, el => el.child(hardwareCoreBars(`${prefix}-core-bars`, data, config, t, 16)));
      }));
  }

  hardwareSettings(t) {
    const config = hardwareConfig(), data = this.hardware || hardwareCached()?.data;
    const coreColumns = (this.hardwareWidth || 0) >= 1100 ? 4 : 2;
    const choices = (id, label, options, value, key) => h_flex().w_full().py(10).gap(12).items_center()
      .child(div().flex_1().text_size(12).child(label))
      .child(ToggleGroup(`hardware-setting-${id}`, label, t).children(options.map(([option, name], index) =>
        ToggleGroupItem(`hardware-${id}-${option}`, value === option, index === 0, t).child(name)
          .accessibility_label(`${label}: ${name}`)
          .on_change((pressed, cx) => { if (pressed) this.saveHardwarePreference({ [key]: option }, cx); else cx.notify(); }))));
    const widgets = v_flex().flex_none().border(1).border_color(t.border).children(config.order.map((id, index) => {
        const module = hardwareModules.find(module => module.id === id);
        return h_flex().id(`hardware-setting-row-${id}`).min_h(50).pl(4).pr(12).gap(8).items_center()
          .when(index > 0, el => el.border_t(1).border_color(t.border))
          .opacity(this.hardwareDrag === id ? 0.5 : 1)
          .bg(this.hardwareDrag && this.hardwareDrop === id && this.hardwareDrag !== id ? t.selected : t.popover)
          .when(Boolean(this.hardwareDrag), el => el.cursor_grabbing())
          .on_mouse_move((_event, cx) => {
            if (this.hardwareDrag && this.hardwareDrop !== id) { this.hardwareDrop = id; cx.notify(); }
          })
          .on_mouse_up('left', (_event, cx) => {
            if (!this.hardwareDrag) return;
            const order = moveOption(hardwareConfig().order, this.hardwareDrag, id);
            this.cancelHardwareDrag(cx); this.saveHardwarePreference({ order }, cx); cx.stop_propagation();
          })
          .child(Button(`hardware-drag-${id}`, t, { variant: 'ghost', size: 'icon' }).cursor_grab()
            .accessibility_label(`Reorder ${module.name}. Drag or use Alt + Up or Down.`)
            .on_mouse_down('left', (_event, cx) => {
              cx.stop_propagation(); this.hardwareDrag = id; this.hardwareDrop = id; cx.notify();
            })
            .on_key_down((event, cx) => {
              if (event.modifiers?.alt && ['up', 'down'].includes(event.key)) {
                const order = hardwareConfig().order, target = order[order.indexOf(id) + (event.key === 'up' ? -1 : 1)];
                if (target) this.saveHardwarePreference({ order: moveOption(order, id, target) }, cx);
                cx.stop_propagation();
              } else if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
            }).child(glyph('grip-vertical')))
          .child(Checkbox(`hardware-visible-${id}`, config.visible[id], t).flex_1().min_w(0)
            .accessibility_label(`Show ${module.name}`).on_change((checked, cx) => this.saveHardwarePreference({ visible: { ...hardwareConfig().visible, [id]: checked } }, cx))
            .child(v_flex().min_w(0).gap(3).py(8)
              .child(div().text_size(12).text_color(t.foreground).child(module.name))
              .child(div().text_size(10).text_color(t.muted).child(id === 'battery' && data && !data.battery ? 'No battery detected · appears when available' : module.description))));
      }));
    const display = v_flex().flex_1().min_w(0).gap(16)
      .child(div().text_size(11).font_medium().text_color(t.muted).child('MONITORING'))
      .child(v_flex().flex_none().px(12).border(1).border_color(t.border)
        .child(choices('interval', 'Update every', [[1, '1s'], [3, '3s'], [5, '5s'], [10, '10s']], config.interval, 'interval')))
      .child(v_flex().flex_none().px(12).border(1).border_color(t.border)
        .child(choices('cpu-graph', 'CPU graph', [['total', 'Total'], ['logical', 'Logical'], ['groups', 'P / E']], config.cpuGraph, 'cpuGraph')))
      .child(v_flex().flex_none().p(12).gap(10).border(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(12).child(`${topologyLabel(data?.topology, data?.cores)} · choose which to show`))
          .child(Button('hardware-cores-all', t, { variant: 'ghost' }).h(24).px(6).child('All')
            .on_click((_event, cx) => this.saveHardwarePreference({ cores: null }, cx))))
        .children(Array.from({ length: Math.ceil((data?.cores || 0) / coreColumns) }, (_, row) => h_flex().gap(12).children(
          Array.from({ length: Math.min(coreColumns, data.cores - row * coreColumns) }, (_, column) => {
            const index = row * coreColumns + column;
            return Checkbox(`hardware-core-${index}`, selectedHardwareCores(config, data.cores).includes(index), t).flex_1().min_w(0)
              .accessibility_label(`Show ${processorLabel(data.topology?.processors?.[index], index)}`)
              .child(div().min_w(0).truncate().text_size(11).child(processorLabel(data.topology?.processors?.[index], index)))
              .on_change((checked, cx) => {
                const selected = selectedHardwareCores(hardwareConfig(), data.cores);
                this.saveHardwarePreference({ cores: checked ? [...new Set([...selected, index])] : selected.filter(core => core !== index) }, cx);
              });
          })))));
    return v_flex().id('hardware-settings').flex_1().min_h(0).overflow_y_scroll().gap(20)
      .on_mouse_up('left', (_event, cx) => this.cancelHardwareDrag(cx))
      .on_hover((inside, cx) => { if (!inside) this.cancelHardwareDrag(cx); })
      .on_key_down((event, cx) => {
        if (event.key === 'escape' && this.hardwareDrag) { this.cancelHardwareDrag(cx); cx.stop_propagation(); }
      })
      .child(v_flex().flex_none().gap(4)
        .child(div().text_size(16).font_semibold().child('System monitor'))
        .child(DialogDescription(t).child('Choose what to show and drag the handles to reorder. Changes save automatically.')))
      .child(h_flex().w_full().gap(24).items_start()
        .child(v_flex().flex_1().min_w(0).gap(16)
          .child(div().text_size(11).font_medium().text_color(t.muted).child('WIDGETS')).child(widgets))
        .child(display));
  }

  hardwareMetricCard(id, t, large = false) {
    const data = this.hardware, history = this.hardwareHistory || [], color = hardwareColors(t)[id];
    const rates = id === 'disk' || id === 'network';
    const rateKeys = id === 'disk' ? ['read', 'write'] : ['received', 'sent'];
    const rateData = id === 'disk' ? data?.disk?.rates : data?.network?.rates;
    const summary = hardwareSensorSummary(data);
    const temperature = id === 'cpu' ? summary.cpu : id === 'gpu' ? summary.gpu : null;
    const sensorKey = summary.cpu !== null ? 'sensor:cpu' : summary.gpu !== null ? 'sensor:gpu' : 'sensor:ssd';
    return v_flex().id(`hardware-detail-${id}`).flex_1().flex_basis(0).min_w(0).h_auto().p(16).gap(12).border(1).border_color(t.border)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(12).font_semibold().child(hardwareTitle(id)))
        .when(Number.isFinite(temperature), el => el.child(div().text_size(11).text_color(t.muted).child(`${temperature.toFixed(1)} °C peak`)))
        .when(id === 'ram' && Boolean(data?.memory?.pressure), el => el.child(div().text_size(10)
          .text_color(data.memory.pressure === 'Critical' ? t.ansi1 : data.memory.pressure === 'Warning' ? t.blocked : t.working).child(data.memory.pressure))))
      .when(!rates, el => el.child(div().h(44).flex_none().text_size(large ? 38 : 28).line_height(1.1).font_family('Geist Mono').text_color(color)
        .child(this.hardwareError ? 'Unavailable' : hardwareValue(id, data))))
      .when(rates, el => el.child(h_flex().h(44).flex_none().gap(16).items_start().children(rateKeys.map((key, index) => v_flex().flex_1().min_w(0).gap(4)
        .child(div().text_size(10).text_color(t.muted).child((id === 'disk' ? ['READ', 'WRITE'] : ['DOWNLOAD', 'UPLOAD'])[index]))
        .child(div().text_size(large ? 22 : 17).font_family('Geist Mono').text_color(index ? t.ansi5 || t.blocked : color).child(hardwareSpeed(rateData?.[key])))))))
      .child(hardwareChart(`hardware-chart-${id}`, history, id, t, large ? 180 : 64, id === 'sensors' ? sensorKey : null))
      .child(h_flex().justify_between().text_size(10).text_color(t.muted).child('3 min ago').child('Now'))
      .child(div().text_size(11).text_color(t.muted).truncate().child(hardwareSubtitle(id, data)));
  }

  hardwareCPUCharts(t) {
    const config = hardwareConfig(), data = this.hardware;
    const selected = selectedHardwareCores(config, data?.cores);
    const topology = data?.topology || { processors: selected.map(index => ({ index, id: `cpu:${index}`, logical: index, group: 0, type: null })) };
    const groups = config.cpuGraph === 'groups' ? topologyGroups(topology, selected)
      : [{ name: 'Logical processors', processors: topology.processors.filter(cpu => selected.includes(cpu.index)) }];
    const columns = (this.hardwareWidth || 1400) >= 1100 ? 4 : 2;
    const chartHeight = selected.length > 32 ? 36 : 56;
    const tileHeight = chartHeight + 48;
    const signature = data?.topology?.processors?.map(cpu => cpu.id).join('|');
    const history = (this.hardwareHistory || []).map(point => point.cpuTopology && point.cpuTopology !== signature
      ? { at: point.at } : point);
    return v_flex().id('hardware-cpu-graphs').flex_none().gap(16)
      .child(h_flex().w_full().gap(12).items_center()
        .child(div().flex_1().text_size(12).font_semibold().child('CPU utilization'))
        .child(ToggleGroup('hardware-cpu-graph-mode', 'CPU graph view', t).children([
          ['total', 'Total'], ['logical', 'Logical processors'], ['groups', 'P / E groups'],
        ].map(([value, label], index) => ToggleGroupItem(`hardware-cpu-view-${value}`, config.cpuGraph === value, index === 0, t).child(label)
          .accessibility_label(`CPU graph: ${label}`)
          .on_change((pressed, cx) => { if (pressed) this.saveHardwarePreference({ cpuGraph: value }, cx); else cx.notify(); })))))
      .when(config.cpuGraph === 'total', el => el.child(this.hardwareMetricCard('cpu', t, true)))
      .when(config.cpuGraph !== 'total', el => el
        .when(config.cpuGraph === 'groups' && !topology.processors.some(cpu => cpu.type), el => el
          .child(DialogDescription(t).child('This system does not report distinct P/E classes.')))
        .child(h_flex().items_center().gap(12)
          .child(div().text_size(32).font_family('Geist Mono').text_color(hardwareColors(t).cpu).child(hardwarePercent(data?.cpu)))
          .child(div().text_size(11).text_color(t.muted).child(`Total · ${topologyLabel(data?.topology, data?.cores)}`)))
        .children(groups.map(group => v_flex().id(`hardware-cpu-group-${group.type || 'all'}`).role('group')
          .accessibility_label(`${group.name} charts`).flex_none().gap(10)
          .child(h_flex().justify_between().text_size(11).text_color(t.muted)
            .child(group.name).child(`${group.processors.length} logical processors`))
          .children(Array.from({ length: Math.ceil(group.processors.length / columns) }, (_, row) => h_flex().w_full().h(tileHeight).flex_none().items_stretch().gap(10)
            .children(group.processors.slice(row * columns, row * columns + columns).map(cpu =>
              div().flex_1().flex_basis(0).min_w(0).h(tileHeight).child(
              v_flex().id(`hardware-cpu-processor-${cpu.index}`).w_full().h_full().min_w(0).p(10).gap(8).border(1).border_color(t.border)
                .role('group').accessibility_label(`${processorLabel(cpu, cpu.index)} usage graph`)
                .child(h_flex().justify_between().gap(6).text_size(11)
                  .child(processorLabel(cpu, cpu.index))
                  .child(div().font_family('Geist Mono').text_color(cpu.type === 'E' ? t.working : hardwareColors(t).cpu).child(hardwarePercent(data?.coreUsage?.[cpu.index]))))
                .child(hardwareChart(`hardware-cpu-history-${cpu.index}`, history, 'cpu', cpu.type === 'E' ? { ...t, ansi4: t.working } : t,
                  chartHeight, `core:${cpu.index}`)))))
            .children(Array.from({ length: columns - group.processors.slice(row * columns, row * columns + columns).length }, () => div().flex_1().flex_basis(0).min_w(0).h(tileHeight)))))))
        .when(!selected.length, el => el.child(DialogDescription(t).child('No processors selected. Choose cores in Settings.'))))
      .child(Button('hardware-configure-cores', t, { variant: 'ghost' }).self_start().h(28).px(0).child('Choose displayed processors…')
        .on_click((_event, cx) => { this.hardwarePage = 'settings'; cx.notify(); }));
  }

  hardwareModuleDetails(id, t) {
    if (id === 'sensors') return this.hardwareSensorDetails(t);
    const data = this.hardware, memory = data?.memory, disk = data?.disk, network = data?.network, battery = data?.battery;
    const temperatures = hardwareSensorSummary(data);
    const entries = id === 'cpu' ? [['Processor', data?.cpuName], ['Sockets', data?.topology?.sockets], ['Physical cores', data?.topology?.physical], ['Logical processors', data?.cores],
      ...(Number.isFinite(temperatures.cpu) ? [['Highest CPU sensor', `${temperatures.cpu.toFixed(1)} °C`]] : []),
      ...(data?.load ? [['Load · 1 / 5 / 15 min', data.load.map(value => value.toFixed(2)).join(' / ')]] : [])]
      : id === 'gpu' ? [...(data?.gpus || []).flatMap(gpu => [[gpu.name, hardwarePercent(gpu.percent)],
        ['Memory type', gpu.memory?.type === 'unified' ? 'Unified · shared with CPU' : gpu.memory?.type === 'shared' ? 'Shared system memory' : gpu.memory?.type === 'dedicated' ? 'Dedicated VRAM' : 'Not reported'],
        ['Memory capacity', hardwareBytes(gpu.memory?.total)],
        ...(Number.isFinite(gpu.memory?.used) ? [['GPU memory in use', hardwareBytes(gpu.memory.used)]] : []),
        ...(gpu.memory?.type === 'dedicated' && gpu.memory.sharedTotal > 0 ? [['Shared memory limit', hardwareBytes(gpu.memory.sharedTotal)],
          ...(Number.isFinite(gpu.memory.sharedUsed) ? [['Shared memory in use', hardwareBytes(gpu.memory.sharedUsed)]] : [])] : []),
        ...(Number.isFinite(gpu.renderer) || Number.isFinite(gpu.tiler) ? [['Renderer / tiler', `${hardwarePercent(gpu.renderer)} / ${hardwarePercent(gpu.tiler)}`]] : [])]),
        ...(Number.isFinite(temperatures.gpu) ? [['Highest GPU sensor', `${temperatures.gpu.toFixed(1)} °C`]] : [])]
      : id === 'ram' ? [['Total RAM', hardwareBytes(memory?.total)], ['RAM type', memory?.type || 'Not reported'],
        ['Manufacturer', memory?.manufacturer || 'Not reported'], ...(memory?.speed ? [['RAM speed', memory.speed]] : []),
        ['Available', hardwareBytes(memory ? memory.total - memory.used : null)],
        ...[['App RAM', memory?.apps], ['Wired', memory?.wired], ['Compressed', memory?.compressed]].filter(([, value]) => Number.isFinite(value)).map(([label, value]) => [label, hardwareBytes(value)]),
        [data?.platform === 'win32' ? 'Page file used / total' : 'Swap used / total', memory?.swap ? `${hardwareBytes(memory.swap.used)} / ${hardwareBytes(memory.swap.total)}` : null]]
      : id === 'disk' ? [['System disk model', disk?.model || 'Not reported'], ...(disk?.type ? [['Drive type', disk.type]] : []),
        ...(disk?.protocol ? [['Connection', disk.protocol]] : []), ['System volume capacity', hardwareBytes(disk?.total)], ['Read speed', hardwareSpeed(disk?.rates?.read)], ['Write speed', hardwareSpeed(disk?.rates?.write)], ['Scope', 'All physical disks · disk images excluded']]
      : id === 'storage' ? [['System disk model', disk?.model || 'Not reported'], ['Used', hardwareBytes(disk?.used)], ['Available', hardwareBytes(disk?.free)], ['Total', hardwareBytes(disk?.total)]]
      : id === 'network' ? [['Active interface', network?.name], ['Received since interface started', hardwareBytes(network?.received)], ['Sent since interface started', hardwareBytes(network?.sent)]]
      : [['Power source', hardwarePower(battery)], ['Health', hardwarePercent(battery?.health)], ['Cycles', battery?.cycles], ['Battery temperature', Number.isFinite(battery?.temperature) ? `${battery.temperature.toFixed(1)} °C` : null]];
    const chart = v_flex().flex_1().min_w(0).gap(16)
      .child(id === 'cpu' ? this.hardwareCPUCharts(t) : this.hardwareMetricCard(id, t, true));
    return h_flex().id(`hardware-module-${id}`).w_full().items_start().flex_none().gap(20)
      .child(chart)
      .child(v_flex().w(300).flex_none().border(1).border_color(t.border).children(entries.map(([label, value], index) =>
        h_flex().px(16).py(11).gap(16).items_start().when(index > 0, el => el.border_t(1).border_color(t.border))
          .child(div().flex_1().text_size(12).text_color(t.muted).child(label))
          .child(div().max_w(320).text_size(12).text_right().child(value === null || value === undefined ? 'Unavailable' : String(value))))));
  }

  hardwareSensorDetails(t) {
    const data = this.hardware;
    return v_flex().id('hardware-module-sensors').flex_none().gap(20)
      .child(h_flex().items_start().gap(20)
        .child(this.hardwareMetricCard('sensors', t, true))
        .child(v_flex().w(300).flex_none().gap(12)
          .child(div().text_size(13).font_semibold().child('Hardware sensors'))
          .child(DialogDescription(t).child('Temperature points measure thermal zones. They do not correspond one-to-one with CPU cores.'))
          .when(Boolean(data?.sensorStatus), el => el.child(DialogDescription(t).child(data.sensorStatus)))
          .when(!hardwareConfig().visible.sensors, el => el.child(Button('hardware-enable-sensors', t, { variant: 'secondary' }).child('Enable sensors')
            .on_click((_event, cx) => { this.saveHardwarePreference({ visible: { ...hardwareConfig().visible, sensors: true } }, cx); this.refresh(cx); })))))
      .children(['Temperature', 'Fan', 'Power'].flatMap(type => {
        const rows = (data?.sensors || []).filter(row => row.type === type);
        return rows.length ? [v_flex().flex_none().gap(10)
          .child(div().text_size(12).font_semibold().child(type === 'Fan' ? 'Fans' : type === 'Power' ? 'Power' : 'Temperatures'))
          .child(v_flex().border(1).border_color(t.border).children(rows.map((row, index) => h_flex().min_h(36).px(12).gap(16).items_center()
            .when(index > 0, el => el.border_t(1).border_color(t.border))
            .accessibility_label(`${row.name}: ${row.value} ${row.unit}. ${row.source}. ${row.id}`)
            .child(div().flex_1().min_w(0).text_size(12).child(row.name))
            .child(div().w(130).text_right().font_family('Geist Mono').text_size(12).child(`${row.value.toFixed(1)} ${row.unit}`))
            .child(div().w(140).text_right().text_size(10).text_color(t.muted).child(row.source)))))] : [];
      }));
  }

  renderDetails(t) {
    const close = () => closeOverlay(this.overlay), data = this.hardware, config = hardwareConfig();
    const page = this.hardwarePage || 'overview';
    const ids = config.order.filter(id => hardwareAvailable(id, data));
    const nav = [{ id: 'overview', name: 'Overview' }, ...ids.map(id => ({ id, name: hardwareTitle(id) })), { id: 'settings', name: 'Settings' }];
    const selected = nav.some(item => item.id === page) ? page : 'overview';
    const visible = config.order.filter(id => config.visible[id] && hardwareAvailable(id, data));
    const columns = (this.hardwareWidth || 1400) >= 1100 ? 3 : 2;
    return DialogContent('hardware-details', t).track_focus(this.handle).gap(16)
      .on_size_change((size, cx) => { if (this.hardwareWidth !== size.width) { this.hardwareWidth = size.width; cx.notify(); } })
      .accessibility_label('System monitor for this computer')
      .on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); if (this.hardwareDrag) this.cancelHardwareDrag(cx); else close(); }
      })
      .child(h_flex().items_center().gap(12).flex_none()
        .child(v_flex().flex_1().gap(4).child(DialogTitle().child('System monitor'))
          .child(DialogDescription(t).child(`${data?.cpuName || 'This computer'} · ${topologyLabel(data?.topology, data?.cores)}`)))
        .child(div().text_size(11).text_color(this.hardwareError ? t.ansi1 : t.muted).child(this.hardwareError ? 'Read unavailable' : `Live · ${config.interval}s`)))
      .child(h_flex().flex_1().min_h(0).gap(24).items_start()
        .child(v_flex().id('hardware-pages').w(132).flex_none().gap(3).children(nav.map(item =>
          Button(`hardware-page-${item.id}`, t, { variant: 'ghost' }).h(32).px(10).justify_start()
            .bg(selected === item.id ? t.selected : t.popover).text_color(selected === item.id ? t.foreground : t.muted)
            .accessibility_label(`${item.name}${selected === item.id ? ', selected' : ''}`)
            .on_click((_event, cx) => { this.cancelHardwareDrag(cx); this.hardwarePage = item.id; cx.notify(); }).child(item.name))))
        .child(v_flex().id('hardware-details-scroll').h_full().flex_1().min_w(0).min_h(0).overflow_y_scroll().gap(16)
          .when(selected === 'settings', el => el.child(this.hardwareSettings(t)))
          .when(selected === 'overview', el => el
            .when(!visible.length, el => el.child(DialogDescription(t).child('No widgets selected. Choose what to display in Settings.')))
            .children(Array.from({ length: Math.ceil(visible.length / columns) }, (_, row) => h_flex().flex_none().items_stretch().gap(16)
              .children(visible.slice(row * columns, row * columns + columns).map(id => this.hardwareMetricCard(id, t)))
              .children(Array.from({ length: Math.max(0, columns - visible.slice(row * columns, row * columns + columns).length) }, () => div().flex_1().flex_basis(0).min_w(0))))))
          .when(selected !== 'settings' && selected !== 'overview', el => el.child(this.hardwareModuleDetails(selected, t)))))
      .child(DialogFooter().flex_none()
        .child(div().flex_1().self_center().text_size(10).text_color(t.muted)
          .child(data?.updatedAt ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()} · History stays on this computer` : 'Reading system data…'))
        .child(Button('hardware-details-done', t).on_click(close).child('Done')));
  }
}
