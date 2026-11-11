import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { Button } from './components/button.js';
import { extensionCatalog, refreshExtensions, extensionEnabled, extensionActive, setExtensionEnabled,
  extensionSurfaceVisible, setExtensionSurfaceVisible } from './extensions.js';

// The Extensions page of the Settings dialog (settings.js). Its body only: the dialog supplies title and frame.
export class ExtensionsManager {
  init(cx) { this.refresh(cx); }
  refresh(cx) { cx.spawn(async cx => { await refreshExtensions(); cx.notify(); }); }
  render(t) {
    const catalog = extensionCatalog();
    return v_flex().flex_1().min_h(0).gap(12)
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll().gap(8)
        .when(catalog.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading extensions…')))
        .when(catalog.ready && !catalog.packages?.length && !catalog.errors.length,
          el => el.child(div().text_size(12).text_color(t.muted).child('No extensions installed.')))
        .children((catalog.packages || []).map(entry => {
          const enabled = extensionEnabled(entry.mod);
          const missing = (catalog.resolved?.unavailable || []).find(item => item.mod === entry.mod);
          const conflict = (catalog.resolved?.conflicts || []).find(item => item.mods.includes(entry.mod));
          const active = extensionActive(entry.mod);
          const surfaces = (active ? entry.surfaces || [] : []).filter(surface => ['sidebar.bottom', 'status.right', 'dock.right'].includes(surface.location));
          const status = entry.error ? 'Unavailable'
            : !enabled ? 'Disabled'
            : conflict ? `Conflict · ${conflict.provider} is provided by ${conflict.mods.join(', ')}; none is used`
            : missing ? `Unavailable · requires ${missing.missing.join(', ')}`
            : `Enabled · ${entry.surfaces?.length ? `Popup · ${entry.surfaces.length} surfaces` : 'Popup'}`;
          return v_flex().gap(8).p(12).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(16)
              .child(v_flex().flex_1().min_w(0).gap(4)
                .child(div().text_size(13).font_semibold().child(entry.title))
                .child(div().text_size(11).text_color(conflict || missing || entry.error ? t.ansi1 : t.muted).child(status)))
              .child(Button(`extension-toggle-${entry.mod}`, t, { variant: 'secondary' })
                .disabled(catalog.loading || Boolean(entry.error))
                .on_click(() => setExtensionEnabled(entry.mod, !extensionEnabled(entry.mod)))
                .child(enabled ? 'Disable' : 'Enable')))
            .children(surfaces.map(surface => {
              const visible = extensionSurfaceVisible(surface);
              const label = surface.location === 'sidebar.bottom' ? 'Sidebar' : surface.location === 'status.right' ? 'Status' : 'Dock';
              return Button(`extension-surface-toggle-${surface.id}`, t, { variant: 'secondary' })
                .disabled(catalog.loading || Boolean(entry.error))
                .accessibility_label(`${visible ? 'Hide' : 'Show'} ${surface.title} ${label}`)
                .on_click(() => setExtensionSurfaceVisible(surface, !extensionSurfaceVisible(surface)))
                .child(`${visible ? 'Hide' : 'Show'} ${label}`);
            }));
        }))
        .children(catalog.errors.map(error => div().text_size(12).text_color(t.ansi1).child(error))))
      .child(h_flex().flex_none().gap(8).justify_end()
        .child(Button('extensions-refresh', t, { variant: 'secondary' }).disabled(catalog.loading)
          .on_click((_event, cx) => this.refresh(cx)).child('Refresh')));
  }
}
