import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { Button } from './button.js';
import { glyph } from './icon.js';

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

// The header of a dialog that closes from its X rather than a Done footer: the title on the left, the close control on the right.
export function DialogHeader(t, title, { id, label, onClose }) {
  return h_flex().flex_none().items_center().gap(12)
    .child(DialogTitle().flex_1().min_w(0).child(title))
    .child(Button(id, t, { variant: 'ghost', size: 'icon' }).accessibility_label(label).on_click(onClose).child(glyph('close', 14)));
}
