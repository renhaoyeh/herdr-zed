import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { props, readTextFile, writeTextFile, closeOverlay } from 'herdr';
import { sharedMcpPath, parseSharedMcp } from './components/shared-mcp.js';
import { Button } from './components/button.js';
import { Switch } from './components/switch.js';
import { glyph } from './components/icon.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';

const mcpLabels = { command: 'Command', args: 'Arguments', url: 'Local URL', env_vars: 'Environment variables',
  bearer_token_env_var: 'Bearer token environment variable', env_http_headers: 'Header environment variables',
  startup_timeout_sec: 'Startup timeout (seconds)', tool_timeout_sec: 'Tool timeout (seconds)',
  enabled_tools: 'Enabled tools', disabled_tools: 'Disabled tools' };

export const sharedMcpSettings = {
  initSharedMcp(cx) {
    if (this.mcpSaving) return;
    this.mcpLoading = true; this.mcpError = null; this.mcpConfig = null; this.mcpRows = [];
    const selected = this.mcpSelected;
    cx.spawn(async cx => {
      try {
        this.mcpOriginal = await readTextFile(sharedMcpPath());
        this.mcpConfig = parseSharedMcp(this.mcpOriginal);
        this.mcpRows = Object.entries(this.mcpConfig.servers).map(([name, server]) => ({ id: name, name, server,
          type: server.url === undefined ? 'command' : 'url', enabled: server.enabled !== false }));
        this.mcpSelected = this.mcpRows.find(row => row.id === selected)?.id || this.mcpRows[0]?.id;
      } catch (error) { this.mcpError = error.message; }
      finally { this.mcpLoading = false; cx.notify(); }
    });
  },
  toggleMcpEnabled(row, cx) {
    if (this.mcpSaving || this.mcpLoading || !this.mcpConfig || !this.mcpRows.includes(row)) return;
    const enabled = !row.enabled;
    const config = { ...this.mcpConfig, servers: { ...this.mcpConfig.servers,
      [row.id]: { ...row.server, enabled } } };
    const text = `${JSON.stringify(config, null, 2)}\n`;
    this.mcpSaving = true; this.mcpError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await writeTextFile(sharedMcpPath(), text, this.mcpOriginal);
        this.mcpOriginal = text; this.mcpConfig = config;
        row.server = config.servers[row.id]; row.enabled = enabled;
      } catch (error) { this.mcpError = error.message; }
      finally { this.mcpSaving = false; cx.notify(); }
    });
  },
  finishSharedMcp() { closeOverlay((props() || {}).overlay); },
  sharedMcpDialog(t) { return DialogContent('shared-mcp', t).child(this.sharedMcpPage(t)); },
  mcpProperty(label, value, t) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return v_flex().gap(4)
      .child(div().text_size(12).text_color(t.muted).child(label))
      .child(div().min_h(32).px(8).py(6).border(1).border_color(t.input).text_size(12).text_color(t.muted)
        .accessibility_label(`${label}, read-only`).child(text === '' ? '—' : text));
  },
  mcpDetails(row, t) {
    const server = row.server;
    const standard = ['enabled', 'command', 'args', 'env_vars', 'url', 'bearer_token_env_var', 'env_http_headers'];
    return v_flex().gap(12)
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(12).child('Enable server'))
        .child(Switch('mcp-enabled', row.enabled, t).disabled(Boolean(this.mcpSaving))
          .accessibility_label(`Enable ${row.name}`).on_change((_checked, cx) => this.toggleMcpEnabled(row, cx))))
      .child(this.mcpProperty('Server name', row.name, t))
      .child(h_flex().h(28).px(8).gap(8).items_center().justify_between().border(1).border_color(t.border)
        .accessibility_label('Transport, read-only').text_size(12).text_color(t.muted)
        .child(row.type === 'command' ? 'Local command' : 'Local HTTP')
        .child(glyph('chevron-down', 12).text_color(t.dim)))
      .when(row.type === 'command', el => el.child(this.mcpProperty('Command', server.command, t))
        .child(v_flex().gap(6).child(div().text_size(12).text_color(t.muted).child('Arguments'))
          .children((server.args || []).map((arg, index) => div().min_h(32).px(8).py(6).border(1).border_color(t.input).text_size(12).text_color(t.muted)
            .accessibility_label(`Argument ${index + 1}, read-only`).child(arg)))
          .when(!server.args?.length, field => field.child(div().min_h(32).px(8).py(6).border(1).border_color(t.input).text_size(12).text_color(t.muted).child('—'))))
        .child(this.mcpProperty('Environment variables · comma-separated names', (server.env_vars || []).join(', '), t)))
      .when(row.type === 'url', el => el.child(this.mcpProperty('Local URL', server.url, t))
        .child(this.mcpProperty('Bearer token · environment variable name', server.bearer_token_env_var || '', t))
        .child(this.mcpProperty('Headers · Header-Name=ENVIRONMENT_VARIABLE', Object.entries(server.env_http_headers || {}).map(([key, value]) => `${key}=${value}`).join('\n'), t)))
      .children(Object.entries(server).filter(([key]) => !standard.includes(key))
        .map(([key, value]) => this.mcpProperty(mcpLabels[key] || key, value, t)));
  },
  sharedMcpPage(t) {
    const selected = this.mcpRows?.find(row => row.id === this.mcpSelected);
    return v_flex().h_full().flex_1().min_h(0).gap(12)
      .child(DialogTitle().flex_none().child('Shared MCP'))
      .child(DialogDescription(t).flex_none().child('Shared MCP for all local Codex accounts and Profiles. Enable changes save automatically and apply to new sessions; connection details are read-only.'))
      .when(this.mcpLoading, el => el.child(div().text_color(t.muted).child('Loading servers…')))
      .when(!this.mcpLoading && Boolean(this.mcpConfig), el => el.child(h_flex().flex_1().min_h(0).items_stretch().gap(16)
        .child(v_flex().w(190).h_full().min_h(0).flex_none().gap(8)
          .child(div().text_size(11).text_color(t.muted).child('SERVERS'))
          .child(v_flex().id('mcp-server-list').flex_1().min_h(0).overflow_y_scroll().border(1).border_color(t.border)
            .children(this.mcpRows.map(row => Button(`mcp-select-${row.id}`, t, { variant: 'ghost' }).h(48).w_full().justify_start().gap(8).px(10)
              .bg(row.id === this.mcpSelected ? t.selected : t.popover)
              .on_click((_event, cx) => { this.mcpSelected = row.id; cx.notify(); })
              .child(glyph(row.type === 'command' ? 'terminal' : 'external-link'))
              .child(v_flex().min_w(0).gap(2).child(div().truncate().child(row.name))
                .child(div().text_size(11).text_color(t.muted).child(row.enabled ? 'Enabled' : 'Disabled')))))))
        .child(v_flex().flex_1().min_w(0).min_h(0).h_full().id('mcp-server-details').overflow_y_scroll().gap(12)
          .when(Boolean(selected), el => el.child(this.mcpDetails(selected, t)))
          .when(!selected, el => el.child(v_flex().py(32).gap(8).child(div().text_size(16).font_family('Georgia').child('No shared servers'))
            .child(div().text_size(12).text_color(t.muted).child('No local MCP servers are configured.')))))))
      .when(Boolean(this.mcpError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.mcpError)))
      .child(DialogFooter().flex_none().child(Button('mcp-refresh', t, { variant: 'secondary' }).disabled(Boolean(this.mcpLoading || this.mcpSaving))
        .on_click((_event, cx) => this.initSharedMcp(cx)).child('Refresh'))
        .when((props() || {}).view === 'shared-mcp', el => el.child(Button('mcp-done', t).on_click(() => this.finishSharedMcp()).child('Done'))));
  },
};
