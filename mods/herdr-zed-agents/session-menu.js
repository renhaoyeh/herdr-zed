import { availableAgents, loadAccountIdentities } from './discovery.js';
import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { shared, setShared, props, spaces, openOverlay, closeOverlay, home, readTextFile, keys, window, exec, appHome, run } from 'herdr';
import { unsavedKey, SETTINGS_CLOSE_COMMAND } from './components/extension-contract.js';
import { launcherChoices, launcherLabel, launcherOption, accountAddresses, programName, permissionModes, sessionKind, isAccountLauncher, claudeModels, claudeEfforts, codexHome, codexModels, mergeModels, orderedOptions, moveOption, effortLabel, sessionChoices, settingsKey, configuredAgents, usageProvider, autoUsage, autoRank, autoMultipliers, autoMultiplier, planMultiplier, planLabel, quotaResetLabel } from './components/session-model.js';
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { Switch } from './components/switch.js';
import { ToggleGroup, ToggleGroupItem } from './components/toggle-group.js';
import { DialogDescription } from './components/dialog.js';
import { glyph, AgentIcon } from './components/icon.js';
import { Select, SelectState } from './components/select.js';
import { accountStorageDirectory, storageGroups, storageSize } from './account-storage-model.js';

const launcherSections = ['Terminal', 'Agents', 'Your accounts', 'Agent profiles'];
// The manifest's settings.pages ids, one shell page each (ARCHITECTURE §2.1).
const settingsPageIds = ['accounts', 'agents', 'models', 'profiles', 'global-rules', 'capabilities', 'mcp', 'ecc'];
const modelProviderIcon = (kind, t) => AgentIcon({ icon: `icons/${kind}.svg`, tint: kind === 'codex' }, t).size(14);

// The New thread menu and the Agents settings pages. Mixed into the Agents view, which provides
// cachedAgents, startThread and the account actions (addAccount, renameAccount, confirmRemoveAccount).
export const sessionMenu = {
  availableAgents,
  initSessionMenu(cx) {
    if ((props() || {}).refreshAgents) setShared('herdr-zed.agent-cache', {});
    this.launchers = [];
    this.manageIndex = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.loadAgents(cx);
    if ((props() || {}).view && !['manage-launchers', 'agent-profile-editor', 'profile-defaults'].includes((props() || {}).view)) return;
    this.loadCodexModels(cx);
    const page = (props() || {}).page;
    this.settingsPage = settingsPageIds.includes(page) ? page : 'agents';
    // Only the Agents page is available for remote projects; the other pages are for this computer.
    const remote = Boolean(spaces().find(space => space.id === (props() || {}).space)?.machine);
    if (remote && this.settingsPage !== 'agents') this.settingsPage = 'remote-unavailable';
    if (this.settingsPage === 'global-rules') this.initGlobalRules(cx);
    if (['capabilities', 'mcp'].includes(this.settingsPage)) { this.initDevkits(cx); this.capTab = this.settingsPage === 'mcp' ? 'mcp' : 'overview'; }
    if (this.settingsPage === 'ecc') this.initEcc(cx);
    this.defaultSelects = { permissions: new SelectState(cx), model: new SelectState(cx), effort: new SelectState(cx), profile: new SelectState(cx) };
    if ((props() || {}).view === 'profile-defaults') return;
    if ((props() || {}).view === 'agent-profile-editor') { this.initAgentProfileEditor(cx); return; }
    // ARCHITECTURE §3.9: report the page's unsaved edits to the shell from a timer, only when that changes.
    const overlay = (props() || {}).overlay;
    if (overlay) cx.timer.every(250, () => {
      const dirty = this.settingsUnsaved() || null;
      if ((shared(unsavedKey(overlay)) || null) !== dirty) setShared(unsavedKey(overlay), dirty);
    });
  },

  // Manage lists the models every local Codex profile knows.
  loadCodexModels(cx) {
    this.codexModelList = [];
    this.codexModelsByHome = new Map();
    cx.spawn(async cx => {
      try {
        const agents = await this.cachedAgents(null);
        const dirs = [...new Set(agents.filter(agent => sessionKind(agent) === 'codex').map(agent => codexHome(agent, home())))];
        const lists = await Promise.all(dirs.map(async dir => [dir, codexModels(await readTextFile(`${dir}/models_cache.json`) || '')]));
        this.codexModelsByHome = new Map(lists);
        this.codexModelList = mergeModels(lists.map(([, models]) => models));
      } catch {}
      cx.notify();
    });
  },

  profileModels(agent) {
    return this.codexModelsByHome?.get(codexHome(agent, home())) ?? this.codexModelList;
  },

  // Default adds no flag and leaves the profile's underlying configuration.
  providerDefaults(agent, draft = null) {
    const key = settingsKey(agent), kind = sessionKind(agent), modes = permissionModes(agent);
    const permission = draft ? draft.permission : shared('herdr-zed.codex-permissions')?.[key] || 'default';
    const settings = shared('herdr-zed.session-options')?.[kind] || {};
    const stored = draft || shared('herdr-zed.profile-sessions')?.[key] || {};
    const saved = { model: settings.models?.includes(stored.model) ? null : stored.model,
      effort: settings.efforts?.includes(stored.effort) ? null : stored.effort };
    const { models, efforts } = sessionChoices(kind, this.profileModels(agent), settings, saved.model);
    const model = models.some(item => item.key === saved.model) ? saved.model : null;
    const effort = efforts.includes(saved.effort) ? saved.effort : null;
    // Read the saved choice when picking, so several picks before a repaint keep each other.
    const set = change => {
      if (draft) { Object.assign(draft, change); return; }
      const current = shared('herdr-zed.profile-sessions')?.[key] || {};
      setShared('herdr-zed.profile-sessions', { ...(shared('herdr-zed.profile-sessions') || {}),
        [key]: { ...current, model: current.model ?? null, effort: current.effort ?? null, ...change } });
    };
    return [
      { id: 'permissions', label: 'Permissions', items: modes.map(mode => ({ key: mode.key, label: mode.label, checked: mode.key === permission,
        choose: () => {
          if (draft) { draft.permission = mode.key; return; }
          const saved = { ...(shared('herdr-zed.codex-permissions') || {}) };
          if (mode.key === 'default') delete saved[key]; else saved[key] = mode.key;
          setShared('herdr-zed.codex-permissions', saved);
        } })) },
      { id: 'model', label: 'Model', items: [{ key: 'default', label: 'Default' }, ...models].map(item => ({ key: item.key, label: item.label,
        checked: (item.key === 'default' ? null : item.key) === model, choose: () => {
          const next = item.key === 'default' ? null : item.key;
          const current = draft ? draft.effort : shared('herdr-zed.profile-sessions')?.[key]?.effort ?? null;
          set({ model: next, effort: sessionChoices(kind, this.profileModels(agent), settings, next).efforts.includes(current) ? current : null });
        } })) },
      { id: 'effort', label: 'Effort', items: ['default', ...efforts].map(value => ({ key: value, label: value === 'default' ? 'Default' : effortLabel(value),
        checked: (value === 'default' ? null : value) === effort, choose: () => set({ effort: value === 'default' ? null : value }) })) },
      ...(kind === 'codex' ? [{ id: 'fast', label: 'Speed', checked: stored.serviceTier === 'fast',
        choose: checked => set({ serviceTier: checked ? 'fast' : null }) }] : [])];
  },

  profileDefaults(t) {
    const agent = this.availableAgents(this.launchers).find(item => item.key === (props() || {}).account && sessionKind(item));
    return DropdownMenuContent('profile-defaults-menu', undefined, t).w_full().max_h(560).overflow_y_scroll().p(16).gap(12)
      .track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); closeOverlay(props().overlay); } })
      .child(DropdownMenuLabel(t).px(0).child(agent ? launcherLabel(agent.name) : 'Session defaults'))
      .child(div().text_size(12).text_color(t.muted).child('Saved automatically for new threads using this profile.'))
      .child(agent && sessionKind(agent) ? this.configurationFields(agent, t, null, 200)
        : div().text_size(12).text_color(t.muted).child(this.loading ? 'Loading profile…' : 'This profile is no longer available.'));
  },

  // Like macOS and Zed settings: accounts grouped by provider on the left, the selected account on the right.
  // Defaults live on account cards; Models manages the shared provider lists.
  accountsPage(t, cx) {
    const agents = this.availableAgents(this.launchers).filter(agent => !agent.profileKey);
    const usage = shared('herdr-zed.usage.snapshot')?.contexts?.[JSON.stringify(null)]?.usage || [];
    const order = shared('herdr-zed.launcher-order') || [];
    const groups = ['claude', 'codex'].map(kind => ({ kind, name: kind === 'claude' ? 'Claude' : 'Codex',
      accounts: launcherChoices(agents.filter(agent => sessionKind(agent) === kind), order).map(choice => choice.agent).filter(Boolean) }));
    const all = groups.flatMap(group => group.accounts);
    const agent = all.find(item => item.key === this.selectedAccount) || all[0];
    return v_flex().id('settings-accounts').flex_1().min_h(0).gap(12)
      .child(DialogDescription(t).flex_none().child('Sign in to more Claude and Codex accounts. Choose session defaults from the account cards in New thread.'))
      .child(h_flex().flex_1().min_h(0).gap(16).items_start()
        .child(v_flex().id('accounts-list').w(220).flex_none().h_full().min_h(0).overflow_y_scroll().gap(12)
          .children(groups.map(group => {
            const installed = group.accounts.some(item => item.key === group.kind);
            return v_flex().id(`accounts-${group.kind}`).flex_none().gap(2)
              .child(h_flex().h(28).flex_none().gap(8).items_center()
                .child(DropdownMenuLabel(t).px(0).flex_1().child(group.name.toUpperCase()))
                .when(installed, el => el.child(Button(`add-${group.kind}-account`, t, { variant: 'ghost', size: 'icon' })
                  .accessibility_label(`Add a ${group.name} account`).tooltip(`Add a ${group.name} account`).on_click(() => this.addAccount(group.kind)).child(glyph('plus')))))
              .when(!group.accounts.length, el => el.child(div().py(4).text_size(12).text_color(t.muted)
                .child(this.loading ? 'Loading agents…' : `${group.kind === 'claude' ? 'Claude Code' : 'Codex CLI'} is not installed.`)))
              .children(group.accounts.flatMap((item, index) => [
                ...(index > 0 && group.accounts[index - 1].key === group.kind
                  ? [DropdownMenuSeparator(t).id(`accounts-${group.kind}-default-separator`)] : []),
                Button(`account-${item.key}`, t, { variant: 'ghost' }).w_full().h(32).px(8).gap(8).justify_start()
                .bg(item.key === agent?.key ? t.selected : t.popover).text_color(item.key === agent?.key ? t.foreground : t.muted)
                .accessibility_label(`${launcherLabel(item.name || group.kind)}${item.key === agent?.key ? ', selected' : ''}`)
                .on_click((_event, cx) => {
                  for (const state of Object.values(this.defaultSelects || {})) state.open = false;
                  this.selectedAccount = item.key; cx.notify();
                })
                .child(AgentIcon(item, t).flex_none())
                .child(div().id(`account-list-name-${item.key}`).flex_1().min_w(0).truncate().text_size(13)
                  .child(this.accountName(item, launcherLabel(item.name || group.kind))))]));
          })))
        .child(agent ? this.accountDetail(agent, usage, t, cx)
          : div().flex_1().p(12).text_size(12).text_color(t.muted).child(this.loading ? 'Loading agents…' : 'Install Claude Code or Codex CLI to manage accounts.')));
  },

  accountDetail(agent, usage, t, cx) {
    if (cx) this.loadAccountStorage(agent, cx);
    const storageBeside = (this.accountDetailWidth || 0) >= 590;
    const kind = sessionKind(agent);
    const label = this.accountName(agent, launcherLabel(agent.name || kind)), identity = this.accountIdentity(agent);
    // On the name's line: a named account's address, then the plan (a Default account already uses its address as the name).
    const about = [identity.email !== label && identity.email, planLabel(identity.plan)].filter(Boolean).join(' · ');
    return v_flex().id(`account-detail-${agent.key}`).flex_1().min_w(0).h_full().min_h(0).overflow_y_scroll().gap(12)
      .on_size_change((size, cx) => {
        if (this.accountDetailWidth === size.width) return;
        this.accountDetailWidth = size.width; cx.notify();
      })
      .child(h_flex().id(`account-header-${agent.key}`).h(28).flex_none().gap(10).items_center()
        .child(AgentIcon(agent, t).flex_none())
        // One centered line: name · address · plan, the details muted.
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().flex_none().max_w_full().truncate().text_size(15).font_medium().child(label))
          .when(Boolean(about), el => el.child(div().flex_none().text_size(13).text_color(t.muted).child('·'))
            .child(div().id(`account-email-${agent.key}`).flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(about))))
        .when(isAccountLauncher(agent), el => el
          .child(Button(`account-actions-${agent.key}-rename`, t, { variant: 'secondary' }).h(28)
            .on_click(() => this.renameAccount(agent)).child('Rename'))
          .child(Button(`account-actions-${agent.key}-remove`, t, { variant: 'secondary' }).h(28)
            .text_color(t.destructive || t.ansi1).on_click(() => this.confirmRemoveAccount(agent)).child('Remove'))))
      .child((storageBeside ? h_flex() : v_flex()).id(`account-settings-storage-${agent.key}`).flex_none().gap(16)
        .when(storageBeside, el => el.items_start())
        .child(div().id(`account-storage-position-${agent.key}`).min_w(0).flex_none()
          .when(storageBeside, el => el.w(250)).when(!storageBeside, el => el.w_full())
          .child(this.accountStoragePanel(agent, t))));
  },

  loadAccountStorage(agent, cx, refresh = false) {
    const target = accountStorageDirectory(agent, home());
    if (!target || this.storageClosed) return;
    this.accountStorage ||= new Map();
    const key = JSON.stringify(target), previous = this.accountStorage.get(key);
    if (previous?.loading || (previous && !refresh)) return;
    const state = { ...previous, loading: true, error: null };
    this.accountStorage.set(key, state);
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/account-storage-reader.js`, target.directory], { timeout: 15000 });
        if (result.code !== 0) throw new Error('Could not read local data sizes.');
        const data = JSON.parse(result.stdout);
        if (!Number.isFinite(data.bytes) || !data.groups) throw new Error('Could not read local data sizes.');
        if (this.storageClosed || this.accountStorage.get(key) !== state) return;
        state.data = data;
      } catch { if (!this.storageClosed) state.error = 'Could not read local data sizes. Try Refresh.'; }
      if (this.storageClosed) return;
      state.loading = false;
      cx.notify();
    });
  },

  accountStoragePanel(agent, t) {
    const target = accountStorageDirectory(agent, home());
    const key = JSON.stringify(target), state = this.accountStorage?.get(key), data = state?.data;
    const summary = data ? `${data.partial ? 'At least ' : ''}${storageSize(data.bytes)}` : state?.error ? 'Unavailable' : 'Calculating…';
    return v_flex().id(`account-storage-${agent.key}`).flex_none().gap(8).mt(4)
      .child(h_flex().items_center().gap(8)
        .child(DropdownMenuLabel(t).px(0).flex_1().child('STORAGE ON THIS COMPUTER'))
        .child(Button(`account-storage-refresh-${agent.key}`, t, { variant: 'ghost' }).h(28).px(6)
          .disabled(Boolean(state?.loading)).on_click((_event, cx) => { this.loadAccountStorage(agent, cx, true); cx.notify(); })
          .child(state?.loading && data ? 'Refreshing…' : 'Refresh')))
      .child(v_flex().id(`account-storage-breakdown-${agent.key}`).flex_none().border(1).border_color(t.border)
        .child(h_flex().h(36).px(12).items_center().gap(12)
          .child(div().flex_1().text_size(13).font_medium().child('Space on disk'))
          .child(div().id(`account-storage-total-${agent.key}`).flex_none().text_size(13).font_medium().child(summary)))
        .children(storageGroups.map(([group, label]) => h_flex().h(28).px(12).items_center().gap(12).border_t(1).border_color(t.border)
          .child(div().flex_1().text_size(12).text_color(t.muted).child(label))
          .child(div().flex_none().text_size(12).child(data ? storageSize(data.groups[group]) : '—')))))
      .child(div().text_size(12).text_color(t.muted).child('All profiles using this account share these files. Adding a profile does not duplicate them.'))
      .when(Boolean(data), el => el.child(div().text_size(12).text_color(t.muted).child(data.missing ? 'No saved data yet.'
        : data.partial ? 'Some files could not be counted. Sizes are incomplete.'
        : data.skippedLinks ? 'Allocated disk space. Linked targets are excluded; shared filesystem blocks may also belong to other files.'
        : 'Allocated disk space. Shared filesystem blocks may also belong to other files.')))
      .when(Boolean(state?.error), el => el.child(div().text_size(12).text_color(t.destructive || t.ansi1).child(state.error)));
  },

  configurationAccountPicker(profiles, profile, choose, t) {
    return h_flex().flex_none().gap(12).items_center()
      .child(div().w(108).flex_none().text_size(13).child('Account'))
      .child(Select('defaults-profile', this.defaultSelects.profile, profile.key,
        profiles.map(item => ({ ...launcherOption(item), color: t.foreground })), 'Account', key => {
          for (const state of Object.values(this.defaultSelects)) state.open = false;
          choose(key);
        }, t, { width: 224, boxed: true }));
  },

  configurationFields(agent, t, draft = null, width = 240) {
    const colors = [t.muted, t.done, t.working, t.ansi1];
    return v_flex().id('agent-settings-fields').flex_none().gap(12)
      .children(this.providerDefaults(agent, draft).map(section => {
        if (section.id === 'fast') return h_flex().flex_none().gap(12).items_center()
          .child(div().w(108).flex_none().text_size(13).child(section.label))
          .child(Checkbox('defaults-fast', section.checked, t).h(28).font_family('Geist').font_normal().text_size(12).text_color(t.foreground)
            .accessibility_label(`Fast mode for ${launcherLabel(agent.name || sessionKind(agent))}`)
            .on_change((checked, cx) => { section.choose(checked); cx.notify(); })
            .child(div().font_family('Geist').font_normal().text_size(12).text_color(t.foreground).child('Fast mode')));
        const value = section.items.find(item => item.checked)?.key || 'default';
        const options = section.items.map((item, index) => ({ key: item.key, label: item.label, icon: section.id === 'permissions' ? 'lock' : section.id === 'effort' ? 'priority-high' : 'agent',
          color: section.id === 'permissions' ? colors[index] : item.key === 'default' ? t.muted : t.foreground }));
        return h_flex().flex_none().gap(12).items_center()
          .child(div().w(108).flex_none().text_size(13).child(section.label))
          .child(Select(`defaults-${section.id}`, this.defaultSelects[section.id], value, options, `Default ${section.label.toLowerCase()}`,
            key => section.items.find(item => item.key === key)?.choose(), t, { width, boxed: true }));
      }));
  },

  modelsPage(t) {
    const kind = this.modelsProvider || 'claude';
    return v_flex().id('settings-models').flex_1().min_h(0).gap(16)
      .child(DialogDescription(t).flex_none().child('Choose the models and efforts offered to every account and profile. Changes save automatically.'))
      .child(h_flex().flex_none().self_start().p(2).gap(2).border(1).border_color(t.border)
        .children(['claude', 'codex'].map(provider => Button(`models-provider-${provider}`, t, { variant: 'ghost' }).h(28).px(12).gap(8)
          .bg(provider === kind ? t.selected : t.popover)
          .on_click((_event, cx) => { this.modelsProvider = provider; this.modelDrag = null; this.modelDrop = null; cx.notify(); })
          .child(modelProviderIcon(provider, t))
          .child(provider === 'claude' ? 'Claude Code' : 'Codex'))))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll().children(this.sessionOptions([kind], t)));
  },

  // One global list per supported provider; Custom programs never have model controls.
  sessionOptions(kinds, t) {
    const saved = shared('herdr-zed.session-options') || {};
    const shown = (kind, field, key) => !(saved[kind]?.[field] || []).includes(key);
    const toggle = (kind, field, key) => {
      const current = shared('herdr-zed.session-options') || {};
      const hidden = current[kind]?.[field] || [];
      setShared('herdr-zed.session-options', { ...current, [kind]: { ...current[kind],
        [field]: hidden.includes(key) ? hidden.filter(item => item !== key) : [...hidden, key] } });
      if (!hidden.includes(key)) {
        const profiles = { ...(shared('herdr-zed.profile-sessions') || {}) };
        for (const [profileKey, profile] of Object.entries(profiles)) {
          const profileAgent = configuredAgents(this.launchers, shared('herdr-zed.agent-configs') || []).find(agent => agent.key === profileKey) || { key: profileKey };
          if (sessionKind(profileAgent) !== kind) continue;
          const setting = field === 'models' ? 'model' : 'effort';
          if (profile[setting] === key) profiles[profileKey] = { ...profile, [setting]: null };
        }
        setShared('herdr-zed.profile-sessions', profiles);
      }
    };
    const title = effortLabel;
    return kinds.filter(kind => ['claude', 'codex'].includes(kind)).map(kind => {
        const models = orderedOptions(kind === 'claude' ? claudeModels : this.codexModelList || [], saved[kind]?.order);
        const reorder = (key, target) => {
          const current = shared('herdr-zed.session-options') || {};
          setShared('herdr-zed.session-options', { ...current, [kind]: { ...current[kind], order: moveOption(models.map(model => model.key), key, target) } });
        };
        const dragging = this.modelDrag?.kind === kind;
        const efforts = kind === 'claude' ? claudeEfforts : [...new Set(models.flatMap(model => model.efforts))];
        const count = models.filter(model => shown(kind, 'models', model.key)).length;
        return v_flex().id(`session-options-${kind}`).flex_none().border(1).border_color(t.border)
          .child(h_flex().h(36).px(12).gap(8).items_center()
            .child(div().flex_1().text_size(13).font_medium().child('Models'))
            .when(models.length > 0, el => el.child(div().text_size(12).text_color(t.muted).child(`${count} of ${models.length} shown`))))
          .when(!models.length, el => el.child(div().h(36).px(12).flex().items_center().text_size(12).text_color(t.muted).child('Loading models…')))
          // Drag a model by its handle to set the Model menu's order, as launchers are dragged above.
          .children(models.map(model => h_flex().id(`session-${kind}-model-${model.key}`).h(36).pl(4).pr(12).gap(8).items_center()
            .border_t(1).border_color(t.border)
            .opacity(dragging && this.modelDrag.key === model.key ? 0.5 : 1)
            .bg(dragging && this.modelDrop === model.key && this.modelDrag.key !== model.key ? t.selected : t.popover)
            .on_mouse_move((_event, cx) => { if (dragging && this.modelDrop !== model.key) { this.modelDrop = model.key; cx.notify(); } })
            .on_mouse_up('left', (_event, cx) => {
              if (!dragging) return;
              reorder(this.modelDrag.key, model.key);
              this.modelDrag = null; this.modelDrop = null; cx.stop_propagation(); cx.notify();
            })
            .child(Button(`drag-session-${kind}-${model.key}`, t, { variant: 'ghost', size: 'icon' }).cursor_grab()
              .accessibility_label(`Reorder ${model.label}`).tooltip(`Reorder ${model.label}`)
              .on_mouse_down('left', (_event, cx) => {
                cx.stop_propagation(); this.handle?.focus();
                this.modelDrag = { kind, key: model.key }; this.modelDrop = model.key; cx.notify();
              }).child(glyph('grip-vertical')))
            .child(div().min_w(0).truncate().text_size(13).text_color(shown(kind, 'models', model.key) ? t.foreground : t.muted).child(model.label))
            .when(model.label !== model.key, el => el.child(div().flex_none().text_size(12).text_color(t.muted).child(model.key)))
            .child(div().flex_1())
            .when(Boolean(model.efforts?.length), el => el.child(div().flex_none().text_size(12).text_color(t.muted)
              .child(`${title(model.efforts[0])} – ${title(model.efforts.at(-1))}`)))
            .child(Switch(`session-${kind}-models-${model.key}`, shown(kind, 'models', model.key), t)
              .accessibility_label(`Show ${model.label}`).on_change((_checked, cx) => { toggle(kind, 'models', model.key); cx.notify(); }))))
          .when(efforts.length > 0, el => el.child(h_flex().h(44).px(12).gap(12).items_center().border_t(1).border_color(t.border)
            .child(div().flex_1().text_size(12).text_color(t.muted).child('Effort'))
            .child(ToggleGroup(`session-${kind}-efforts`, `${kind === 'claude' ? 'Claude' : 'Codex'} efforts`, t)
              .children(efforts.map((effort, index) => ToggleGroupItem(`session-${kind}-efforts-${effort}`, shown(kind, 'efforts', effort), index === 0, t)
                .accessibility_label(`Show ${title(effort)} effort`).on_change((_pressed, cx) => { toggle(kind, 'efforts', effort); cx.notify(); })
                .child(title(effort)))))));
      });
  },

  loadAgents(cx) {
    const machine = spaces().find(s => s.id === (props() || {}).space)?.machine;
    const cached = shared('herdr-zed.agent-cache')?.[JSON.stringify(machine || null)];
    if (cached) {
      this.launchers = this.availableAgents(cached, machine);
      this.loading = false;
      this.launchError = false;
      return;
    }
    this.loading = true;
    this.launchError = false;
    cx.spawn(async cx => {
      try {
        this.launchers = await this.cachedAgents(machine);
      } catch { this.launchError = true; }
      this.loading = false;
      cx.notify();
    });
  },

  // Dialogs stacked above Settings change accounts and bump profile-revision; reload, selecting a new account.
  // A local account's signed-in address: Usage's reading, else the address read for accounts Usage does not show.
  accountIdentity(agent) {
    const key = agent?.profileKey || agent?.key;
    const reading = (shared('herdr-zed.usage.snapshot')?.contexts?.[JSON.stringify(null)]?.usage || []).find(item => item.key === key);
    const saved = shared('herdr-zed.account-identities')?.[key];
    return { email: reading?.email || saved?.email || null, plan: reading?.plan || saved?.plan || null };
  },

  // A Default account is named by its signed-in address, or by its program when no address is known; named accounts
  // keep their own name. Every account list uses this one rule, so "No account" never shows.
  accountName(agent, label) {
    if (label !== 'Default account' || !agent || agent.profileKey || !['claude', 'codex'].includes(sessionKind(agent))) return label;
    return accountAddresses(shared)(agent.key) || programName(agent);
  },

  // New thread and the Agents list name a row by its program and account: "Claude Code", "Claude Code · work@example.test".
  pickerName(agent, label) {
    if (!agent || agent.profileKey || !['claude', 'codex'].includes(sessionKind(agent))) return label;
    const program = programName(agent), name = this.accountName(agent, label);
    return name === program ? name : `${program} · ${name}`;
  },

  // Usage reads only the accounts it shows, so read every other local account's address once per app session
  // through the same credential-free reader, and share it with every account label.
  loadAccountIdentities(cx, agents = this.launchers) {
    loadAccountIdentities(cx, agents, spaces().find(space => space.id === (props() || {}).space)?.machine);
  },

  syncAccountChanges(cx) {
    if (['accounts', 'agents'].includes(this.settingsPage)) this.loadAccountIdentities(cx);
    const revision = shared('herdr-zed.profile-revision') || 0;
    if (this.agentsRevision === undefined || revision === this.agentsRevision) { this.agentsRevision = revision; return; }
    this.agentsRevision = revision;
    const before = new Set((this.launchers || []).map(agent => agent.key));
    cx.spawn(async cx => {
      try { this.launchers = await this.cachedAgents(spaces().find(space => space.id === (props() || {}).space)?.machine); }
      catch { this.launchError = true; }
      const added = this.launchers.find(agent => isAccountLauncher(agent) && !agent.profileKey && !before.has(agent.key));
      if (added) this.selectedAccount = added.key;
      cx.notify();
    });
  },

  // The Agents page of the shell's Settings dialog. The shell mounts one page per manifest `settings.pages` id, with
  // `page` in its props, and draws the frame, the header title and the page list, so this draws none of them.
  manageLaunchers(t, cx) {
    const hidden = shared('herdr-zed.hidden-launchers') || [];
    const choices = launcherChoices(this.availableAgents(this.launchers, spaces().find(space => space.id === (props() || {}).space)?.machine), shared('herdr-zed.launcher-order') || []);
    const toggle = (key, cx) => {
      const current = shared('herdr-zed.hidden-launchers') || [];
      setShared('herdr-zed.hidden-launchers', current.includes(key) ? current.filter(item => item !== key) : [...current, key]);
      cx.notify();
    };
    const move = (index, target, cx) => {
      if (!choices[index] || !choices[target] || choices[index].group !== choices[target].group || index === target) return;
      const order = [...new Set([...(shared('herdr-zed.launcher-order') || []), ...choices.map(choice => choice.key)])];
      const key = choices[index].key;
      order.splice(order.indexOf(key), 1);
      order.splice(order.indexOf(choices[target].key) + (index < target ? 1 : 0), 0, key);
      setShared('herdr-zed.launcher-order', order);
      this.manageIndex = target;
      cx.notify();
    };
    const cancelDrag = cx => {
      if (!this.dragKey && !this.modelDrag) return;
      this.dragKey = null; this.dropKey = null; this.modelDrag = null; this.modelDrop = null;
      cx.notify();
    };
    const page = this.settingsPage;
    return v_flex().id('manage-launchers').size_full().min_h(0).p(24).gap(12).text_color(t.foreground)
      .accessibility_label('Settings')
      .on_mouse_up('left', (_event, cx) => cancelDrag(cx))
      .on_hover((inside, cx) => { if (!inside) cancelDrag(cx); })
      .track_focus(this.handle).on_key_down((event, cx) => {
        // Escape cancels a drag; otherwise the shell closes the dialog, asking first if this page has unsaved edits.
        // The dialog is a layout overlay, so Esc reaches this page instead of closing the dialog natively.
        if (event.key === 'escape') {
          cx.stop_propagation();
          if (this.dragKey || this.modelDrag) { cancelDrag(cx); return; }
          run(`herdr-zed.${SETTINGS_CLOSE_COMMAND}`);
          return;
        }
        if (page !== 'agents') return;
        if (event.modifiers?.alt && ['up', 'down'].includes(event.key)) {
          move(this.manageIndex, this.manageIndex + (event.key === 'up' ? -1 : 1), cx);
        } else if (event.key === 'down') this.manageIndex = (this.manageIndex + 1) % choices.length;
        else if (event.key === 'up') this.manageIndex = (this.manageIndex + choices.length - 1) % choices.length;
        else if (event.key === 'enter' || event.key === 'space') toggle(choices[this.manageIndex].key, cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(this.settingsPageBody(page, { choices, hidden, toggle, move, cancelDrag }, t, cx));
  },

  // Edits on the open Settings page that Esc would lose: each page with Save/Discard reports its own draft.
  settingsUnsaved() {
    return Boolean(this.capDirty || this.mcpDirty || this.eccDirty);
  },

  // One shell page of the Agents extension. Projects on a remote machine only get Agents: the other pages read this computer.
  settingsPageBody(page, { choices, hidden, toggle, move, cancelDrag }, t, cx) {
    if (page === 'remote-unavailable') return DialogDescription(t).flex_none()
      .child('Accounts, profiles, rules, capabilities, MCP connections and ECC are set up on this computer. This project is on another machine.');
    if (page === 'accounts') return this.accountsPage(t, cx);
    if (page === 'profiles') return this.agentProfilesPage(t);
    if (page === 'models') return this.modelsPage(t);
    if (page === 'global-rules') return this.withSideNav(this.globalRulesNavigation(t), this.globalRulesPage(t), t);
    if (page === 'mcp') return this.devkitsPage(t);
    if (page === 'capabilities') return this.withSideNav(this.devkitsNavigation(t), this.devkitsPage(t), t);
    if (page === 'ecc') return this.withSideNav(this.eccNavigation(t), this.eccPage(t), t);
    return v_flex().flex_1().min_w(0).min_h(0).gap(8)
      .child(DialogDescription(t).flex_none().child('Choose what New thread and Usage show, in one order. Drag to reorder; changes save automatically. Agents using the same account share its quota.'))
      .child(this.agentsPage(choices, hidden, toggle, move, cancelDrag, t));
  },

  // A page with its own sections (Capabilities, ECC, Global Rules): a segmented row at its top, then the page. The
  // dialog's left nav lists the pages, so a page never has a second column of navigation.
  withSideNav(side, body, t) {
    return v_flex().flex_1().min_h(0).gap(12)
      .child(h_flex().id('page-sections').flex_none().p(2).gap(2).self_start().border(1).border_color(t.border).child(side))
      .child(v_flex().flex_1().min_w(0).min_h(0).child(body));
  },

  // Auto in New thread starts one of these accounts, chosen by quota at each launch.
  // The rules and each account's current standing are shown, so the pick is predictable.
  autoAccountsSection(profiles, t) {
    const members = shared('herdr-zed.auto-accounts') || [];
    const multipliers = shared('herdr-zed.auto-multipliers') || {};
    const hiddenUsage = shared('herdr-zed.hidden-usage-profiles') || [];
    const accounts = profiles.filter(choice => choice.group === 2 && !hiddenUsage.includes(choice.agent.key));
    const usage = autoUsage(shared);
    const next = this.autoThreadAgent(this.launchers || [], null)?.key;
    const reading = key => usage.find(account => account.key === key);
    const standing = key => {
      const rank = autoRank(reading(key), autoMultiplier(key, reading(key), multipliers));
      if (rank.full) return `At limit · ${quotaResetLabel({ resetsAt: rank.resetsAt })}`;
      return `Room ${rank.room.toFixed(2)}${rank.known ? '' : ' · no reading'}`;
    };
    const rules = ['Each time Auto starts a session, it chooses among the selected accounts:',
      '1. Skip accounts at their 5h or weekly limit. If every account is at a limit, use the one that resets soonest.',
      '2. For each quota window, divide quota left by time left; 1 means on pace. An account uses its lowest window.',
      '3. Multiply by the account’s plan size to get its Room, and start the account with the most Room. Ties follow New thread order.',
      'Plan size follows each account’s detected plan: ×1 for ChatGPT Plus, Business or Claude Pro; ×5 for ChatGPT Pro $100 or Claude Max 5x; ×20 for ChatGPT Pro $200 or Claude Max 20x. Choose another size to override it, or the detected size to follow the plan again.',
      'Only accounts shown in Usage above can join Auto. Accounts without a reading count as on pace. A session keeps the account it started with.'];
    const setMultiplier = (key, value) => {
      const saved = { ...(shared('herdr-zed.auto-multipliers') || {}) };
      if (value === planMultiplier(reading(key)?.plan)) delete saved[key]; else saved[key] = value;
      setShared('herdr-zed.auto-multipliers', saved);
    };
    return v_flex().id('auto-account-settings').flex_none().gap(4)
      .child(h_flex().flex_none().mt(8).gap(8).items_center()
        .child(DropdownMenuLabel(t).px(0).flex_1().child('AUTO'))
        .child(Button('auto-rules-toggle', t, { variant: 'ghost' }).h(24).px(6).gap(4).text_size(12)
          .on_click((_event, cx) => { this.autoRulesOpen = !this.autoRulesOpen; cx.notify(); })
          .child('How Auto chooses').child(glyph(this.autoRulesOpen ? 'chevron-up' : 'chevron-down', 14))))
      .when(Boolean(this.autoRulesOpen), el => el.child(v_flex().id('auto-account-rules').flex_none().gap(2)
        .children(rules.map(rule => DialogDescription(t).flex_none().child(rule)))))
      .child(v_flex().flex_none().mt(4).border(1).border_color(t.border)
        // An empty table keeps one row's height instead of collapsing to a line.
        .when(!accounts.length, el => el.child(h_flex().id('auto-account-empty').h(40).px(12).items_center()
          .text_size(12).text_color(t.muted).child('No added accounts.')))
        .children(accounts.map((choice, index) => {
          const key = choice.agent.key, selected = members.includes(key), status = standing(key);
          const plan = planLabel(reading(key)?.plan), size = autoMultiplier(key, reading(key), multipliers);
          return h_flex().h(40).px(12).gap(12).items_center().when(index > 0, el => el.border_t(1).border_color(t.border))
            .child(Checkbox(`auto-account-${key}`, selected, t).h_full().flex_1().min_w(0)
              .accessibility_label(`Use ${choice.name} for Auto. ${status}`).on_change((checked, cx) => {
                const saved = (shared('herdr-zed.auto-accounts') || []).filter(item => item !== key);
                setShared('herdr-zed.auto-accounts', checked ? [...saved, key] : saved);
                cx.notify();
              }).child(AgentIcon(choice.agent, t).flex_none()).child(div().truncate().text_size(13)
                  .child(this.accountName(choice.agent, choice.name)))
              .when(Boolean(plan), el => el.child(div().id(`auto-plan-${key}`).flex_none().text_size(12).text_color(t.muted).child(plan))))
            .when(selected && key === next, el => el.child(div().id(`auto-next-${key}`).flex_none()
              .text_size(12).font_medium().text_color(t.foreground).child('Next')))
            .child(div().id(`auto-standing-${key}`).flex_none().text_size(12).text_color(t.muted).child(status))
            .child(ToggleGroup(`auto-multiplier-${key}`, `${choice.name} plan size`, t)
              .children(autoMultipliers.map((value, position) => ToggleGroupItem(`auto-multiplier-${key}-${value}`,
                size === value, position === 0, t)
                .accessibility_label(`${choice.name} plan size ×${value}`)
                .on_change((_pressed, cx) => { setMultiplier(key, value); cx.notify(); })
                .child(`×${value}`))));
        })));
  },

  // One list for what New thread and Usage show, in their shared order, with Auto below.
  agentsPage(choices, hidden, toggle, move, cancelDrag, t) {
    const usageHidden = shared('herdr-zed.hidden-usage-profiles') || [];
    const toggleUsage = (agent, checked, cx) => {
      if (!usageProvider(agent)) return;
      const key = agent.key;
      const saved = shared('herdr-zed.hidden-usage-profiles') || [];
      setShared('herdr-zed.hidden-usage-profiles', checked ? saved.filter(item => item !== key) : [...new Set([...saved, key])]);
      cx.notify();
    };
    // Usage lists native agents and accounts; Terminal and profiles share their account's quota.
    const usageEligible = choice => Boolean(usageProvider(choice.agent));
    // Remote projects have no local quota readings, so they show only New thread.
    const local = !spaces().find(space => space.id === (props() || {}).space)?.machine;
    const column = (id, child) => div().id(id).w(96).flex_none().flex().items_center().justify_center().child(child);
    return v_flex().id('manage-launchers-list').flex_1().min_h(0).overflow_y_scroll().gap(8)
        .child(h_flex().id('manage-columns').flex_none().h(20).px(8).items_center().text_size(11).text_color(t.muted)
          .child(div().flex_1()).child(column('manage-column-session', 'New thread')).when(local, el => el.child(column('manage-column-usage', 'Usage'))))
        // One bordered table per section; rows are separated by rules and hover with t.selected.
        .children([0, 1, 2, 3].filter(group => choices.some(choice => choice.group === group)).map(group => v_flex().flex_none().gap(4)
          .when(group > 0, el => el.mt(8))
          .child(DropdownMenuLabel(t).id(`manage-section-${group}`).px(0).child(launcherSections[group].toUpperCase()))
          .child(v_flex().flex_none().border(1).border_color(t.border)
            .children(choices.map((choice, index) => [choice, index]).filter(([choice]) => choice.group === group).map(([choice, index], position) =>
              v_flex().id(`manage-${choice.key}`).flex_none()
                .when(position > 0, el => el.border_t(1).border_color(t.border))
                // Hover uses t.hover; t.selected marks the keyboard row only, so the two never look alike.
                .bg(this.manageIndex === index ? t.selected : t.popover).hover(el => el.bg(this.manageIndex === index ? t.selected : t.hover))
                .opacity(this.dragKey === choice.key ? 0.5 : 1)
                .on_mouse_move((_event, cx) => {
                  if (this.dragKey && this.dropKey !== choice.key) { this.dropKey = choice.key; cx.notify(); }
                })
                .on_mouse_up('left', (_event, cx) => {
                  if (!this.dragKey) return;
                  move(choices.findIndex(item => item.key === this.dragKey), index, cx);
                  cancelDrag(cx); cx.stop_propagation();
                })
                .child(h_flex().h(44).px(8).gap(8).items_center()
                  .when(choice.group !== 0, el => el.child(Button(`drag-${choice.key}`, t, { variant: 'row', size: 'icon' }).cursor_grab()
                    .accessibility_label(`Reorder ${choice.name}. Use Alt + Up or Down.`).tooltip(`Reorder ${choice.name}. Use Alt + Up or Down.`)
                    .on_mouse_down('left', (_event, cx) => {
                      cx.stop_propagation(); this.handle?.focus();
                      this.dragKey = choice.key; this.dropKey = choice.key; this.manageIndex = index; cx.notify();
                    }).child(glyph('grip-vertical'))))
                  .when(choice.group === 0, el => el.child(div().size(28).flex_none()))
                  .child(AgentIcon(choice.agent, t).flex_none())
                  .child(div().flex_1().min_w(0).truncate().text_size(13).child(this.pickerName(choice.agent, choice.name)))
                  .child(column(`manage-session-${choice.key}`, Checkbox(`show-${choice.key}`, !hidden.includes(choice.key), t)
                    .accessibility_label(`Show ${choice.name} in New thread`).on_change((_checked, cx) => toggle(choice.key, cx))))
                  .when(local, el => el.child(column(`manage-usage-${choice.key}`, usageEligible(choice)
                    ? Checkbox(`usage-profile-${choice.agent.key}`, !usageHidden.includes(choice.agent.key), t)
                      .accessibility_label(`Show ${choice.name} in Usage`).on_change((checked, cx) => toggleUsage(choice.agent, checked, cx))
                    : div().tooltip('Usage is unavailable for this program or shared with its account')
                      .child(Checkbox(`usage-profile-${choice.agent?.key || choice.key}`, false, t, { indeterminate: true, disabled: true })
                        .accessibility_label(`Usage unavailable for ${choice.name}`)))))))))))
        .when(local, el => el.child(this.autoAccountsSection(choices.filter(usageEligible), t)))
        .when(this.loading, el => el.child(div().p(8).text_size(12).text_color(t.muted).child('Loading agents…')))
        .when(this.launchError, el => el.child(Button('manage-retry-agents', t, { variant: 'secondary' })
          .on_click((_event, cx) => this.loadAgents(cx)).child('Could not load agents. Retry')));
  },

  // The effective New thread binding, formatted for this platform.

  launcher(t) {
    const available = this.availableAgents(this.launchers, spaces().find(space => space.id === (props() || {}).space)?.machine);
    const hidden = shared('herdr-zed.hidden-launchers') || [];
    const choices = launcherChoices(available, shared('herdr-zed.launcher-order') || []).filter(choice => !hidden.includes(choice.key));
    const launchers = choices.filter(choice => choice.agent).map(choice => choice.agent);
    const target = props(), machine = spaces().find(space => space.id === target.space)?.machine || '';
    const remembered = this.defaultThreadChoice({ id: target.space, folder: target.folder, machine }, this.launchers);
    const last = remembered.auto ? 'auto' : remembered.agent?.key;
    const auto = this.autoThreadAgent(this.launchers, machine);
    // Show the binding only beside the agent that New thread will actually launch.
    const shortcutLabel = this.newThreadShortcut();
    const row = (id, name, icon, action) => DropdownMenuItem(id, t).on_click(action)
      .child(div().size(16).flex_none().flex().items_center().justify_center().text_color(t.muted).child(icon))
      .child(div().flex_1().min_w(0).truncate().child(name));
    return DropdownMenuContent('thread-launcher', undefined, t)
      .track_focus(this.handle).on_key_down(event => {
        if (event.modifiers.control || event.modifiers.platform || event.modifiers.alt) return;
        const agent = /^[1-9]$/.test(event.key) ? launchers[Number(event.key) - 1] : null;
        if (agent?.installed) this.startThread(agent);
      })
      .child(v_flex().id('thread-launchers').flex_none().gap(1)
        .children(choices.flatMap((choice, i) => {
          const agent = choice.agent;
          return [
            ...(i > 0 && choices[i - 1].group !== choice.group ? [DropdownMenuSeparator(t)] : []),
            ...(choice.group !== 0 && (i === 0 || choices[i - 1].group !== choice.group)
              ? [DropdownMenuLabel(t).id(`launcher-section-${choice.group}`).child(launcherSections[choice.group])] : []),
            row(agent ? `start-${agent.key}` : 'new-terminal', this.pickerName(agent, choice.name), AgentIcon(agent, t),
              () => this.startThread(agent))
              .when(Boolean(agent && agent.key === last && shortcutLabel), el => el
                .child(div().text_size(11).text_color(t.muted).child(shortcutLabel))),
            // Preview the current pick; resolve again on click as quotas may change.
            ...(choice.group === 0 && auto ? [row('start-auto', `Auto · ${this.pickerName(auto, launcherLabel(auto.name))}`, AgentIcon(auto, t),
              () => this.startThread(this.autoThreadAgent(this.launchers, machine), props(), { auto: true }))
              .accessibility_label(`Auto: next account ${launcherLabel(auto.name)}`)
              .when(Boolean(last === 'auto' && shortcutLabel), el => el
                .child(div().text_size(11).text_color(t.muted).child(shortcutLabel)))] : []),
          ];
        }))
        .when(Boolean(this.startError), el => el.child(div().id('launch-error').p(10).text_size(12).text_color(t.error ?? t.muted)
          .accessibility_label(`Could not start session: ${this.startError}`).child(this.startError)))
        .when(this.loading, el => el.child(div().p(10).text_size(12).text_color(t.muted).child('Loading agents…')))
        .when(this.launchError, el => el.child(div().id('retry-agents').p(10).text_size(12).text_color(t.muted).cursor_pointer()
          .on_click((_event, cx) => this.loadAgents(cx)).child('Could not load agents. Click to retry.')))
        .when(!this.loading && !this.launchError && !choices.length, el => el.child(div().p(10).text_size(12).text_color(t.muted)
          .child(this.launchers.length ? 'All agents are hidden. Show them in Agent settings → New thread.' : 'No installed agents found.'))));
  },
};
