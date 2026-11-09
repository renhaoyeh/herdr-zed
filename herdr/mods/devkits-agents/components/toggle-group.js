import { ToggleGroup as NativeToggleGroup, Toggle as NativeToggle } from 'gpui-base';

// Joined segments, as shadcn's ToggleGroup: each item stays pressed independently.
export function ToggleGroup(id, label, t) {
  return NativeToggleGroup.new(id).accessibility_label(label).flex().flex_row().items_center().flex_none()
    .rounded(0).border(1).border_color(t.border);
}

export function ToggleGroupItem(id, pressed, first, t) {
  return NativeToggle.new(id).pressed(pressed).h(26).px(10).flex().items_center().justify_center().text_size(12).cursor_pointer()
    .when(!first, el => el.border_l(1).border_color(t.border))
    .text_color(pressed ? t.foreground : t.muted).bg(pressed ? t.selected : t.popover).hover(el => el.bg(t.hover))
    .on_key_down((event, cx) => {
      if (event.key === 'enter' || event.key === 'space') cx.stop_propagation();
    });
}
