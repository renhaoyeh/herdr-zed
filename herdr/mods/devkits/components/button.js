import { Button as NativeButton } from 'gpui-base';

export function Button(id, t, { variant = 'default', size = 'sm' } = {}) {
  const icon = size.startsWith('icon');
  return NativeButton.new(id).flex_none().flex().items_center().justify_center().gap(8).rounded(size === 'icon-sm' ? 4 : 6)
    .when(icon, el => el.size(size === 'icon-sm' ? 20 : 28))
    .when(!icon, el => el.h(32).px(12).text_size(12))
    .when(variant === 'default', el => el.bg(t.solid).text_color(t.solid_foreground).hover(el => el.opacity(0.9)))
    .when(variant === 'outline', el => el.border(1).border_color(t.input).text_color(t.foreground).hover(el => el.bg(t.hover)))
    .when(variant === 'ghost', el => el.text_color(t.muted).hover(el => el.bg(t.hover).text_color(t.foreground)))
    .cursor_pointer().on_mouse_down('left', (_event, cx) => cx.stop_propagation())
    .on_key_down((event, cx) => {
      if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
    });
}
