// Shared: the source is mods/devkits/components/dropdown-menu.js; herdr/sync-shared.js copies it into each mod in herdr/COPIES.
// Edit this source, never a mod's copy, then run npm run sync:shared.
import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, Popup } from 'gpui-base';
import { settings } from 'herdr';

// The press's position outlives render: a re-render between mouse down and click
// rebuilds the trigger's handlers, and a closure variable would reset to the pointer.
let pressed;

// A menu opens 8px clear of the nearest line: below its trigger by default. A trigger inside a bar or
// row passes `y` reaching 8px past the bar's 1px bottom border, and `x` only when a vertical divider
// meets the menu's aligned edge, so the menu's border never runs beside another line.
const OFFSET = { x: 0, y: 8 };

export function DropdownMenuTrigger(trigger, width, open, align = 'start', offset = OFFSET) {
  return trigger.on_mouse_down('left', (event, cx) => {
    cx.stop_propagation();
    const bounds = event.bounds;
    const zoom = settings().zoom;
    pressed = bounds ? { x: bounds.x + (align === 'end' ? bounds.width - (width + offset.x) * zoom : offset.x * zoom),
      y: bounds.y + bounds.height + offset.y * zoom } : undefined;
  }).on_click((_event, cx) => {
    cx.stop_propagation();
    const position = pressed;
    pressed = undefined;
    // shortcut: keyboard activation has no bounds in Herdr; use its pointer fallback until exposed.
    open(cx, position);
  });
}

export function DropdownMenuContent(id, height, t) {
  return v_flex().id(id).w_full().h_auto().when(height !== undefined, el => el.h(height))
    .p(4).rounded(0).border(1).border_color(t.border)
    .bg(t.popover).text_color(t.foreground).text_size(13);
}

export function DropdownMenuItem(id, t) {
  return h_flex().id(id).h(32).flex_none().px(8).gap(8).items_center().rounded(0)
    .hover(el => el.bg(t.hover)).cursor_pointer();
}

export function DropdownMenuLabel(t) {
  return div().h(28).flex_none().px(8).flex().items_center().font_medium().text_size(10).text_color(t.muted);
}

export function DropdownMenuSeparator(t) {
  return div().h(1).flex_none().my(4).bg(t.border);
}

export class DropdownMenuState {
  constructor(cx) {
    this.open = false;
    this.index = 0;
    this.focus = cx?.focus_handle?.();
    this.trigger = cx?.focus_handle?.();
  }
}

/** An anchored action menu with native dismissal and focus, and keyboard navigation. */
export function DropdownMenu(id, state, trigger, items, onSelect, t, { side = 'bottom', align = 'end', offset = OFFSET, fullHeight = false } = {}) {
  const close = cx => { state.open = false; state.page = null; state.trigger?.focus(); cx.notify(); };
  const choose = (item, cx) => {
    cx.stop_propagation();
    if (!item || item.disabled) return;
    state.open = false;
    onSelect(item.key, cx);
    if (!state.open) state.trigger?.focus();
    cx.notify();
  };
  const enabled = items.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0);
  const content = DropdownMenuContent(`${id}-content`, undefined, t).w(224)
    .role('menu')
    .track_focus(state.focus).accessibility_label('Actions')
    .on_mouse_down_out((_event, cx) => { cx.stop_propagation(); close(cx); })
    .on_key_down((event, cx) => {
      const position = enabled.indexOf(state.index);
      if (event.key === 'escape') close(cx);
      else if (event.key === 'enter' || event.key === 'space') choose(items[state.index], cx);
      else if (!enabled.length) return;
      else if (event.key === 'down') state.index = enabled[(position + 1) % enabled.length];
      else if (event.key === 'up') state.index = enabled[(position - 1 + enabled.length) % enabled.length];
      else if (event.key === 'home') state.index = enabled[0];
      else if (event.key === 'end') state.index = enabled.at(-1);
      else return;
      cx.stop_propagation(); cx.notify();
    })
    .children(items.flatMap((item, index) => [
      ...(item.separator ? [DropdownMenuSeparator(t)] : []),
      DropdownMenuItem(`${id}-${item.key}`, t).role('menu_item').accessibility_label(item.label)
        .min_w(0).when(Boolean(item.description), el => el.h(44))
        .when(item.disabled, el => el.opacity(0.4).cursor_default())
        .when(!item.disabled && state.index === index, el => el.bg(t.selected).aria_active_descendant())
        .on_hover((inside, cx) => { if (inside && !item.disabled) { state.index = index; cx.notify(); } })
        .on_click((_event, cx) => choose(item, cx))
        .child(v_flex().flex_1().min_w(0)
          .child(div().min_w(0).truncate().child(item.label))
          .when(Boolean(item.description), el => el.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(item.description))))
        .when(item.checked !== undefined, el => el.child(div().w(14).flex_none()
          .when(item.checked, el => el.child(svg('mods/devkits/assets/icons/check.svg').size(14))))),
    ]));
  const open = cx => {
    state.open = true; state.index = enabled[0] ?? 0; state.focus?.focus(); cx.notify();
  };
  trigger.track_focus(state.trigger)
    .on_click((_event, cx) => { cx.stop_propagation(); state.open ? close(cx) : open(cx); })
    .on_key_down((event, cx) => {
      if (['down', 'up', 'enter', 'space'].includes(event.key)) { cx.stop_propagation(); open(cx); }
    });
  // Popup measures an absolute canvas inside its host. Contain that canvas so
  // it measures the trigger, rather than an enclosing workspace's bounds.
  // Native Popup then fits the content to the window edges.
  const anchor = `${side === 'top' ? 'bottom' : 'top'}_${align === 'start' ? 'left' : 'right'}`;
  // Native Popup ignores a margin on the side it grows from, so a transparent wrapper's padding holds the gap.
  const spaced = div().flex_none()
    .when(side === 'top', el => el.pb(offset.y)).when(side !== 'top', el => el.pt(offset.y))
    .when(align === 'start', el => el.pl(offset.x)).when(align !== 'start', el => el.pr(offset.x))
    .child(content);
  return Popup.new(id, trigger).relative().flex_none().when(fullHeight, el => el.h_full()).anchor(anchor).when(state.open, el => el.content(spaced));
}
