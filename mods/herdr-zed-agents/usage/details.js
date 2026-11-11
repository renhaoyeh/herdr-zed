import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { props, closeOverlay } from 'herdr';
import { quotaResetLabel, quotaElapsedPercent } from './components/session-model.js';
import { Button } from './components/button.js';
import { Progress } from './components/progress.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
export class UsageDetails {
  init(cx) { this.handle = cx.focus_handle(); this.handle.focus(); cx.timer.every(60000, cx => cx.notify()); }
  render(t) { return this.usageDetails(t); }
  usageDetails(t) {
    const { account, overlay } = props();
    const close = () => closeOverlay(overlay);
    return DialogContent('usage-details', t).track_focus(this.handle)
      .accessibility_label(`${account.name} usage details`).on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); close(); }
      })
      .child(DialogTitle().flex_none().child(account.name))
      .child(DialogDescription(t).flex_none().child(account.supported ? 'Account quota usage' : 'Not supported'))
      .child(v_flex().id('usage-windows').flex_1().min_h(0).overflow_y_scrollbar().gap(16)
        .when(Boolean(account.error), el => el.child(div().text_size(12).text_color(t.muted).child(account.error)))
        .when(account.supported && !account.error && !account.windows?.length, el => el
          .child(div().text_size(12).text_color(t.muted).child('No quota windows available.')))
        .children((account.windows || []).map((window, index) => {
          const elapsed = quotaElapsedPercent(window);
          const duration = window.minutes === null ? 'Unknown duration' : window.minutes % 1440 === 0
            ? `${window.minutes / 1440}d` : window.minutes % 60 === 0 ? `${window.minutes / 60}h` : `${window.minutes}m`;
          return v_flex().flex_none().gap(8)
            .child(h_flex().justify_between().text_size(13)
              .child(`${window.name} · ${duration}`)
              .child(`${Math.round(window.usedPercent)}% used · ${Math.round(100 - window.usedPercent)}% remaining`))
            .child(Progress(`usage-detail-meter-${index}`, window.usedPercent, t, elapsed, window.minutes === 300 ? 5 : window.minutes === 10080 ? 7 : 0)
              .accessibility_label(`${window.name} ${duration} used`))
            .when(elapsed !== null, el => el.child(div().text_size(12).text_color(t.muted)
              .child(`Top: ${Math.round(elapsed)}% of window elapsed · Bottom: quota used`)))
            .child(div().text_size(12).text_color(t.muted)
              .child(quotaResetLabel(window)));
        })))
      .when(Boolean(account.fetchedAt), el => el.child(DialogDescription(t).flex_none()
        .child(`Updated ${new Date(account.fetchedAt).toLocaleString()}`)))
      .child(DialogFooter().flex_none().child(Button('usage-details-done', t).on_click(close).child('Done')));
  }
}
