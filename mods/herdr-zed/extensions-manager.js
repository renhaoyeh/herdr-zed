import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { props } from 'herdr';
import { Button } from './components/button.js';
import { Switch } from './components/switch.js';
import { extensionCatalog, refreshExtensions, extensionEnabled, extensionActive, extensionSurfaceVisible, setExtensionSurfaceVisible } from './extensions.js';
import { extensionCategories } from './extension-model.js';

// design.md, Extensions: macOS Settings style. The left nav lists the optional extensions by category; the right side
// shows the selected one: its header (title, description, places, On/Off) and its own settings view below.
export const SURFACE_PLACES = { 'sidebar.bottom': 'sidebar', 'status.right': 'status bar', 'dock.right': 'right dock' };
const CATEGORY_TITLES = { work: 'Work', sources: 'Task sources', git: 'Git', tools: 'Tools' };

const titleOf = (catalog, id) => (catalog.packages || []).find(item => item.id === id)?.title || id;
// A package's page id: its extension ID, or its mod when the manifest failed to load.
export const extensionKeyOf = entry => entry.id || entry.mod;

// Every optional extension (never the launcher workflow), in category order.
export function managedExtensions(catalog = extensionCatalog()) {
  const launcher = catalog.resolved?.launcher?.mod;
  const list = (catalog.packages || []).filter(entry => entry.mod !== launcher && !entry.provides?.launcher);
  return extensionCategories.flatMap(category => list.filter(entry => (entry.category || 'tools') === category));
}

// A problem to show in red, or the muted platform note; null when there is nothing to say.
export function packageStatus(entry, catalog) {
  if (entry.unsupported) return 'Not available on this platform';
  if (entry.error) return entry.error;
  const conflict = (catalog.resolved?.conflicts || []).find(item => item.mods.includes(entry.mod));
  if (conflict) return `Conflict · ${conflict.provider} is provided by ${conflict.mods.join(', ')}; none is used`;
  const missing = (catalog.resolved?.unavailable || []).find(item => item.mod === entry.mod);
  if (missing && extensionEnabled(entry.mod)) return `Turn on ${missing.missing.map(id => titleOf(catalog, id)).join(', ')} to use it`;
  return null;
}

// Where an extension shows when it has no switch for it: its status bar buttons and its Git contributions.
export function packagePlaces(entry, catalog) {
  const actions = (catalog.actions || []).filter(action => action.mod === entry.mod);
  return [
    ...(actions.some(action => action.location === 'status.right') ? ['Status bar button'] : []),
    ...(actions.some(action => action.location === 'git.actions') || entry.provides?.gitCredentials ? ['Changes and Git commands'] : []),
  ];
}

// The description line under the title: what it does, then its fixed places.
export function packageAbout(entry, catalog) {
  const places = packagePlaces(entry, catalog);
  return [entry.description, places.length ? `${places.join(' · ')}.` : null].filter(Boolean).join(' ');
}

// Surfaces with a place to choose; each gets a switch row.
export const placeSurfaces = entry => entry.unsupported || entry.error ? [] : (entry.surfaces || []).filter(surface => SURFACE_PLACES[surface.location]);

// "Show <content> in <place>" rows for the extension's card, each under a divider, switches right-aligned. While the
// extension is off the rows stay (dimmed and inert), so turning it off never moves anything.
export function placeSwitches(entry, t) {
  const catalog = extensionCatalog(), surfaces = placeSurfaces(entry), active = extensionActive(entry.mod);
  if (!surfaces.length) return null;
  return v_flex().id(`extension-places-${entry.mod}`).flex_none().opacity(active ? 1 : 0.45)
    .children(surfaces.map(surface => {
      const label = `Show ${surface.title} in ${SURFACE_PLACES[surface.location]}`;
      return h_flex().h(40).px(12).gap(12).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(label))
        .child(Switch(`extension-surface-toggle-${surface.id}`, active && extensionSurfaceVisible(surface), t)
          .accessibility_label(label)
          .on_change((checked, cx) => { if (active && !catalog.loading) { setExtensionSurfaceVisible(surface, checked); cx.notify(); } }));
    }));
}

// The left nav of the Extensions dialog: a label per category and one row per extension with a state dot (on, off, or a
// problem). Choosing one reopens the dialog on it, as the Settings nav does.
export class ExtensionsNav {
  constructor({ openSettings, pageKey, closeOnEscape, unsaved = () => false }) {
    this.openSettings = openSettings; this.pageKey = pageKey; this.closeOnEscape = closeOnEscape; this.unsaved = unsaved;
  }
  // The nav takes focus when the dialog opens, so Esc closes it before anything is clicked.
  init(cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    cx.spawn(async cx => { await refreshExtensions(); cx.notify(); });
  }
  render(t) {
    const { page, context, overlay } = props();
    const catalog = extensionCatalog(), entries = managedExtensions(catalog), unsaved = this.unsaved(overlay);
    const row = entry => {
      const key = this.pageKey(extensionKeyOf(entry)), selected = page === key || Boolean(page?.startsWith(`${key}:`));
      const problem = Boolean(packageStatus(entry, catalog)) && !entry.unsupported;
      const on = extensionActive(entry.mod);
      const dot = problem ? t.ansi1 : on ? t.working : t.muted;
      return Button(`extensions-nav-${overlay ? `${overlay}-` : ''}${entry.mod}`, t, { variant: 'ghost' })
        .w_full().h(32).px(12).gap(8).justify_start()
        .bg(selected ? t.selected : t.chrome).text_color(selected ? t.foreground : t.muted)
        .hover(el => el.bg(selected ? t.selected : t.hover))
        // design.md, Unsaved changes: a red edge on the open extension while its page has edits to save.
        .when(selected && unsaved, el => el.border_l(2).border_color(t.ansi1))
        .accessibility_label(`${entry.title}, ${problem ? 'needs attention' : on ? 'on' : 'off'}${selected && unsaved ? ', unsaved changes' : ''}`)
        .on_click(() => { if (!selected) this.openSettings(key, context); })
        .child(div().size(6).flex_none().rounded(3).border(1).border_color(dot).bg(problem || on ? dot : t.chrome))
        .child(div().min_w(0).truncate().text_size(13).child(entry.title));
    };
    const groups = extensionCategories.map(category => ({ category, group: entries.filter(entry => (entry.category || 'tools') === category) }))
      .filter(({ group }) => group.length);
    return this.closeOnEscape(v_flex().size_full().min_h(0).p(16).gap(2).bg(t.chrome).border_r(1).border_color(t.border)
      .when(Boolean(this.handle), el => el.track_focus(this.handle)), overlay)
      // Same 32px row, 16px from the top, as the title in the right-hand title bar, so both titles share a line.
      .child(h_flex().h(32).flex_none().px(12).mb(16).items_center().font_family('Georgia').text_size(22).child('Extensions'))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll()
        .children(groups.map(({ category, group }) => v_flex().id(`extensions-nav-group-${category}`).gap(2).pb(12)
          .child(div().px(12).pb(4).text_size(11).font_medium().text_color(t.muted).child(CATEGORY_TITLES[category].toUpperCase()))
          .children(group.map(row))))
        .when(!entries.length, el => el.child(div().px(12).text_size(12).text_color(t.muted).child(catalog.loading ? 'Loading extensions…' : 'No extensions installed.'))))
      .child(Button('extensions-refresh', t, { variant: 'ghost' }).flex_none().h(28).px(12).justify_start().text_size(12).text_color(t.muted)
        .disabled(catalog.loading).accessibility_label('Reload extensions')
        .on_click((_event, cx) => cx.spawn(async cx => { await refreshExtensions(); cx.notify(); }))
        .child(catalog.loading ? 'Reloading…' : 'Reload extensions'));
  }
}
