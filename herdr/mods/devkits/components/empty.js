import { div } from 'gpui-kit';
import { v_flex } from 'gpui-base';

export function Empty(t) {
  return v_flex().items_center().justify_center().text_center().gap(12).text_color(t.foreground);
}

export function EmptyMedia(t) {
  return div().size(48).flex().items_center().justify_center().rounded(10).border(1).border_color(t.border).text_color(t.muted);
}

export function EmptyTitle() {
  return div().text_size(18).font_semibold();
}

export function EmptyDescription(t) {
  return div().text_size(12).text_color(t.muted);
}
