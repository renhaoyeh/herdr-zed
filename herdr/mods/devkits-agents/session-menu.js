import { availableAgents, loadAccountIdentities } from './discovery.js';
import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { shared, setShared, props, spaces, openOverlay, closeOverlay, home, readTextFile, keys, window, exec, appHome } from 'herdr';
import { launcherChoices, launcherLabel, launcherOption, accountAddresses, noAccountLabel, permissionModes, sessionKind, isAccountLauncher, claudeModels, claudeEfforts, codexHome, codexModels, mergeModels, orderedOptions, moveOption, effortLabel, sessionChoices, settingsKey, profileSettings, configuredAgents, autoRank, autoMultipliers, autoMultiplier, planMultiplier, planLabel, quotaResetLabel } from './model.js';
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { Switch } from './components/switch.js';
import { ToggleGroup, ToggleGroupItem } from './components/toggle-group.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { glyph, AgentIcon } from './components/icon.js';
import { Select, SelectState } from './components/select.js';

const launcherSections = ['Terminal', 'Agents', 'Your accounts', 'Agent profiles'];
import { openAgentSettings, noAccount } from './components/agents.js';
// Accounts whose address was already requested in this app session.


// One Settings dialog for agents, reachable with or without an open project.


// The Add session menu and its Manage dialog. Mixed into the Agents view, which provides
// cachedAgents, startThread and the account actions (addAccount, renameAccount, confirmRemoveAccount).
export const sessionMenu = {
  availableAgents,
  initSessionMenu(cx) {
    if ((props() || {}).refreshAgents) setShared('devkits.agent-cache', {});
    this.launchers = [];
    this.manageIndex = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.loadAgents(cx);
    if ((props() || {}).view && !['manage-launchers', 'agent-profile-editor'].includes((props() || {}).view)) return;
    this.loadCodexModels(cx);
    // Former provider pages open their default account on Accounts.
    const page = (props() || {}).page || 'agents';
    // Former provider and Models pages open the same settings on Accounts.
    this.settingsPage = ['claude', 'codex', 'models'].includes(page) ? 'accounts' : page === 'usage' ? 'agents' : page;
    if (['claude', 'codex'].includes(page)) this.selectedAccount = page;
    this.defaultSelects = { permissions: new SelectState(cx), model: new SelectState(cx), effort: new SelectState(cx), profile: new SelectState(cx) };
    if ((props() || {}).view === 'agent-profile-editor') { this.initAgentProfileEditor(cx); return; }
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

  // Copy legacy provider defaults once, then keep every profile and named agent independent.

  profileModels(agent) {
    return this.codexModelsByHome?.get(codexHome(agent, home())) ?? this.codexModelList;
  },

  // Default adds no flag and leaves the profile's underlying configuration.
  providerDefaults(agent, draft = null) {
    const key = settingsKey(agent), kind = sessionKind(agent), modes = permissionModes(agent);
    const permission = draft ? draft.permission : shared('devkits.codex-permissions')?.[key] || 'default';
    const settings = shared('devkits.session-options')?.[kind] || {};
    const stored = draft || shared('devkits.profile-sessions')?.[key] || {};
    const saved = { model: settings.models?.includes(stored.model) ? null : stored.model,
      effort: settings.efforts?.includes(stored.effort) ? null : stored.effort };
    const { models, efforts } = sessionChoices(kind, this.profileModels(agent), settings, saved.model);
    const model = models.some(item => item.key === saved.model) ? saved.model : null;
    const effort = efforts.includes(saved.effort) ? saved.effort : null;
    // Read the saved choice when picking, so several picks before a repaint keep each other.
    const set = change => {
      if (draft) { Object.assign(draft, change); return; }
      const current = shared('devkits.profile-sessions')?.[key] || {};
      setShared('devkits.profile-sessions', { ...(shared('devkits.profile-sessions') || {}),
        [key]: { ...current, model: current.model ?? null, effort: current.effort ?? null, ...change } });
    };
    return [
      { id: 'permissions', label: 'Permissions', items: modes.map(mode => ({ key: mode.key, label: mode.label, checked: mode.key === permission,
        choose: () => {
          if (draft) { draft.permission = mode.key; return; }
          const saved = { ...(shared('devkits.codex-permissions') || {}) };
          if (mode.key === 'default') delete saved[key]; else saved[key] = mode.key;
          setShared('devkits.codex-permissions', saved);
        } })) },
      { id: 'model', label: 'Model', items: [{ key: 'default', label: 'Default' }, ...models].map(item => ({ key: item.key, label: item.label,
        checked: (item.key === 'default' ? null : item.key) === model, choose: () => {
          const next = item.key === 'default' ? null : item.key;
          const current = draft ? draft.effort : shared('devkits.profile-sessions')?.[key]?.effort ?? null;
          set({ model: next, effort: sessionChoices(kind, this.profileModels(agent), settings, next).efforts.includes(current) ? current : null });
        } })) },
      { id: 'effort', label: 'Effort', items: ['default', ...efforts].map(value => ({ key: value, label: value === 'default' ? 'Default' : effortLabel(value),
        checked: (value === 'default' ? null : value) === effort, choose: () => set({ effort: value === 'default' ? null : value }) })) },
      ...(kind === 'codex' ? [{ id: 'fast', label: 'Speed', checked: stored.serviceTier === 'fast',
        choose: checked => set({ serviceTier: checked ? 'fast' : null }) }] : [])];
  },

  // Like macOS and Zed settings: accounts grouped by provider on the left, the selected account on the right.
  // Its session defaults choose from the provider's shared Models in menus, so both sit together.
  accountsPage(t) {
    const agents = this.availableAgents(this.launchers).filter(agent => !agent.profileKey);
    const usage = shared('devkits.usage.snapshot')?.contexts?.[JSON.stringify(null)]?.usage || [];
    const order = shared('devkits.launcher-order') || [];
    const groups = ['claude', 'codex'].map(kind => ({ kind, name: kind === 'claude' ? 'Claude' : 'Codex',
      accounts: launcherChoices(agents.filter(agent => sessionKind(agent) === kind), order).map(choice => choice.agent).filter(Boolean) }));
    const all = groups.flatMap(group => group.accounts);
    const agent = all.find(item => item.key === this.selectedAccount) || all[0];
    return v_flex().id('settings-accounts').flex_1().min_h(0).gap(12)
      .child(DialogDescription(t).flex_none().child('Sign in to more Claude and Codex accounts. Each account keeps its own session defaults.'))
      .child(h_flex().flex_1().min_h(0).gap(16).items_start()
        .child(v_flex().id('accounts-list').w(220).flex_none().h_full().min_h(0).overflow_y_scroll().gap(12)
          .children(groups.map(group => {
            const installed = group.accounts.some(item => item.key === group.kind);
            return v_flex().id(`accounts-${group.kind}`).flex_none().gap(2)
              .child(h_flex().h(28).flex_none().gap(8).items_center()
                .child(DropdownMenuLabel(t).px(0).flex_1().child(group.name.toUpperCase()))
                .when(installed, el => el.child(Button(`add-${group.kind}-account`, t, { variant: 'ghost', size: 'icon' })
                  .accessibility_label(`Add a ${group.name} account`).on_click(() => this.addAccount(group.kind)).child(glyph('plus')))))
              .when(!group.accounts.length, el => el.child(div().py(4).text_size(12).text_color(t.muted)
                .child(this.loading ? 'Loading agents…' : `${group.kind === 'claude' ? 'Claude Code' : 'Codex CLI'} is not installed.`)))
              .children(group.accounts.map(item => Button(`account-${item.key}`, t, { variant: 'ghost' }).w_full().h(32).px(8).gap(8).justify_start()
                .bg(item.key === agent?.key ? t.selected : t.popover).text_color(item.key === agent?.key ? t.foreground : t.muted)
                .accessibility_label(`${launcherLabel(item.name || group.kind)}${item.key === agent?.key ? ', selected' : ''}`)
                .on_click((_event, cx) => {
                  for (const state of Object.values(this.defaultSelects || {})) state.open = false;
                  this.selectedAccount = item.key; cx.notify();
                })
                .child(AgentIcon(item, t).flex_none())
                .child(div().id(`account-list-name-${item.key}`).flex_1().min_w(0).truncate().text_size(13)
                  .when(this.accountName(item, launcherLabel(item.name || group.kind)) === noAccount, el => el.text_color(t.muted))
                  .child(this.accountName(item, launcherLabel(item.name || group.kind))))));
          })))
        .child(agent ? this.accountDetail(agent, usage, t)
          : div().flex_1().p(12).text_size(12).text_color(t.muted).child(this.loading ? 'Loading agents…' : 'Install Claude Code or Codex CLI to manage accounts.')));
  },

  accountDetail(agent, usage, t) {
    const kind = sessionKind(agent), name = kind === 'claude' ? 'Claude' : 'Codex';
    const label = this.accountName(agent, launcherLabel(agent.name || kind)), identity = this.accountIdentity(agent);
    // On the name's line: a named account's address, then the plan (a Default account already uses its address as the name).
    const about = [identity.email !== label && identity.email, planLabel(identity.plan)].filter(Boolean).join(' · ');
    return v_flex().id(`account-detail-${agent.key}`).flex_1().min_w(0).h_full().min_h(0).overflow_y_scroll().gap(12)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(AgentIcon(agent, t).flex_none())
        // One centered line: name · address · plan, the details muted.
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().flex_none().max_w_full().truncate().text_size(15).font_medium().when(label === noAccount, el => el.text_color(t.muted)).child(label))
          .when(Boolean(about), el => el.child(div().flex_none().text_size(13).text_color(t.muted).child('·'))
            .child(div().id(`account-email-${agent.key}`).flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(about))))
        .when(isAccountLauncher(agent), el => el
          .child(Button(`account-actions-${agent.key}-rename`, t, { variant: 'secondary' }).h(28)
            .on_click(() => this.renameAccount(agent)).child('Rename'))
          .child(Button(`account-actions-${agent.key}-remove`, t, { variant: 'secondary' }).h(28)
            .text_color(t.destructive || t.ansi1).on_click(() => this.confirmRemoveAccount(agent)).child('Remove'))))
      .child(v_flex().id(`account-defaults-panel-${agent.key}`).flex_none().gap(8).mt(4)
        .child(DropdownMenuLabel(t).px(0).child('SESSION DEFAULTS'))
        .child(div().text_size(12).text_color(t.muted).child(`For new sessions started with ${label}. Model choices come from the list below.`))
        .child(this.configurationFields(agent, t)))
      .child(v_flex().flex_none().gap(8).mt(8)
        .child(DropdownMenuLabel(t).px(0).child(`MODELS IN MENUS · ALL ${name.toUpperCase()} ACCOUNTS`))
        .child(div().text_size(12).text_color(t.muted)
          .child(`Which models and efforts every ${name} Model and Effort menu offers, including profiles. Drag to reorder.`))
        .children(this.sessionOptions([kind], t)));
  },

  configurationAccountPicker(profiles, profile, choose, t) {
    return h_flex().flex_none().gap(12).items_center()
      .child(div().w(108).flex_none().text_size(13).child('Account'))
      .child(Select('defaults-profile', this.defaultSelects.profile, profile.key,
        profiles.map(item => ({ ...launcherOption(item), color: t.foreground })), 'Account', key => {
          for (const state of Object.values(this.defaultSelects)) state.open = false;
          choose(key);
        }, t, { width: 240, boxed: true }));
  },

  configurationFields(agent, t, draft = null) {
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
        const options = section.items.map((item, index) => ({ key: item.key, label: item.label,
          color: section.id === 'permissions' ? colors[index] : item.key === 'default' ? t.muted : t.foreground }));
        return h_flex().flex_none().gap(12).items_center()
          .child(div().w(108).flex_none().text_size(13).child(section.label))
          .child(Select(`defaults-${section.id}`, this.defaultSelects[section.id], value, options, `Default ${section.label.toLowerCase()}`,
            key => section.items.find(item => item.key === key)?.choose(), t, { width: 240, boxed: true }));
      }));
  },

  // Which models and efforts Asana's session composer offers, like Cursor's model list: one row and switch per model,
  // and efforts as joined segments as in Claude Code and Codex. Turned-off ones are hidden; Default always stays.
  sessionOptions(kinds, t) {
    const saved = shared('devkits.session-options') || {};
    const shown = (kind, field, key) => !(saved[kind]?.[field] || []).includes(key);
    const toggle = (kind, field, key) => {
      const current = shared('devkits.session-options') || {};
      const hidden = current[kind]?.[field] || [];
      setShared('devkits.session-options', { ...current, [kind]: { ...current[kind],
        [field]: hidden.includes(key) ? hidden.filter(item => item !== key) : [...hidden, key] } });
      if (!hidden.includes(key)) {
        const profiles = { ...(shared('devkits.profile-sessions') || {}) };
        for (const [profileKey, profile] of Object.entries(profiles)) {
          const profileAgent = configuredAgents(this.launchers, shared('devkits.agent-configs') || []).find(agent => agent.key === profileKey) || { key: profileKey };
          if (sessionKind(profileAgent) !== kind) continue;
          const setting = field === 'models' ? 'model' : 'effort';
          if (profile[setting] === key) profiles[profileKey] = { ...profile, [setting]: null };
        }
        setShared('devkits.profile-sessions', profiles);
      }
    };
    const title = effortLabel;
    // One card per provider, shown beside the selected account's session defaults.
    return kinds.map(kind => {
        const models = orderedOptions(kind === 'claude' ? claudeModels : this.codexModelList || [], saved[kind]?.order);
        const reorder = (key, target) => {
          const current = shared('devkits.session-options') || {};
          setShared('devkits.session-options', { ...current, [kind]: { ...current[kind], order: moveOption(models.map(model => model.key), key, target) } });
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
              .accessibility_label(`Reorder ${model.label}`)
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
    const cached = shared('devkits.agent-cache')?.[JSON.stringify(machine || null)];
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
    const reading = (shared('devkits.usage.snapshot')?.contexts?.[JSON.stringify(null)]?.usage || []).find(item => item.key === key);
    const saved = shared('devkits.account-identities')?.[key];
    return { email: reading?.email || saved?.email || null, plan: reading?.plan || saved?.plan || null };
  },

  // A Default account is named by its signed-in address, or a muted No account when none is known;
  // named accounts keep their own name. Every account list uses this one rule.
  accountName(agent, label) {
    if (label !== 'Default account' || !agent || agent.profileKey || !['claude', 'codex'].includes(sessionKind(agent))) return label;
    return launcherOption(agent, accountAddresses(shared)).label;
  },

  // Usage reads only the accounts it shows, so read every other local account's address once per app session
  // through the same credential-free reader, and share it with every account label.
  loadAccountIdentities(cx, agents = this.launchers) {
    loadAccountIdentities(cx, agents, spaces().find(space => space.id === (props() || {}).space)?.machine);
  },

  syncAccountChanges(cx) {
    if (this.settingsPage === 'accounts') this.loadAccountIdentities(cx);
    const revision = shared('devkits.profile-revision') || 0;
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

  manageLaunchers(t) {
    const hidden = shared('devkits.hidden-launchers') || [];
    const choices = launcherChoices(this.availableAgents(this.launchers, spaces().find(space => space.id === (props() || {}).space)?.machine), shared('devkits.launcher-order') || []);
    const local = !spaces().find(space => space.id === (props() || {}).space)?.machine;
    const toggle = (key, cx) => {
      const current = shared('devkits.hidden-launchers') || [];
      setShared('devkits.hidden-launchers', current.includes(key) ? current.filter(item => item !== key) : [...current, key]);
      cx.notify();
    };
    const done = () => closeOverlay((props() || {}).overlay);
    const move = (index, target, cx) => {
      if (!choices[index] || !choices[target] || choices[index].group !== choices[target].group || index === target) return;
      const order = [...new Set([...(shared('devkits.launcher-order') || []), ...choices.map(choice => choice.key)])];
      const key = choices[index].key;
      order.splice(order.indexOf(key), 1);
      order.splice(order.indexOf(choices[target].key) + (index < target ? 1 : 0), 0, key);
      setShared('devkits.launcher-order', order);
      this.manageIndex = target;
      cx.notify();
    };
    const cancelDrag = cx => {
      if (!this.dragKey && !this.modelDrag) return;
      this.dragKey = null; this.dropKey = null; this.modelDrag = null; this.modelDrop = null;
      cx.notify();
    };
    // Like Zed's settings, one page per subject in a left list, ordered as a new user sets things up:
    // accounts first, then what Add session shows, then the optional extras.
    const pages = [...(local ? [{ id: 'accounts', label: 'Accounts', icon: glyph('user-round') }] : []),
      { id: 'agents', label: 'Agents', icon: glyph('square-plus') },
      ...(local ? [{ id: 'agent-profiles', label: 'Profiles', icon: glyph('agent') }] : [])];
    const page = pages.some(item => item.id === this.settingsPage) ? this.settingsPage : 'agents';
    return DialogContent('manage-launchers', t).accessibility_label('Settings')
      .on_mouse_up('left', (_event, cx) => cancelDrag(cx))
      .on_hover((inside, cx) => { if (!inside) cancelDrag(cx); })
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') {
          if (this.dragKey || this.modelDrag) cancelDrag(cx); else done();
          cx.stop_propagation(); return;
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
      .child(DialogTitle().flex_none().child('Settings'))
      .child(h_flex().flex_1().min_h(0).gap(16).items_start()
        .child(v_flex().id('settings-pages').w(140).flex_none().gap(2)
          .children(pages.map(item => Button(`settings-page-${item.id}`, t, { variant: 'ghost' }).h(32).px(8).gap(8).justify_start()
            .bg(item.id === page ? t.selected : t.popover).text_color(item.id === page ? t.foreground : t.muted)
            .accessibility_label(`${item.label} settings${item.id === page ? ', selected' : ''}`)
            .on_click((_event, cx) => { this.settingsPage = item.id; cancelDrag(cx); cx.notify(); })
            .child(div().size(16).flex_none().flex().items_center().justify_center().child(item.icon)).child(item.label))))
        .child(v_flex().h_full().flex_1().min_w(0).min_h(0).gap(8)
          .when(page === 'accounts', el => el.child(this.accountsPage(t)))
          .when(page === 'agents', el => el.child(DialogDescription(t).flex_none().child('Choose what Add session and Usage show, in one order. Drag to reorder; changes save automatically. Agents using the same account share its quota.'))
            .child(this.agentsPage(choices, hidden, toggle, move, cancelDrag, t)))
          .when(page === 'agent-profiles', el => el.child(this.agentProfilesPage(t)))))
      .child(DialogFooter().flex_none().child(Button('manage-launchers-done', t).on_click(done).child('Done')));
  },

  // Auto in Add session starts one of these accounts, chosen by quota at each launch.
  // The rules and each account's current standing are shown, so the pick is predictable.
  autoAccountsSection(profiles, t) {
    const members = shared('devkits.auto-accounts') || [];
    const multipliers = shared('devkits.auto-multipliers') || {};
    const hiddenUsage = shared('devkits.hidden-usage-profiles') || [];
    const accounts = profiles.filter(choice => choice.group === 2 && !hiddenUsage.includes(choice.agent.key));
    const usage = shared('devkits.usage.snapshot')?.contexts?.[JSON.stringify(null)]?.usage || [];
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
      '3. Multiply by the account’s plan size to get its Room, and start the account with the most Room. Ties follow Add session order.',
      'Plan size follows each account’s detected plan: ×1 for ChatGPT Plus, Business or Claude Pro; ×5 for ChatGPT Pro $100 or Claude Max 5x; ×20 for ChatGPT Pro $200 or Claude Max 20x. Choose another size to override it, or the detected size to follow the plan again.',
      'Only accounts shown in Usage above can join Auto. Accounts without a reading count as on pace. A session keeps the account it started with.'];
    const setMultiplier = (key, value) => {
      const saved = { ...(shared('devkits.auto-multipliers') || {}) };
      if (value === planMultiplier(reading(key)?.plan)) delete saved[key]; else saved[key] = value;
      setShared('devkits.auto-multipliers', saved);
    };
    return v_flex().id('auto-account-settings').flex_none().gap(4)
      .child(h_flex().flex_none().mt(8).gap(8).items_center()
        .child(DropdownMenuLabel(t).px(0).flex_1().child('AUTO'))
        .child(Button('auto-rules-toggle', t, { variant: 'ghost' }).h(24).px(6).gap(4).text_size(12)
          .on_click((_event, cx) => { this.autoRulesOpen = !this.autoRulesOpen; cx.notify(); })
          .child('How Auto chooses').child(glyph(this.autoRulesOpen ? 'chevron-up' : 'chevron-down', 12))))
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
                const saved = (shared('devkits.auto-accounts') || []).filter(item => item !== key);
                setShared('devkits.auto-accounts', checked ? [...saved, key] : saved);
                cx.notify();
              }).child(AgentIcon(choice.agent, t).flex_none()).child(div().truncate().text_size(13)
                  .when(this.accountName(choice.agent, choice.name) === noAccount, el => el.text_color(t.muted)).child(this.accountName(choice.agent, choice.name)))
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

  // One list for what Add session and Usage show, in their shared order, with Auto below.
  agentsPage(choices, hidden, toggle, move, cancelDrag, t) {
    const usageHidden = shared('devkits.hidden-usage-profiles') || [];
    const toggleUsage = (key, checked, cx) => {
      const saved = shared('devkits.hidden-usage-profiles') || [];
      setShared('devkits.hidden-usage-profiles', checked ? saved.filter(item => item !== key) : [...new Set([...saved, key])]);
      cx.notify();
    };
    // Usage lists native agents and accounts; Terminal and profiles share their account's quota.
    const usageEligible = choice => Boolean(choice.agent && !choice.agent.profileKey);
    // Remote projects have no local quota readings, so they show only Add session.
    const local = !spaces().find(space => space.id === (props() || {}).space)?.machine;
    const column = (id, child) => div().id(id).w(96).flex_none().flex().items_center().justify_center().child(child);
    return v_flex().id('manage-launchers-list').flex_1().min_h(0).overflow_y_scroll().gap(8)
        .child(h_flex().id('manage-columns').flex_none().h(20).px(8).items_center().text_size(11).text_color(t.muted)
          .child(div().flex_1()).child(column('manage-column-session', 'Add session')).when(local, el => el.child(column('manage-column-usage', 'Usage'))))
        // One bordered table per section; rows are separated by rules and hover with t.selected.
        .children([0, 1, 2, 3].filter(group => choices.some(choice => choice.group === group)).map(group => v_flex().flex_none().gap(4)
          .when(group > 0, el => el.mt(8))
          .child(DropdownMenuLabel(t).id(`manage-section-${group}`).px(0).child(launcherSections[group].toUpperCase()))
          .child(v_flex().flex_none().border(1).border_color(t.border)
            .children(choices.map((choice, index) => [choice, index]).filter(([choice]) => choice.group === group).map(([choice, index], position) =>
              v_flex().id(`manage-${choice.key}`).flex_none()
                .when(position > 0, el => el.border_t(1).border_color(t.border))
                .bg(this.manageIndex === index ? t.selected : t.popover)
                .opacity(this.dragKey === choice.key ? 0.5 : 1)
                .on_hover((inside, cx) => { if (inside) { this.manageIndex = index; cx.notify(); } })
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
                    .accessibility_label(`Reorder ${choice.name}. Use Alt + Up or Down.`)
                    .on_mouse_down('left', (_event, cx) => {
                      cx.stop_propagation(); this.handle?.focus();
                      this.dragKey = choice.key; this.dropKey = choice.key; this.manageIndex = index; cx.notify();
                    }).child(glyph('grip-vertical'))))
                  .when(choice.group === 0, el => el.child(div().size(28).flex_none()))
                  .child(AgentIcon(choice.agent, t).flex_none())
                  .child(div().flex_1().min_w(0).truncate().text_size(13)
                    .when(this.accountName(choice.agent, choice.name) === noAccount, el => el.text_color(t.muted))
                    .child(this.accountName(choice.agent, choice.name)))
                  .child(column(`manage-session-${choice.key}`, Checkbox(`show-${choice.key}`, !hidden.includes(choice.key), t)
                    .accessibility_label(`Show ${choice.name} in Add session`).on_change((_checked, cx) => toggle(choice.key, cx))))
                  .when(local, el => el.child(column(`manage-usage-${choice.key}`, usageEligible(choice)
                    ? Checkbox(`usage-profile-${choice.agent.key}`, !usageHidden.includes(choice.agent.key), t)
                      .accessibility_label(`Show ${choice.name} in Usage`).on_change((checked, cx) => toggleUsage(choice.agent.key, checked, cx))
                    : div().text_size(12).text_color(t.muted).child('–'))))))))))
        .when(local, el => el.child(this.autoAccountsSection(choices.filter(usageEligible), t)))
        .when(this.loading, el => el.child(div().p(8).text_size(12).text_color(t.muted).child('Loading agents…')))
        .when(this.launchError, el => el.child(Button('manage-retry-agents', t, { variant: 'secondary' })
          .on_click((_event, cx) => this.loadAgents(cx)).child('Could not load agents. Retry')));
  },

  // The effective New thread binding, formatted for this platform.

  launcher(t) {
    const available = this.availableAgents(this.launchers, spaces().find(space => space.id === (props() || {}).space)?.machine);
    const hidden = shared('devkits.hidden-launchers') || [];
    const choices = launcherChoices(available, shared('devkits.launcher-order') || []).filter(choice => !hidden.includes(choice.key));
    const launchers = choices.filter(choice => choice.agent).map(choice => choice.agent);
    const target = props(), machine = spaces().find(space => space.id === target.space)?.machine || '';
    const remembered = this.defaultThreadChoice({ id: target.space, folder: target.folder, machine }, this.launchers);
    const last = remembered.auto ? 'auto' : remembered.agent?.key;
    const auto = this.autoThreadAgent(this.launchers, machine);
    // Show the binding only beside the agent that New thread will actually launch.
    const shortcutLabel = this.newThreadShortcut();
    const row = (id, name, icon, action) => DropdownMenuItem(id, t).on_click(action)
      .child(div().size(16).flex_none().flex().items_center().justify_center().text_color(t.muted).child(icon))
      .child(div().flex_1().min_w(0).truncate().when(name === noAccount, el => el.text_color(t.muted)).child(name));
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
            row(agent ? `start-${agent.key}` : 'new-terminal', this.accountName(agent, choice.name), AgentIcon(agent, t),
              () => this.startThread(agent))
              .when(Boolean(agent && agent.key === last && shortcutLabel), el => el
                .child(div().text_size(11).text_color(t.muted).child(shortcutLabel))),
            // Preview the current pick; resolve again on click as quotas may change.
            ...(choice.group === 0 && auto ? [row('start-auto', `Auto · ${launcherLabel(auto.name)}`, AgentIcon(auto, t),
              () => this.startThread(this.autoThreadAgent(this.launchers, machine), props(), { auto: true }))
              .accessibility_label(`Auto: next account ${launcherLabel(auto.name)}`)
              .when(Boolean(last === 'auto' && shortcutLabel), el => el
                .child(div().text_size(11).text_color(t.muted).child(shortcutLabel)))] : []),
          ];
        }))
        .when(this.loading, el => el.child(div().p(10).text_size(12).text_color(t.muted).child('Loading agents…')))
        .when(this.launchError, el => el.child(div().id('retry-agents').p(10).text_size(12).text_color(t.muted).cursor_pointer()
          .on_click((_event, cx) => this.loadAgents(cx)).child('Could not load agents. Click to retry.')))
        .when(!this.loading && !this.launchError && !choices.length, el => el.child(div().p(10).text_size(12).text_color(t.muted)
          .child(this.launchers.length ? 'All agents are hidden. Show them in Agent settings → Add session.' : 'No installed agents found.'))));
  },
};
