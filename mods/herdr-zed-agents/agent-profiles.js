import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState, TextareaState, Textarea } from 'gpui-base';
import { shared, setShared, props, openOverlay, closeOverlay } from 'herdr';
import { sessionKind, permissionModes, launcherChoices, launcherLabel, launcherOption, sessionChoices, effortLabel, claudeModels } from './components/session-model.js';
import { Button } from './components/button.js';
import { Select } from './components/select.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter, DiscardPrompt } from './components/dialog.js';
import { DropdownMenuLabel } from './components/dropdown-menu.js';
import { AgentIcon, glyph } from './components/icon.js';
import { noAccount } from './components/agents.js';

// Profiles can use any installed account, in New thread's saved order.
export const agentProfiles = {
  profileAccounts() {
    return launcherChoices(this.launchers, shared('herdr-zed.launcher-order') || [])
      .filter(choice => choice.agent && !choice.agent.profileKey && choice.agent.installed !== false && sessionKind(choice.agent))
      .map(choice => choice.agent);
  },

  profileEditorAccounts() { return this.profileAccounts(); },

  openAgentProfileEditor(config = null) {
    if (!config && !this.profileAccounts().length) return;
    const target = props();
    openOverlay({ mod: 'herdr-zed-agents', kind: 'dialog', modal: true, frame: 'none', width: 560, height: 600,
      props: { view: 'agent-profile-editor', configKey: config?.key || null, space: target.space } });
  },

  finishAgentProfileEditor() {
    if (this.profileSaving) return;
    const target = props();
    closeOverlay(target.overlay);
  },

  initAgentProfileEditor() {
    const key = (props() || {}).configKey;
    const config = (shared('herdr-zed.agent-configs') || []).find(item => item.key === key);
    const session = config && shared('herdr-zed.profile-sessions')?.[key] || {};
    this.profileDraft = { name: config?.name || '', profileKey: config?.profileKey || null,
      model: session.model || null, effort: session.effort || null, serviceTier: session.serviceTier || null,
      permission: config && shared('herdr-zed.codex-permissions')?.[key] || 'default' };
    this.configName = InputState.new({ placeholder: 'Profile name', value: this.profileDraft.name });
    this.configName.set_value(this.profileDraft.name);
    this.configName.on('change', (_event, cx) => { this.profileError = null; cx.notify(); });
    this.configInstructions = TextareaState.new({ placeholder: 'Extra instructions for this agent…', rows: 5 });
    this.configInstructions.set_value(config?.instructions || '');
    this.configInstructions.on('change', (_event, cx) => { this.profileError = null; cx.notify(); });
    if (key && !config) this.profileError = 'This agent profile no longer exists.';
    this.profileBaseline = this.profileSnapshot();
  },

  // What Save would write, to tell whether the editor has unsaved edits.
  profileSnapshot() {
    return JSON.stringify([this.profileDraft, this.configName?.value() || '', this.configInstructions?.value() || '']);
  },
  profileDirty() { return Boolean(this.profileBaseline) && this.profileSnapshot() !== this.profileBaseline; },

  chooseProfileAccount(key) {
    const account = this.profileEditorAccounts().find(item => item.key === key);
    const saved = account && shared('herdr-zed.profile-sessions')?.[account.key] || {};
    Object.assign(this.profileDraft, { profileKey: account?.key || null, model: saved.model || null, effort: saved.effort || null,
      serviceTier: sessionKind(account) === 'codex' ? saved.serviceTier || null : null,
      permission: account && shared('herdr-zed.codex-permissions')?.[account.key] || 'default' });
    this.profileError = null;
  },

  saveAgentProfile(cx) {
    if (this.profileSaving || this.profileSaved) return;
    const draft = this.profileDraft, account = this.profileEditorAccounts().find(item => item.key === draft.profileKey);
    const name = this.configName.value().trim(), configs = shared('herdr-zed.agent-configs') || [], existing = (props() || {}).configKey;
    const instructions = this.configInstructions.value().trim();
    let error;
    if (existing && !configs.some(item => item.key === existing)) error = 'This agent profile no longer exists.';
    else if (!name || Array.from(name).length > 48 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) error = 'Use a name of 1–48 characters without control characters.';
    else if (instructions.includes('\u0000')) error = 'Instructions cannot contain null characters.';
    else if (!account) error = 'Choose an account.';
    else {
      const choices = sessionChoices(sessionKind(account), this.profileModels(account), shared('herdr-zed.session-options')?.[sessionKind(account)] || {}, draft.model);
      if (draft.model && !choices.models.some(model => model.key === draft.model)) error = 'Choose an available model.';
      else if (draft.effort && !choices.efforts.includes(draft.effort)) error = 'Choose an effort supported by this model.';
      else if (!permissionModes(account).some(mode => mode.key === draft.permission)) error = 'Choose an available permission mode.';
    }
    if (error) { this.profileError = error; cx.notify(); return; }
    this.profileSaving = true;
    let number = configs.length + 1, key = existing || `herdr-zed-preset-${Date.now().toString(36)}-${number}`;
    while (!existing && configs.some(item => item.key === key)) key = `herdr-zed-preset-${Date.now().toString(36)}-${++number}`;
    const config = { key, profileKey: account.key, name, ...(instructions ? { instructions } : {}) };
    const sessions = shared('herdr-zed.profile-sessions') || {};
    setShared('herdr-zed.profile-sessions', { ...sessions, [key]: { ...sessions[key], model: draft.model, effort: draft.effort,
      serviceTier: sessionKind(account) === 'codex' && draft.serviceTier === 'fast' ? 'fast' : null } });
    const permissions = { ...(shared('herdr-zed.codex-permissions') || {}) };
    if (draft.permission === 'default') delete permissions[key]; else permissions[key] = draft.permission;
    setShared('herdr-zed.codex-permissions', permissions);
    setShared('herdr-zed.agent-configs', existing ? configs.map(item => item.key === key ? config : item) : [...configs, config]);
    this.profileSaved = true;
    this.profileSaving = false;
    this.finishAgentProfileEditor();
  },

  removeConfiguration(config) {
    setShared('herdr-zed.agent-configs', (shared('herdr-zed.agent-configs') || []).filter(item => item.key !== config.key));
    for (const key of ['herdr-zed.profile-sessions', 'herdr-zed.codex-permissions']) {
      const saved = { ...(shared(key) || {}) }; delete saved[config.key]; setShared(key, saved);
    }
    for (const key of ['herdr-zed.hidden-launchers', 'herdr-zed.launcher-order']) {
      setShared(key, (shared(key) || []).filter(item => item !== `agent:${config.key}`));
    }
  },

  agentProfileEditor(t) {
    const draft = this.profileDraft, accounts = this.profileEditorAccounts(), account = accounts.find(item => item.key === draft.profileKey);
    const creating = !(props() || {}).configKey;
    return DialogContent('agent-profile-editor', t).track_focus(this.handle)
      .accessibility_label(creating ? 'New agent profile' : 'Edit agent profile')
      .on_key_down((event, cx) => {
        // Esc asks first when there are unsaved edits (design.md, Unsaved changes); Cancel discards on purpose.
        if (event.key === 'escape') { if (this.profileDirty() && !this.profileAsking) { this.profileAsking = true; cx.notify(); } else this.finishAgentProfileEditor(); }
        else if (event.key === 'enter' && (event.modifiers?.platform || event.modifiers?.control)) this.saveAgentProfile(cx);
        else return;
        cx.stop_propagation();
      })
      .child(v_flex().id('agent-profile-header').flex_none().gap(6)
        .child(DialogTitle().child(creating ? 'New agent profile' : 'Edit agent profile'))
        .child(DialogDescription(t).child(creating ? 'Name this setup and choose the account it starts with.' : 'Edit this saved model setup.')))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll().gap(12)
        .child(h_flex().flex_none().gap(12).items_center()
          .child(div().w(108).flex_none().text_size(13).child('Name'))
          .child(Input.new(this.configName, t).id('agent-configuration-name').accessibility_label('Agent profile name')
            .w(240).h(28).px(8).border_b(1).border_color(t.input).text_size(12)))
        .child(h_flex().flex_none().gap(12).items_center()
          .child(div().w(108).flex_none().text_size(13).child('Account'))
          .child(Select('defaults-profile', this.defaultSelects.profile, account?.key || 'none',
            [{ key: 'none', label: 'Select account', color: t.muted }, ...accounts.map(item => { const option = launcherOption(item), label = this.accountName(item, option.label);
              return { ...option, label, color: label === noAccount ? t.muted : t.foreground }; })], 'Account',
            key => this.chooseProfileAccount(key), t, { width: 224, boxed: true })))
        .when(Boolean(account), el => el.child(this.configurationFields(account, t, draft)))
        .child(v_flex().flex_none().gap(6)
          .child(div().text_size(13).child('Additional system instructions'))
          .child(div().text_size(12).text_color(t.muted).child('Added after your global Rules for new sessions using this profile; both apply. Leave blank to use global Rules only.'))
          .child(Textarea.new(this.configInstructions).id('agent-profile-instructions').accessibility_label('Additional system instructions')
            .w_full().h(112).p(8).border(1).border_color(t.input).rounded(0).text_size(12)))
        .when(!accounts.length, el => el.child(div().text_size(12).text_color(t.muted).child('Install Claude Code or Codex CLI first.')))
        .when(Boolean(this.profileError), el => el.child(div().id('agent-profile-error').text_size(12)
          .text_color(t.destructive || t.ansi1).child(this.profileError))))
      .child(this.profileAsking && this.profileDirty()
        ? DiscardPrompt('agent-profile-discard', t, { keep: (_event, cx) => { this.profileAsking = false; cx.notify(); }, discard: () => this.finishAgentProfileEditor() })
        : DialogFooter().flex_none().items_center().children([
        div().id('agent-profile-unsaved').flex_1().min_w(0).text_size(12).text_color(t.ansi1).child(this.profileDirty() ? 'Unsaved changes' : ''),
        Button('cancel-agent-profile', t, { variant: 'secondary' }).on_click(() => this.finishAgentProfileEditor()).child('Cancel'),
        Button('save-agent-profile', t).disabled(!account || !this.configName.value().trim())
          .on_click((_event, cx) => this.saveAgentProfile(cx)).child(creating ? 'Create' : 'Save'),
      ]));
  },

  agentProfilesPage(t) {
    const accounts = this.profileAccounts(), configs = shared('herdr-zed.agent-configs') || [];
    const canAdd = accounts.length > 0;
    const columns = (name, account, model, effort, speed, actions) => h_flex().w_full().px(12).gap(12).items_center()
      .child(div().flex_1().min_w(0).child(name)).child(div().w(144).flex_none().min_w(0).child(account))
      .child(div().w(160).flex_none().min_w(0).child(model)).child(div().w(64).flex_none().child(effort))
      .child(div().w(48).flex_none().child(speed)).child(div().w(72).flex_none().child(actions));
    const text = value => div().truncate().text_size(12).child(value);
    return v_flex().id('settings-agent-profiles').flex_1().min_h(0).gap(12)
      .child(h_flex().flex_none().gap(12).items_center()
        .child(DropdownMenuLabel(t).px(0).flex_1().child('AGENT PROFILES'))
        .child(Button('add-agent-configuration', t, { variant: 'secondary' }).h(28).px(10).gap(6)
          .disabled(!canAdd)
          .on_click(() => this.openAgentProfileEditor()).child(glyph('plus')).child('Add')))
      .child(DialogDescription(t).flex_none().child(canAdd ? 'Saved model, effort, permissions and instructions for an account. Profiles share the account’s local data without copying it. Each appears in New thread.' : 'Install Claude Code or Codex CLI to add a profile.'))
      .child(v_flex().id('agent-profiles-table').flex_1().min_h(0).border(1).border_color(t.border)
        .child(columns('NAME', 'ACCOUNT', 'MODEL', 'EFFORT', 'SPEED', '').h(32).flex_none().text_size(11).text_color(t.muted)
          .border_b(1).border_color(t.border))
        .child(v_flex().flex_1().min_h(0).overflow_y_scroll()
          .when(!configs.length, el => el.child(div().p(12).text_size(12).text_color(t.muted).child('No agent profiles. Click Add to create one.')))
          .children(configs.map((config, index) => {
            const account = accounts.find(item => item.key === config.profileKey), saved = shared('herdr-zed.profile-sessions')?.[config.key] || {};
            const models = sessionKind(account) === 'claude' ? claudeModels : account ? this.profileModels(account) || [] : [];
            const label = h_flex().gap(6).items_center().min_w(0).child(AgentIcon(account, t).flex_none())
              .child(text(account ? this.accountName(account, launcherLabel(account.name || sessionKind(account))) : 'Unavailable'));
            const actions = h_flex().gap(4).items_center()
              .child(Button(`edit-agent-profile-${config.key}`, t, { variant: 'ghost' }).h(28).px(4).on_click(() => this.openAgentProfileEditor(config)).child('Edit'))
              .child(Button(`remove-agent-profile-${config.key}`, t, { variant: 'ghost', size: 'icon' }).accessibility_label(`Remove ${config.name}`).tooltip(`Remove ${config.name}`)
                .on_click((_event, cx) => { this.removeConfiguration(config); cx.notify(); }).child(glyph('trash')));
            return columns(text(config.name), label, text(models.find(item => item.key === saved.model)?.label || saved.model || 'Default'),
              text(saved.effort ? effortLabel(saved.effort) : 'Default'), text(saved.serviceTier === 'fast' ? 'Fast' : '—'), actions)
              .id(`agent-profile-row-${config.key}`).h(40).flex_none().when(index > 0, el => el.border_t(1).border_color(t.border));
          }))));
  },
};
