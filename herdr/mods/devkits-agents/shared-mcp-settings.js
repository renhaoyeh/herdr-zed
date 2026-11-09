import { div } from 'gpui-kit';
import { v_flex, EditorState, Editor } from 'gpui-base';
import { props, readTextFile, writeTextFile, closeOverlay, notify } from 'herdr';
import { sharedMcpPath, parseSharedMcp } from './components/shared-mcp.js';
import { Button } from './components/button.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';

export const sharedMcpSettings = {
  initSharedMcp(cx) {
    this.mcpLoading = true; this.mcpError = null;
    this.mcpServers = EditorState.new({ language: 'json', value: '{}' });
    cx.spawn(async cx => {
      try {
        this.mcpOriginal = await readTextFile(sharedMcpPath());
        this.mcpConfig = parseSharedMcp(this.mcpOriginal);
        this.mcpServers.set_value(JSON.stringify(this.mcpConfig.servers, null, 2));
      } catch (error) { this.mcpError = error.message; }
      finally { this.mcpLoading = false; cx.notify(); }
    });
  },
  finishSharedMcp() { closeOverlay((props() || {}).overlay); },
  saveSharedMcp(cx) {
    if (this.mcpLoading || this.mcpSaving || !this.mcpConfig) return;
    this.mcpSaving = true; this.mcpError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const config = parseSharedMcp(JSON.stringify({ ...this.mcpConfig,
          servers: JSON.parse(this.mcpServers.value()) }));
        // Compare-and-swap prevents another settings window or editor's changes being overwritten.
        await writeTextFile(sharedMcpPath(), `${JSON.stringify(config, null, 2)}\n`, this.mcpOriginal);
        notify({ title: 'Shared MCP settings saved', body: 'Applies to new local Codex sessions, including Tasks.' });
        this.finishSharedMcp();
      } catch (error) { this.mcpError = error.message; }
      finally { this.mcpSaving = false; cx.notify(); }
    });
  },
  sharedMcpDialog(t) {
    return DialogContent('shared-mcp', t)
      .on_key_down((event, cx) => { if (event.key === 'escape' && !this.mcpSaving) { cx.stop_propagation(); this.finishSharedMcp(); } })
      .child(DialogTitle().child('Shared local MCP servers'))
      .child(DialogDescription(t).child('All local Codex accounts and named agents use this shared configuration in new sessions.'))
      .when(this.mcpLoading, el => el.child(div().text_color(t.muted).child('Loading MCP settings…')))
      .child(v_flex().flex_1().min_h(0).gap(8)
        .child(div().text_size(12).child('Shared servers · command or local URL, using Codex MCP field names'))
        .child(Editor.new(this.mcpServers).flex_1().min_h(0).border(1).border_color(t.border)))
      .when(Boolean(this.mcpError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.mcpError)))
      .child(DialogFooter()
        .child(Button('mcp-cancel', t, { variant: 'secondary' }).disabled(Boolean(this.mcpSaving)).on_click(() => this.finishSharedMcp()).child('Cancel'))
        .child(Button('mcp-save', t).disabled(this.mcpLoading || Boolean(this.mcpSaving) || !this.mcpConfig)
          .on_click((_event, cx) => this.saveSharedMcp(cx)).child(this.mcpSaving ? 'Saving…' : 'Save')));
  },
};
