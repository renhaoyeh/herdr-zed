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

// The Extensions page of the Settings dialog (settings.js). Its body only: the dialog supplies title and frame.
export class ExtensionsManager {
  init(cx) { this.refresh(cx); }
  refresh(cx) { cx.spawn(async cx => { await refreshExtensions(); cx.notify(); }); }
  render(t) {
    const catalog = extensionCatalog();
    return v_flex().flex_1().min_h(0).gap(12)
      .child(h_flex().flex_none().justify_end()
        .child(Button('extensions-refresh', t, { variant: 'secondary' }).h(24).px(8).text_size(11).disabled(catalog.loading)
          .on_click((_event, cx) => this.refresh(cx)).child('Refresh')))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll().gap(8)
        .when(catalog.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading extensions…')))
        .when(catalog.ready && !catalog.packages?.length && !catalog.errors.length,
          el => el.child(div().text_size(12).text_color(t.muted).child('No extensions installed.')))
        .children((catalog.packages || []).map(entry => {
          const enabled = extensionEnabled(entry.mod);
          const status = packageStatus(entry, catalog);
          const problem = entry.unsupported || entry.error || (catalog.resolved?.conflicts || []).some(item => item.mods.includes(entry.mod))
            || (enabled && (catalog.resolved?.unavailable || []).some(item => item.mod === entry.mod));
          const active = extensionActive(entry.mod);
          // Unsupported packages contribute nothing and so get no switch at all.
          const surfaces = (active ? entry.surfaces || [] : []).filter(surface => SURFACE_LABELS[surface.location]);
          return v_flex().gap(8).p(12).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(16)
              .child(v_flex().flex_1().min_w(0).gap(4)
                .child(div().text_size(13).font_semibold().child(entry.title))
                .child(div().text_size(11).text_color(problem ? t.ansi1 : t.muted).child(status)))
              .when(!entry.unsupported, el => el.child(Switch(`extension-toggle-${entry.mod}`, enabled, t)
                .accessibility_label(`${entry.title} enabled`)
                .on_change((checked, cx) => { if (!catalog.loading && !entry.error) { setExtensionEnabled(entry.mod, checked); cx.notify(); } }))))
            .children(surfaces.map(surface => {
              const visible = extensionSurfaceVisible(surface);
              const label = SURFACE_LABELS[surface.location];
              return h_flex().items_center().gap(16).pl(12)
                .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(label))
                .child(Switch(`extension-surface-toggle-${surface.id}`, visible, t)
                  .accessibility_label(`${label}: ${surface.title}`)
                  .on_change((checked, cx) => { if (!catalog.loading) { setExtensionSurfaceVisible(surface, checked); cx.notify(); } }));
            }));
        }))
        .children(catalog.errors.map(error => div().text_size(12).text_color(t.ansi1).child(error))));
  }
}
