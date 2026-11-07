import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { shared, setShared, props, spaces, openOverlay, closeOverlay, home, readTextFile } from 'herdr';
import { launcherChoices, permissionModes, sessionKind, claudeModels, claudeEfforts, codexHome, codexModels, mergeModels, orderedOptions, moveOption, effortLabel, sessionChoices } from './model.js';
import { DropdownMenu, DropdownMenuState, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { Switch } from './components/switch.js';
import { ToggleGroup, ToggleGroupItem } from './components/toggle-group.js';
import { Select, SelectState } from './components/select.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { glyph, AgentIcon } from './components/icon.js';
import { rulesPath, editRules } from './global-rules.js';

const launcherSections = ['Terminal', 'Agents', 'Your accounts'];

// The Add session menu and its Manage dialog. Mixed into the Devkits view, which provides
// cachedAgents, startThread and the account actions (addAccount, renameAccount, openCodexSharing, confirmRemoveAccount).
export const sessionMenu = {
  initSessionMenu(cx) {
    if (props().refreshAgents) setShared('devkits.agent-cache', {});
    this.launchers = [];
    this.permissionSelects = new Map();
    this.manageIndex = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.loadAgents(cx);
    if (props().view === 'manage-launchers') this.loadCodexModels(cx);
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

  // A profile's settings line under its name: default permissions and, for local profiles, the model and effort
  // every new session starts with. Default adds no flag and leaves the profile's own Claude Code or Codex configuration.
  profileSettings(agent, local, t) {
    const key = agent.key, kind = sessionKind(agent);
    const colors = [t.muted, t.done, t.working, t.ansi1];
    // Labels sit above bordered selects whose left edges line up with the profile name.
    const line = h_flex().id(`profile-settings-${key}`).pl(92).pr(8).pb(12).gap(8).items_center()
      .child(Select(`permissions-${key}`, this.permissionSelects.get(key), shared('devkits.codex-permissions')?.[key] || 'default',
        permissionModes(agent).map((mode, index) => ({ ...mode, color: colors[index] })), `Default permissions for ${agent.name}`, mode => {
          const saved = { ...(shared('devkits.codex-permissions') || {}) };
          if (mode === 'default') delete saved[key]; else saved[key] = mode;
          setShared('devkits.codex-permissions', saved);
        }, t, { width: 168, prefix: 'Permissions', boxed: true }));
    const selects = this.sessionSelects?.get(key);
    if (!local || !kind || !selects) return line;
    const settings = shared('devkits.session-options')?.[kind] || {};
    const stored = shared('devkits.profile-sessions')?.[key] || {};
    const saved = { model: settings.models?.includes(stored.model) ? null : stored.model,
      effort: settings.efforts?.includes(stored.effort) ? null : stored.effort };
    const codexList = this.codexModelsByHome?.get(codexHome(agent, home())) || this.codexModelList;
    const { models, efforts } = sessionChoices(kind, codexList, settings, saved.model);
    const set = change => setShared('devkits.profile-sessions', { ...(shared('devkits.profile-sessions') || {}),
      [key]: { model: saved.model || null, effort: saved.effort || null, ...change } });
    const option = (value, label) => ({ key: value, label, color: value === 'default' ? t.muted : t.foreground });
    return line
      .child(Select(`profile-model-${key}`, selects.model, models.some(item => item.key === saved.model) ? saved.model : 'default',
        [option('default', 'Default'), ...models.map(item => option(item.key, item.label))], `Default model for ${agent.name}`,
        value => {
          const model = value === 'default' ? null : value;
          const supported = sessionChoices(kind, codexList, settings, model).efforts;
          set({ model, effort: supported.includes(saved.effort) ? saved.effort : null });
        }, t, { width: 168, prefix: 'Model', boxed: true }))
      .child(Select(`profile-effort-${key}`, selects.effort, efforts.includes(saved.effort) ? saved.effort : 'default',
        [option('default', 'Default'), ...efforts.map(item => option(item, effortLabel(item)))], `Default effort for ${agent.name}`,
        value => set({ effort: value === 'default' ? null : value }), t, { width: 168, prefix: 'Effort', boxed: true }));
  },

  // Which models and efforts Asana's session composer offers, like Cursor's model list: one row and switch per model,
  // and efforts as joined segments as in Claude Code and Codex. Turned-off ones are hidden; Default always stays.
  sessionOptions(choices, t) {
    const kinds = ['claude', 'codex'].filter(kind => choices.some(choice => sessionKind(choice.agent) === kind));
    if (!kinds.length) return [];
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
          if (sessionKind({ key: profileKey }) !== kind) continue;
          const setting = field === 'models' ? 'model' : 'effort';
          if (profile[setting] === key) profiles[profileKey] = { ...profile, [setting]: null };
        }
        setShared('devkits.profile-sessions', profiles);
      }
    };
    const title = effortLabel;
    return [DropdownMenuLabel(t).id('manage-section-session').px(0).mt(16).child('MODELS AND EFFORT'),
      ...kinds.map(kind => {
        const models = orderedOptions(kind === 'claude' ? claudeModels : this.codexModelList || [], saved[kind]?.order);
        const reorder = (key, target) => {
          const current = shared('devkits.session-options') || {};
          setShared('devkits.session-options', { ...current, [kind]: { ...current[kind], order: moveOption(models.map(model => model.key), key, target) } });
        };
        const dragging = this.modelDrag?.kind === kind;
        const efforts = kind === 'claude' ? claudeEfforts : [...new Set(models.flatMap(model => model.efforts))];
        const count = models.filter(model => shown(kind, 'models', model.key)).length;
        return v_flex().id(`session-options-${kind}`).mb(8).flex_none().border(1).border_color(t.border)
          .child(h_flex().h(36).px(12).gap(8).items_center().border_b(1).border_color(t.border)
            .child(div().flex_1().text_size(13).font_medium().child(kind === 'claude' ? 'Claude' : 'Codex'))
            .when(models.length > 0, el => el.child(div().text_size(12).text_color(t.muted).child(`${count} of ${models.length} models`))))
          .when(!models.length, el => el.child(div().h(36).px(12).flex().items_center().text_size(12).text_color(t.muted).child('Loading models…')))
          // Drag a model by its handle to set the Model menu's order, as launchers are dragged above.
          .children(models.map((model, index) => h_flex().id(`session-${kind}-model-${model.key}`).h(36).pl(4).pr(12).gap(8).items_center()
            .when(index > 0, el => el.border_t(1).border_color(t.border))
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
      })];
  },

  editGlobalRules() { return editRules(); },

  globalRules(t) {
    const path = rulesPath(), shown = path.startsWith(`${home()}/`) ? `~${path.slice(home().length)}` : path;
    return v_flex().flex_none().gap(4).mt(8)
      .child(DropdownMenuLabel(t).id('manage-section-rules').px(0).child('GLOBAL RULES'))
      .child(div().text_size(12).text_color(t.muted).child('Added to the system prompt of every Claude and Codex session started on this computer.'))
      .child(h_flex().h(44).px(12).gap(8).items_center().border(1).border_color(t.border)
        .child(glyph('file').text_color(t.muted))
        .child(div().flex_none().text_size(13).child('AGENTS.md'))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(shown))
        .child(Button('edit-global-rules', t, { variant: 'secondary' }).h(28).px(10)
          .accessibility_label('Edit global rules').on_click(() => this.editGlobalRules()).child('Edit')));
  },

  loadAgents(cx) {
    const machine = spaces().find(s => s.id === props().space)?.machine;
    const cached = shared('devkits.agent-cache')?.[JSON.stringify(machine || null)];
    if (cached) {
      this.launchers = cached;
      this.loading = false;
      this.launchError = false;
      if (props().view === 'manage-launchers') this.preparePermissionSelects(cx);
      return;
    }
    this.loading = true;
    this.launchError = false;
    cx.spawn(async cx => {
      try {
        this.launchers = await this.cachedAgents(machine);
        if (props().view === 'manage-launchers') this.preparePermissionSelects(cx);
      } catch { this.launchError = true; }
      this.loading = false;
      cx.notify();
    });
  },

  preparePermissionSelects(cx) {
    this.permissionSelects ||= new Map();
    this.sessionSelects ||= new Map();
    this.accountMenus ||= new Map();
    for (const agent of this.launchers) if (!this.accountMenus.has(agent.key)) this.accountMenus.set(agent.key, new DropdownMenuState(cx));
    for (const agent of this.launchers.filter(permissionModes)) {
      if (!this.permissionSelects.has(agent.key)) this.permissionSelects.set(agent.key, new SelectState(cx));
      if (!this.sessionSelects.has(agent.key)) this.sessionSelects.set(agent.key, { model: new SelectState(cx), effort: new SelectState(cx) });
    }
  },

  manageLaunchers(t) {
    const hidden = shared('devkits.hidden-launchers') || [];
    const choices = launcherChoices(this.launchers, shared('devkits.launcher-order') || []);
    const local = !spaces().find(space => space.id === props().space)?.machine;
    const toggle = (key, cx) => {
      const current = shared('devkits.hidden-launchers') || [];
      setShared('devkits.hidden-launchers', current.includes(key) ? current.filter(item => item !== key) : [...current, key]);
      cx.notify();
    };
    const done = () => closeOverlay(props().overlay);
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
      this.dragKey = null; this.dropKey = null; this.modelDrag = null; this.modelDrop = null; cx.notify();
    };
    return DialogContent('manage-launchers', t).accessibility_label('Manage session menu')
      .on_mouse_up('left', (_event, cx) => cancelDrag(cx))
      .on_hover((inside, cx) => { if (!inside) cancelDrag(cx); })
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') {
          if (this.dragKey || this.modelDrag) cancelDrag(cx); else done();
          cx.stop_propagation(); return;
        }
        if (event.modifiers?.alt && ['up', 'down'].includes(event.key)) {
          move(this.manageIndex, this.manageIndex + (event.key === 'up' ? -1 : 1), cx);
        } else if (event.key === 'down') this.manageIndex = (this.manageIndex + 1) % choices.length;
        else if (event.key === 'up') this.manageIndex = (this.manageIndex + choices.length - 1) % choices.length;
        else if (event.key === 'enter' || event.key === 'space') toggle(choices[this.manageIndex].key, cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(DialogTitle().child('Manage session menu'))
      .child(DialogDescription(t).child('Choose what Add session shows. Drag to reorder; changes save automatically.'))
      .child(v_flex().id('manage-launchers-list').flex_1().min_h(0).overflow_y_scroll().gap(8)
        // One bordered table per section; rows are separated by rules and hover with t.selected.
        .children([0, 1, 2].filter(group => choices.some(choice => choice.group === group)).map(group => v_flex().flex_none().gap(4)
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
                  .child(Checkbox(`show-${choice.key}`, !hidden.includes(choice.key), t).h_full().flex_1().min_w(0)
                    .accessibility_label(choice.name).on_change((_checked, cx) => toggle(choice.key, cx))
                    .child(AgentIcon(choice.agent, t).flex_none())
                    .child(div().flex_1().min_w(0).truncate().text_size(13).child(choice.name)))
                  .when(local && ['codex', 'claude'].includes(choice.agent?.key), el => el
                    .child(Button(`add-${choice.agent.key}-account`, t, { variant: 'secondary' }).h(28).px(10).gap(6)
                      .accessibility_label(`Add a ${choice.agent.key === 'codex' ? 'Codex' : 'Claude'} account`)
                      .on_click(() => this.addAccount(choice.agent.key)).child(glyph('plus')).child('Add account')))
                  // Account actions live in one menu so every row's controls line up.
                  .when(local && choice.group === 2 && Boolean(this.accountMenus?.get(choice.agent.key)), el => el
                    .child(DropdownMenu(`account-actions-${choice.agent.key}`, this.accountMenus.get(choice.agent.key),
                      Button(`account-menu-${choice.agent.key}`, t, { variant: 'row', size: 'icon' })
                        .accessibility_label(`Actions for ${choice.name}`).child(glyph('ellipsis')),
                      [{ key: 'rename', label: 'Rename' },
                        ...(choice.agent.key.startsWith('devkits-codex-') ? [{ key: 'sync', label: 'Shared plugins and skills…' }] : []),
                        { key: 'remove', label: 'Remove', separator: true }],
                      key => key === 'rename' ? this.renameAccount(choice.agent)
                        : key === 'sync' ? this.openCodexSharing(choice.agent) : this.confirmRemoveAccount(choice.agent), t))))
                .when(Boolean(permissionModes(choice.agent)) && Boolean(this.permissionSelects?.get(choice.agent.key)), el => el
                  .child(this.profileSettings(choice.agent, local, t))))))))
        .when(local && !this.loading && !this.launchError && !choices.some(choice => choice.group === 2), el => el
          .child(DropdownMenuLabel(t).id('manage-section-2').px(0).mt(16).child('YOUR ACCOUNTS'))
          .child(div().text_size(12).text_color(t.muted).child('No accounts added. Use Add account on the Codex or Claude row.')))
        .when(local && !this.loading && !this.launchError, el => el.children(this.sessionOptions(choices, t)).child(this.globalRules(t)))
        .when(this.loading, el => el.child(div().p(8).text_size(12).text_color(t.muted).child('Loading agents…')))
        .when(this.launchError, el => el.child(Button('manage-retry-agents', t, { variant: 'secondary' })
          .on_click((_event, cx) => this.loadAgents(cx)).child('Could not load agents. Retry'))))
      .child(DialogFooter().child(Button('manage-launchers-done', t).on_click(done).child('Done')));
  },

  launcher(t) {
    const hidden = shared('devkits.hidden-launchers') || [];
    const choices = launcherChoices(this.launchers, shared('devkits.launcher-order') || []).filter(choice => !hidden.includes(choice.key));
    const launchers = choices.filter(choice => choice.agent).map(choice => choice.agent);
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
            row(agent ? `start-${agent.key}` : 'new-terminal', choice.name, AgentIcon(agent, t),
              () => this.startThread(agent)),
          ];
        }))
        .when(this.loading, el => el.child(div().p(10).text_size(12).text_color(t.muted).child('Loading agents…')))
        .when(this.launchError, el => el.child(div().id('retry-agents').p(10).text_size(12).text_color(t.muted).cursor_pointer()
          .on_click((_event, cx) => this.loadAgents(cx)).child('Could not load agents. Click to retry.')))
        .when(!this.loading && !this.launchError && !choices.length, el => el.child(div().p(10).text_size(12).text_color(t.muted)
          .child(this.launchers.length ? 'All agents are hidden. Use Manage to show them.' : 'No installed agents found.'))))
      .child(DropdownMenuSeparator(t))
      .child(row('manage-launchers-open', 'Manage…', glyph('settings'), () => {
        const target = props();
        closeOverlay(target.overlay);
        openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 680, height: 0.8,
          props: { view: 'manage-launchers', space: target.space } });
      }));
  },
};
