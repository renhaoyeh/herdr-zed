import { div } from 'gpui-kit';
import { Switch as NativeSwitch } from 'gpui-base';

// Sera's switch: a 28x16 pill track, the knob on the left when off (muted on the border tone) and on the
// right when on (solid foreground on the accent track). Square-ish in the Sera sense but clearly two states.
export function Switch(id, checked, t) {
  return NativeSwitch.new(id).checked(checked).w(28).h(16).flex_none().p(2).flex().items_center()
    .when(checked, el => el.justify_end()).when(!checked, el => el.justify_start())
    .rounded(999).bg(checked ? t.solid : t.border).cursor_pointer()
    .on_key_down((event, cx) => {
      if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
    })
    .child(div().size(12).rounded(999).bg(checked ? t.solid_foreground : t.muted));
}
