import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';

export function DialogContent(id, t) {
  return v_flex().id(id).size_full().p(24).gap(20).border(1).border_color(t.border).bg(t.popover).text_color(t.foreground).role('dialog');
}

export function DialogTitle() {
  return div().font_family('Georgia').text_size(22).font_normal();
}

export function DialogDescription(t) {
  return div().text_size(13).text_color(t.muted);
}

export function DialogFooter() {
  return h_flex().gap(8).justify_end();
}
