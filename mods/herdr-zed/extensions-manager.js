import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { openOverlay, closeOverlay, props } from 'herdr';
import { Button } from './components/button.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { extensionCatalog, refreshExtensions, extensionEnabled, setExtensionEnabled,
  extensionSurfaceVisible, setExtensionSurfaceVisible } from './extensions.js';

export const openExtensions = () => openOverlay({ mod: 'herdr-zed', kind: 'dialog', frame: 'none',
  modal: true, width: 640, height: 480, props: { view: 'extensions' } });

export class ExtensionsManager {
  init(cx) { this.refresh(cx); }
  refresh(cx) { cx.spawn(async cx => { await refreshExtensions(); cx.notify(); }); }
  render(t) {
    const catalog = extensionCatalog(), close = () => closeOverlay(props().overlay);
    return DialogContent('extensions-manager', t).on_key_down((event, cx) => {
      if (event.key === 'escape') { cx.stop_propagation(); close(); }
    })
      .child(DialogTitle().flex_none().child('Extensions'))
      .child(DialogDescription(t).flex_none().child('Manage installed workspace extensions. Changes apply immediately.'))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll().gap(8)
        .when(catalog.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading extensions…')))
        .when(catalog.ready && !catalog.packages?.length && !catalog.errors.length,
          el => el.child(div().text_size(12).text_color(t.muted).child('No extensions installed.')))
        .children((catalog.packages || []).map(entry => {
          const enabled = extensionEnabled(entry.mod);
          const surfaces = (enabled ? entry.surfaces || [] : []).filter(surface => ['sidebar.bottom', 'status.right', 'dock.right'].includes(surface.location));
          return v_flex().gap(8).p(12).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(16)
              .child(v_flex().flex_1().min_w(0).gap(4)
                .child(div().text_size(13).font_semibold().child(entry.title))
                .child(div().text_size(11).text_color(t.muted).child(entry.error ? 'Unavailable'
                  : enabled ? `Enabled · ${entry.surfaces?.length ? `Popup · ${entry.surfaces.length} surfaces` : 'Popup'}` : 'Disabled')))
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
      .child(DialogFooter().flex_none()
        .child(Button('extensions-refresh', t, { variant: 'secondary' }).disabled(catalog.loading)
          .on_click((_event, cx) => this.refresh(cx)).child('Refresh'))
        .child(Button('extensions-close', t, { variant: 'secondary' }).on_click(close).child('Close')));
  }
}
