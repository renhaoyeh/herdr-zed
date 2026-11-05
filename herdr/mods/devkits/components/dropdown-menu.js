import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { settings } from 'herdr';

export function DropdownMenuTrigger(trigger, width, open, align = 'start') {
  let at;
  return trigger.on_mouse_down('left', (event, cx) => {
    cx.stop_propagation();
    const bounds = event.bounds;
    const zoom = settings().zoom;
    at = bounds ? { x: bounds.x + (align === 'end' ? bounds.width - width * zoom : 0),
      y: bounds.y + bounds.height + 4 * zoom } : undefined;
  }).on_click((_event, cx) => {
    cx.stop_propagation();
    const position = at;
    at = undefined;
    // shortcut: keyboard activation has no bounds in Herdr; use its pointer fallback until exposed.
    open(cx, position);
  });
}

export function DropdownMenuContent(id, height, t) {
  return v_flex().id(id).w_full().h(height).p(4).rounded(8).border(1).border_color(t.border).shadow_md()
    .bg(t.popover).text_color(t.foreground).text_size(13);
}

export function DropdownMenuItem(id, t) {
  return h_flex().id(id).h(32).flex_none().px(8).gap(8).items_center().rounded(4)
    .hover(el => el.bg(t.hover)).cursor_pointer();
}

export function DropdownMenuLabel(t) {
  return div().h(28).flex_none().px(8).flex().items_center().font_medium().text_size(12).text_color(t.muted);
}

export function DropdownMenuSeparator(t) {
  return div().h(1).flex_none().my(4).bg(t.border);
}
