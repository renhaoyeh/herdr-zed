import { div } from 'gpui-kit';
import { h_flex, v_flex, TextView, InputState } from 'gpui-base';
import { appHome, readTextFile, writeTextFile, exec } from 'herdr';
import { devkitsPath, readDevkitsSkills, readMineItems } from './devkits.js';
import { parseDevkits, devkitsCatalog, devkitsMcpPresets, resourceSupported, resourceProblems, devkitsPlan, applyDevkitsPlan, mcpUsers,
  mineRoot, mineSelectionPath, parseMineSelection, providerSupported } from './devkits-model.js';
import { parseSharedMcp, sharedMcpSupported } from './components/shared-mcp-model.js';
import { sharedMcpPath } from './components/shared-mcp.js';
import { tasksMcpServer } from './components/session-model.js';
import { mcpFingerprint } from './mcp-setup-settings.js';
import { Button } from './components/button.js';
import { Input } from './components/input.js';
import { Switch } from './components/switch.js';
import { glyph, AgentIcon } from './components/icon.js';
import { DialogDescription, DialogFooter } from './components/dialog.js';

const providers = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }];
const kinds = [{ id: 'rules', label: 'Rules', note: 'Guide every new conversation.' }, { id: 'skills', label: 'Skills', note: 'Loaded when the task needs them.' }];
const stripFrontmatter = text => (text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');

// Capabilities: built-in and your own Rules and Skills, browsed per provider like ECC. MCP Connections shares the loaded
// files but keeps its own draft, Save and Discard.
export const devkitsSettings = {
  initDevkits(cx) {
    if (this.capCatalog) return;
    this.capClosed = false; this.capTab = 'overview'; this.capPlatform = null; this.capItem = null;
    this.capCatalog = devkitsCatalog(appHome());
    this.capSearch = InputState.new({ placeholder: 'Search names and descriptions…' });
    this.capSearch.on('change', (_event, cx) => { this.capShowSource = false; cx.notify(); });
    this.capShowSource = false;
    this.capMcpSelected = 'herdr_tasks'; this.capVerified = {};
    this.loadDevkits(cx);
  },
  selectDevkitsSection(tab, cx) {
    if (this.capChecking || this.capSaving || this.capSetup) return;
    this.capTab = tab; this.capItem = null; this.capSearch.set_value(''); this.capShowSource = false;
    cx.notify();
  },
  enabled(kind, item) { return item.source === 'mine' ? !this.capMine.disabled.includes(item.id) : this.capConfig[kind][item.id] === true; },
  setEnabled(kind, item, on) {
    if (item.source === 'mine') this.capMine = { ...this.capMine, disabled: on ? this.capMine.disabled.filter(id => id !== item.id) : [...this.capMine.disabled, item.id] };
    else this.capConfig[kind][item.id] = on;
    this.capDirty = true; this.capSaved = false;
  },
  // The provider page's items, Rules before Skills, filtered by the search field.
  providerItems(provider) {
    const query = this.capSearch.value().trim().toLowerCase();
    return kinds.flatMap(kind => this.capCatalog[kind.id].filter(item => providerSupported(item, provider)
      && (!query || [item.name, item.description].filter(Boolean).join(' ').toLowerCase().includes(query))).map(item => ({ kind: kind.id, item })));
  },
  changeDevkitsGroup(checked, cx) {
    if (this.capSaving || this.capLoading || this.capChecking || this.capSetup || this.capPending) return;
    const items = this.providerItems(this.capTab).filter(({ item }) => resourceSupported(item, this.capPlatform) && (!checked || !this.capMissing.includes(item.path)));
    if (!items.length) return;
    const builtin = items.filter(({ item }) => item.source !== 'mine');
    for (const { kind, item } of items.filter(({ item }) => item.source === 'mine' || !checked)) this.setEnabled(kind, item, checked);
    if (checked && builtin.length) this.requestDevkitsSelection(Object.fromEntries(kinds.map(kind => [kind.id, builtin.filter(entry => entry.kind === kind.id).map(entry => entry.item.id)])), cx);
    else cx.notify();
  },
  loadDevkits(cx) {
    if (this.capSaving || this.capLoading || this.capChecking) return;
    this.capLoading = true; this.capError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const catalog = devkitsCatalog(appHome());
        const [text, mcp, info, skills, mine, mineText] = await Promise.all([readTextFile(devkitsPath()), readTextFile(sharedMcpPath()),
          exec('node', [`${appHome()}/mods/herdr-zed-agents/mcp-probe.js`, 'info'], { timeout: 10000 }), readDevkitsSkills([...catalog.rules, ...catalog.skills]),
          readMineItems(), readTextFile(mineSelectionPath(appHome()))]);
        if (info.code !== 0) throw Error('Could not identify the local platform. Check Node.js.');
        const platformInfo = JSON.parse(info.stdout || '{}');
        if (!['windows', 'macos', 'linux'].includes(platformInfo.platform)) throw Error('Local platform information is unavailable.');
        const config = parseDevkits(text), mcpConfig = parseSharedMcp(mcp), mineSelection = parseMineSelection(mineText);
        if (this.capClosed) return;
        this.capOriginal = text; this.capConfig = config; this.mcpOriginal = mcp; this.mcpConfig = mcpConfig;
        this.mineOriginal = mineText; this.capMine = mineSelection;
        this.capPlatform = platformInfo.platform; this.capInfo = platformInfo;
        for (const kind of ['rules', 'skills']) catalog[kind] = [...skills.filter(item => item.group === kind).map(({ text, ...item }) => item),
          ...mine.filter(item => item.group === kind).map(({ text, ...item }) => item)];
        this.capCatalog = catalog;
        this.capSkillText = Object.fromEntries([...skills, ...mine].map(skill => [skill.path, skill.text]));
        this.capMissing = skills.filter(skill => skill.text == null).map(skill => skill.path);
        this.capPending = null; this.capDisable = null; this.capSetup = null; this.capShowSource = false;
        this.capDirty = false; this.capSaved = false; this.mcpDirty = false; this.mcpSaved = false;
      } catch (error) { if (!this.capClosed) this.capError = error.message; }
      finally { this.capLoading = false; if (!this.capClosed) cx.notify(); }
    });
  },
  // Each page saves only its own draft; the other file is written back unchanged.
  saveDevkits(scope, cx) {
    const mcpScope = scope === 'mcp';
    if (this.capSaving || this.capLoading || this.capChecking || this.capSetup || this.capPending || this.capDisable || !this.capConfig || !(mcpScope ? this.mcpDirty : this.capDirty)) return;
    let text = this.capOriginal, mcp = this.mcpOriginal, mineText = this.mineOriginal;
    try {
      if (mcpScope) mcp = JSON.stringify(parseSharedMcp(this.mcpOriginal)) === JSON.stringify(this.mcpConfig) ? this.mcpOriginal : `${JSON.stringify(this.mcpConfig, null, 2)}\n`;
      else {
        text = JSON.stringify(parseDevkits(this.capOriginal)) === JSON.stringify(this.capConfig) ? this.capOriginal : `${JSON.stringify(this.capConfig, null, 2)}\n`;
        mineText = JSON.stringify(parseMineSelection(this.mineOriginal)) === JSON.stringify(this.capMine) ? this.mineOriginal : `${JSON.stringify(this.capMine, null, 2)}\n`;
      }
      parseDevkits(text); parseSharedMcp(mcp);
    } catch (error) { this.capError = error.message; cx.notify(); return; }
    this.capSaving = true; this.capError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const payload = { capabilities: { expected: this.capOriginal, text }, mcp: { expected: this.mcpOriginal, text: mcp } };
        const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/devkits-save.js`, appHome(), JSON.stringify(payload)], { timeout: 15000 });
        if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not save. The draft is retained.');
        if (JSON.parse(result.stdout || '{}').saved !== true) throw Error('Save returned no confirmation. Reload before retrying.');
        if (mineText !== this.mineOriginal) await writeTextFile(mineSelectionPath(appHome()), mineText, this.mineOriginal);
        if (this.capClosed) return;
        this.capOriginal = text; this.mcpOriginal = mcp; this.mineOriginal = mineText;
        if (mcpScope) { this.mcpDirty = false; this.mcpSaved = true; } else { this.capDirty = false; this.capSaved = true; }
      } catch (error) { if (!this.capClosed) this.capError = error.message; }
      finally { this.capSaving = false; if (!this.capClosed) cx.notify(); }
    });
  },
  discardDevkits(scope, cx) {
    if (this.capSaving || this.capLoading || this.capChecking || !this.capConfig) return;
    if (scope === 'mcp') { this.mcpConfig = parseSharedMcp(this.mcpOriginal); this.capSetup = null; this.capDisable = null; this.mcpDirty = false; this.mcpSaved = false; }
    else { this.capConfig = parseDevkits(this.capOriginal); this.capMine = parseMineSelection(this.mineOriginal); this.capPending = null; this.capDirty = false; this.capSaved = false; }
    this.capError = null; cx.notify();
  },
  currentDevkitsPlan() { return devkitsPlan(this.capConfig, this.capCatalog, this.capPending, this.mcpConfig.servers, this.capPlatform, this.capMissing); },
  requestDevkitsSelection(request, cx) {
    if (this.capSaving || this.capLoading || this.capChecking || !this.capConfig) return;
    this.capPending = request; this.capDisable = null; this.capError = null;
    const plan = this.currentDevkitsPlan();
    if (!plan.blocked.length && !plan.missing.length && !plan.enable.length) this.acceptDevkitsPlan(cx);
    else cx.notify();
  },
  acceptDevkitsPlan(cx) {
    if (!this.capPending || this.capSaving) return;
    try {
      const plan = this.currentDevkitsPlan();
      if (plan.enable.length || plan.missing.length) throw Error('Set up and enable the required connections in MCP Connections first.');
      this.capConfig = applyDevkitsPlan(this.capConfig, this.mcpConfig, plan).config; this.capPending = null;
      this.capDirty = true; this.capSaved = false; cx.notify();
    } catch (error) { this.capError = error.message; cx.notify(); }
  },
  toggleDevkitsResource(kind, item, checked, cx) {
    if (this.capSaving || this.capLoading || this.capChecking || !resourceSupported(item, this.capPlatform)) return;
    if (checked && item.source !== 'mine') this.requestDevkitsSelection({ [kind]: [item.id] }, cx);
    else { this.setEnabled(kind, item, checked); cx.notify(); }
  },
  setDevkitsMcp(row, checked, cx) {
    if (this.capSaving || this.capChecking || row.builtin || row.missing || !sharedMcpSupported(row.name, this.capPlatform)) return;
    const users = mcpUsers(row.name, this.capConfig, this.capCatalog);
    if (!checked && users.length) { this.capDisable = { row, users }; cx.notify(); return; }
    this.mcpConfig = { ...this.mcpConfig, servers: { ...this.mcpConfig.servers, [row.name]: { ...row.server, enabled: checked } } };
    this.mcpDirty = true; this.mcpSaved = false; cx.notify();
  },
  devkitsMcpRows() {
    const servers = this.mcpConfig?.servers || {};
    return [...new Set(['herdr_tasks', ...devkitsMcpPresets.map(item => item.id), ...Object.keys(servers)])].map(name => {
      const builtin = name === 'herdr_tasks', server = builtin ? tasksMcpServer(appHome()) : servers[name];
      return { id: name, name, builtin, server, missing: !server, type: server?.url ? 'url' : 'command', enabled: builtin || server?.enabled !== false };
    });
  },
  devkitsStatus(kind, item) {
    if (!resourceSupported(item, this.capPlatform)) return 'Windows only';
    const problems = item.source === 'mine' ? [] : resourceProblems(item, this.capConfig, this.mcpConfig.servers, this.capPlatform, this.capMissing);
    return this.enabled(kind, item) ? problems.length ? 'On · Unavailable' : 'On' : problems.length ? 'Needs setup' : 'Off';
  },

  devkitsNavigation(t) {
    return v_flex().gap(2).children([{ id: 'overview', label: 'Overview' }, ...providers].map(tab =>
      Button(`devkits-page-${tab.id}`, t, { variant: 'ghost' }).h(30).w_full().justify_start().gap(8).px(8)
        .disabled(Boolean(this.capChecking || this.capSaving || this.capSetup))
        .bg(this.capTab === tab.id ? t.selected : t.popover)
        .on_click((_event, cx) => this.selectDevkitsSection(tab.id, cx))
        .child(tab.id === 'overview' ? glyph('book-open', 16) : AgentIcon({ icon: `icons/${tab.id}.svg` }, t)).child(tab.label)));
  },
  devkitsOverview(t) {
    const root = mineRoot(appHome());
    return v_flex().id('devkits-overview').flex_1().min_h(0).overflow_y_scroll().gap(12)
      .children(providers.map(provider => {
        const items = this.providerItems(provider.id), on = items.filter(({ kind, item }) => this.enabled(kind, item)).length;
        return h_flex().p(12).gap(12).items_center().border(1).border_color(t.border)
          .child(AgentIcon({ icon: `icons/${provider.id}.svg` }, t))
          .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(13).child(provider.label))
            .child(div().text_size(12).text_color(t.muted).child(`${on} of ${items.length} on · ${kinds.map(kind => `${items.filter(entry => entry.kind === kind.id).length} ${kind.label}`).join(' · ')}`)))
          .child(Button(`devkits-open-${provider.id}`, t, { variant: 'secondary' }).h(28).on_click((_event, cx) => this.selectDevkitsSection(provider.id, cx)).child('Browse'));
      }))
      .child(v_flex().p(12).gap(6).border(1).border_color(t.border)
        .child(div().text_size(13).child('Your Rules and Skills'))
        .child(div().text_size(12).text_color(t.muted).child('Add a Markdown file to rules/, or a folder with SKILL.md to skills/. New files are on; reopen this page to list them.'))
        .child(div().text_size(11).text_color(t.dim).child(root)));
  },
  devkitsList(t) {
    const entries = this.providerItems(this.capTab), selected = entries.find(({ item }) => item.id === this.capItem);
    return h_flex().flex_1().min_h(0).items_stretch().gap(12)
      .child(v_flex().id(`devkits-${this.capTab}-list`).w(240).h_full().min_h(0).flex_none().overflow_y_scroll().border(1).border_color(t.border)
        .children(kinds.flatMap(kind => {
          const group = entries.filter(entry => entry.kind === kind.id);
          return group.length ? [div().px(10).pt(10).pb(4).text_size(11).font_medium().text_color(t.dim).child(kind.label.toUpperCase()),
            ...group.map(({ item }) => Button(`devkits-item-${item.id}`, t, { variant: 'ghost' }).w_full().h_auto().min_h(44).px(10).py(6).justify_start()
              .bg(item.id === selected?.item.id ? t.selected : t.popover).on_click((_event, cx) => { this.capItem = item.id; this.capShowSource = false; cx.notify(); })
              .child(v_flex().min_w(0).gap(2).child(h_flex().gap(6).items_center().child(div().text_size(12).child(item.name))
                .when(item.source === 'mine', el => el.child(div().text_size(10).text_color(t.muted).child('Mine'))))
                .child(div().text_size(11).text_color(t.muted).child(this.devkitsStatus(kind.id, item)))))] : [];
        }))
        .when(!entries.length, el => el.child(div().p(10).text_size(12).text_color(t.muted).child('No matching items.'))))
      .child(v_flex().id(`devkits-details-${selected?.item.id || 'empty'}`).flex_1().min_w(0).min_h(0).h_full().overflow_y_scroll().gap(10)
        .when(Boolean(selected), el => el.child(this.devkitsResourceDetails(selected.kind, selected.item, t)))
        .when(!selected, el => el.child(div().text_size(12).text_color(t.muted).child('Select an item to read it and turn it on or off.'))));
  },
  devkitsResourceDetails(kind, selected, t) {
    const supported = resourceSupported(selected, this.capPlatform);
    const problems = selected.source === 'mine' ? [] : resourceProblems(selected, this.capConfig, this.mcpConfig.servers, this.capPlatform, this.capMissing);
    const project = devkitsMcpPresets.find(preset => selected.mcps.includes(preset.id));
    const available = providers.filter(provider => providerSupported(selected, provider.id)).map(provider => provider.label).join(' · ');
    return v_flex().gap(10)
      .child(h_flex().min_h(28).items_center().justify_between().gap(8)
        .child(h_flex().flex_1().min_w(0).flex_wrap().items_center().gap(8)
          .child(div().min_w(0).text_size(16).font_semibold().child(selected.name))
          .when(Boolean(project), el => el.child(Button('devkits-skill-project', t, { variant: 'secondary' }).h(28).gap(6)
            .accessibility_label('Open project on GitHub').on_click((_event, cx) => cx.open_url(project.url.split('#')[0])).child(glyph('github', 14)).child('GitHub'))))
        .child(Switch(`devkits-${kind}-enabled`, supported && this.enabled(kind, selected), t)
          .disabled(!supported || this.capSaving || this.capChecking || this.capMissing.includes(selected.path))
          .accessibility_label(`Use ${selected.name}`).on_change((checked, cx) => this.toggleDevkitsResource(kind, selected, checked, cx))))
      .child(div().text_size(13).child(selected.description || '—'))
      .child(div().text_size(11).text_color(t.muted).child([kind === 'rules' ? 'Rule' : 'Skill', selected.source === 'mine' ? 'Mine' : 'Built-in', available,
        selected.platforms ? 'Windows only' : null, ...selected.mcps.filter(name => name !== 'herdr_tasks').map(name => `Requires MCP: ${name}`)].filter(Boolean).join(' · ')))
      .children(problems.map(problem => div().text_size(12).text_color(t.ansi3).child(problem)))
      .child(div().text_size(11).text_color(t.dim).child(selected.path))
      .child(Button('devkits-read-description', t, { variant: 'secondary' }).h(28).self_start()
        .on_click((_event, cx) => { this.capShowSource = !this.capShowSource; cx.notify(); }).child(this.capShowSource ? 'Hide content' : 'Show content'))
      .when(Boolean(this.capShowSource), el => el.child(v_flex().id(`devkits-${kind}-document`).min_w(0).p(16).border(1).border_color(t.border)
        .child(TextView.markdown(`devkits-${kind}-content-${selected.id}`, stripFrontmatter(this.capSkillText[selected.path] ?? 'Unavailable. Reinstall herdr-zed-agents to restore it.'))
          .text_size(13).line_height('20px').font_family('Geist').selectable(true).scrollable(false))));
  },

  devkitsMcpPage(t) {
    const rows = this.devkitsMcpRows(), row = rows.find(item => item.name === this.capMcpSelected);
    const label = item => !sharedMcpSupported(item.name, this.capPlatform) ? 'Windows only' : item.builtin ? 'Built-in'
      : `${devkitsMcpPresets.some(preset => preset.id === item.name) ? 'Recommended' : 'User added'} · ${item.missing ? 'Setup required' : item.enabled ? 'Enabled' : 'Off'}`;
    return h_flex().flex_1().min_h(0).items_stretch().gap(12)
      .child(v_flex().id('devkits-mcp-list').w(224).h_full().min_h(0).flex_none().overflow_y_scroll().border(1).border_color(t.border)
        .children(rows.map(item => Button(`devkits-mcp-${item.name}`, t, { variant: 'ghost' }).w_full().h_auto().min_h(44).px(10).py(6).justify_start()
          .bg(item.name === row?.name ? t.selected : t.popover).on_click((_event, cx) => { if (!this.capSetup) this.capMcpSelected = item.name; cx.notify(); })
          .child(v_flex().min_w(0).gap(2).child(div().text_size(12).child(item.name)).child(div().text_size(11).text_color(t.muted).child(label(item)))))))
      .child(v_flex().id(`devkits-mcp-details-${row?.name || 'empty'}`).flex_1().min_w(0).min_h(0).h_full().gap(10)
        .when(Boolean(this.capSetup), el => el.child(this.mcpSetupForm(t)))
        .when(!this.capSetup && Boolean(row), el => el.child(this.devkitsMcpDetails(row, t)))
        .when(!this.capSetup && !row, el => el.child(div().text_size(12).text_color(t.muted).child('Select a connection.'))));
  },
  devkitsMcpDetails(row, t) {
    const supported = sharedMcpSupported(row.name, this.capPlatform), users = mcpUsers(row.name, this.capConfig, this.capCatalog);
    const verification = this.capVerified[row.name], verified = row.server && verification?.fingerprint === mcpFingerprint(row.server);
    const busy = Boolean(this.capSaving || this.capChecking);
    const project = devkitsMcpPresets.find(preset => preset.id === row.name);
    const status = verified ? `Verified · ${verification.toolsCount} tools` : row.missing ? 'Not configured' : 'Not verified';
    return v_flex().flex_1().min_h(0).gap(10)
      .child(h_flex().min_h(28).items_center().gap(8)
        .child(div().min_w(0).text_size(16).font_semibold().child(row.name))
        .child(div().text_size(11).text_color(t.muted).child(status))
        .child(div().flex_1())
        .when(Boolean(project), el => el.child(Button('devkits-mcp-project', t, { variant: 'secondary' }).h(28).gap(6)
          .accessibility_label('Open project on GitHub').on_click((_event, cx) => cx.open_url(project.url.split('#')[0])).child(glyph('github', 14)).child('GitHub')))
        .when(!row.builtin, el => el.child(Button('devkits-mcp-setup', t, { variant: 'secondary' }).h(28).disabled(busy || !supported)
          .on_click((_event, cx) => this.openMcpSetup(row.name, cx)).child(row.missing ? 'Setup' : 'Configure')))
        .child(Button('devkits-mcp-verify', t, { variant: 'secondary' }).h(28).disabled(busy || !supported || row.missing)
          .on_click((_event, cx) => this.verifyDevkitsMcp(row, cx)).child(this.capChecking ? 'Testing…' : 'Verify')))
      .child(div().text_size(12).text_color(t.muted).child(row.builtin
        ? 'Built-in. Herdr adds it to every new local Claude Code and Codex session; nothing to configure.'
        : users.length ? `Used by: ${users.join(', ')}` : 'No selected Capability uses this connection.'))
      .when(!supported, el => el.child(div().text_size(12).text_color(t.muted).child('Windows only. Setup and verification are unavailable on this platform.')))
      .when(!row.builtin, el => el.child(v_flex().flex_1().min_h(0).overflow_y_scroll()
        .child(this.mcpDetails(row, t, { disabled: busy || !supported, onToggle: (item, checked, cx) => this.setDevkitsMcp(item, checked, cx) }))));
  },
  devkitsPage(t) {
    const busy = Boolean(this.capLoading || this.capSaving || this.capChecking), mcp = this.settingsPage === 'mcp';
    const dirty = mcp ? this.mcpDirty : this.capDirty, saved = mcp ? this.mcpSaved : this.capSaved;
    const provider = providers.find(item => item.id === this.capTab);
    return v_flex().id('devkits-capabilities').h_full().flex_1().min_h(0).gap(10)
      .child(DialogDescription(t).flex_none().child(mcp
        ? 'Shared connections for new local Codex sessions. Claude Code uses the connections in its own account.'
        : 'Choose Rules and Skills for new local sessions, per provider.'))
      .when(Boolean(provider) && Boolean(this.capConfig), el => el.child(h_flex().flex_none().gap(8).items_center()
        .child(Input.new(this.capSearch, t).h(30).px(8).text_size(12).flex_1().min_w(0).border(1).border_color(t.input).disabled(busy).accessibility_label('Search Capabilities'))
        .child(Button('devkits-group-enable', t, { variant: 'secondary' }).h(30).disabled(busy).on_click((_event, cx) => this.changeDevkitsGroup(true, cx)).child('All on'))
        .child(Button('devkits-group-disable', t, { variant: 'secondary' }).h(30).disabled(busy).on_click((_event, cx) => this.changeDevkitsGroup(false, cx)).child('All off'))))
      .when(this.capLoading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading…')))
      .when(Boolean(this.capConfig) && !this.capLoading, el => el
        .when(mcp, body => body.child(this.devkitsMcpPage(t)))
        .when(!mcp && this.capTab === 'overview', body => body.child(this.devkitsOverview(t)))
        .when(!mcp && Boolean(provider), body => body.child(this.devkitsList(t))))
      .when(!mcp && Boolean(this.capPending) && !this.capSetup, el => el.child(this.devkitsSelectionPrompt(t)))
      .when(mcp && Boolean(this.capDisable), el => el.child(v_flex().id('devkits-disable-prompt').flex_none().gap(6).p(10).border(1).border_color(t.border)
        .child(div().text_size(12).child(`Turning off ${this.capDisable.row.name} makes these Capabilities unavailable: ${this.capDisable.users.join(', ')}. Their selections are kept.`))
        .child(h_flex().gap(8)
          .child(Button('devkits-disable-cancel', t, { variant: 'secondary' }).h(30).on_click((_event, cx) => { this.capDisable = null; cx.notify(); }).child('Cancel'))
          .child(Button('devkits-disable-confirm', t).h(30).on_click((_event, cx) => {
            const name = this.capDisable.row.name; this.capDisable = null;
            this.mcpConfig.servers[name] = { ...this.mcpConfig.servers[name], enabled: false }; this.mcpDirty = true; this.mcpSaved = false; cx.notify();
          }).child('Turn off connection')))))
      .when(Boolean(this.capError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.capError)))
      .child(DialogFooter().flex_none()
        .child(div().flex_1().text_size(12).text_color(t.muted).child(saved ? 'Saved. Applies to new sessions.' : this.capSaving ? 'Saving…' : dirty ? 'Unsaved changes.' : ''))
        .child(Button('devkits-discard', t, { variant: 'secondary' }).disabled(busy || !dirty).on_click((_event, cx) => this.discardDevkits(mcp ? 'mcp' : 'capabilities', cx)).child('Discard changes'))
        .child(Button('devkits-save', t).disabled(busy || !dirty || Boolean(this.capSetup) || Boolean(this.capPending) || Boolean(this.capDisable))
          .on_click((_event, cx) => this.saveDevkits(mcp ? 'mcp' : 'capabilities', cx)).child(this.capSaving ? 'Saving…' : 'Save changes')));
  },
  devkitsSelectionPrompt(t) {
    const plan = this.currentDevkitsPlan();
    const names = [...plan.addedRules.map(id => this.capCatalog.rules.find(item => item.id === id).name), ...plan.addedSkills.map(id => this.capCatalog.skills.find(item => item.id === id).name)];
    return v_flex().id('devkits-selection-prompt').flex_none().gap(6).p(10).border(1).border_color(t.border)
      .child(div().text_size(12).child(`Turn on: ${names.join(', ') || 'already on'}`))
      .when(plan.enable.length > 0, el => el.child(div().text_size(12).text_color(t.muted).child(`Enable in MCP Connections first: ${plan.enable.join(', ')}`)))
      .children(plan.blocked.map(problem => div().text_size(12).text_color(t.ansi1).child(problem)))
      .children(plan.missing.map(name => div().text_size(12).text_color(t.muted).child(`Set up in MCP Connections first: ${name}`)))
      .child(h_flex().gap(8)
        .child(Button('devkits-plan-cancel', t, { variant: 'secondary' }).h(30).disabled(this.capChecking).on_click((_event, cx) => { this.capPending = null; cx.notify(); }).child('Cancel'))
        .child(Button('devkits-plan-accept', t).h(30).disabled(this.capChecking || plan.blocked.length > 0 || plan.missing.length > 0 || plan.enable.length > 0)
          .on_click((_event, cx) => this.acceptDevkitsPlan(cx)).child('Turn on')));
  },
};
