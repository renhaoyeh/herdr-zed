import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import { agents, spaces, panes, theme, run, props, window, openOverlay, closeOverlay, setAgentOrder, layout, settings, pickFolder, shared, setShared, knownAgents, notify, exec, appHome, readTextFile } from 'herdr';
import { projectGroups, projectCatalog, folderKey, launcherChoices, codexPermissionModes, isAccountLauncher, isCodexLauncher, launcherArgv, quotaResetLabel } from './model.js';
import AccountLogin, { accountLabel, removeAccountProfile, renameAccountProfile } from './account-login.js';
import FileViewer from './files.js';
import { DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { Select, SelectState } from './components/select.js';
import { Progress } from './components/progress.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './components/alert-dialog.js';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenuButton, SidebarFooter } from './components/sidebar.js';

const glyph = (name, size = 14) => svg(`mods/devkits/assets/icons/${name}.svg`).size(size).flex_none();
const stateColor = (status, t) => t[status] || t.muted;
const launcherSections = ['Terminal', 'Agents', 'Your accounts'];
const agentLoads = new Map();
const launcherIcon = (agent, t) => !agent ? glyph('terminal', 16) : agent.icon
  ? (agent.tint ? svg(agent.icon).size(16).text_color(t.foreground) : image(agent.icon).size(16)) : glyph('mark', 16);

export default class Devkits extends View {
  init(_props, cx) {
    // Return an already-open permissions dialog to Manage during live updates.
    if (props()?.view === 'codex-permissions') {
      const target = props(); closeOverlay(target.overlay);
      openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 680, height: 0.8,
        props: { view: 'manage-launchers', space: target.space } });
      return;
    }
    if (props()?.view === 'usage-details') cx.timer.every(60000, cx => cx.notify());
    if (!props()?.view && cx) {
      // Shared values survive restarts; discover once for this app session.
      setShared('devkits.agent-cache', {});
      this.refreshUsage(cx);
      const activeMachine = this.projects().find(project => project.active)?.machine || null;
      for (const machine of new Set([null, ...spaces().map(space => space.machine || null)])) {
        if (machine === activeMachine) continue;
        cx.spawn(async () => { try { await this.cachedAgents(machine); } catch {} });
      }
      cx.timer.every(60000, cx => this.refreshUsage(cx));
    }
    if (props()?.view === 'files') {
      this.files = new FileViewer();
      this.files.init(cx);
      return;
    }
    if (props()?.view === 'account-login') {
      this.login = new AccountLogin();
      this.login.init(props(), cx);
      return;
    }
    this.folded = new Set();
    if (props()?.view === 'rename-account') {
      this.renameInput = InputState.new({ placeholder: 'Account name' });
      this.renameInput.set_value(accountLabel(props().account.name));
      this.renameInput.on('submit', (_event, cx) => this.saveAccountName(cx));
      this.renameInput.focus();
    }
    this.hovered = null;
    this.hoveredProject = null;
    if (['close-project', 'remove-account', 'rename-account', 'project-menu', 'project-picker', 'usage-details'].includes(props()?.view)) {
      this.handle = cx.focus_handle();
      if (props().view !== 'rename-account') this.handle.focus();
      if (props().view === 'project-picker') this.projectIndex = -1;
    }
    if (['launcher', 'manage-launchers'].includes(props()?.view)) {
      if (props().refreshAgents) setShared('devkits.agent-cache', {});
      this.launchers = [];
      this.permissionSelects = new Map();
      this.manageIndex = 0;
      this.handle = cx.focus_handle();
      this.handle.focus();
      this.loadAgents(cx);
    }
  }

  openProject(cx) {
    const target = props();
    const overlay = target?.view === 'project-picker' ? target.overlay : null;
    cx.spawn(async cx => {
      try {
        const folder = await pickFolder({ prompt: 'Open project' });
        if (!folder) return;
        const saved = shared('devkits.projects') || [];
        if (!saved.some(path => folderKey(path) === folderKey(folder))) setShared('devkits.projects', [...saved, folder]);
        const project = this.projects().find(p => !p.machine && folderKey(p.folder) === folderKey(folder));
        if (project.pending) {
          setShared('devkits.files', null);
          setShared('devkits.selected-project', null);
          run('layout.select', { stack: 'workspace-view', child: 'main' });
          run('space.new', { name: project.name, folder, machine: '', tab: '__devkits_default_terminal__' });
        } else this.selectProject(project);
        cx.notify();
      } catch (error) { notify({ title: 'Could not open project', body: error.message, level: 'error' }); }
      finally { if (overlay) closeOverlay(overlay); }
    });
  }

  projects() {
    return projectCatalog(spaces(), shared('devkits.projects') || [], shared('devkits.project-roots') || {}, shared('devkits.selected-project'), shared('devkits.project-order') || []);
  }

  moveProject(id, direction) {
    const projects = this.projects();
    const from = projects.findIndex(project => project.id === id);
    const to = from + direction;
    if (from >= 0 && to >= 0 && to < projects.length) {
      projects.splice(to, 0, projects.splice(from, 1)[0]);
      setShared('devkits.project-order', projects.map(project => JSON.stringify([project.machine || '', folderKey(project.folder) || project.id])));
    }
  }

  selectProject(project) {
    setShared('devkits.files', null);
    setShared('devkits.selected-project', project.id);
    if (!project.pending) run('space.select', { id: project.id });
    run('layout.select', { stack: 'workspace-view', child: project.pending ? 'project-empty' : 'main' });
  }

  closeProject(project) {
    if (project.pending) { this.finishCloseProject(project); return; }
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', width: 440, height: 220,
      props: { view: 'close-project', project } });
  }

  projectMenu(t) {
    const target = props();
    const projects = this.projects();
    const index = projects.findIndex(project => project.id === target.project.id);
    const close = () => { closeOverlay(target.overlay); this.closeProject(target.project); };
    const actions = [
      { id: 'menu-project-up', label: 'Move up', enabled: index > 0, action: () => this.moveProject(target.project.id, -1) },
      { id: 'menu-project-down', label: 'Move down', enabled: index >= 0 && index < projects.length - 1, action: () => this.moveProject(target.project.id, 1) },
      { id: 'menu-close-project', label: 'Close project', enabled: true, action: close },
    ];
    const activate = action => {
      if (!action.enabled) return;
      if (action.id !== 'menu-close-project') closeOverlay(target.overlay);
      action.action();
    };
    this.projectMenuIndex ??= actions.findIndex(action => action.enabled);
    return DropdownMenuContent('project-menu', undefined, t)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'enter' || event.key === 'space') activate(actions[this.projectMenuIndex]);
        else if (event.key === 'escape') closeOverlay(target.overlay);
        else if (event.key === 'up' || event.key === 'down') {
          const step = event.key === 'up' ? -1 : 1;
          do { this.projectMenuIndex = (this.projectMenuIndex + step + actions.length) % actions.length; }
          while (!actions[this.projectMenuIndex].enabled);
          cx.notify();
        }
        else return;
        cx.stop_propagation();
      })
      .children(actions.flatMap((action, i) => [
        ...(i === 2 ? [DropdownMenuSeparator(t)] : []),
        DropdownMenuItem(action.id, t).opacity(action.enabled ? 1 : 0.4)
          .bg(this.projectMenuIndex === i && action.enabled ? t.hover : t.popover)
          .on_hover((inside, cx) => { if (inside && action.enabled) { this.projectMenuIndex = i; cx.notify(); } })
          .on_click(() => activate(action))
          .when(i === 2, el => el.child(glyph('close'))).child(action.label),
      ]));
  }

  projectPicker(t) {
    const projects = this.projects();
    const choose = (project, cx) => {
      if (project) { closeOverlay(props().overlay); this.selectProject(project); }
      else this.openProject(cx);
    };
    return DropdownMenuContent('project-picker', Math.min(360, 80 + projects.length * 33), t).track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); closeOverlay(props().overlay); return; }
        if (event.key === 'enter') {
          cx.stop_propagation();
          if (this.projectIndex >= 0) choose(projects[this.projectIndex], cx);
          return;
        }
        if (event.key === 'down') this.projectIndex = (this.projectIndex + 1) % (projects.length + 1);
        else if (event.key === 'up') this.projectIndex = this.projectIndex < 0 ? projects.length : (this.projectIndex + projects.length) % (projects.length + 1);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(DropdownMenuLabel(t).child('PROJECTS'))
      .child(v_flex().id('picker-projects').flex_1().min_h(0).overflow_y_scrollbar().gap(1)
        .children(projects.map((project, index) => DropdownMenuItem(`picker-project-${project.id}`, t)
          .bg(this.projectIndex === index ? t.selected : t.popover)
          .on_hover((inside, cx) => { if (inside) { this.projectIndex = index; cx.notify(); } })
          .on_click((_event, cx) => choose(project, cx))
          .child(glyph('folder').text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(project.name))
          .child(div().size(14).flex_none().when(project.active, el => el.child(glyph('check').text_color(t.foreground)))))))
      .child(DropdownMenuSeparator(t))
      .child(DropdownMenuItem('picker-open-folder', t)
        .bg(this.projectIndex === projects.length ? t.selected : t.popover)
        .on_hover((inside, cx) => { if (inside) { this.projectIndex = projects.length; cx.notify(); } })
        .on_click((_event, cx) => choose(null, cx)).child(glyph('folder-plus').text_color(t.muted)).child('Open folder…'));
  }

  finishCloseProject(project) {
    if (!project.machine) setShared('devkits.projects', (shared('devkits.projects') || []).filter(folder => folderKey(folder) !== folderKey(project.folder)));
    if (shared('devkits.selected-project') === project.id) setShared('devkits.selected-project', null);
    if (!project.pending) run('space.close', { id: project.id, confirmed: true });
  }

  closePrompt(t) {
    const target = props();
    const confirm = () => { closeOverlay(target.overlay); this.finishCloseProject(target.project); };
    const cancel = () => closeOverlay(target.overlay);
    return AlertDialogContent('close-project-dialog', t).accessibility_label(`Close ${target.project.name}?`)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') cancel();
        else if (event.key === 'enter') confirm();
        else return;
        cx.stop_propagation();
      })
      .child(AlertDialogTitle().child(`Close ${target.project.name}?`))
      .child(AlertDialogDescription(t)
        .child('This ends every session in this project, including running agents. Your project files stay on disk.'))
      .child(AlertDialogFooter().children([
        AlertDialogCancel('cancel-close-project', t).on_click(cancel).child('Cancel'),
        AlertDialogAction('confirm-close-project', t).on_click(confirm).child('Close project'),
      ]));
  }

  newThread(cx, id, at) {
    const project = this.projects().find(s => id ? s.id === id : s.active);
    if (!project) { this.openProject(cx); return; }
    openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 280, at,
      props: { view: 'launcher', space: project.pending ? null : project.id, folder: project.folder, projectName: project.name } });
  }

  async cachedAgents(machine) {
    const key = JSON.stringify(machine || null);
    const cached = shared('devkits.agent-cache')?.[key];
    if (cached) return cached;
    if (agentLoads.has(key)) return agentLoads.get(key);
    const pending = (async () => {
      let agents = (await knownAgents({ on: machine }))
        .filter(agent => agent.installed && (!machine || !isAccountLauncher(agent)));
      // The native program table may still contain old labels just after a write.
      if (!machine) {
        const source = await readTextFile(`${appHome()}/programs.json`);
        const programs = source === null ? {} : JSON.parse(source).programs || {};
        agents = agents.map(agent => typeof programs[agent.key]?.name === 'string'
          ? { ...agent, name: programs[agent.key].name } : agent);
      }
      setShared('devkits.agent-cache', { ...(shared('devkits.agent-cache') || {}), [key]: agents });
      return agents;
    })();
    agentLoads.set(key, pending);
    try { return await pending; } finally { agentLoads.delete(key); }
  }

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
  }

  startThread(agent) {
    const target = props();
    let argv;
    try { argv = launcherArgv(agent, shared('devkits.codex-permissions')?.[agent?.key]); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); return; }
    closeOverlay(target.overlay);
    setShared('devkits.files', null);
    setShared('devkits.selected-project', null);
    run('layout.select', { stack: 'workspace-view', child: 'main' });
    if (target.space) run('tab.new', { space: target.space, folder: target.folder, ...(agent ? { name: agent.name, argv } : {}) });
    else run('space.new', { name: target.projectName, folder: target.folder, machine: '', ...(agent ? { tab: agent.name, argv } : {}) });
  }

  addAccount(provider) {
    const target = props();
    closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: true, width: 520, height: 380,
      props: { view: 'account-login', provider, returnTo: { view: 'manage-launchers', space: target.space } } });
  }

  async close() {
    this.files?.close();
    await this.login?.close();
  }

  renameAccount(account) {
    const target = props();
    closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: true, width: 480, height: 260,
      props: { view: 'rename-account', account: { key: account.key, name: account.name }, space: target.space } });
  }

  finishRename() {
    if (this.renaming) return;
    const target = props();
    closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 680, height: 0.8,
      props: { view: 'manage-launchers', space: target.space } });
  }

  saveAccountName(cx) {
    if (this.renaming) return;
    this.renaming = true; this.renameError = null; cx.notify();
    const name = this.renameInput.value();
    cx.spawn(async cx => {
      try {
        await renameAccountProfile(props().account.key, name);
        setShared('devkits.agent-cache', {});
        setShared('devkits.profile-revision', (shared('devkits.profile-revision') || 0) + 1);
        this.renaming = false; this.finishRename();
      } catch (error) { this.renaming = false; this.renameError = error.message; cx.notify(); }
    });
  }

  renameAccountPrompt(t) {
    return DialogContent('rename-account-dialog', t).accessibility_label('Rename agent profile')
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); this.finishRename(); }
      })
      .child(DialogTitle().child('Rename agent profile'))
      .child(DialogDescription(t).child('Choose a display name for this account.'))
      .child(Input.new(this.renameInput).id('rename-account-name').accessibility_label('Account name')
        .h(36).px(10).rounded(0).border_b(1).border_color(t.input).text_size(13))
      .when(Boolean(this.renameError), el => el.child(div().id('rename-account-error').text_size(12)
        .text_color(t.destructive || t.foreground).child(this.renameError)))
      .child(DialogFooter().children([
        Button('cancel-rename-account', t, { variant: 'outline' }).disabled(Boolean(this.renaming)).on_click(() => this.finishRename()).child('Cancel'),
        Button('save-rename-account', t).disabled(Boolean(this.renaming)).on_click((_event, cx) => this.saveAccountName(cx)).child(this.renaming ? 'Saving…' : 'Save'),
      ]));
  }

  confirmRemoveAccount(account) {
    const target = props();
    closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: true, width: 480, height: 300,
      props: { view: 'remove-account', account: { key: account.key, name: account.name }, space: target.space } });
  }

  removeAccountPrompt(t) {
    const target = props();
    const back = () => {
      if (this.removing) return;
      closeOverlay(target.overlay);
      openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 680, height: 0.8,
        props: { view: 'manage-launchers', space: target.space } });
    };
    const confirm = cx => {
      if (this.removing) return;
      this.removing = true; this.removeError = null; cx.notify();
      cx.spawn(async cx => {
        try {
          await removeAccountProfile(target.account.key);
          setShared('devkits.agent-cache', {});
          const key = `agent:${target.account.key}`;
          for (const setting of ['devkits.hidden-launchers', 'devkits.launcher-order']) {
            setShared(setting, (shared(setting) || []).filter(item => item !== key));
          }
          const permissions = { ...(shared('devkits.codex-permissions') || {}) };
          delete permissions[target.account.key];
          setShared('devkits.codex-permissions', permissions);
          this.removing = false; back();
        } catch (error) { this.removing = false; this.removeError = error.message; cx.notify(); }
      });
    };
    return AlertDialogContent('remove-account-dialog', t).accessibility_label(`Remove ${target.account.name}?`)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') back();
        else if (event.key === 'enter') confirm(cx);
        else return;
        cx.stop_propagation();
      })
      .child(AlertDialogTitle().child(`Remove ${target.account.name}?`))
      .child(AlertDialogDescription(t).child('This signs out this saved account and removes it from the menu. History and project files are kept. Running sessions stay open but may need to sign in again.'))
      .when(Boolean(this.removeError), el => el.child(div().id('remove-account-error').text_size(12).text_color(t.destructive || t.foreground).child(this.removeError)))
      .child(AlertDialogFooter().children([
        AlertDialogCancel('cancel-remove-account', t).disabled(Boolean(this.removing)).on_click(back).child('Cancel'),
        AlertDialogAction('confirm-remove-account', t).disabled(Boolean(this.removing))
          .on_click((_event, cx) => confirm(cx)).child(this.removing ? 'Removing…' : 'Remove'),
      ]));
  }

  preparePermissionSelects(cx) {
    this.permissionSelects ||= new Map();
    for (const agent of this.launchers.filter(isCodexLauncher)) {
      if (!this.permissionSelects.has(agent.key)) this.permissionSelects.set(agent.key, new SelectState(cx));
    }
  }

  manageLaunchers(t) {
    const hidden = shared('devkits.hidden-launchers') || [];
    const choices = launcherChoices(this.launchers, shared('devkits.launcher-order') || []);
    const local = !spaces().find(space => space.id === props().space)?.machine;
    const dragGroup = choices.find(choice => choice.key === this.dragKey)?.group;
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
      if (!this.dragKey) return;
      this.dragKey = null; this.dropKey = null; cx.notify();
    };
    return DialogContent('manage-launchers', t).accessibility_label('Manage session menu')
      .on_mouse_up('left', (_event, cx) => cancelDrag(cx))
      .on_hover((inside, cx) => { if (!inside) cancelDrag(cx); })
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') {
          if (this.dragKey) cancelDrag(cx); else done();
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
      .child(DialogDescription(t).child('Choose what appears in Add session and the sidebar usage area. Drag within each section to reorder, or use Alt + ↑ / ↓. Changes are saved automatically.'))
      .child(v_flex().id('manage-launchers-list').flex_1().min_h(0).overflow_y_scroll().gap(4)
        .children(choices.flatMap((choice, index) => [
          ...(index === 0 || choices[index - 1].group !== choice.group
            ? [DropdownMenuLabel(t).id(`manage-section-${choice.group}`).mt(index ? 12 : 0).child(launcherSections[choice.group].toUpperCase())] : []),
          h_flex().id(`manage-${choice.key}`).h(44).flex_none().px(8).gap(8).items_center().rounded(0)
          .bg(this.manageIndex === index ? t.selected : t.popover)
          .border(1).border_color(this.dragKey && dragGroup === choice.group && this.dropKey === choice.key ? t.solid : t.popover)
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
          .when(choice.group !== 0, el => el.child(Button(`drag-${choice.key}`, t, { variant: 'ghost', size: 'icon' }).cursor_grab()
            .accessibility_label(`Reorder ${choice.name}. Use Alt + Up or Down.`)
            .on_mouse_down('left', (_event, cx) => {
              cx.stop_propagation(); this.handle?.focus();
              this.dragKey = choice.key; this.dropKey = choice.key; this.manageIndex = index; cx.notify();
            }).child(glyph('grip-vertical'))))
          .when(choice.group === 0, el => el.child(div().size(28).flex_none()))
          .child(Checkbox(`show-${choice.key}`, !hidden.includes(choice.key), t).h_full().flex_1().min_w(0)
            .accessibility_label(choice.name).on_change((_checked, cx) => toggle(choice.key, cx))
            .child(launcherIcon(choice.agent, t).flex_none())
            .child(div().flex_1().min_w(0).truncate().text_size(13).child(choice.name)))
          .when(isCodexLauncher(choice.agent), el => {
            const key = choice.agent.key;
            const colors = { default: t.muted, 'read-only': t.done, 'workspace-write': t.working, 'danger-full-access': t.ansi1 };
            return el.child(Select(`permissions-${key}`, this.permissionSelects.get(key),
              shared('devkits.codex-permissions')?.[key] || 'default',
              codexPermissionModes.map(mode => ({ ...mode, color: colors[mode.key] })),
              `Default permissions for ${choice.name}`, mode => {
                const saved = { ...(shared('devkits.codex-permissions') || {}) };
                if (mode === 'default') delete saved[key]; else saved[key] = mode;
                setShared('devkits.codex-permissions', saved);
              }, t));
          })
          .when(local && ['codex', 'claude'].includes(choice.agent?.key), el => el
            .child(Button(`add-${choice.agent.key}-account`, t, { variant: 'outline' })
              .accessibility_label(`Add a ${choice.agent.key === 'codex' ? 'Codex' : 'Claude'} account`)
              .on_click(() => this.addAccount(choice.agent.key)).child(glyph('plus')).child('Add account')))
          .when(local && choice.group === 2, el => el.child(Button(`rename-${choice.agent.key}`, t, { variant: 'outline' })
            .accessibility_label(`Rename ${choice.name}`).on_click(() => this.renameAccount(choice.agent)).child('Rename')))
          .when(local && choice.group === 2, el => el.child(Button(`remove-${choice.agent.key}`, t, { variant: 'outline' })
            .accessibility_label(`Remove ${choice.name}`).on_click(() => this.confirmRemoveAccount(choice.agent))
            .child(glyph('close')).child('Remove')))
        ]))
        .when(local && !this.loading && !this.launchError && !choices.some(choice => choice.group === 2), el => el
          .child(DropdownMenuLabel(t).id('manage-section-2').mt(12).child('YOUR ACCOUNTS'))
          .child(div().px(8).text_size(12).text_color(t.muted).child('No accounts added. Use Add account on the Codex or Claude row.')))
        .when(this.loading, el => el.child(div().p(8).text_size(12).text_color(t.muted).child('Loading agents…')))
        .when(this.launchError, el => el.child(Button('manage-retry-agents', t, { variant: 'outline' })
          .on_click((_event, cx) => this.loadAgents(cx)).child('Could not load agents. Retry'))))
      .child(DialogFooter().child(Button('manage-launchers-done', t).on_click(done).child('Done')));
  }

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
            row(agent ? `start-${agent.key}` : 'new-terminal', choice.name, launcherIcon(agent, t),
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
  }

  refreshUsage(cx, force = true) {
    const machine = this.projects().find(project => project.active)?.machine || null;
    const hidden = shared('devkits.hidden-launchers') || [];
    const order = shared('devkits.launcher-order') || [];
    const scope = JSON.stringify([machine, hidden, order, shared('devkits.profile-revision') || 0]);
    if (this.usageLoading || (!force && this.usageScope === scope)) return;
    this.usageScope = scope;
    this.usageLoading = true;
    cx.spawn(async cx => {
      try {
        const agents = await this.cachedAgents(machine);
        this.usageAgents = agents;
        if (this.usageMachine !== machine) this.usage = [];
        this.usageMachine = machine;
        this.usageError = null;
        cx.notify();
        const accounts = launcherChoices(this.usageAgents, order)
          .filter(choice => !hidden.includes(choice.key) && !machine &&
            choice.agent?.run.some(arg => /(^|\/)codex$/.test(arg))).map(choice => choice.agent);
        if (accounts.length) {
          const result = await exec('node', [`${appHome()}/mods/devkits/usage-reader.js`, JSON.stringify(accounts)]);
          if (result.code !== 0) throw new Error('Could not read usage');
          this.usage = JSON.parse(result.stdout);
        }
      } catch { this.usage = []; this.usageError = 'Could not read usage'; }
      finally { this.usageLoading = false; cx.notify(); }
    });
  }

  usageDetails(t) {
    const { account, overlay } = props();
    const close = () => closeOverlay(overlay);
    return DialogContent('usage-details', t).track_focus(this.handle)
      .accessibility_label(`${account.name} usage details`).on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); close(); }
      })
      .child(DialogTitle().child(account.name))
      .child(DialogDescription(t).child(account.supported ? 'Account quota usage' : 'Not supported'))
      .child(v_flex().id('usage-windows').flex_1().min_h(0).overflow_y_scrollbar().gap(16)
        .when(Boolean(account.error), el => el.child(div().text_size(12).text_color(t.muted).child(account.error)))
        .when(account.supported && !account.error && !account.windows?.length, el => el
          .child(div().text_size(12).text_color(t.muted).child('No quota windows available.')))
        .children((account.windows || []).map((window, index) => {
          const duration = window.minutes === null ? 'Unknown duration' : window.minutes % 1440 === 0
            ? `${window.minutes / 1440}d` : window.minutes % 60 === 0 ? `${window.minutes / 60}h` : `${window.minutes}m`;
          return v_flex().gap(8)
            .child(h_flex().justify_between().text_size(13)
              .child(`${window.name} · ${duration}`)
              .child(`${Math.round(window.usedPercent)}% used · ${Math.round(100 - window.usedPercent)}% remaining`))
            .child(Progress(`usage-detail-meter-${index}`, window.usedPercent, t).h(6)
              .accessibility_label(`${window.name} ${duration} used`))
            .child(div().text_size(12).text_color(t.muted)
              .child(quotaResetLabel(window)));
        })))
      .when(Boolean(account.fetchedAt), el => el.child(DialogDescription(t)
        .child(`Updated ${new Date(account.fetchedAt).toLocaleString()}`)))
      .child(DialogFooter().child(Button('usage-details-done', t).on_click(close).child('Done')));
  }

  accountUsage(t) {
    const space = this.projects().find(s => s.active);
    const choices = launcherChoices(this.usageMachine === (space?.machine || null) ? this.usageAgents || [] : [],
      shared('devkits.launcher-order') || []).filter(choice => !(shared('devkits.hidden-launchers') || []).includes(choice.key));
    return v_flex().id('account-usage').w_full().flex_none().h_auto().min_h(0)
      .border_t(1).border_color(t.border)
      .child(h_flex().h(32).flex_none().px(12).gap(8).items_center()
        .child(div().flex_1().text_size(11).font_medium().text_color(t.muted).child('AGENT PROFILES'))
        .child(Button('manage-agent-profiles', t, { variant: 'ghost', size: 'icon-sm' })
          .accessibility_label('Manage agent profiles')
          .on_click(() => openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 680, height: 0.8,
            props: { view: 'manage-launchers', space: space?.id } })).child(glyph('settings'))))
      .child(v_flex().id('account-usage-list').w_full().h_auto().flex_none()
        .children(choices.map(choice => {
            const data = (this.usage || []).find(account => account.key === choice.agent?.key);
            const supported = !space?.machine && Boolean(choice.agent?.run.some(arg => /(^|\/)codex$/.test(arg)));
            const windows = supported ? [300, 10080].flatMap(minutes =>
              data?.windows?.find(window => window.bucket === 'codex' && window.minutes === minutes) || []) : [];
            const status = !supported ? 'Not supported' : data?.error || this.usageError ? 'Unavailable'
              : windows.length ? windows.map(window => `${window.minutes === 300 ? '5h' : 'Week'} ${Math.round(window.usedPercent)}% used · ${quotaResetLabel(window)}`).join(' · ')
                : this.usageLoading ? 'Loading…' : 'No quota';
            const account = { ...data, name: choice.name, supported,
              error: data?.error || (supported ? this.usageError || (this.usageLoading ? 'Reading account usage…' : null) : null) };
            return Button(`usage-${choice.key}`, t, { variant: 'ghost' }).w_full().flex_none().h_auto().px(12).gap(8).items_start().justify_start().py(6)
              .accessibility_label(`${choice.name}: ${status}. Open usage details`)
              .on_click(() => openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 480, height: 400,
                props: { view: 'usage-details', account } }))
              .child(launcherIcon(choice.agent, t).self_center())
              .child(v_flex().flex_1().min_w(0).gap(3).line_height('12px')
                .child(div().truncate().text_size(12).font_semibold().text_color(t.foreground).child(accountLabel(choice.name)))
                .children(windows.map(window => {
                  const label = window.minutes === 300 ? '5h' : 'Week';
                  const reset = quotaResetLabel(window);
                  const time = reset === 'Reset time unavailable' ? '—' : reset.startsWith('Reset due')
                    ? 'Reset due' : reset.replace(/^Resets (?:in )?/, '');
                  const displayTime = time.replace(/\b(\d)([dhm])\b/g, '0$1$2');
                  return h_flex().w_full().gap(4).items_center().text_size(10).whitespace_nowrap()
                    .child(div().w(30).flex_none().child(label))
                    .child(Progress(`usage-meter-${choice.key}-${window.minutes}`, window.usedPercent, t)
                      .flex_1().w_auto().min_w(0).accessibility_label(`${choice.name} ${label} used`))
                    .child(div().w(24).flex_none().font_family('Geist Mono').text_right().child(`${Math.round(window.usedPercent)}%`))
                    .child(div().id(`usage-reset-${choice.key}-${window.minutes}`).w(54).flex_none().font_family('Geist Mono').text_right()
                      .accessibility_label(reset).child(displayTime));
                }))
                .when(!windows.length, el => el
                  .child(div().text_size(10).child(status))
                  .child(Progress(`usage-meter-${choice.key}`, null, t).accessibility_label(`${choice.name}: ${status}`))));
          })));
  }

  header(t) {
    const space = this.projects().find(s => s.active);
    const win = window();
    const root = layout(), sidebar = root?.children?.find(node => node.id === 'sidebar');
    const inset = win?.platform === 'macos' && !win.fullscreen && sidebar?.hidden
      ? (root.traffic_lights[0] + 64) / settings().zoom : 12;
    return h_flex().size_full().pr(4).pl(inset).gap(4).items_center().bg(t.background).text_size(13)
      .border_b(1).border_color(t.border)
      .child(DropdownMenuTrigger(h_flex().id('project-switcher').h(28).px(8).gap(6).items_center().rounded(0)
        .text_color(t.foreground).font_medium().hover(el => el.bg(t.hover)).cursor_pointer(), 280,
        (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 280, at,
          props: { view: 'project-picker' } }))
        .child(div().max_w(220).truncate().child(space?.name || 'Open project'))
        .child(glyph('chevron-down', 12).text_color(t.muted)))
      .child(div().flex_1())
      .when(Boolean(win?.buttons), el => el
        .child(Button('minimize', t, { variant: 'ghost', size: 'icon' }).accessibility_label('Minimize')
          .on_click(() => run('window.minimize')).child(glyph('minus')))
        .child(Button('maximize', t, { variant: 'ghost', size: 'icon' }).accessibility_label('Maximize / restore')
          .on_click(() => run('window.maximize')).child(glyph('square')))
        .child(Button('close-window', t, { variant: 'ghost', size: 'icon' }).accessibility_label('Close window')
          .on_click(() => run('window.close')).child(glyph('close'))));
  }

  brand(t) {
    return div().size_full().bg(t.chrome).border_b(1).border_color(t.border);
  }

  paneHeader(t) {
    const p = panes().find(p => p.pane === props()?.pane);
    if (!p) return div();
    const program = p.program;
    const thread = projectGroups(spaces(), agents()).flatMap(group => group.threads).find(thread => thread.tab.id === p.tab);
    const icon = program?.icon ? (program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)) : glyph('terminal');
    return h_flex().size_full().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .text_size(12).text_color(t.muted).on_click(() => run('pane.focus', { pane: p.pane }))
      .child(div().flex_none().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(thread?.title || p.title || 'Terminal'))
      .when(Boolean(p.status), el => el.child(h_flex().h(22).px(7).gap(5).items_center().rounded(0)
        .border(1).border_color(t.border).text_size(10).text_color(t.muted)
        .child(div().size(5).rounded(3).bg(stateColor(p.status, t)))
        .child(p.status === 'blocked' ? 'Needs you' : `${p.status[0].toUpperCase()}${p.status.slice(1)}`)));
  }

  statusBar(t) {
    const space = this.projects().find(s => s.active);
    return h_flex().size_full().pl(16).pr(4).gap(8).items_center().bg(t.background).border_t(1).border_color(t.border)
      .text_size(11).text_color(t.muted).child(glyph('terminal', 12)).child(space?.machine || 'Local project')
      .when(Boolean(space?.branch), el => el.child(glyph('branch', 12)).child(space.branch))
      .child(div().flex_1())
      .when(Boolean(space), el => el.child(Button('open-files', t, { variant: 'ghost', size: 'icon' })
        .h_full().rounded(0)
        .bg(shared('devkits.files') === space.id ? t.selected : t.background)
        .accessibility_label(shared('devkits.files') === space.id ? 'Hide files' : 'Show files')
        .on_click(() => setShared('devkits.files', shared('devkits.files') === space.id ? null : space.id))
        .child(glyph('folder'))));
  }

  threadRow(thread, t) {
    const agent = thread.agent;
    const working = thread.status === 'working' || thread.agents.some(agent => agent.status === 'working');
    const isFocused = thread.active;
    const p = agent?.program;
    const icon = p?.icon ? (p.tint ? svg(p.icon).size(14).text_color(t.muted) : image(p.icon).size(14)) : glyph('terminal', 14).text_color(t.muted);
    return SidebarMenuButton(`thread-${thread.tab.id}`, isFocused, t)
      .on_hover((hovered, cx) => { this.hovered = hovered ? thread.tab.id : null; cx.notify(); })
      .on_click(() => {
        this.selectProject(this.projects().find(project => project.id === thread.space));
        run('tab.select', { id: thread.tab.id });
      })
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground)
        .when(isFocused, el => el.font_medium()).child(thread.title))
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(working
        ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
        : glyph(thread.status === 'done' ? 'check' : thread.status === 'blocked' ? 'circle-alert' : 'circle', 14)
          .text_color(stateColor(thread.status, t)).accessibility_label(thread.status)))
      .child(Button(`close-thread-${thread.tab.id}`, t, { variant: 'ghost', size: 'icon-sm' })
        .opacity(isFocused || this.hovered === thread.tab.id ? 1 : 0)
        .accessibility_label('Close thread')
        .on_click((_event, cx) => { cx.stop_propagation(); run('tab.close', { id: thread.tab.id }); })
        .child(glyph('close', 12)));
  }

  render(cx) {
    const t = theme();
    if (props()?.view === 'codex-permissions') return div();
    if (props()?.view === 'files') return this.files.render(this.projects().find(project => project.active), cx);
    if (props()?.view === 'account-login') return this.login.render();
    if (props()?.view === 'header') return this.header(t);
    if (props()?.view === 'usage-details') return this.usageDetails(t);
    if (props()?.view === 'brand') return this.brand(t);
    if (props()?.view === 'pane') return this.paneHeader(t);
    if (props()?.view === 'status') return this.statusBar(t);
    if (props()?.view === 'launcher') return this.launcher(t);
    if (props()?.view === 'manage-launchers') return this.manageLaunchers(t);
    if (props()?.view === 'remove-account') return this.removeAccountPrompt(t);
    if (props()?.view === 'rename-account') return this.renameAccountPrompt(t);
    if (props()?.view === 'project-empty') return div().size_full().bg(t.background);
    if (props()?.view === 'close-project') return this.closePrompt(t);
    if (props()?.view === 'project-menu') return this.projectMenu(t);
    if (props()?.view === 'project-picker') return this.projectPicker(t);
    if (cx) this.refreshUsage(cx, false);
    const all = agents(), native = spaces();
    const roots = shared('devkits.project-roots') || {};
    const missing = native.filter(s => roots[s.id] === undefined && s.folder);
    if (missing.length) setShared('devkits.project-roots', { ...roots, ...Object.fromEntries(missing.map(s => [s.id, s.folder])) });
    const active = native.find(s => s.active);
    const selection = `${active?.id || ''}:${active?.tabs.find(tab => tab.active)?.id || ''}`;
    if (shared('devkits.native-selection') !== selection) {
      if (shared('devkits.native-selection') !== undefined) {
        setShared('devkits.files', null);
        setShared('devkits.selected-project', null);
        run('layout.select', { stack: 'workspace-view', child: 'main' });
      }
      setShared('devkits.native-selection', selection);
    }
    const workspaces = this.projects();
    const chosen = workspaces.find(p => p.active);
    const selectedTab = chosen?.tabs.find(tab => tab.active);
    const defaultSelected = selectedTab && (selectedTab.id === shared('devkits.default-terminals')?.[chosen.id]
      || selectedTab.name === '__devkits_default_terminal__')
      && !all.some(agent => agent.space === chosen.id && agent.tab === selectedTab.id);
    const content = chosen && shared('devkits.files') === chosen.id ? 'files' : chosen?.pending || defaultSelected ? 'project-empty' : 'main';
    if (this.shownContent !== content) {
      this.shownContent = content;
      run('layout.select', { stack: 'workspace-view', child: content });
    }
    const defaults = { ...(shared('devkits.default-terminals') || {}) };
    let defaultsChanged = false;
    for (const space of native) {
      if (defaults[space.id]) continue;
      const tab = space.tabs.find(tab => tab.name === '__devkits_default_terminal__');
      if (tab) { defaults[space.id] = tab.id; defaultsChanged = true; }
    }
    if (defaultsChanged) setShared('devkits.default-terminals', defaults);
    const groups = projectGroups(workspaces, all, defaults);
    const visible = groups.filter(g => !this.folded.has(g.space.id)).flatMap(g => g.threads.flatMap(thread => thread.agents));
    setAgentOrder(visible.map(a => a.address));
    return Sidebar(t)
      .child(SidebarContent()
        .children(groups.map(({ space, threads }, index) => SidebarGroup(index > 0, t)
          .child(SidebarGroupLabel(`project-${space.id}`, space.active, t)
            .on_hover((hovered, cx) => { this.hoveredProject = hovered ? space.id : null; cx.notify(); })
            .on_click((event, cx) => {
              const modifier = window()?.platform === 'macos' ? event?.modifiers?.platform : event?.modifiers?.control;
              if (modifier) this.selectProject(space);
              else { this.folded.has(space.id) ? this.folded.delete(space.id) : this.folded.add(space.id); cx.notify(); }
            })
            .child(div().min_w(0).truncate().child(space.name))
            .child(div().opacity(this.hoveredProject === space.id || this.folded.has(space.id) ? 1 : 0)
              .child(glyph(this.folded.has(space.id) ? 'chevron-right' : 'chevron-down', 12)))
            .when(Boolean(space.machine), el => el.child(div().text_size(9).text_color(t.muted).child(space.machine)))
            .child(div().flex_1())
            .child(DropdownMenuTrigger(Button(`new-thread-${space.id}`, t, { variant: 'ghost', size: 'icon' })
              .accessibility_label(`Add session in ${space.name}`), 280,
              (cx, at) => this.newThread(cx, space.id, at), 'end')
              .child(glyph('plus')).opacity(this.hoveredProject === space.id ? 1 : 0))
            .child(DropdownMenuTrigger(Button(`project-menu-${space.id}`, t, { variant: 'ghost', size: 'icon' })
              .accessibility_label(`More actions for ${space.name}`), 200,
              (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 200, at,
                props: { view: 'project-menu', project: space } }), 'end')
              .child(glyph('ellipsis')).opacity(this.hoveredProject === space.id ? 1 : 0)))
          .when(!this.folded.has(space.id), el => el.children(threads.map(thread => this.threadRow(thread, t)))
            .when(!threads.length, el => el.child(div().px(12).py(6).text_size(12).text_color(t.muted).child('No threads yet')))))))
      .child(this.accountUsage(t))
      .child(SidebarFooter(t)
        .child(Button('settings', t, { variant: 'ghost', size: 'icon' }).accessibility_label('Settings')
          .h_full().rounded(0)
          .on_click(() => run('app.settings')).child(glyph('settings')))
        .child(div().flex_1()));
  }
}
