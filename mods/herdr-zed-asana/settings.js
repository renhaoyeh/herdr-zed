import { div } from 'gpui-kit';
import { v_flex, h_flex, Input } from 'gpui-base';
import { props, theme, closeOverlay } from 'herdr';
import AsanaPanel from './ui.js';
import { asanaSource } from './source.js';
import { sourceModuleOptions } from './components/source-channel.js';
import { Button } from './components/button.js';
import { DialogContent, DialogHeader, DialogDescription } from './components/dialog.js';

// Asana's Settings page: the personal access token and field display. The panel owns the token state
// (saveToken, clearToken, copyToken, fieldSettings); this view draws it in the shell's theme tokens.
// Embedded in the shell's Settings dialog it draws no frame, close control or footer.
export class AsanaSettings {
  init(cx) {
    this.target = { ...(props() || {}), context: props()?.context || { folder: 'source:asana', name: 'Asana' } };
    this.embedded = Boolean(this.target.embedded);
    this.panel = new AsanaPanel(sourceModuleOptions(asanaSource, this.target));
    this.panel.init(cx);
    this.panel.open(this.target.context, cx);
  }

  close() { this.panel?.dispose(); }

  render(cx) {
    const t = theme(), panel = this.panel;
    const busy = Boolean(panel.tokenBusy);
    // The form shows the saved token once it is known, and again after a save or clear changes it.
    if (panel.needsToken !== null && panel.needsToken !== undefined) {
      const key = String(panel.token);
      if (this.seeded !== key) { this.seeded = key; panel.openSettings(cx); }
      panel.syncFields(cx);
    }
    const body = v_flex().gap(16).text_color(t.foreground)
      .when(panel.needsToken === null || panel.needsToken === undefined, el => el.child(DialogDescription(t).child('Loading connection…')))
      .when(panel.needsToken !== null && panel.needsToken !== undefined, el => el
        .child(DialogDescription(t).child(panel.token ? 'Your saved token is masked below. Replace it to change accounts, or clear it below.' : asanaSource.tokenHelp))
        .child(div().text_size(13).font_medium().child('Personal access token'))
        .child(h_flex().gap(8).items_center()
          .child(Input.new(panel.tokenInput).id('asana-token').accessibility_label(`${asanaSource.name} personal access token`)
            .flex_1().min_w(0).h(32).px(8).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(13))
          .child(Button('asana-copy-token', t, { variant: 'outline' }).h(32).disabled(!panel.tokenInput.value().trim())
            .accessibility_label('Copy personal access token').on_click((_event, cx) => panel.copyToken(cx))
            .child(panel.tokenCopied ? 'Copied' : 'Copy')))
        .when(Boolean(panel.error), el => el.child(div().id('asana-error').text_size(12).text_color(t.destructive).child(panel.error)))
        .child(h_flex().gap(8)
          .child(Button('asana-save-token', t).disabled(busy).on_click((_event, cx) => panel.saveToken(cx)).child(busy ? 'Saving…' : panel.token ? 'Save token' : 'Connect'))
          .child(Button('asana-cancel-token', t, { variant: 'outline' }).disabled(busy).on_click((_event, cx) => panel.openSettings(cx)).child('Cancel'))
          .when(Boolean(panel.token), el => el.child(Button('asana-clear-token', t, { variant: 'outline' }).disabled(busy)
            .on_click((_event, cx) => panel.clearToken(cx)).child('Clear saved token'))))
        .child(panel.fieldSettings(t)));
    if (this.embedded) return v_flex().id('asana-settings').size_full().min_h(0).overflow_y_scroll().child(body);
    const close = () => closeOverlay(this.target.overlay);
    return DialogContent('asana-settings', t).overflow_y_scroll().on_key_down((event, cx) => {
      if (event.key === 'escape') { cx.stop_propagation(); close(); }
    }).child(DialogHeader(t, 'Asana', { id: 'asana-settings-close', label: 'Close Asana settings', onClose: close })).child(body);
  }
}
