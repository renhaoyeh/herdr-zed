import { div } from 'gpui-kit';
import { h_flex } from 'gpui-base';

// A drag of the line between content and its side list. The width lives with the caller (Files and
// Changes share one); during a drag the panel follows the pointer and reports the width once released.
export class SidePanelState {
  constructor(width, setWidth, { minWidth = 200, maxWidth = 560, defaultWidth = 280, minContentWidth = 0, label = 'Resize side panel' } = {}) {
    this.saved = width; this.setWidth = setWidth; this.drag = null;
    this.minWidth = minWidth; this.maxWidth = maxWidth; this.defaultWidth = defaultWidth;
    this.minContentWidth = minContentWidth; this.label = label;
  }
  clamp(width) {
    const available = this.availableWidth ?? Infinity;
    const min = Math.min(this.minWidth, available);
    const max = Math.min(this.maxWidth, Math.max(min, available - this.minContentWidth));
    return Math.round(Math.max(min, Math.min(max, Number.isFinite(width) ? width : this.defaultWidth)));
  }
  get width() { return this.clamp(this.drag ? this.drag.now : this.saved()); }
  end(cx) {
    if (!this.drag) return;
    const width = this.width;
    this.drag = null;
    this.setWidth(width);
    cx.notify();
  }
}

// Content with a list docked at its right, as Zed's editor beside a dock panel. The visible line is the
// list's own 1px border, like Herdr's dividers: an invisible strip over it changes only the cursor and drags.
export function SidePanelLayout(id, state, content, side) {
  return h_flex().id(id).size_full().min_h(0)
    .when(Boolean(state.drag), el => el.cursor_col_resize())
    .on_size_change((size, cx) => {
      const previous = state.width;
      state.availableWidth = size.width;
      if (state.width !== previous) cx.notify();
    })
    .on_mouse_move((event, cx) => {
      if (!state.drag) return;
      const scale = state.availableWidth && event.bounds?.width ? event.bounds.width / state.availableWidth : 1;
      const width = state.clamp(state.drag.width + (state.drag.x - event.position.x) / scale);
      if (width !== state.drag.now) { state.drag.now = width; cx.notify(); }
    })
    // GPUI reports no release outside the view, so leaving it ends the drag too.
    .on_mouse_up('left', (_event, cx) => state.end(cx))
    .on_hover((inside, cx) => { if (!inside) state.end(cx); })
    .child(div().flex_1().min_w(0).h_full().child(content))
    .child(div().relative().flex_none().h_full().w(state.width).child(side)
      .child(div().id(`${id}-handle`).absolute().top(0).bottom(0).left(-3).w(6).cursor_col_resize()
        .accessibility_label(state.label)
        .on_click((event, cx) => {
          if (event.click_count < 2) return;
          state.drag = null; state.setWidth(state.clamp(state.defaultWidth)); cx.notify();
        })
        .on_mouse_down('left', (event, cx) => {
          cx.stop_propagation();
          state.drag = { x: event.position.x, width: state.width, now: state.width };
        })));
}
