import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';

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
