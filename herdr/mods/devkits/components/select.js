import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, Select as NativeSelect, Popup as NativePopup } from 'gpui-base';
import { DropdownMenuContent, DropdownMenuItem } from './dropdown-menu.js';

export class SelectState {
  constructor(cx) {
    this.trigger = cx.focus_handle();
    this.list = cx.focus_handle();
    this.open = false;
    this.index = 0;
  }
}

export function SelectTrigger(id, color, t, width = 144) {
  return h_flex().id(id).w(width).h(32).px(12).gap(8).items_center().justify_between().flex_none()
    .rounded(0).border_b(1).border_color(color).text_size(12).text_color(color)
    .hover(el => el.bg(t.hover)).cursor_pointer();
}

// Label fields above their triggers so the setting name stays separate from the chosen value. `boxed` draws the
// trigger as a bordered field instead of an underline, for rows inside bordered tables.
export function Select(id, state, value, options, label, onChange, t, { width = 144, prefix, boxed = false, radius = 0 } = {}) {
  const selected = options.find(option => option.key === value) || options[0];
  const close = cx => { state.open = false; state.trigger.focus(); cx.notify(); };
  const choose = (option, cx) => { cx.stop_propagation(); onChange(option.key, cx); close(cx); };
  // A hovered row already uses t.hover or t.selected, so a boxed trigger hovers with the stronger input color.
  const base = boxed
    ? h_flex().id(id).w(width).h(28).px(8).gap(8).items_center().flex_none().rounded(0).text_size(12).text_color(selected.color)
      .border(1).border_color(t.border).bg(t.popover).hover(el => el.bg(t.input)).cursor_pointer()
    : SelectTrigger(id, selected.color, t, width);
  const trigger = base.rounded(radius)
    .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); state.trigger.focus(); })
    .on_click((_event, cx) => {
      cx.stop_propagation();
      state.open = !state.open;
      state.index = options.indexOf(selected);
      if (state.open) state.list.focus(); else state.trigger.focus();
      cx.notify();
    })
    .child(div().flex_1().min_w(0).truncate().text_color(selected.color).child(selected.label))
    .child(svg('mods/devkits/assets/icons/chevron-down.svg').size(12).flex_none().text_color(boxed ? t.muted : selected.color));
  const list = DropdownMenuContent(`${id}-options`, undefined, t).w(Math.max(168, width)).mt(4).rounded(radius ? radius + 2 : 0)
    .when(radius > 0, el => el.font_family('Arial').shadow_lg())
    .role('list_box').track_focus(state.list).accessibility_label(label)
    .on_mouse_down_out((_event, cx) => { cx.stop_propagation(); close(cx); })
    .on_key_down((event, cx) => {
      if (event.key === 'escape') close(cx);
      else if (event.key === 'enter' || event.key === 'space') choose(options[state.index], cx);
      else if (event.key === 'down') state.index = (state.index + 1) % options.length;
      else if (event.key === 'up') state.index = (state.index + options.length - 1) % options.length;
      else if (event.key === 'home') state.index = 0;
      else if (event.key === 'end') state.index = options.length - 1;
      else return;
      cx.stop_propagation(); cx.notify();
    })
    .children(options.map((option, index) => DropdownMenuItem(`${id}-option-${option.key}`, t).rounded(Math.max(0, radius - 2))
      .role('list_box_option').text_color(option.color).bg(state.index === index ? t.selected : t.popover)
      .accessibility_label(`${option.label}${selected.key === option.key ? ', selected' : ''}`)
      .when(state.index === index, el => el.aria_active_descendant())
      .on_hover((inside, cx) => { if (inside) { state.index = index; cx.notify(); } })
      .on_click((_event, cx) => choose(option, cx))
      .child(div().size(14).flex_none().when(selected.key === option.key, el => el
        .child(svg('mods/devkits/assets/icons/check.svg').size(14))))
      .child(option.label)));
  const control = NativeSelect.new(`${id}-select`).open(state.open).accessibility_label(`${label}: ${selected.label}`)
    .track_focus(state.trigger).content_focus_handle(state.list)
    .on_open_change((open, cx) => {
      state.open = open; state.index = options.indexOf(selected); cx.notify();
    })
    .child(NativePopup.new(`${id}-popup`, trigger).anchor('top_left')
      .when(state.open, el => el.content(list)));
  return prefix ? v_flex().w(width).flex_none().gap(4)
    .child(div().text_size(11).text_color(t.muted).child(prefix))
    .child(control) : control;
}
