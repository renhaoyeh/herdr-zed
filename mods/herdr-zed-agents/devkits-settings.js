import { div } from 'gpui-kit';
import { h_flex, v_flex, TextView, InputState } from 'gpui-base';
import { appHome, readTextFile, exec } from 'herdr';
import { devkitsPath, readDevkitsSkills } from './devkits.js';
import { parseDevkits, devkitsCatalog, devkitsGroups, devkitsMcpPresets, resourceSupported, resourceProblems, devkitsPlan, applyDevkitsPlan, mcpUsers } from './devkits-model.js';
import { parseSharedMcp, sharedMcpSupported } from './components/shared-mcp-model.js';
import { sharedMcpPath } from './components/shared-mcp.js';
import { tasksMcpServer } from './components/session-model.js';
import { mcpFingerprint } from './mcp-setup-settings.js';
import { Button } from './components/button.js';
import { Input } from './components/input.js';
import { Switch } from './components/switch.js';
import { glyph } from './components/icon.js';
import { DialogDescription, DialogFooter } from './components/dialog.js';

export const devkitsSettings = {
  initDevkits(cx) {
    if (this.capCatalog) return;
    this.capClosed = false; this.capTab = 'overview'; this.capPlatform = null;
    this.capCatalog = devkitsCatalog(appHome()); this.capSelected = { rules: null, skills: null };
    this.capSearch = InputState.new({ placeholder: 'Search names, descriptions or sources…' });
    this.capSearch.on('change', (_event, cx) => { this.capShowSource = false; cx.notify(); });
    this.capShowSource = false;
    this.capMcpSelected = 'herdr_tasks'; this.capVerified = {};
    this.loadDevkits(cx);
  },
  selectDevkitsSection(kind, cx) {
    if (this.capChecking || this.capSaving || this.capSetup) return;
    this.capTab = kind; this.capLastTab = kind; this.capSearch.set_value(''); this.capShowSource = false;
    if (kind === 'mcp') this.capMcpSelected = null; else this.capSelected[kind] = null;
    cx.notify();
  },
  devkitsSearchItems(items) {
    const query = this.capSearch.value().trim().toLowerCase();
    return items.filter(item => !query || [item.name, item.description, item.path].filter(Boolean).join(' ').toLowerCase().includes(query));
  },
  changeDevkitsGroup(kind, checked, cx) {
    if (this.capSaving || this.capLoading || this.capChecking || this.capSetup || this.capPending) return;
    const items = this.devkitsSearchItems(this.capCatalog[kind]).filter(item => resourceSupported(item, this.capPlatform) && (!checked || !this.capMissing.includes(item.path)));
    if (!items.length) return;
    if (checked) this.requestDevkitsSelection({ [kind]: items.map(item => item.id) }, cx);
    else {
      for (const item of items) this.capConfig[kind][item.id] = false;
      this.capDirty = true; this.capSaved = false; cx.notify();
    }
  },
  devkitsSearchBar(kind, t) {
    const busy = Boolean(this.capSaving || this.capLoading || this.capChecking || this.capSetup || this.capPending), query = this.capSearch.value().trim();
    return h_flex().gap(8).items_center()
      .child(Input.new(this.capSearch, t).h(30).px(8).text_size(12).flex_1().min_w(0).border(1).border_color(t.input).disabled(busy).accessibility_label('Search Devkits components'))
      .when(kind !== 'mcp', el => el
        .child(Button('devkits-group-enable', t, { variant: 'secondary' }).h(30).disabled(busy)
          .on_click((_event, cx) => this.changeDevkitsGroup(kind, true, cx)).child(query ? 'Use search results' : 'Use all'))
        .child(Button('devkits-group-disable', t, { variant: 'secondary' }).h(30).disabled(busy)
          .on_click((_event, cx) => this.changeDevkitsGroup(kind, false, cx)).child(query ? 'Turn off search results' : 'Turn off all')));
  },
  loadDevkits(cx) {
    if (this.capSaving || this.capLoading || this.capChecking) return;
    this.capLoading = true; this.capError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const catalog = devkitsCatalog(appHome());
        const [text, mcp, info, skills] = await Promise.all([readTextFile(devkitsPath()), readTextFile(sharedMcpPath()),
          exec('node', [`${appHome()}/mods/herdr-zed-agents/mcp-probe.js`, 'info'], { timeout: 10000 }), readDevkitsSkills([...catalog.rules, ...catalog.skills])]);
        if (info.code !== 0) throw Error('Could not identify the local platform. Check Node.js.');
        const platformInfo = JSON.parse(info.stdout || '{}');
        if (!['windows', 'macos', 'linux'].includes(platformInfo.platform)) throw Error('Local platform information is unavailable.');
        const config = parseDevkits(text), mcpConfig = parseSharedMcp(mcp);
        if (this.capClosed) return;
        this.capOriginal = text; this.capConfig = config; this.mcpOriginal = mcp; this.mcpConfig = mcpConfig;
        this.capPlatform = platformInfo.platform; this.capInfo = platformInfo;
        for (const kind of ['rules', 'skills']) catalog[kind] = skills.filter(item => item.group === kind).map(({ text, ...item }) => item); this.capCatalog = catalog;
        this.capSkillText = Object.fromEntries(skills.map(skill => [skill.path, skill.text]));
        this.capMissing = skills.filter(skill => skill.text == null).map(skill => skill.path);
        this.capPending = null; this.capDisable = null; this.capSetup = null; this.capShowSource = false; this.capDirty = false; this.capSaved = false;
      } catch (error) { if (!this.capClosed) this.capError = error.message; }
      finally { this.capLoading = false; if (!this.capClosed) cx.notify(); }
    });
  },
  saveDevkits(cx) {
    if (this.capSaving || this.capLoading || this.capChecking || this.capSetup || this.capPending || this.capDisable || !this.capConfig || !this.capDirty) return;
    let text, mcp;
    try {
      text = JSON.stringify(parseDevkits(this.capOriginal)) === JSON.stringify(this.capConfig) ? this.capOriginal : `${JSON.stringify(this.capConfig, null, 2)}\n`;
      mcp = JSON.stringify(parseSharedMcp(this.mcpOriginal)) === JSON.stringify(this.mcpConfig) ? this.mcpOriginal : `${JSON.stringify(this.mcpConfig, null, 2)}\n`;
      parseDevkits(text); parseSharedMcp(mcp);
    } catch (error) { this.capError = error.message; cx.notify(); return; }
    this.capSaving = true; this.capError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const payload = { capabilities: { expected: this.capOriginal, text }, mcp: { expected: this.mcpOriginal, text: mcp } };
        const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/devkits-save.js`, appHome(), JSON.stringify(payload)], { timeout: 15000 });
        if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not save selections and connections. The draft is retained.');
        if (JSON.parse(result.stdout || '{}').saved !== true) throw Error('Save returned no confirmation. Reload before retrying.');
        if (this.capClosed) return;
        this.capOriginal = text; this.mcpOriginal = mcp; this.capDirty = false; this.capSaved = true;
      } catch (error) { if (!this.capClosed) this.capError = error.message; }
      finally { this.capSaving = false; if (!this.capClosed) cx.notify(); }
    });
  },
  currentDevkitsPlan() { return devkitsPlan(this.capConfig, this.capCatalog, this.capPending, this.mcpConfig.servers, this.capPlatform, this.capMissing); },
  requestDevkitsSelection(request, cx) {
    if (this.capSaving || this.capLoading || this.capChecking || !this.capConfig) return;
    this.capPending = request; this.capDisable = null; this.capError = null;
    const plan = this.currentDevkitsPlan();
    if (!plan.blocked.length && !plan.missing.length && !plan.enable.length)
      this.acceptDevkitsPlan(cx);
    else cx.notify();
  },
  acceptDevkitsPlan(cx) {
    if (!this.capPending || this.capSaving) return;
    try {
      const plan = this.currentDevkitsPlan();
      if (plan.enable.length || plan.missing.length) throw Error('Set up and enable the required connections in MCP Connections first.');
      const result = applyDevkitsPlan(this.capConfig, this.mcpConfig, this.currentDevkitsPlan());
      this.capConfig = result.config; this.mcpConfig = result.mcp; this.capPending = null;
      this.capDirty = true; this.capSaved = false; cx.notify();
    } catch (error) { this.capError = error.message; cx.notify(); }
  },
  toggleDevkitsResource(kind, item, checked, cx) {
    if (this.capSaving || this.capLoading || this.capChecking || !resourceSupported(item, this.capPlatform)) return;
    if (checked) this.requestDevkitsSelection({ [kind]: [item.id] }, cx);
    else { this.capConfig[kind][item.id] = false; this.capDirty = true; this.capSaved = false; cx.notify(); }
  },
  setDevkitsMcp(row, checked, cx) {
    if (this.capSaving || this.capChecking || row.builtin || row.missing || !sharedMcpSupported(row.name, this.capPlatform)) return;
    const users = mcpUsers(row.name, this.capConfig, this.capCatalog);
    if (!checked && users.length) { this.capDisable = { row, users }; this.capPending = null; cx.notify(); return; }
    this.mcpConfig = { ...this.mcpConfig, servers: { ...this.mcpConfig.servers, [row.name]: { ...row.server, enabled: checked } } };
    this.capDirty = true; this.capSaved = false; cx.notify();
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
    const problems = resourceProblems(item, this.capConfig, this.mcpConfig.servers, this.capPlatform, this.capMissing);
    return this.capConfig[kind][item.id] ? problems.length ? 'Selected · Unavailable' : 'Selected' : problems.length ? 'Needs setup' : 'Off';
  },
  devkitsDependencies(item, t) {
    return h_flex().flex_wrap().gap(6)
      .children(item.mcps.map(name => div().text_size(12).text_color(t.muted).child(`Requires MCP: ${name}`)));
  },
  devkitsResources(kind, t) {
    const items = this.devkitsSearchItems(this.capCatalog[kind]), selected = items.find(item => item.id === this.capSelected[kind]);
    return h_flex().flex_1().min_h(0).items_stretch().gap(12)
      .child(v_flex().id(`devkits-${kind}-list`).w(224).h_full().min_h(0).flex_none().overflow_y_scroll().border(1).border_color(t.border)
        .children(items.map(item => Button(`devkits-${kind}-${item.id}`, t, { variant: 'ghost' }).w_full().h_auto().min_h(48).px(10).py(8).justify_start()
          .bg(item.id === selected?.id ? t.selected : t.popover).on_click((_event, cx) => { this.capSelected[kind] = item.id; this.capShowSource = false; cx.notify(); })
          .child(v_flex().min_w(0).gap(3).child(div().text_size(12).child(item.name))
            .child(div().text_size(11).text_color(t.muted).child(this.devkitsStatus(kind, item)))))))
      .child(v_flex().id(`devkits-${kind}-details-${selected?.id || 'empty'}`).flex_1().min_w(0).min_h(0).h_full().overflow_y_scroll().gap(10)
        .when(Boolean(selected), el => el.child(this.devkitsResourceDetails(kind, selected, t)))
        .when(!selected, el => el.child(div().text_size(12).text_color(t.muted).child(items.length ? 'Select a component to read its purpose and change its selection.' : 'No matching components.'))));
  },
  devkitsResourceDetails(kind, selected, t) {
    const supported = resourceSupported(selected, this.capPlatform), problems = resourceProblems(selected, this.capConfig, this.mcpConfig.servers, this.capPlatform, this.capMissing);
    const project = devkitsMcpPresets.find(preset => selected.mcps.includes(preset.id));
    return v_flex().gap(10)
      .child(h_flex().min_h(28).items_center().justify_between().gap(8)
        .child(h_flex().flex_1().min_w(0).flex_wrap().items_center().gap(8)
          .child(div().min_w(0).text_size(16).font_semibold().child(selected.name))
          .when(selected.mcps.length > 0, el => el.child(this.devkitsDependencies(selected, t)))
          .when(Boolean(project), el => el.child(Button('devkits-skill-project', t, { variant: 'secondary' }).h(28).gap(6)
            .accessibility_label('Open project on GitHub').on_click((_event, cx) => cx.open_url(project.url.split('#')[0])).child(glyph('github', 14)).child('GitHub'))))
        .child(Switch(`devkits-${kind}-enabled`, supported && this.capConfig[kind][selected.id] === true, t)
          .disabled(!supported || this.capSaving || this.capChecking || this.capMissing.includes(selected.path))
          .accessibility_label(`Use ${selected.name}`).on_change((checked, cx) => this.toggleDevkitsResource(kind, selected, checked, cx))))
      .child(div().text_size(12).text_color(t.muted).child(devkitsGroups.find(group => group.id === kind).description))
      .child(div().text_size(13).child(selected.description))
      .child(div().text_size(11).text_color(t.muted).child(`Available in: Claude Code · Codex${selected.platforms ? ' · Windows only' : ''}`))
      .children(problems.map(problem => div().text_size(12).text_color(t.ansi3).child(problem)))
      .child(div().text_size(11).text_color(t.dim).child(selected.path))
      .child(Button('devkits-read-description', t, { variant: 'secondary' }).h(28)
        .on_click((_event, cx) => { this.capShowSource = !this.capShowSource; cx.notify(); }).child(this.capShowSource ? 'Hide source description' : 'Read full description'))
      .when(Boolean(this.capShowSource), el => el.child(v_flex().id(`devkits-${kind}-document`).min_w(0).gap(12).p(16).border(1).border_color(t.border)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child('DOCUMENT CONTENT'))
        .child(TextView.markdown(`devkits-${kind}-content-${selected.id}`,
          (this.capSkillText[selected.path] ?? 'Resource unavailable. Reinstall Devkits to restore it.').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, ''))
          .text_size(13).line_height('20px').font_family('Geist').selectable(true).scrollable(false))));
  },

  devkitsMcpPage(t) {
    const rows = this.devkitsMcpRows(), row = rows.find(item => item.name === this.capMcpSelected);
    return h_flex().flex_1().min_h(0).items_stretch().gap(12)
      .child(v_flex().id('devkits-mcp-list').w(224).h_full().min_h(0).flex_none().overflow_y_scroll().border(1).border_color(t.border)
        .children(rows.map(item => Button(`devkits-mcp-${item.name}`, t, { variant: 'ghost' }).w_full().h_auto().min_h(48).px(10).py(8).justify_start()
          .bg(item.name === row?.name ? t.selected : t.popover).on_click((_event, cx) => { if (!this.capSetup) this.capMcpSelected = item.name; cx.notify(); })
          .child(v_flex().min_w(0).gap(3).child(div().text_size(12).child(item.name))
            .child(div().text_size(11).text_color(t.muted).child(`${item.builtin ? 'Built-in' : devkitsMcpPresets.some(preset => preset.id === item.name) ? 'Recommended' : 'User added'} · ${!sharedMcpSupported(item.name, this.capPlatform) ? 'Windows only' : item.builtin ? 'Built-in' : item.missing ? 'Setup required' : item.enabled ? 'Enabled' : 'Off'}`))))))
      .child(v_flex().id(`devkits-mcp-details-${row?.name || 'empty'}`).flex_1().min_w(0).min_h(0).h_full().gap(10)
        .when(Boolean(this.capSetup), el => el.child(this.mcpSetupForm(t)))
        .when(!this.capSetup && Boolean(row), el => el.child(this.devkitsMcpDetails(row, t)))
        .when(!this.capSetup && !row, el => el.child(div().text_size(12).text_color(t.muted).child(rows.length ? 'Select a component to read its purpose and change its selection.' : 'No matching components.'))));
  },
  devkitsMcpDetails(row, t) {
    const supported = sharedMcpSupported(row.name, this.capPlatform), users = mcpUsers(row.name, this.capConfig, this.capCatalog);
    const verification = this.capVerified[row.name], verified = row.server && verification?.fingerprint === mcpFingerprint(row.server);
    const busy = Boolean(this.capSaving || this.capChecking);
    const project = devkitsMcpPresets.find(preset => preset.id === row.name);
    return v_flex().flex_1().min_h(0).gap(10)
      .child(h_flex().min_h(28).items_center().gap(8)
        .child(div().min_w(0).text_size(16).font_semibold().child(row.name))
        .when(Boolean(project), el => el.child(Button('devkits-mcp-project', t, { variant: 'secondary' }).h(28).gap(6)
          .accessibility_label('Open project on GitHub').on_click((_event, cx) => cx.open_url(project.url.split('#')[0])).child(glyph('github', 14)).child('GitHub'))))
      .child(h_flex().gap(8)
        .when(!row.builtin, el => el.child(Button('devkits-mcp-setup', t, { variant: 'secondary' }).h(30).disabled(busy || !supported)
          .on_click((_event, cx) => this.openMcpSetup(row.name, cx)).child(row.missing ? 'Setup' : 'Configure')))
        .child(Button('devkits-mcp-verify', t, { variant: 'secondary' }).h(30).disabled(busy || !supported || row.missing)
          .on_click((_event, cx) => this.verifyDevkitsMcp(row, cx)).child(this.capChecking ? 'Testing…' : 'Verify connection')))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll().gap(10)
      .child(div().text_size(12).text_color(t.muted).child(devkitsGroups.find(group => group.id === 'mcp').description))
      .when(!supported, el => el.child(div().text_size(12).text_color(t.muted).child('Windows only. Setup, verification and selection are unavailable on this platform.')))
      .child(div().text_size(12).text_color(t.muted).child(users.length ? `Used by selected resources: ${users.join(', ')}` : 'No selected Rule or Skill uses this connection.'))
      .child(this.mcpDetails(row, t, { disabled: busy || !supported, onToggle: (item, checked, cx) => this.setDevkitsMcp(item, checked, cx) }))
      .child(div().text_size(12).text_color(t.muted).child(verified ? `Connection verified · ${verification.toolsCount} tools discovered` : row.missing ? 'Connection not configured.' : 'Configured · Connection not verified')));
  },
  devkitsNavigation(t) {
    return v_flex().gap(2).children([{ id: 'overview', label: 'Overview', icon: 'book-open' }, { id: 'components', label: 'Components', icon: 'settings' }].map(tab =>
      Button(`devkits-page-${tab.id}`, t, { variant: 'ghost' }).h(30).w_full().justify_start().gap(8).px(8)
        .disabled(this.capChecking || this.capSaving || Boolean(this.capSetup))
        .bg((this.capTab === 'overview' ? 'overview' : 'components') === tab.id ? t.selected : t.popover)
        .on_click((_event, cx) => { if (tab.id === 'overview') { this.capTab = 'overview'; cx.notify(); } else this.selectDevkitsSection(this.capLastTab || 'rules', cx); })
        .child(glyph(tab.icon, 16)).child(tab.label)));
  },
  devkitsOverview(t) {
    return v_flex().id('devkits-overview').flex_1().min_h(0).overflow_y_scroll().gap(12)
      .child(v_flex().p(12).gap(6).border(1).border_color(t.border)
        .child(div().text_size(14).child('Understand what each part of Devkits does'))
        .child(div().text_size(12).text_color(t.muted).child('Built-in Rules guide conversations. Built-in Skills supply methods. Manage tool connections in MCP Connections.'))
        .child(div().text_size(12).text_color(t.muted).child('Browse components, choose selections and save to apply them to new local sessions.')))
      .children(devkitsGroups.filter(group => group.id !== 'mcp').map(group => {
        const count = group.id === 'mcp' ? this.devkitsMcpRows().length : this.capCatalog[group.id].length;
        return v_flex().gap(6).p(12).border(1).border_color(t.border)
          .child(h_flex().items_center().justify_between().gap(8)
            .child(div().text_size(13).child(`${group.label} · ${count}`))
            .child(Button(`devkits-open-${group.id}`, t, { variant: 'secondary' }).h(28)
              .on_click((_event, cx) => this.selectDevkitsSection(group.id, cx)).child('Browse components')))
          .child(div().text_size(12).text_color(t.muted).child(group.description))
          .child(div().text_size(11).text_color(t.dim).child(group.id === 'mcp' ? 'Shared connections · Local Codex setup' : 'Claude Code · Codex'));
      }))
      .child(div().text_size(12).text_color(t.muted).child('Managed by Devkits. Browsing descriptions does not run their code.'));
  },
  devkitsSelectionPrompt(t) {
    const plan = this.currentDevkitsPlan();
    const names = [...plan.addedSkills.map(id => this.capCatalog.skills.find(item => item.id === id).name), ...plan.addedRules.map(id => this.capCatalog.rules.find(item => item.id === id).name)];
    return v_flex().id('devkits-selection-prompt').flex_none().gap(6).p(10).border(1).border_color(t.border)
      .child(div().text_size(12).child(`Select together: ${names.join(', ') || 'Resources already selected'}`))
      .when(plan.enable.length > 0, el => el.child(div().text_size(12).text_color(t.muted).child(`Enable in MCP Connections first: ${plan.enable.join(', ')}`)))
      .children(plan.blocked.map(problem => div().text_size(12).text_color(t.ansi1).child(problem)))
      .children(plan.missing.map(name => h_flex().gap(8).items_center().child(div().text_size(12).text_color(t.muted).child(`Setup required in MCP Connections: ${name}`))))
      .child(h_flex().gap(8)
        .child(Button('devkits-plan-cancel', t, { variant: 'secondary' }).h(30).disabled(this.capChecking).on_click((_event, cx) => { this.capPending = null; cx.notify(); }).child('Cancel'))
        .child(Button('devkits-plan-accept', t).h(30).disabled(this.capChecking || plan.blocked.length > 0 || plan.missing.length > 0 || plan.enable.length > 0)
          .on_click((_event, cx) => this.acceptDevkitsPlan(cx)).child('Select resources')));
  },
  devkitsPage(t) {
    const busy = Boolean(this.capLoading || this.capSaving || this.capChecking), mcp = this.settingsPage === 'mcp';
    return v_flex().id('devkits-capabilities').h_full().flex_1().min_h(0).gap(10)
      .child(DialogDescription(t).flex_none().child(mcp ? 'Manage shared MCP connections for new local Codex sessions. Configure, verify and enable existing connections, then save. Claude uses its account connections.' : 'Choose built-in Rules and Skills for new local agent sessions. Save to apply. Custom global instructions belong in Global Rules; tool connections belong in MCP Connections.'))
      .when(this.capTab !== 'overview' && Boolean(this.capConfig), el => el
        .child(div().text_size(12).text_color(t.muted).child(this.capTab === 'mcp'
          ? `Shared MCP connections · ${this.devkitsMcpRows().length} connections`
          : `Devkits global components · selected ${this.capCatalog[this.capTab].filter(item => this.capConfig[this.capTab][item.id]).length} / ${this.capCatalog[this.capTab].length}`))
        .when(!mcp, el => el.child(h_flex().flex_none().flex_wrap().gap(4).children([{ id: 'rules', label: 'Rules', icon: 'settings' }, { id: 'skills', label: 'Skills', icon: 'book-open' }].map(tab =>
          Button(`devkits-tab-${tab.id}`, t, { variant: 'ghost' }).h(30).gap(6).disabled(this.capChecking || this.capSaving || Boolean(this.capSetup))
            .bg(this.capTab === tab.id ? t.selected : t.popover).accessibility_label(tab.label)
            .on_click((_event, cx) => this.selectDevkitsSection(tab.id, cx)).child(glyph(tab.icon)).child(tab.label)))))
        .when(!mcp, el => el.child(this.devkitsSearchBar(this.capTab, t))))
      .when(this.capLoading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading capabilities and platform…')))
      .when(Boolean(this.capConfig) && !this.capLoading, el => el
        .when(this.capTab === 'overview', body => body.child(this.devkitsOverview(t)))
        .when(this.capTab === 'skills', body => body.child(this.devkitsResources('skills', t)))
        .when(this.capTab === 'mcp', body => body.child(this.devkitsMcpPage(t)))
        .when(this.capTab === 'rules', body => body.child(this.devkitsResources('rules', t))))
      .when(Boolean(this.capPending) && !this.capSetup, el => el.child(this.devkitsSelectionPrompt(t)))
      .when(Boolean(this.capDisable), el => el.child(v_flex().id('devkits-disable-prompt').flex_none().gap(6).p(10).border(1).border_color(t.border)
        .child(div().text_size(12).child(`Turning off ${this.capDisable.row.name} makes these selections unavailable: ${this.capDisable.users.join(', ')}. Their selections are retained.`))
        .child(h_flex().gap(8)
          .child(Button('devkits-disable-cancel', t, { variant: 'secondary' }).h(30).on_click((_event, cx) => { this.capDisable = null; cx.notify(); }).child('Cancel'))
          .child(Button('devkits-disable-confirm', t).h(30).on_click((_event, cx) => {
            const name = this.capDisable.row.name; this.capDisable = null;
            this.mcpConfig.servers[name] = { ...this.mcpConfig.servers[name], enabled: false }; this.capDirty = true; this.capSaved = false; cx.notify();
          }).child('Turn off connection')))))
      .when(Boolean(this.capError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.capError)))
      .child(DialogFooter().flex_none()
        .child(div().flex_1().text_size(12).text_color(t.muted).child(this.capSaved ? 'Saved. Applies to new local Claude and Codex sessions.' : this.capSaving ? 'Saving selections and connections…' : 'Selection switches change the draft. Save to apply.'))
        .child(Button('devkits-discard', t, { variant: 'secondary' }).disabled(busy).on_click((_event, cx) => this.loadDevkits(cx)).child('Discard changes'))
        .child(Button('devkits-save', t).disabled(busy || !this.capDirty || Boolean(this.capSetup) || Boolean(this.capPending) || Boolean(this.capDisable))
          .on_click((_event, cx) => this.saveDevkits(cx)).child(this.capSaving ? 'Saving…' : 'Save changes')));
  },
};
