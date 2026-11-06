import { div } from 'gpui-kit';

export function Progress(id, value, t, elapsed = null) {
  const showElapsed = value !== null && Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 100;
  return div().id(id).role('progress_indicator').w_full().flex_none().h(10)
    .when(value !== null, el => el.value(value))
    .when(value === null, el => el.indeterminate(true))
    .child(div().relative().size_full().rounded(0).bg(t.border).overflow_hidden()
      .when(showElapsed, el => el
        .child(div().id(`${id}-elapsed`).absolute().left(0).top(0).w(`${elapsed}%`).h('50%').bg(t.muted).opacity(0.5))
        .child(div().id(`${id}-time-marker`).absolute().left(`${elapsed}%`).top(0).w(1).h('50%').bg(t.foreground).opacity(0.6)))
      .when(value !== null, el => el.child(div().id(`${id}-fill`)
        .absolute().left(0).bottom(0).w(`${value}%`).h(showElapsed ? '50%' : '100%').rounded(0)
        .bg(value >= 90 ? t.ansi1 : value >= 70 ? t.blocked : t.working))));
}
