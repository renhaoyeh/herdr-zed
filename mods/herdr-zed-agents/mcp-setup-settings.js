import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState } from 'gpui-base';
import { appHome, exec } from 'herdr';
import { parseSharedMcp, sharedMcpSupported } from './components/shared-mcp-model.js';
import { devkitsMcpPresets } from './devkits-model.js';
import { Button } from './components/button.js';

export const mcpFingerprint = server => { const { enabled, ...transport } = server; return JSON.stringify(transport); };
const setupInput = (text = '') => { const state = InputState.new({}); state.set_value(text); return state; };
export const mcpSetupSettings = {
  openMcpSetup(name, cx) {
    if (this.capSaving || this.capChecking || !sharedMcpSupported(name, this.capPlatform) || name === 'herdr_tasks') return;
    const server = this.mcpConfig.servers[name] || {};
    this.capTab = 'mcp'; this.capMcpSelected = name; this.capError = null;
    this.capSetup = { name, original: server, type: server.url ? 'url' : 'command',
      command: setupInput(server.command || (name === 'visual_studio' ? this.capInfo.bridgePath || this.capInfo.suggestedBridge || '' : '')),
      args: (server.args || []).map(arg => setupInput(arg)), env: setupInput((server.env_vars || []).join(', ')),
      url: setupInput(server.url || ''), token: setupInput(server.bearer_token_env_var || '') };
    cx.notify();
  },
  setupCandidate() {
    const form = this.capSetup;
    if (!form) throw Error('Choose a connection to set up.');
    const candidate = { ...form.original, enabled: true };
    for (const key of ['command', 'args', 'env_vars', 'url', 'bearer_token_env_var']) delete candidate[key];
    if (form.type === 'command') {
      delete candidate.env_http_headers;
      candidate.command = form.command.value().trim(); candidate.args = form.args.map(state => state.value());
      const names = form.env.value().split(',').map(name => name.trim()).filter(Boolean);
      if (names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw Error('Use comma-separated environment-variable names.');
      if (names.length) candidate.env_vars = names;
    } else {
      candidate.url = form.url.value().trim();
      if (form.token.value().trim()) candidate.bearer_token_env_var = form.token.value().trim();
    }
    parseSharedMcp(JSON.stringify({ version: 1, servers: { [form.name]: candidate } }));
    return candidate;
  },
  async probeMcp(name, server) {
    const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/mcp-probe.js`, 'verify', name, JSON.stringify(server), appHome()], { timeout: 15000 });
    if (result.code !== 0) throw Error(result.stderr?.trim() || 'Connection verification failed.');
    const value = JSON.parse(result.stdout || '{}');
    if (!Number.isFinite(value.verifiedAt) || !Number.isInteger(value.toolsCount) || value.toolsCount < 0) throw Error('Connection verification returned no result.');
    return value;
  },
  testMcpSetup(cx) {
    if (!this.capSetup || this.capChecking || this.capSaving || !sharedMcpSupported(this.capSetup.name, this.capPlatform)) return;
    const form = this.capSetup; let server;
    try { server = this.setupCandidate(); } catch (error) { this.capError = error.message; cx.notify(); return; }
    this.capChecking = true; this.capError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.probeMcp(form.name, server);
        if (this.capClosed || this.capSetup !== form) return;
        if (JSON.stringify(this.setupCandidate()) !== JSON.stringify(server)) throw Error('Setup changed during verification. Test the current values again.');
        this.mcpConfig = { ...this.mcpConfig, servers: { ...this.mcpConfig.servers, [form.name]: server } };
        this.capVerified[form.name] = { ...result, fingerprint: mcpFingerprint(server) };
        this.capSetup = null; this.capDirty = true; this.capSaved = false;
        if (this.capPending) {
          const plan = this.currentDevkitsPlan();
          if (!plan.missing.length && !plan.blocked.length) this.acceptDevkitsPlan(cx);
        }
      } catch (error) { if (!this.capClosed) this.capError = error.message; }
      finally { this.capChecking = false; if (!this.capClosed) cx.notify(); }
    });
  },
  verifyDevkitsMcp(row, cx) {
    if (this.capChecking || this.capSaving || row.missing || !sharedMcpSupported(row.name, this.capPlatform)) return;
    this.capChecking = true; this.capError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.probeMcp(row.name, row.server);
        if (!this.capClosed) this.capVerified[row.name] = { ...result, fingerprint: mcpFingerprint(row.server) };
      } catch (error) { if (!this.capClosed) this.capError = error.message; }
      finally { this.capChecking = false; if (!this.capClosed) cx.notify(); }
    });
  },
  detectMcpBridge(cx) {
    if (this.capChecking || this.capPlatform !== 'windows' || !this.capSetup) return;
    const form = this.capSetup;
    this.capChecking = true; this.capError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/mcp-probe.js`, 'info'], { timeout: 10000 });
        if (result.code !== 0) throw Error('Could not inspect the installed bridge.');
        const info = JSON.parse(result.stdout);
        if (this.capClosed || this.capSetup !== form) return;
        this.capInfo = info;
        if (!info.bridgePath) throw Error('Bridge not found. Install the official VSIX, start Visual Studio once, then detect again.');
        form.command.set_value(info.bridgePath);
      } catch (error) { if (!this.capClosed) this.capError = error.message; }
      finally { this.capChecking = false; if (!this.capClosed) cx.notify(); }
    });
  },
  mcpSetupForm(t) {
    const form = this.capSetup, busy = Boolean(this.capChecking || this.capSaving);
    const preset = devkitsMcpPresets.find(item => item.id === form.name);
    const field = (id, label, state) => v_flex().gap(4)
      .child(div().text_size(12).text_color(t.muted).child(label))
      .child(Input.new(state, t).id(id).h(32).px(8).border(1).border_color(t.input).text_size(12).disabled(busy).accessibility_label(label));
    return v_flex().gap(10)
      .child(div().text_size(13).font_semibold().child(`Set up ${form.name}`))
      .when(Boolean(preset), el => el.child(div().text_size(12).text_color(t.muted).child(preset.setup))
        .child(h_flex().gap(8).children([
          Button('mcp-setup-install', t, { variant: 'secondary' }).h(30).disabled(busy).on_click((_event, cx) => cx.open_url(preset.url)).child('Official installation guide'),
          Button('mcp-setup-detect', t, { variant: 'secondary' }).h(30).disabled(busy || this.capPlatform !== 'windows').on_click((_event, cx) => this.detectMcpBridge(cx)).child('Detect installed bridge'),
        ])))
      .child(h_flex().gap(4).children([{ id: 'command', label: 'Local command' }, { id: 'url', label: 'Local HTTP' }].map(type =>
        Button(`mcp-setup-type-${type.id}`, t, { variant: 'ghost' }).h(30).disabled(busy).bg(form.type === type.id ? t.selected : t.popover)
          .on_click((_event, cx) => { form.type = type.id; cx.notify(); }).child(type.label))))
      .when(form.type === 'command', el => el.child(field('mcp-setup-command', 'Command or executable path', form.command))
        .child(v_flex().gap(6).child(div().text_size(12).text_color(t.muted).child('Arguments · one field per argument'))
          .children(form.args.map((state, index) => h_flex().gap(6).items_center()
            .child(Input.new(state, t).id(`mcp-setup-arg-${index}`).h(32).px(8).flex_1().min_w(0).border(1).border_color(t.input).text_size(12).disabled(busy).accessibility_label(`Argument ${index + 1}`))
            .child(Button(`mcp-setup-arg-remove-${index}`, t, { variant: 'secondary' }).h(30).disabled(busy)
              .on_click((_event, cx) => { form.args.splice(index, 1); cx.notify(); }).child('Remove'))))
          .child(Button('mcp-setup-arg-add', t, { variant: 'secondary' }).h(30).disabled(busy)
            .on_click((_event, cx) => { form.args.push(setupInput()); cx.notify(); }).child('Add argument')))
        .child(field('mcp-setup-env', 'Environment variables · comma-separated names', form.env)))
      .when(form.type === 'url', el => el.child(field('mcp-setup-url', 'Local MCP URL', form.url))
        .child(field('mcp-setup-token', 'Bearer token environment-variable name · optional', form.token)))
      .child(div().text_size(12).text_color(t.muted).child('Testing starts this command or connects to this local endpoint, then discovers tools. It does not call tools or run a workflow. Test and use stages the verified connection; Save changes applies it.'))
      .child(h_flex().gap(8)
        .child(Button('mcp-setup-cancel', t, { variant: 'secondary' }).h(30).disabled(busy).on_click((_event, cx) => { this.capSetup = null; cx.notify(); }).child('Cancel'))
        .child(Button('mcp-setup-test', t).h(30).disabled(busy).on_click((_event, cx) => this.testMcpSetup(cx)).child(this.capChecking ? 'Testing…' : 'Test and use')));
  },
};
