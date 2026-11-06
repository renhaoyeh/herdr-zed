import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { Button } from './button.js';

export function AlertDialogContent(id, t) {
  return v_flex().id(id).size_full().p(24).gap(20).border(1).border_color(t.border).bg(t.popover).text_color(t.foreground).role('alert_dialog');
}

export function AlertDialogTitle() {
  return div().font_family('Georgia').text_size(22).font_normal();
}

export function AlertDialogDescription(t) {
  return div().flex_1().text_size(13).text_color(t.muted);
}

export function AlertDialogFooter() {
  return h_flex().gap(8).justify_end();
}

export function AlertDialogCancel(id, t) {
  return Button(id, t, { variant: 'outline' });
}

export function AlertDialogAction(id, t) {
  return Button(id, t);
}
