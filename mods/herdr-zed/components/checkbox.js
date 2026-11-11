import { div, svg } from 'gpui-kit';
import { Checkbox as NativeCheckbox } from 'gpui-base';

// Sera boxes are square; a scoped exception such as Asana passes its own corner radius.
export function Checkbox(id, checked, t, { radius = 0, indeterminate = false, disabled = false } = {}) {
  return NativeCheckbox.new(id).checked(checked).indeterminate(indeterminate).disabled(disabled).flex().items_center().gap(8)
    .opacity(disabled ? 0.45 : 1).when(disabled, el => el.cursor_default()).when(!disabled, el => el.cursor_pointer())
    .on_key_down((event, cx) => {
      if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
    })
    .child(div().size(16).flex_none().flex().items_center().justify_center().rounded(radius).border(1)
      .border_color(checked && !indeterminate ? t.solid : t.input).bg(checked && !indeterminate ? t.solid : t.popover)
      .text_color(t.solid_foreground)
      .when(indeterminate, el => el.child(div().w(8).h(2).bg(t.muted)))
      .when(checked && !indeterminate, el => el.child(svg('mods/herdr-zed/assets/icons/check.svg').size(14))));
}
