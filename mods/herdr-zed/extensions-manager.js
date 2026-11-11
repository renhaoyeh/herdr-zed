import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { Button } from './components/button.js';
import { Switch } from './components/switch.js';
import { extensionCatalog, refreshExtensions, extensionEnabled, extensionActive, setExtensionEnabled, extensionSurfaceVisible, setExtensionSurfaceVisible } from './extensions.js';

// design.md, Settings and the review (L9): per package, its title, a plain status line and an On/Off switch; per
// surface, a switch labelled by where it shows. No internal terms ("Popup · 2 surfaces") and no text toggles.
const SURFACE_LABELS = { 'sidebar.bottom': 'Show in sidebar', 'status.right': 'Show in status bar', 'dock.right': 'Show in right dock' };

// The status line of a package. Problems read first: unsupported platform, load error, conflict, missing requirements.
export function packageStatus(entry, catalog) {
  if (entry.unsupported) return 'Not available on this platform';
  if (entry.error) return entry.error;
  const conflict = (catalog.resolved?.conflicts || []).find(item => item.mods.includes(entry.mod));
  if (conflict) return `Conflict · ${conflict.provider} is provided by ${conflict.mods.join(', ')}; none is used`;
  const missing = (catalog.resolved?.unavailable || []).find(item => item.mod === entry.mod);
  if (missing && extensionEnabled(entry.mod)) {
    const titles = missing.missing.map(id => (catalog.packages || []).find(item => item.id === id)?.title || id);
    return `Needs ${titles.join(', ')}`;
  }
  return extensionEnabled(entry.mod) ? 'On' : 'Off';
}

// The standalone Extensions manager's body. The shell supplies its title and frame; launcher workflows are separate.
export class ExtensionsManager {
  constructor({ openSettings } = {}) { this.openSettings = openSettings; }
  init(cx) { this.refresh(cx); }
  refresh(cx) { cx.spawn(async cx => { await refreshExtensions(); cx.notify(); }); }
  controls(entry, t) {
    const catalog = extensionCatalog();
    const surfaces = (extensionActive(entry.mod) ? entry.surfaces || [] : []).filter(surface => SURFACE_LABELS[surface.location]);
    return h_flex().flex_none().gap(20).items_center()
      .children(surfaces.map(surface => {
        const label = SURFACE_LABELS[surface.location];
        return h_flex().gap(8).items_center()
          .child(Switch(`extension-surface-toggle-${surface.id}`, extensionSurfaceVisible(surface), t)
            .accessibility_label(`${label}: ${surface.title}`)
            .on_change((checked, cx) => { if (!catalog.loading) { setExtensionSurfaceVisible(surface, checked); cx.notify(); } }))
          .child(div().text_size(12).text_color(t.muted).child(label));
      }));
  }
  render(t) {
    const catalog = extensionCatalog();
    const packages = (catalog.packages || []).filter(entry => !entry.provides?.launcher);
    return v_flex().flex_1().min_h(0).gap(12)
      .child(h_flex().flex_none().items_center().justify_between()
        .child(div().text_size(12).text_color(t.muted).child(`${packages.length} installed · Changes save automatically`))
        .child(Button('extensions-refresh', t, { variant: 'secondary' }).h(24).px(8).text_size(11).disabled(catalog.loading)
          .on_click((_event, cx) => this.refresh(cx)).child('Refresh')))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll()
        .when(catalog.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading extensions…')))
        .when(catalog.ready && !packages.length && !catalog.errors.length,
          el => el.child(div().text_size(12).text_color(t.muted).child('No extensions installed.')))
        .children(packages.map(entry => {
          const enabled = extensionEnabled(entry.mod);
          const status = packageStatus(entry, catalog);
          // A platform the package does not run on is not a problem: its status line is muted.
          const problem = entry.error || (catalog.resolved?.conflicts || []).some(item => item.mods.includes(entry.mod))
            || (enabled && (catalog.resolved?.unavailable || []).some(item => item.mod === entry.mod));
          const active = extensionActive(entry.mod);
          // Unsupported packages contribute nothing and so get no switch at all.
          const surfaces = (active ? entry.surfaces || [] : []).filter(surface => SURFACE_LABELS[surface.location]);
          const configurable = (catalog.resolved?.settings || []).some(item => item.mod === entry.mod);
          return v_flex().gap(12).py(18).border_b(1).border_color(t.border)
            .child(h_flex().items_center().gap(16)
              .child(v_flex().flex_1().min_w(0).gap(4)
                .child(div().text_size(14).font_semibold().child(entry.title))
                .child(div().text_size(11).text_color(problem ? t.ansi1 : t.muted).child(status)))
              .when(configurable && Boolean(this.openSettings), el => el.child(Button(`extension-settings-${entry.id}`, t, { variant: 'secondary' })
                .accessibility_label(`Configure ${entry.title}`).on_click(() => this.openSettings(entry.id)).child('Configure…')))
              .when(!entry.unsupported, el => el.child(Switch(`extension-toggle-${entry.mod}`, enabled, t)
                .accessibility_label(`${entry.title} enabled`)
                .on_change((checked, cx) => { if (!catalog.loading && !entry.error) { setExtensionEnabled(entry.mod, checked); cx.notify(); } }))))
            .when(surfaces.length > 0, el => el.child(this.controls(entry, t)));
        }))
        .children(catalog.errors.map(error => div().text_size(12).text_color(t.ansi1).child(error))));
  }
}
