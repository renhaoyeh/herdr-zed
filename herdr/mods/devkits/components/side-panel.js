import { div } from 'gpui-kit';
import { h_flex } from 'gpui-base';

// A drag of the line between content and its side list. The width lives with the caller (Files and
// Changes share one); during a drag the panel follows the pointer and reports the width once released.
export class SidePanelState {
  constructor(width, setWidth) { this.saved = width; this.setWidth = setWidth; this.drag = null; }
  get width() { return this.drag ? this.drag.now : this.saved(); }
  end(cx) {
    if (!this.drag) return;
    const width = this.drag.now;
    this.drag = null;
    this.setWidth(width);
    cx.notify();
  }
}

// Content with a list docked at its right, as Zed's editor beside a dock panel. The visible line is the
// list's own 1px border, like Herdr's dividers: an invisible strip over it changes only the cursor and drags.
export function SidePanelLayout(id, state, content, side) {
  return h_flex().id(id).size_full().min_h(0)
    .on_mouse_move((event, cx) => {
      if (!state.drag) return;
      const width = Math.round(Math.min(560, Math.max(200, state.drag.width + state.drag.x - event.position.x)));
      if (width !== state.drag.now) { state.drag.now = width; cx.notify(); }
    })
    // GPUI reports no release outside the view, so leaving it ends the drag too.
    .on_mouse_up('left', (_event, cx) => state.end(cx))
    .on_hover((inside, cx) => { if (!inside) state.end(cx); })
    .child(div().flex_1().min_w(0).h_full().child(content))
    .child(div().relative().flex_none().h_full().w(state.width).child(side)
      .child(div().id(`${id}-handle`).absolute().top(0).bottom(0).left(-3).w(6).cursor_col_resize()
        .on_mouse_down('left', (event, cx) => {
          cx.stop_propagation();
          state.drag = { x: event.position.x, width: state.width, now: state.width };
        })));
}
