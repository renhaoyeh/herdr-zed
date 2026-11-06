import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, appHome, home, notify, closeOverlay, props, theme } from 'herdr';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { DropdownMenuLabel } from './components/dropdown-menu.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';

// Decimal units, as Finder reports sizes.
export const bytes = value => value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB`
  : value >= 1e3 ? `${Math.round(value / 1e3)} KB` : `${value || 0} B`;
const day = value => value ? new Date(value).toLocaleDateString() : '—';
const sum = items => items.reduce((total, item) => total + (item.size || 0), 0);

// A DerivedData folder's workspace, shortened; EAS local builds use a fresh temporary folder every time.
export function workspaceLabel(item, homeDir) {
  if (!item.workspace) return item.id;
  const eas = /\/eas-build-local-nodejs\/([0-9a-f]{8})/.exec(item.workspace);
  if (eas) return `EAS local build ${eas[1]}`;
  return homeDir && item.workspace.startsWith(`${homeDir}/`) ? `~${item.workspace.slice(homeDir.length)}` : item.workspace;
}

// Projects by total size; within one, folders whose workspace is gone come first.
export function derivedGroups(derived) {
  const groups = new Map();
  for (const item of derived) groups.set(item.name, [...(groups.get(item.name) || []), item]);
  return [...groups].map(([name, items]) => ({ name, size: sum(items),
    items: items.sort((a, b) => Number(b.missing) - Number(a.missing) || b.size - a.size) }))
    .sort((a, b) => b.size - a.size);
}

// Simulators by how recently they ran: still in use, idle, or never booted since Xcode created them.
const DAY = 86400000;
export function simulatorGroups(simulators, now = Date.now()) {
  const recent = item => item.booted || (item.lastUsed && now - Date.parse(item.lastUsed) < 7 * DAY);
  const groups = [['RECENTLY USED · LAST 7 DAYS', item => recent(item)], ['NOT USED FOR 7+ DAYS', item => !recent(item) && item.lastUsed],
    ['NEVER USED', item => !item.lastUsed]];
  return groups.map(([title, test]) => ({ title, items: simulators.filter(test).sort((a, b) => b.size - a.size) }))
    .map(group => ({ ...group, size: sum(group.items) })).filter(group => group.items.length);
}

export function lastUsedLabel(value, now = Date.now()) {
  if (!value) return 'Never used';
  const days = Math.floor((now - (typeof value === 'number' ? value : Date.parse(value))) / DAY);
  return days < 1 ? 'Today' : days === 1 ? 'Yesterday' : days < 60 ? `${days} days ago` : `${Math.floor(days / 30)} months ago`;
}

const reader = () => `${appHome()}/mods/devkits/xcode-storage-reader.js`;

export default class XcodeStorage {
  init(cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    this.selected = new Set(); this.confirming = false;
    this.scan(cx);
  }

  scan(cx) {
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [reader(), 'scan']);
        const data = JSON.parse(result.stdout || '{}');
        if (result.code !== 0 || data.error) throw new Error(data.error || 'Could not measure Xcode storage.');
        this.data = data; this.error = null;
        const known = new Set(this.items().map(item => item.key));
        this.selected = new Set([...this.selected].filter(key => known.has(key)));
        // Folders whose workspace is gone are only stale caches, so the first scan checks them.
        if (!this.preselected) {
          this.preselected = true;
          for (const item of this.items()) if (item.missing) this.selected.add(item.key);
        }
      } catch (error) { this.error = error.message; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Everything that can be deleted, keyed for selection.
  items() {
    if (!this.data) return [];
    return [...this.data.derived.map(item => ({ ...item, kind: 'derived', key: `derived:${item.id}`, label: workspaceLabel(item, home()) })),
      ...this.data.simulators.map(item => ({ ...item, kind: 'simulator', key: `simulator:${item.id}`, label: `${item.name} · ${item.os}` }))];
  }

  // Checked items that can be deleted; booted simulators never are.
  chosen() { return this.items().filter(item => this.selected.has(item.key) && !item.booted); }

  remove(cx) {
    const chosen = this.chosen();
    if (!chosen.length || this.busy) return;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [reader(), 'delete', JSON.stringify(chosen.map(({ kind, id, label }) => ({ kind, id, label })))]);
        const data = JSON.parse(result.stdout || '{}');
        if (data.error) throw new Error(data.error);
        const freed = sum(chosen.filter(item => data.removed.some(r => r.kind === item.kind && r.id === item.id)));
        if (data.removed.length) notify({ title: 'Xcode storage cleaned', body: `Deleted ${data.removed.length} items · ${bytes(freed)} freed` });
        if (data.errors.length) this.error = data.errors.join('\n');
        this.selected.clear();
      } catch (error) { this.error = error.message; }
      finally { this.busy = false; this.confirming = false; this.scan(cx); cx.notify(); }
    });
  }

  toggle(keys, checked, cx) {
    for (const key of keys) checked ? this.selected.add(key) : this.selected.delete(key);
    this.confirming = false; cx.notify();
  }

  row(id, t, item, columns, checkbox) {
    const cells = el => el.child(div().flex_1().min_w(0).truncate().text_size(13).child(item.label))
      .children(columns.map(([text, width, color]) => div().w(width).flex_none().truncate().text_size(12)
        .text_color(color || t.muted).when(width === 88, el => el.text_right()).child(text)));
    if (!checkbox) return cells(h_flex().id(id).h(36).px(8).gap(8).flex_none().items_center().border_b(1).border_color(t.border).pl(32));
    return cells(Checkbox(id, this.selected.has(item.key), t).h(36).px(8).flex_none().border_b(1).border_color(t.border)
      .disabled(Boolean(this.busy)).accessibility_label(`${item.label}, ${bytes(item.size)}`)
      .on_change((checked, cx) => this.toggle([item.key], checked, cx)));
  }

  // A group's checkbox covers the items it can select; booted simulators stay out.
  groupHeader(id, t, title, items, size) {
    const keys = items.filter(item => !item.booted).map(item => item.key);
    return Checkbox(id, keys.length > 0 && keys.every(key => this.selected.has(key)), t)
      .h(28).px(8).flex_none().bg(t.hover).disabled(Boolean(this.busy) || !keys.length)
      .accessibility_label(`All ${title}, ${bytes(size)}`)
      .on_change((checked, cx) => this.toggle(keys, checked, cx))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(title))
      .child(div().w(88).flex_none().text_right().text_size(11).text_color(t.muted).child(bytes(size)));
  }

  section(t, title, action) {
    return h_flex().h(28).mt(8).flex_none().items_center().gap(8)
      .child(div().flex_1().text_size(11).text_color(t.muted).child(title))
      .when(Boolean(action), el => el.child(action));
  }

  render() {
    const t = theme(), close = () => { if (!this.busy) closeOverlay(props().overlay); };
    const items = this.items();
    const derived = items.filter(item => item.kind === 'derived'), simulators = items.filter(item => item.kind === 'simulator');
    const missing = derived.filter(item => item.missing).map(item => item.key);
    const chosen = this.chosen(), chosenSize = sum(chosen);
    const data = this.data, totals = data ? [
      ['DerivedData', sum(data.derived)], ['Simulators', sum(data.simulators)], ['Runtimes', sum(data.runtimes)], ['Archives', data.archives.size],
    ] : [];
    return DialogContent('xcode-storage', t).gap(12).track_focus(this.handle).accessibility_label('Xcode storage')
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); close(); } })
      .child(DialogTitle().flex_none().child('Xcode storage'))
      .child(DialogDescription(t).flex_none().child('~/Library/Developer · Xcode rebuilds DerivedData when a project builds again. Deleting a simulator removes its apps and data.'))
      .child(h_flex().flex_none().gap(16)
        .children([['Total', sum(totals.map(([, size]) => ({ size })))], ...totals].map(([title, size]) => v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(11).text_color(t.muted).child(title))
          .child(div().text_size(20).font_medium().child(data ? bytes(size) : '—')))))
      .child(v_flex().id('xcode-storage-list').flex_1().min_h(0).overflow_y_scroll()
        .when(!data, el => el.child(DialogDescription(t).py(8).child(this.loading ? 'Measuring Xcode storage…' : 'No storage information available.')))
        .when(Boolean(data), el => el
          .child(this.section(t, 'DERIVED DATA', missing.length ? Button('xcode-storage-select-missing', t, { variant: 'secondary' })
            .disabled(Boolean(this.busy)).child(`Select ${missing.length} with missing workspace`)
            .on_click((_event, cx) => this.toggle(missing, true, cx)) : null))
          .children(derivedGroups(derived).flatMap(group => [
            this.groupHeader(`xcode-storage-group-${group.name}`, t,
              `${group.name.toUpperCase()} · ${group.items.length === 1 ? '1 folder' : `${group.items.length} folders`}`, group.items, group.size),
            ...group.items.map(item => this.row(`xcode-storage-${item.key}`, t, item, [
              [item.missing ? 'Workspace missing' : item.workspace ? '' : 'Shared cache', 128, item.missing ? t.foreground : null],
              [day(item.lastUsed), 88], [bytes(item.size), 88, t.foreground]], true)),
          ]))
          .child(this.section(t, 'SIMULATORS'))
          .children(simulatorGroups(simulators).flatMap(group => [
            this.groupHeader(`xcode-storage-simulators-${group.title}`, t,
              `${group.title} · ${group.items.length === 1 ? '1 simulator' : `${group.items.length} simulators`}`, group.items, group.size),
            ...group.items.map(item => this.row(item.booted ? `xcode-storage-booted-${item.id}` : `xcode-storage-${item.key}`, t, item, [
              item.booted ? ['Booted', 128, t.done] : [item.available ? lastUsedLabel(item.lastUsed) : 'Unavailable', 128],
              [day(item.lastUsed), 88], [bytes(item.size), 88, t.foreground]], !item.booted)),
          ]))
          .child(this.section(t, 'RUNTIMES · REMOVE IN XCODE › SETTINGS › COMPONENTS'))
          .children(data.runtimes.map(item => this.row(`xcode-storage-runtime-${item.id}`, t, { label: `${item.version} (${item.build})` }, [
            [item.devices === 1 ? '1 simulator' : `${item.devices} simulators`, 128], [day(item.lastUsed), 88], [bytes(item.size), 88, t.foreground]], false)))
          .child(this.section(t, 'ARCHIVES · MANAGE IN XCODE › ORGANIZER'))
          .child(this.row('xcode-storage-archives', t, { label: data.archives.count === 1 ? '1 archive' : `${data.archives.count} archives` }, [
            [data.archives.oldest ? `Since ${data.archives.oldest}` : '', 128], ['', 88], [bytes(data.archives.size), 88, t.foreground]], false))))
      .children([...(data?.errors || []), ...(this.error ? [this.error] : [])].map(text => div().flex_none().text_size(12).text_color(t.blocked).child(text)))
      .child(DialogFooter().flex_none().items_center()
        .child(DialogDescription(t).flex_1().min_w(0).child(this.busy ? 'Deleting…' : this.confirming
          ? `Delete ${chosen.length} items (${bytes(chosenSize)})? This cannot be undone.`
          : chosen.length ? `${chosen.length} selected · ${bytes(chosenSize)}` : this.loading && data ? 'Measuring…' : ''))
        .when(this.confirming, el => el
          .child(Button('xcode-storage-cancel', t, { variant: 'secondary' }).disabled(Boolean(this.busy)).child('Cancel')
            .on_click((_event, cx) => { this.confirming = false; cx.notify(); }))
          .child(Button('xcode-storage-delete', t).disabled(Boolean(this.busy)).child(this.busy ? 'Deleting…' : 'Delete')
            .on_click((_event, cx) => this.remove(cx))))
        .when(!this.confirming, el => el
          .child(Button('xcode-storage-review', t, { variant: 'secondary' }).disabled(!chosen.length || this.loading).child('Delete…')
            .on_click((_event, cx) => { this.confirming = true; cx.notify(); }))
          .child(Button('xcode-storage-done', t).child('Done').on_click(close))));
  }
}
