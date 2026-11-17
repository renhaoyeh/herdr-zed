import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState } from 'gpui-base';
import { appHome, home, exec, props, spaces, pickFolder, run } from 'herdr';
import { sessionKind, launcherLabel } from './components/session-model.js';
import { eccAccount } from './ecc-model.js';
import { Select, SelectState } from './components/select.js';
import { Button } from './components/button.js';
import { Input } from './components/input.js';
import { Switch } from './components/switch.js';
import { DialogDescription, ApplyFooter } from './components/dialog.js';

export const skillSettings = {
  initSkills(cx) {
    this.skillsProvider = 'claude'; this.skillsScope = 'global'; this.skillsAccounts = [];
    this.skillsAccountSelect = new SelectState(cx);
    this.skillsSearch = InputState.new({ placeholder: 'Search skills and sources…' });
    this.skillsSearch.on('change', (_event, cx) => cx.notify());
    this.skillsClosed = false; this.skillsDirty = false; this.skillsInventory = null;
    this.skillsProject = props()?.context?.folder || props()?.folder || spaces().find(item => item.id === props()?.space)?.folder || null;
    cx.spawn(async cx => {
      try {
        const accounts = await this.cachedAgents(null);
        if (this.skillsClosed) return;
        this.skillsAccounts = accounts.filter(agent => ['claude', 'codex'].includes(sessionKind(agent)) && !agent.profileKey);
        if (!this.skillsAccounts.some(agent => sessionKind(agent) === this.skillsProvider)) this.skillsProvider = this.skillsAccounts[0] && sessionKind(this.skillsAccounts[0]) || 'claude';
        this.loadSkills(cx);
      } catch (error) { this.skillsError = error.message; cx.notify(); }
    });
  },
  async skillsCall(action, values = {}) {
    const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/native-skills-cli.js`, action, appHome(), JSON.stringify(values)], { timeout: 60000 });
    if (result.code !== 0) throw Error(result.stderr?.trim() || 'Could not read skills.');
    return JSON.parse(result.stdout || '{}');
  },
  skillsContext() {
    const accounts = this.skillsAccounts.filter(agent => sessionKind(agent) === this.skillsProvider);
    const agent = accounts.find(item => item.key === this.skillsAccount) || accounts[0];
    return { provider: this.skillsProvider, userHome: home(), directory: eccAccount(this.skillsProvider, agent?.run || [], home()).directory,
      folder: this.skillsScope === 'project' ? this.skillsProject : '', agent, accounts };
  },
  loadSkills(cx) {
    if (this.skillsSaving || this.skillsDirty) return;
    const context = this.skillsContext(), request = this.skillsRequest = (this.skillsRequest || 0) + 1;
    this.skillsLoading = true; this.skillsError = null; this.skillsSelected = null; this.skillsInventory = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const { provider, userHome, directory, folder } = context;
        const result = await this.skillsCall('inventory', { provider, userHome, directory, folder });
        if (this.skillsClosed || request !== this.skillsRequest) return;
        this.skillsInventory = result; this.skillsDisabled = [...result.disabled]; this.skillsSaved = false;
      } catch (error) { if (!this.skillsClosed && request === this.skillsRequest) this.skillsError = error.message; }
      finally { if (!this.skillsClosed && request === this.skillsRequest) { this.skillsLoading = false; cx.notify(); } }
    });
  },
  setProjectSkill(item, on, cx) {
    if (this.skillsScope !== 'project' || item.managed || !item.enabled || item.canExclude === false || this.skillsSaving) return;
    const next = new Set(this.skillsDisabled);
    if (on) next.delete(item.key); else next.add(item.key);
    this.skillsDisabled = [...next].sort();
    this.skillsDirty = JSON.stringify(this.skillsDisabled) !== JSON.stringify([...this.skillsInventory.disabled].sort());
    this.skillsSaved = false; cx.notify();
  },
  saveSkills(cx) {
    if (!this.skillsDirty || this.skillsSaving || this.skillsLoading) return;
    const context = this.skillsContext(), disabled = [...this.skillsDisabled], revision = this.skillsInventory.revision;
    this.skillsSaving = true; this.skillsError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const policy = await this.skillsCall('save', { provider: context.provider, folder: context.folder, disabled, revision });
        if (this.skillsClosed) return;
        this.skillsInventory.revision = policy.revision; this.skillsInventory.disabled = disabled;
        this.skillsDirty = false; this.skillsSaved = true;
      } catch (error) { if (!this.skillsClosed) this.skillsError = error.message; }
      finally { this.skillsSaving = false; if (!this.skillsClosed) cx.notify(); }
    });
  },
  chooseSkillSource(cx) {
    if (this.skillsSaving || this.skillsDirty || this.skillsLoading) return;
    this.skillsSaving = true; this.skillsError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const source = await pickFolder({ prompt: 'Find skills' });
        if (!source || this.skillsClosed) return;
        this.skillsCandidates = (await this.skillsCall('scan', { source })).items;
        if (!this.skillsCandidates.length) throw Error('No skills found. Choose a skill, repository or installed runtime folder.');
      } catch (error) { if (!this.skillsClosed) this.skillsError = error.message; }
      finally { this.skillsSaving = false; if (!this.skillsClosed) cx.notify(); }
    });
  },
  installSelectedSkill(item, cx) {
    if (this.skillsSaving || this.skillsDirty) return;
    const provider = this.skillsProvider;
    this.skillsSaving = true; this.skillsError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await this.skillsCall('install', { userHome: home(), provider, source: item.source });
        if (this.skillsClosed) return;
        this.skillsCandidates = this.skillsCandidates.filter(candidate => candidate.source !== item.source);
        if (!this.skillsCandidates.length) this.skillsCandidates = null;
        this.skillsSaving = false; this.loadSkills(cx);
      } catch (error) { if (!this.skillsClosed) this.skillsError = error.message; }
      finally { this.skillsSaving = false; if (!this.skillsClosed) cx.notify(); }
    });
  },
  changeNativeSkill(item, cx) {
    if (this.skillsDirty || this.skillsSaving || this.skillsLoading || item.managed) return;
    const { provider, userHome, directory } = this.skillsContext();
    this.skillsSaving = true; this.skillsError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await this.skillsCall('enable', { provider, userHome, directory, path: item.path, enabled: !item.enabled, expected: item.enabled });
        if (this.skillsClosed) return;
        this.skillsSaving = false; this.loadSkills(cx);
      } catch (error) { if (!this.skillsClosed) this.skillsError = error.message; }
      finally { this.skillsSaving = false; if (!this.skillsClosed) cx.notify(); }
    });
  },
  skillsPage(t) {
    const context = this.skillsContext(), inventory = this.skillsInventory, busy = this.skillsLoading || this.skillsSaving;
    const query = this.skillsSearch.value().trim().toLowerCase();
    const items = (inventory?.items || []).filter(item => !query || `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(query));
    const selected = items.find(item => item.id === this.skillsSelected) || items[0];
    const active = item => item.enabled && (item.managed || !this.skillsDisabled?.includes(item.key));
    const status = item => !item.enabled ? 'Off in native source' : active(item) ? 'Available' : 'Off for this project';
    const changeScope = scope => (_event, cx) => { this.skillsScope = scope; this.skillsCandidates = null; this.loadSkills(cx); };
    return v_flex().id('skills-manager').flex_1().min_h(0).gap(12)
      .child(DialogDescription(t).child('Skills installed once are inherited by your projects. Choose a program to see its sources and availability.'))
      .when(Boolean(context.agent), el => el.child(div().text_size(12).text_color(t.muted).child(`Account: ${launcherLabel(context.agent?.name) || context.agent?.name}`)))
      .child(h_flex().flex_none().gap(8).flex_wrap().items_center()
        .children(['claude', 'codex'].map(provider => Button(`skills-provider-${provider}`, t, { variant: 'ghost' }).h(30)
          .bg(this.skillsProvider === provider ? t.selected : t.popover).disabled(busy || this.skillsDirty)
          .on_click((_event, cx) => { this.skillsProvider = provider; this.skillsAccount = null; this.skillsCandidates = null; this.loadSkills(cx); }).child(provider === 'claude' ? 'Claude Code' : 'Codex')))
        .when(context.accounts.length > 1, el => el.child(Select('skills-account', this.skillsAccountSelect, context.agent?.key,
          context.accounts.map(agent => ({ key: agent.key, label: launcherLabel(agent.name) || agent.name })), 'Account',
          (key, cx) => { if (!busy && !this.skillsDirty) { this.skillsAccount = key; this.loadSkills(cx); } }, t, { width: 180, boxed: true })))
        .child(div().flex_1())
        .child(Button('skills-refresh', t, { variant: 'secondary' }).h(30).disabled(busy || this.skillsDirty).on_click((_event, cx) => this.loadSkills(cx)).child('Refresh'))
        .child(Button('skills-install', t, { variant: 'secondary' }).h(30).disabled(busy || this.skillsDirty).on_click((_event, cx) => this.chooseSkillSource(cx)).child('Install from folder…')))
      .child(h_flex().flex_none().gap(8).items_center()
        .child(Button('skills-global', t, { variant: 'ghost' }).h(28).bg(this.skillsScope === 'global' ? t.selected : t.popover)
          .disabled(busy || this.skillsDirty).on_click(changeScope('global')).child('All projects'))
        .when(Boolean(this.skillsProject), el => el.child(Button('skills-project', t, { variant: 'ghost' }).h(28).bg(this.skillsScope === 'project' ? t.selected : t.popover)
          .disabled(busy || this.skillsDirty).on_click(changeScope('project')).child('This project')))
        .when(this.skillsScope === 'project', el => el.child(Button('skills-inherit', t, { variant: 'secondary' }).h(28).disabled(busy || !this.skillsDisabled?.length)
          .on_click((_event, cx) => { this.skillsDisabled = []; this.skillsDirty = Boolean(this.skillsInventory.disabled.length); this.skillsSaved = false; cx.notify(); }).child('Inherit all'))))
      .child(div().text_size(12).text_color(t.muted).child(this.skillsScope === 'global'
        ? 'Global availability belongs to this account’s native settings. Install here to make a skill available across projects.'
        : 'Everything inherits its global state unless you turn it off here. Apply changes for new conversations.'))
      .when(Boolean(inventory), el => el.child(div().text_size(11).text_color(t.dim).child(`Personal source: ${inventory.root}`)))
      .when(Boolean(this.skillsCandidates), el => el.child(v_flex().flex_none().max_h(180).overflow_y_scroll().p(10).gap(6).border(1).border_color(t.border)
        .child(div().text_size(12).child('Install a source reference for all projects. Keep the original folder available.'))
        .children((this.skillsCandidates || []).map(item => h_flex().gap(8).items_center()
          .child(v_flex().flex_1().min_w(0).child(div().text_size(12).child(item.name)).child(div().text_size(11).text_color(t.dim).child(item.source)))
          .child(Button(`skills-install-${item.slug}`, t, { variant: 'secondary' }).h(28).disabled(busy).on_click((_event, cx) => this.installSelectedSkill(item, cx)).child('Install'))))
        .child(Button('skills-install-cancel', t, { variant: 'ghost' }).h(28).disabled(busy).on_click((_event, cx) => { this.skillsCandidates = null; cx.notify(); }).child('Close'))))
      .child(Input.new(this.skillsSearch, t).h(30).px(8).border(1).border_color(t.input).accessibility_label('Search skills'))
      .when(this.skillsLoading, el => el.child(div().text_size(12).text_color(t.muted).child('Reading skill sources…')))
      .child(h_flex().flex_1().min_h(0).gap(14)
        .child(v_flex().w(250).flex_none().min_h(0).overflow_y_scroll().border(1).border_color(t.border)
          .children(items.map(item => Button(`skill-row-${item.id}`, t, { variant: 'ghost' }).w_full().h_auto().min_h(52).px(10).py(6).justify_start()
            .bg(item.id === selected?.id ? t.selected : t.popover).on_click((_event, cx) => { this.skillsSelected = item.id; cx.notify(); })
            .child(v_flex().min_w(0).gap(2).child(div().text_size(12).child(item.name)).child(div().text_size(11).text_color(t.muted).child(`${item.source} · ${status(item)}`)))))
          .when(!items.length && !this.skillsLoading, el => el.child(div().p(10).text_size(12).text_color(t.muted).child('No matching skills. Install from a folder or refresh after using your native installer.'))))
        .child(v_flex().flex_1().min_w(0).min_h(0).overflow_y_scroll().gap(10)
          .when(Boolean(selected), el => el
            .child(h_flex().gap(8).justify_between().items_center()
              .child(div().text_size(16).font_semibold().child(selected?.name || ''))
              .when(this.skillsScope === 'project' && !selected?.managed, body => body.child(Switch('skill-project-enabled', active(selected), t).disabled(busy || !selected.enabled || selected.canExclude === false)
                .accessibility_label(`Use ${selected.name} for this project`).on_change((on, cx) => this.setProjectSkill(selected, on, cx)))))
            .child(div().text_size(13).child(selected?.description || ''))
            .child(div().text_size(12).text_color(t.muted).child(`${selected?.source} · ${selected && status(selected)}`))
            .child(div().text_size(11).text_color(t.dim).child(selected?.path || ''))
            .when(this.skillsScope === 'global' && !selected?.managed, body => body
              .child(Button('skills-native-state', t, { variant: 'secondary' }).h(28).self_start().disabled(busy || this.skillsDirty || !selected?.path)
                .on_click((_event, cx) => this.changeNativeSkill(selected, cx)).child(`${selected?.enabled ? 'Turn off' : 'Enable'}${selected?.plugin ? ' plugin' : ''}`))
              .when(Boolean(selected?.plugin), text => text.child(div().text_size(12).text_color(t.muted).child('This changes the native plugin for all its skills.'))))
            .when(selected?.canExclude === false, body => body.child(div().text_size(12).text_color(t.muted).child(!selected?.path
              ? 'Managed by the native plugin. Use its native plugin manager to change it.'
              : 'This native plugin is managed as a whole by Claude. Per-skill project choices are available with an isolated Claude account.')))
            .when(Boolean(selected?.managed), body => body.child(Button('skills-managed-settings', t, { variant: 'secondary' }).h(28).self_start().disabled(this.skillsDirty)
              .on_click(() => run(`herdr-zed.settings:agents:${selected?.source === 'ECC' ? 'ecc' : 'capabilities'}`)).child('Configure source…'))))))
      .child(h_flex().flex_none().gap(8).items_center()
        .child(Button('skills-advanced', t, { variant: 'ghost' }).h(28).disabled(this.skillsDirty).on_click((_event, cx) => { this.skillsAdvanced = !this.skillsAdvanced; cx.notify(); }).child('Advanced…'))
        .when(Boolean(this.skillsAdvanced), el => el
          .child(Button('skills-advanced-shared', t, { variant: 'secondary' }).h(28).disabled(this.skillsDirty).on_click(() => run('herdr-zed.settings:agents:capabilities')).child('Built-in & shared library'))
          .child(Button('skills-advanced-ecc', t, { variant: 'secondary' }).h(28).disabled(this.skillsDirty).on_click(() => run('herdr-zed.settings:agents:ecc')).child('ECC'))))
      .child(ApplyFooter('skills', t, { dirty: this.skillsDirty, busy, applied: this.skillsSaved, error: this.skillsError, progress: this.skillsSaving ? 'Applying…' : 'Reading…',
        discard: (_event, cx) => { this.skillsDisabled = [...this.skillsInventory.disabled]; this.skillsDirty = false; this.skillsError = null; cx.notify(); }, apply: (_event, cx) => this.saveSkills(cx) }));
  },
};
