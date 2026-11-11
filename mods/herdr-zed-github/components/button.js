// Shared: the source is components/button.js; sync-shared.js copies it into each mod listed in COPIES.
// Edit this source, never a mod's copy, then run npm run sync:shared.
import { Button as NativeButton } from 'gpui-base';

// design.md, Icons and hover: one hover treatment for interactive elements, the background `hover`, with no border or
// colour shift. Filled buttons (default, destructive) dim to 90% instead. A disabled button never hovers.
export function Button(id, t, { variant = 'default', size = 'sm', disabled = false } = {}) {
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
      .when(!disabled, el => el.hover(hovered => primary ? hovered.bg(t.solidHover) : danger ? hovered.opacity(0.9) : hovered.bg(t.hover)))
      .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
      .on_key_down((event, cx) => {
        if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
      });
  }
  const quiet = variant === 'ghost' || variant === 'row';
  return NativeButton.new(id).flex_none().flex().items_center().justify_center().gap(8).rounded(0)
    .when(icon, el => el.size(size === 'icon-sm' ? 24 : 28))
    .when(!icon, el => el.h(32).px(12).text_size(12))
    .when(variant === 'default', el => el.bg(t.solid).text_color(t.solid_foreground).when(!disabled, e => e.hover(h => h.opacity(0.9))))
    .when(variant === 'destructive', el => el.bg(t.destructive || t.ansi1).text_color('#ffffff').when(!disabled, e => e.hover(h => h.opacity(0.9))))
    .when(variant === 'outline', el => el.border_b(1).border_color(t.input).text_color(t.foreground)
      .when(!disabled, e => e.hover(h => h.bg(t.hover))))
    .when(quiet, el => el.text_color(t.muted).when(!disabled, e => e.hover(h => h.bg(t.hover))))
    // A secondary text action: bordered so it reads as a button before hover.
    .when(variant === 'secondary', el => el.border(1).border_color(t.border).text_color(t.foreground)
      .when(!disabled, e => e.hover(h => h.bg(t.hover))))
    .cursor_pointer().on_mouse_down('left', (_event, cx) => cx.stop_propagation())
    .on_key_down((event, cx) => {
      if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
    });
}

// The one icon-only button (design.md, Icons and hover). Toolbars and the status bar: a 28×28 target with a 16px glyph
// (TOOLBAR_GLYPH). Dense rows (`row`): 24×24 with a 14px glyph (ROW_GLYPH). Every icon-only button also needs a tooltip
// and an accessibility label. `selected` keeps the selected background on hover; `disabled` is 45% and never hovers.
// Text toolbar actions (icon: false) fill the bar height.
export const TOOLBAR_GLYPH = 16, ROW_GLYPH = 14;
// Transparent at rest so the bar or row behind it shows through; selected fills with `selected`.
export function ToolbarButton(id, t, { icon = false, row = false, selected = false, disabled = false } = {}) {
  const button = Button(id, t, { variant: 'ghost', size: icon ? (row ? 'icon-sm' : 'icon') : 'sm', disabled })
    .rounded(0).font_family('Geist').text_size(12).gap(6)
    .disabled(disabled).opacity(disabled ? 0.45 : 1)
    .bg(selected ? t.selected : '#00000000')
    .text_color(selected ? t.foreground : t.muted)
    .when(!disabled && selected, el => el.hover(hovered => hovered.bg(t.selected)));
  return icon ? button : button.h_full().px(8);
}
