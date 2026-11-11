import { div, svg, image } from 'gpui-kit';
import { h_flex, v_flex, InputState, Input, Select as NativeSelect, Popup as NativePopup } from 'gpui-base';
import { DropdownMenuContent, DropdownMenuItem } from './dropdown-menu.js';

export class SelectState {
  constructor(cx) {
    this.trigger = cx.focus_handle();
    this.list = cx.focus_handle();
    this.open = false;
    this.index = 0;
  }
  prepareSearch(label) {
    if (!this.search) {
      const placeholder = label === 'Agent' ? 'Assign to…' : /status/i.test(label) ? 'Change status…' : `Change ${label.toLowerCase()}…`;
      this.search = InputState.new({ placeholder });
      this.search.on('change', (_event, cx) => { this.index = 0; cx.notify(); });
    }
    this.search.set_value('');
  }
}

export function SelectTrigger(id, color, t, width = 144) {
  return h_flex().id(id).w(width).h(32).px(12).gap(8).items_center().justify_between().flex_none()
    .rounded(0).border_b(1).border_color(color).text_size(12).text_color(color)
    .hover(el => el.bg(t.hover)).cursor_pointer();
}

// Label fields above their triggers so the setting name stays separate from the chosen value. `boxed` draws the
// trigger as a bordered field instead of an underline, for rows inside bordered tables.
export function Select(id, state, value, options, label, onChange, t, { width = 144, prefix, boxed = false, radius = 0, fullWidth = false } = {}) {
  const selected = options.find(option => option.key === value) || options[0];
  const linear = t.appearance === 'linear', naturalWidth = linear;
  const triggerColor = linear ? t.secondary : selected.color;
  const query = linear ? state.search?.value().trim().toLowerCase() || '' : '';
  const items = options.filter(option => !query || option.label.toLowerCase().includes(query));
  const hasIcons = options.some(option => Boolean(option.icon));
  const optionIcon = option => {
    const path = option.icon.includes('/') ? option.icon : `mods/herdr-zed/assets/icons/${option.icon}.svg`;
    return (option.iconTint === false ? image(path) : svg(path).text_color(option.iconColor || option.color)).size(14).flex_none();
  };
  const close = cx => { state.open = false; state.trigger.focus(); cx.notify(); };
  const choose = (option, cx) => { if (!option) return; cx.stop_propagation(); onChange(option.key, cx); close(cx); };
  // A hovered row already uses t.hover or t.selected, so a boxed trigger hovers with the stronger input color.
  const base = linear
    ? h_flex().id(id).h(28).py(0).pl(6).pr(10).gap(6).items_center().flex_none().rounded(999).text_size(13).font_medium()
      .when(naturalWidth, el => el.w_auto()).when(!naturalWidth, el => el.w(width))
      .border(boxed ? 1 : 0).border_color(t.controlBorder).bg(state.open ? t.hover : boxed ? t.control : '#00000000')
      .text_color(triggerColor).hover(el => el.bg(t.hover)).cursor_default()
    : boxed
    ? h_flex().id(id).w(width).h(28).px(8).gap(8).items_center().flex_none().rounded(0).text_size(12).text_color(selected.color)
      .border(1).border_color(t.border).bg(t.popover).hover(el => el.bg(t.input)).cursor_pointer()
    : SelectTrigger(id, selected.color, t, width);
  const trigger = base.rounded(linear ? 999 : radius)
    .when(fullWidth, el => el.w_full().min_w(0).on_size_change((size, cx) => {
      if (size.width > 0 && state.width !== size.width) { state.width = size.width; cx.notify(); }
    }))
    .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); state.trigger.focus(); })
    .on_click((_event, cx) => {
      cx.stop_propagation();
      state.open = !state.open;
      state.index = options.indexOf(selected);
      if (state.open) {
        if (linear) { state.prepareSearch(label); state.search.focus(); } else state.list.focus();
      } else state.trigger.focus();
      cx.notify();
    })
    .when(Boolean(selected.icon), el => el.child(optionIcon(selected)))
    .child(div().when(!naturalWidth, el => el.flex_1()).min_w(0).truncate().text_color(triggerColor).child(selected.label))
    .child(svg('mods/herdr-zed/assets/icons/chevron-down.svg').size(12).flex_none().text_color(linear || boxed ? t.muted : selected.color));
  const list = DropdownMenuContent(`${id}-options`, undefined, t).w(fullWidth ? state.width || width : Math.max(linear ? 208 : 168, width)).mt(fullWidth ? 0 : 4).rounded(linear ? 12 : radius ? radius + 2 : 0)
    .when(linear, el => el.p(0).font_family(t.fontFamily).font_normal().shadow_md())
    .when(!linear && radius > 0, el => el.font_family('Arial').shadow_lg())
    .role('list_box').track_focus(state.list).accessibility_label(label)
    .on_mouse_down_out((_event, cx) => { cx.stop_propagation(); close(cx); })
    .on_key_down((event, cx) => {
      if (event.key === 'escape') close(cx);
      else if (event.key === 'enter' || (!linear && event.key === 'space')) choose(items[state.index], cx);
      else if (event.key === 'down') state.index = items.length ? (state.index + 1) % items.length : 0;
      else if (event.key === 'up') state.index = items.length ? (state.index + items.length - 1) % items.length : 0;
      else if (event.key === 'home') state.index = 0;
      else if (event.key === 'end') state.index = Math.max(0, items.length - 1);
      else return;
      cx.stop_propagation(); cx.notify();
    })
    .when(linear && Boolean(state.search), el => el.child(Input.new(state.search).id(`${id}-search`).accessibility_label(`Search ${label.toLowerCase()}`)
      .w_full().h(36).px(14).py(0).border(0).border_b(1).border_color(t.border).bg(t.popover).text_size(13).text_color(t.secondary)))
    .child(v_flex().when(linear, el => el.py(6).max_h(288).overflow_y_scroll())
      .when(!items.length, el => el.child(div().h(32).px(14).flex().items_center().text_color(t.muted).child('No results')))
      .children(items.map((option, index) => DropdownMenuItem(`${id}-option-${option.key}`, t).rounded(linear ? 8 : Math.max(0, radius - 2))
      .when(linear, el => el.mx(4).px(10).py(0).cursor_default())
      .role('list_box_option').text_color(linear ? (state.index === index ? t.foreground : t.secondary) : option.color)
      .bg(state.index === index ? (linear ? t.menuHover : t.selected) : t.popover)
      .accessibility_label(`${option.label}${selected.key === option.key ? ', selected' : ''}`)
      .when(state.index === index, el => el.aria_active_descendant())
      .on_hover((inside, cx) => { if (inside) { state.index = index; cx.notify(); } })
      .on_click((_event, cx) => choose(option, cx))
      .when(!hasIcons, el => el.child(div().size(14).flex_none().when(selected.key === option.key, el => el
        .child(svg('mods/herdr-zed/assets/icons/check.svg').size(14)))))
      .when(Boolean(option.icon), el => el.child(optionIcon(option)))
      .when(hasIcons && !option.icon, el => el.child(div().size(14).flex_none()))
      .child(div().flex_1().min_w(0).truncate().child(option.label))
      .when(hasIcons, el => el.child(div().size(14).flex_none().when(selected.key === option.key, el => el
        .child(svg('mods/herdr-zed/assets/icons/check.svg').size(14))))))));
  const control = NativeSelect.new(`${id}-select`).open(state.open).accessibility_label(`${label}: ${selected.label}`)
    .when(fullWidth, el => el.w_full().min_w(0))
    .when(linear, el => el.flex_none().w_auto().self_start())
    .track_focus(state.trigger).content_focus_handle(state.list)
    .on_open_change((open, cx) => {
      state.open = open; state.index = options.indexOf(selected);
      if (linear && open) { state.prepareSearch(label); state.search.focus(); }
      cx.notify();
    })
    .child(NativePopup.new(`${id}-popup`, trigger).anchor('top_left')
      .when(fullWidth, el => el.relative().w_full().min_w(0))
      .when(state.open, el => el.content(list)));
  return prefix ? v_flex().w(width).flex_none().gap(4).when(linear, el => el.items_start())
    .child(div().text_size(11).text_color(t.muted).child(prefix))
    .child(control) : control;
}
