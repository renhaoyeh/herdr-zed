import { div } from 'gpui-kit';

export function Progress(id, value, t) {
  return div().id(id).role('progress_indicator').w_full().h(4)
    .when(value !== null, el => el.value(value))
    .when(value === null, el => el.indeterminate(true))
    .child(div().size_full().rounded(0).bg(t.border).overflow_hidden()
      .when(value !== null, el => el.child(div().id(`${id}-fill`)
        .w(`${value}%`).h_full().rounded(0)
        .bg(value >= 90 ? t.ansi1 : value >= 70 ? t.blocked : t.working))));
}
