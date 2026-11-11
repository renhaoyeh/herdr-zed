import { div } from 'gpui-kit';
import { Switch as NativeSwitch } from 'gpui-base';

// Sera's square switch: a solid track with the knob at the end when on, an outlined track when off.
export function Switch(id, checked, t) {
  return NativeSwitch.new(id).checked(checked).w(28).h(16).flex_none().p(2).flex().items_center()
    .when(checked, el => el.justify_end()).rounded(0).border(1)
    .border_color(checked ? t.solid : t.input).bg(checked ? t.solid : t.popover).cursor_pointer()
    .on_key_down((event, cx) => {
      if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
    })
    .child(div().size(10).rounded(0).bg(checked ? t.solid_foreground : t.muted));
}
