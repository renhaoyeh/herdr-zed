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

// design.md, Unsaved changes: a dialog's footer while it asks before Esc or its close control would drop edits. The red
// rule above it and the red question are the reminder; Keep editing returns to the form, Discard closes without saving.
export function DiscardPrompt(id, t, { keep, discard }) {
  return h_flex().id(id).flex_none().gap(8).items_center().pt(12).border_t(1).border_color(t.ansi1)
    .child(div().flex_1().min_w(0).text_size(12).text_color(t.ansi1).child('Discard unsaved changes?'))
    .child(Button(`${id}-keep`, t, { variant: 'secondary' }).on_click(keep).child('Keep editing'))
    .child(Button(`${id}-discard`, t, { variant: 'destructive' }).on_click(discard).child('Discard'));
}

// design.md, Saving: the footer of a page whose changes install or run setup (Capabilities, MCP Connections, ECC). One
// status slot on the left (the error in red, progress, the red "Unsaved changes", or "Applied"), then Discard and Apply.
export function ApplyFooter(id, t, { dirty, busy = false, progress = 'Applying…', applied = false, error = null, canApply = true, discard, apply }) {
  const text = error || (busy ? progress : dirty ? 'Unsaved changes' : applied ? 'Applied. New sessions use it.' : '');
  return h_flex().id(id).flex_none().gap(8).items_center()
    .child(div().id(`${id}-status`).flex_1().min_w(0).truncate().text_size(12).text_color(error || (dirty && !busy) ? t.ansi1 : t.muted)
      .when(Boolean(error), el => el.tooltip(error)).child(text))
    .child(Button(`${id}-discard`, t, { variant: 'secondary' }).disabled(busy || !dirty).on_click(discard).child('Discard'))
    .child(Button(`${id}-apply`, t).disabled(busy || !dirty || !canApply).on_click(apply).child(busy ? progress : 'Apply'));
}
