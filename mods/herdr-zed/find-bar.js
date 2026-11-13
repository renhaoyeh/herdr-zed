import { div, svg } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { ToolbarButton } from './components/button.js';
import { Input } from './components/input.js';
import { ToggleGroup, ToggleGroupItem } from './components/toggle-group.js';

const findIcon = name => svg(`mods/herdr-zed/assets/icons/${name}.svg`).size(12).flex_none();

/**
 * The search row shared by buffer search (Ctrl+F) and project search (Ctrl+Shift+F):
 * the query, Aa / whole word / regex, a status, then optional previous, next and close.
 * `onChange` runs after an option toggles; `onEnter(shift)` on Enter or F3; `onClose` on Escape.
 */
export function FindBar(id, t, state, { label, status = '', statusWidth = 96, canStep = false, onStep, onChange, onEnter, onClose, extra = null }) {
  const option = (key, name, text, first) => ToggleGroupItem(`${id}-${key}`, state[key], first, t).px(8)
    // The group's selected tint barely shows on the chrome bar; an on option takes the solid fill (white in dark themes).
    .when(state[key], el => el.bg(t.solid).text_color(t.solid_foreground).hover(el => el.bg(t.solid)))
    .accessibility_label(name)
    .on_change((_pressed, cx) => { state.toggle(key); onChange?.(cx); cx.notify(); })
    .child(text);
  const step = (suffix, name, icon, delta) => ToolbarButton(`${id}-${suffix}`, t, { icon: true, disabled: !canStep }).accessibility_label(name).tooltip(name)
    .on_click((_event, cx) => onStep(delta, cx)).child(findIcon(icon));
  return h_flex().id(id).h(44).flex_none().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .on_key_down((event, cx) => {
      if (event.key === 'escape' && onClose) onClose(cx);
      else if (event.key === 'enter' || event.key === 'f3') onEnter?.(event.modifiers.shift, cx);
      else return;
      cx.stop_propagation();
    })
    .child(Input.new(state.input, t).id(`${id}-input`).accessibility_label(label)
      .flex_1().min_w(0).h(28).border_color(state.error ? t.blocked : t.input))
    .child(ToggleGroup(`${id}-options`, 'Search options', t)
      .child(option('caseSensitive', 'Match case', 'Aa', true))
      .child(option('wholeWord', 'Match whole word', 'ab', false))
      .child(option('regex', 'Use regular expression', '.*', false)))
    .when(Boolean(extra), el => el.child(extra))
    // A fixed width keeps the controls still while the count changes.
    .child(div().flex_none().w(statusWidth).truncate().text_right().text_size(12).text_color(t.muted)
      .child(state.error ? 'Invalid regex' : status))
    .when(Boolean(onStep), el => el
      .child(step('prev', 'Previous match (Shift+Enter)', 'chevron-up', -1))
      .child(step('next', 'Next match (Enter)', 'chevron-down', 1)))
    .when(Boolean(onClose), el => el.child(ToolbarButton(`${id}-close`, t, { icon: true }).accessibility_label('Close search').tooltip('Close search (Escape)')
      .on_click((_event, cx) => onClose(cx)).child(findIcon('close'))));
}
