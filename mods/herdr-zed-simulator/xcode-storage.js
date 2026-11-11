import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, appHome, home, notify, closeOverlay, openOverlay, props, theme, shared, setShared } from 'herdr';
import { Button } from './components/button.js';
import { glyph } from './components/icon.js';
import { Checkbox } from './components/checkbox.js';
import { DropdownMenuLabel } from './components/dropdown-menu.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from './components/alert-dialog.js';

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

const reader = () => `${appHome()}/mods/herdr-zed-simulator/xcode-storage-reader.js`;

// A deletion's outcome, published by its confirmation. The storage panel rescans when the revision changes.
export const STORAGE_RESULT = 'herdr-zed.simulator-storage-result';

export default class XcodeStorage {
  init(cx) {
    this.closed = false;
    this.cx = cx;
    this.handle = cx.focus_handle(); this.handle.focus();
    this.selected = new Set();
    this.seenResult = shared(STORAGE_RESULT)?.revision ?? null;
    this.scan(cx);
  }

  close() { this.closed = true; this.handle?.release?.(); }

  scan(cx) {
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [reader(), 'scan']);
        if (this.closed) return;
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
      } catch (error) { if (!this.closed) this.error = error.message; }
      finally { this.loading = false; if (!this.closed) cx.notify(); }
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

  // The confirmation finished: keep what could not be removed in view, forget the selection and measure again.
  finishDeletion(result) {
    this.deleteErrors = result.errors || [];
    this.selected.clear();
    this.scan(this.cx);
  }

  // Opens the confirmation for the checked items. Booted simulators are never checked, so never listed.
  review() {
    const chosen = this.chosen();
    if (!chosen.length) return;
    openOverlay({ mod: 'herdr-zed-simulator', kind: 'dialog', frame: 'none', modal: true, width: 440,
      props: { view: 'simulator-storage-confirm', items: chosen.map(({ kind, id, label, size }) => ({ kind, id, label, size })) } });
  }

  toggle(keys, checked, cx) {
    for (const key of keys) checked ? this.selected.add(key) : this.selected.delete(key);
    cx.notify();
  }

  row(id, t, item, columns, checkbox) {
    const cells = el => el.child(div().flex_1().min_w(0).truncate().text_size(13).child(item.label))
      .children(columns.map(([text, width, color]) => div().w(width).flex_none().truncate().text_size(12)
        .text_color(color || t.muted).when(width === 88, el => el.text_right()).child(text)));
    if (!checkbox) return cells(h_flex().id(id).h(36).px(8).gap(8).flex_none().items_center().border_b(1).border_color(t.border).pl(32));
    return cells(Checkbox(id, this.selected.has(item.key), t).h(36).px(8).flex_none().border_b(1).border_color(t.border)
      .accessibility_label(`${item.label}, ${bytes(item.size)}`)
      .on_change((checked, cx) => this.toggle([item.key], checked, cx)));
  }

  // A group's checkbox covers the items it can select; booted simulators stay out.
  groupHeader(id, t, title, items, size) {
    const keys = items.filter(item => !item.booted).map(item => item.key);
    return Checkbox(id, keys.length > 0 && keys.every(key => this.selected.has(key)), t)
      .h(28).px(8).flex_none().bg(t.hover).disabled(!keys.length)
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
    const t = theme(), close = () => closeOverlay(props().overlay);
    const result = shared(STORAGE_RESULT);
    if (result && result.revision !== this.seenResult) { this.seenResult = result.revision; this.finishDeletion(result); }
    const items = this.items();
    const derived = items.filter(item => item.kind === 'derived'), simulators = items.filter(item => item.kind === 'simulator');
    const missing = derived.filter(item => item.missing).map(item => item.key);
    const chosen = this.chosen(), chosenSize = sum(chosen);
    const data = this.data, totals = data ? [
      ['DerivedData', sum(data.derived)], ['Simulators', sum(data.simulators)], ['Runtimes', sum(data.runtimes)], ['Archives', data.archives.size],
    ] : [];
    return DialogContent('xcode-storage', t).gap(12).track_focus(this.handle).accessibility_label('Xcode storage')
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); close(); } })
      .child(h_flex().flex_none().items_center().gap(12)
        .child(DialogTitle().flex_1().min_w(0).child('Xcode storage'))
        .child(Button('xcode-storage-close', t, { variant: 'ghost', size: 'icon' }).accessibility_label('Close Xcode storage').tooltip('Close Xcode storage').on_click(close).child(glyph('close', 14))))
      .child(DialogDescription(t).flex_none().child('~/Library/Developer · Xcode rebuilds DerivedData when a project builds again. Deleting a simulator removes its apps and data.'))
      .child(h_flex().flex_none().gap(16)
        .children([['Total', sum(totals.map(([, size]) => ({ size })))], ...totals].map(([title, size]) => v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(11).text_color(t.muted).child(title))
          .child(div().text_size(20).font_medium().child(data ? bytes(size) : '—')))))
      .child(v_flex().id('xcode-storage-list').flex_1().min_h(0).overflow_y_scroll()
        .when(!data, el => el.child(DialogDescription(t).py(8).child(this.loading ? 'Measuring Xcode storage…' : 'No storage information available.')))
        .when(Boolean(data), el => el
          .child(this.section(t, 'DERIVED DATA', missing.length ? Button('xcode-storage-select-missing', t, { variant: 'secondary' })
            .child(`Select ${missing.length} with missing workspace`)
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
      .children([...(data?.errors || []), ...(this.error ? [this.error] : []), ...(this.deleteErrors || [])].map(text => div().flex_none().text_size(12).text_color(t.blocked).child(text)))
      .child(DialogFooter().flex_none().items_center()
        .child(DialogDescription(t).flex_1().min_w(0).child(chosen.length ? `${chosen.length} selected · ${bytes(chosenSize)}` : this.loading && data ? 'Measuring…' : ''))
        .child(Button('xcode-storage-review', t, { variant: 'secondary' }).disabled(!chosen.length || this.loading).child('Delete…')
          .on_click(() => this.review())));
  }
}

// The confirmation for a storage deletion: its own modal dialog, 440 wide. It runs the delete, publishes the outcome for
// the storage panel to rescan, and closes. The reader checks booted state again before it removes anything.
export class XcodeStorageConfirm {
  init(cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    this.busy = false;
    this.items = props().items || [];
  }

  close() { this.handle?.release?.(); }

  dismiss() { if (!this.busy) closeOverlay(props().overlay); }

  remove(cx) {
    if (this.busy || !this.items.length) return;
    this.busy = true; cx.notify();
    const items = this.items, overlay = props().overlay;
    cx.spawn(async () => {
      let outcome = { removed: 0, freed: 0, errors: [] };
      try {
        const result = await exec('node', [reader(), 'delete', JSON.stringify(items.map(({ kind, id, label }) => ({ kind, id, label })))]);
        const data = JSON.parse(result.stdout || '{}');
        if (data.error) throw new Error(data.error);
        const removed = items.filter(item => data.removed.some(r => r.kind === item.kind && r.id === item.id));
        outcome = { removed: removed.length, freed: sum(removed), errors: data.errors || [] };
      } catch (error) { outcome = { removed: 0, freed: 0, errors: [error.message] }; }
      if (outcome.removed) notify({ title: 'Xcode storage cleaned', body: `Deleted ${outcome.removed} items · ${bytes(outcome.freed)} freed` });
      setShared(STORAGE_RESULT, { revision: (shared(STORAGE_RESULT)?.revision || 0) + 1, errors: outcome.errors });
      try { closeOverlay(overlay); } catch { /* already closed */ }
    });
  }

  render() {
    const t = theme(), items = this.items;
    const count = items.length, total = sum(items);
    const derived = items.filter(item => item.kind === 'derived').length, simulators = count - derived;
    const parts = [derived && (derived === 1 ? '1 DerivedData folder' : `${derived} DerivedData folders`),
      simulators && (simulators === 1 ? '1 simulator' : `${simulators} simulators`)].filter(Boolean);
    return AlertDialogContent('xcode-storage-confirm', t).accessibility_label(`Delete ${count} items?`).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); this.dismiss(); } })
      .child(AlertDialogTitle().child(`Delete ${count === 1 ? '1 item' : `${count} items`}?`))
      .child(AlertDialogDescription(t).child(`Frees ${bytes(total)} from ${parts.join(' and ')}.${simulators ? ' Deleting a simulator removes its apps and data.' : ''} This cannot be undone.`))
      .child(AlertDialogFooter().children([
        AlertDialogCancel('xcode-storage-confirm-cancel', t).disabled(this.busy).on_click(() => this.dismiss()).child('Cancel'),
        Button('xcode-storage-confirm-delete', t, { variant: 'destructive' }).disabled(this.busy)
          .on_click((_event, cx) => this.remove(cx)).child(this.busy ? 'Deleting…' : 'Delete'),
      ]));
  }
}
