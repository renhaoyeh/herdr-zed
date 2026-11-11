import { div } from 'gpui-kit';
import { v_flex, h_flex, Input } from 'gpui-base';
import { props, theme, closeOverlay } from 'herdr';
import MantisPanel from './ui.js';
import { mantisSource } from './source.js';
import { sourceModuleOptions } from './components/source-channel.js';
import { Button } from './components/button.js';
import { DialogContent, DialogHeader, DialogDescription } from './components/dialog.js';

// MantisBT's My Account page: the server URL and API token. The panel owns the connection state
// (saveToken, clearToken, copyToken, fieldSettings); this view draws the form in the shell's theme tokens.
// Embedded in the shell's Settings dialog it draws no frame, close control or footer.
export class MantisSettings {
  init(cx) {
    this.target = { ...(props() || {}), context: props()?.context || { folder: 'source:mantisbt', name: 'MantisBT' } };
    this.embedded = Boolean(this.target.embedded);
    this.panel = new MantisPanel(sourceModuleOptions(mantisSource, this.target));
    this.panel.init(cx);
    this.panel.open(this.target.context, cx);
  }

  close() { this.panel?.dispose(); }

  render(cx) {
    const t = theme(), panel = this.panel;
    const busy = Boolean(panel.tokenBusy), loaded = panel.needsToken !== null && panel.needsToken !== undefined;
    // The form shows the saved connection once it is known, and again after a save or clear changes the token.
    if (loaded) {
      const key = String(panel.token);
      if (this.seeded !== key) { this.seeded = key; panel.seedSettings(); }
      panel.syncFields(cx);
    }
    const label = text => div().text_size(13).font_medium().child(text);
    const body = v_flex().gap(16).text_color(t.foreground)
      .when(!loaded, el => el.child(DialogDescription(t).child('Loading connection…')))
      .when(loaded, el => el
        .child(label('Server URL'))
        .child(Input.new(panel.serverInput).id('mantis-server').accessibility_label('MantisBT server URL')
          .w_full().h(32).px(8).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(13))
        .child(label('API token'))
        .child(h_flex().gap(8).items_center()
          .child(Input.new(panel.tokenInput).id('mantis-token').accessibility_label('MantisBT personal access token')
            .flex_1().min_w(0).h(32).px(8).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(13))
          .child(Button('mantis-copy-token', t, { variant: 'outline' }).h(32).disabled(!panel.tokenInput.value().trim())
            .accessibility_label('Copy personal access token').on_click((_event, cx) => panel.copyToken(cx))
            .child(panel.tokenCopied ? 'Copied' : 'Copy')))
        .child(DialogDescription(t).child('Create an API Token in MantisBT → My Account → API Tokens. Save keeps your settings even if the connection fails.'))
        .when(Boolean(panel.error), el => el.child(div().id('mantis-error').text_size(12).text_color(t.destructive).child(panel.error)))
        .child(h_flex().gap(8)
          .child(Button('mantis-save-token', t).disabled(busy).on_click((_event, cx) => panel.saveToken(cx)).child(busy ? 'Saving…' : 'Save'))
          .child(Button('mantis-cancel-token', t, { variant: 'outline' }).disabled(busy).on_click((_event, cx) => panel.openSettings(cx)).child('Cancel'))
          .when(Boolean(panel.token), el => el.child(Button('mantis-clear-token', t, { variant: 'outline' }).disabled(busy)
            .on_click((_event, cx) => panel.clearToken(cx)).child('Clear saved token'))))
        .child(panel.fieldSettings()));
    if (this.embedded) return v_flex().id('mantis-settings').size_full().min_h(0).overflow_y_scroll().child(body);
    const close = () => closeOverlay(this.target.overlay);
    return DialogContent('mantis-settings', t).overflow_y_scroll().on_key_down((event, cx) => {
      if (event.key === 'escape') { cx.stop_propagation(); close(); }
    }).child(DialogHeader(t, 'MantisBT', { id: 'mantis-settings-close', label: 'Close MantisBT settings', onClose: close })).child(body);
  }
}
