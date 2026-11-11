import { div } from 'gpui-kit';
import { Button } from './button.js';

/** Zed's version-control colors, shared by the Changes and Files trees. */
export const GitStatusColor = { added: '#27a657', deleted: '#e06c76', modified: '#d3b020' };

/** A tree row as Zed's panels draw it: one indent guide per ancestor, then an icon slot and a label. */
export function TreeItem(id, depth, selected, t, { deferred = false } = {}) {
  // Virtual rows dispatch input through their list; a Button would register per-row handlers.
  const row = deferred ? div().id(id).flex().items_center().text_color(t.muted).cursor_pointer()
    .hover(el => el.bg(t.hover).text_color(t.foreground)) : Button(id, t, { variant: 'ghost' });
  return row.w_full().h(28).pl(8).pr(12).gap(0).justify_start()
    .bg(selected ? t.selected : t.chrome)
    .children(Array.from({ length: depth }, () => div().w(16).h_full().flex_none().flex().justify_center()
      .child(div().w(1).h_full().bg(t.border))));
}

export function TreeItemIcon(child) {
  return div().w(16).flex_none().flex().justify_center().child(child);
}

export function TreeItemLabel(t) {
  return div().flex_1().min_w(0).pl(4).truncate().text_size(13).text_color(t.foreground);
}
