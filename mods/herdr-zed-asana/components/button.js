// Shared: the source is components/button.js; sync-shared.js copies it into each mod listed in COPIES.
// Edit this source, never a mod's copy, then run npm run sync:shared.
import { Button as NativeButton } from 'gpui-base';

export function Button(id, t, { variant = 'default', size = 'sm' } = {}) {
  const icon = size.startsWith('icon');
  if (t.appearance === 'linear') {
    const primary = variant === 'default', danger = variant === 'destructive', bordered = ['secondary', 'outline'].includes(variant);
    return NativeButton.new(id).flex_none().flex().items_center().justify_center().p(0).gap(icon ? 0 : 6)
      .when(icon, el => el.size(size === 'icon-sm' ? 24 : 28).px(2))
      .when(!icon, el => el.h(28).px(10).text_size(12))
      .rounded(999).font_medium().cursor_default().border(1)
      .border_color(bordered ? t.controlBorder : '#00000000')
      .bg(danger ? (t.destructive || t.ansi1) : primary ? t.solid : bordered ? t.control : '#00000000')
      .text_color(danger ? '#ffffff' : primary ? t.solid_foreground : t.muted)
      .hover(el => danger ? el.opacity(0.9) : el.bg(primary ? t.solidHover : t.hover).text_color(primary ? t.solid_foreground : t.secondary))
      .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
      .on_key_down((event, cx) => {
        if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
      });
  }
  return NativeButton.new(id).flex_none().flex().items_center().justify_center().gap(8).rounded(0)
    .when(icon, el => el.size(size === 'icon-sm' ? 20 : 28))
    .when(!icon, el => el.h(32).px(12).text_size(12))
    .when(variant === 'default', el => el.bg(t.solid).text_color(t.solid_foreground).hover(el => el.opacity(0.9)))
    .when(variant === 'destructive', el => el.bg(t.destructive || t.ansi1).text_color('#ffffff').hover(el => el.opacity(0.9)))
    .when(variant === 'outline', el => el.border_b(1).border_color(t.input).text_color(t.foreground).hover(el => el.bg(t.hover)))
    .when(variant === 'ghost', el => el.text_color(t.muted).hover(el => el.bg(t.hover).text_color(t.foreground)))
    // A secondary text action: bordered so it reads as a button before hover.
    .when(variant === 'secondary', el => el.border(1).border_color(t.border).text_color(t.foreground).hover(el => el.bg(t.input)))
    // Inside a row that itself hovers with t.hover, a stronger background shows the button is its own target.
    .when(variant === 'row', el => el.text_color(t.muted).hover(el => el.bg(t.input).text_color(t.foreground)))
    .cursor_pointer().on_mouse_down('left', (_event, cx) => cx.stop_propagation())
    .on_key_down((event, cx) => {
      if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
    });
}

// Bar actions share one target size and keep their selected state on hover.
export function ToolbarButton(id, t, { icon = false, selected = false, disabled = false } = {}) {
  return Button(id, t, { variant: 'ghost', size: icon ? 'icon' : 'sm' })
    .h_full().rounded(0).font_family('Geist').text_size(12).gap(6)
    .when(icon, el => el.w(32)).when(!icon, el => el.px(8))
    .disabled(disabled).opacity(disabled ? 0.4 : 1)
    .bg(selected ? t.selected : t.background)
    .text_color(selected ? t.foreground : t.muted)
    .hover(el => el.bg(selected ? t.selected : t.hover).text_color(t.foreground));
}
