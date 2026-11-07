import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { agents, spaces, panes, theme, run, props, window, openOverlay, closeOverlay, setAgentOrder, layout, settings, pickFolder, shared, setShared, knownAgents, notify, appHome, readTextFile, nextCommand, terminals } from 'herdr';
import { projectGroups, projectCatalog, folderKey, launcherChoices, isAccountLauncher, launcherArgv, sessionArgv, sessionKind, resolveThreadProfiles, threadProfile, threadProgram, archivable, rulesArgv, childTerminals, settingsKey, rootSettings } from './model.js';
import { commandArgv } from './shell-command.js';
import AccountLogin from './account-login.js';
import FileViewer, { FileMenu } from './files.js';
import DiffViewer from './diff.js';
import Analytics from './analytics.js';
import XcodeStorage from './xcode-storage.js';
import AsanaPanel, { AsanaProjectPicker, taskPrompt, unsaveTask } from './asana.js';
import { sessionMenu } from './session-menu.js';
import { accountActions } from './account-actions.js';
import { agentUsage } from './usage.js';
import { RunControls, RunMenu, runApp } from './run-app.js';
import { BranchMenu } from './branch-menu.js';
import { ProjectLayout, layoutNode } from './project-layout.js';
import { threadArchive } from './thread-archive.js';
import { sessionRules, ensureRules } from './global-rules.js';
import { DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button } from './components/button.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './components/alert-dialog.js';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenuButton, SidebarFooter } from './components/sidebar.js';

// A 28px icon button centred in a 32px project row: 8px below the row.
const SIDEBAR_MENU = { x: 0, y: 10 };
import { glyph } from './components/icon.js';

const startingThreads = new Set();
// Asana replaces the terminals for one project; selecting anything else returns to them.
// Files and Changes share the editor beside the thread instead, shown or hidden in the layout like the simulator.
const hidePanels = () => { setShared('devkits.asana', null); };
// Each project remembers its open panel and gets it back when selected again; choosing a thread forgets it.
const rememberPanel = (id, name) => { if (id) setShared('devkits.project-panels', { ...(shared('devkits.project-panels') || {}), [id]: name || null }); };
const showPanel = (name, id) => { hidePanels(); setShared(`devkits.${name}`, id); rememberPanel(id, name); };
const restorePanel = id => { const shown = shared('devkits.project-panels')?.[id] === 'asana'; if (shown) setShared('devkits.asana', id); return shown; };
// Shows Files or Changes in the editor beside the thread, or hides the editor when that one is already shown.
const toggleEditor = (editor, name) => {
  if (editor && !editor.hidden && editor.active === name) { run('layout.hide', { id: 'editor' }); return; }
  run('layout.select', { stack: 'editor', child: name });
  run('layout.show', { id: 'editor' });
};
const conversationKey = project => JSON.stringify([project.machine || '', folderKey(project.folder) || project.id]);
const conversationVisible = project => Boolean(project && shared('devkits.conversation-visible')?.[conversationKey(project)]);
const agentLoads = new Map();

export default class Devkits extends View {
  init(_props, cx) {
    if (props()?.view === 'codex-sharing') { this.initCodexSharing(cx); return; }
    if (props()?.view === 'file-menu') {
      this.fileMenu = new FileMenu(); this.fileMenu.init(cx); return;
    }
    if (props()?.view === 'token-statistics') {
      this.analytics = new Analytics();
      this.analytics.init(cx);
      return;
    }
    if (props()?.view === 'xcode-storage') {
      this.xcodeStorage = new XcodeStorage();
      this.xcodeStorage.init(cx);
      return;
    }
    // Return an already-open permissions dialog to Manage during live updates.
    if (props()?.view === 'codex-permissions') {
      const target = props(); closeOverlay(target.overlay);
      openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 820, height: 0.8,
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
      cx.spawn(async () => { try { await ensureRules(); } catch {} });
      // Settings saved per account before they moved to the provider (Claude, Codex) carry over once.
      const permissions = shared('devkits.codex-permissions') || {}, sessions = shared('devkits.profile-sessions') || {};
      const movedPermissions = rootSettings(permissions);
      const movedSessions = rootSettings(sessions, (kept = {}, value = {}) => ({ model: kept.model ?? value.model ?? null, effort: kept.effort ?? value.effort ?? null }));
      if (movedPermissions !== permissions) setShared('devkits.codex-permissions', movedPermissions);
      if (movedSessions !== sessions) setShared('devkits.profile-sessions', movedSessions);
    }
    if (props()?.view === 'branch-menu') {
      this.branchMenu = new BranchMenu();
      this.branchMenu.init(cx);
      return;
    }
    if (props()?.view === 'run-menu') {
      this.runMenu = new RunMenu();
      this.runMenu.init(cx);
      return;
    }
    // Only the always-visible header consumes layout shortcuts.
    if (props()?.view === 'header') cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === 'run') await runApp();
        if (command === 'new-thread') await this.repeatThread(cx);
      }
    });
    if (props()?.view === 'files') {
      this.files = new FileViewer();
      this.files.init(cx);
      cx.spawn(async cx => {
        for (;;) if (await nextCommand() === 'close-file') this.closeFileTab(cx);
      });
      return;
    }
    if (props()?.view === 'diff') {
      this.diff = new DiffViewer();
      this.diff.init(cx);
      return;
    }
    if (props()?.view === 'account-login') {
      this.login = new AccountLogin();
      this.login.init(props(), cx);
      return;
    }
    this.folded = new Set();
    if (props()?.view === 'rename-account') this.initRenameAccount();
    this.hovered = null;
    this.hoveredProject = null;
    if (['close-project', 'remove-account', 'rename-account', 'project-menu', 'project-picker', 'usage-details'].includes(props()?.view)) {
      this.handle = cx.focus_handle();
      if (props().view !== 'rename-account') this.handle.focus();
      if (props().view === 'project-picker') this.projectIndex = -1;
    }
    if (props()?.view === 'asana-projects') {
      this.asanaProjects = new AsanaProjectPicker();
      this.asanaProjects.init(props(), cx);
      return;
    }
    if (props()?.view === 'asana') {
      this.asana = new AsanaPanel();
      this.asana.init(cx);
      // The composer offers the local agents Add session shows.
      cx.spawn(async cx => { try { await this.cachedAgents(null); } catch {} cx.notify(); });
      return;
    }
    if (['launcher', 'manage-launchers'].includes(props()?.view)) this.initSessionMenu(cx);
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
          hidePanels();
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
    hidePanels();
    setShared('devkits.selected-project', project.id);
    if (!project.pending) run('space.select', { id: project.id });
    run('layout.select', { stack: 'workspace-view', child: project.pending ? 'project-empty' : 'main' });
    restorePanel(project.id);
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
    const asana = () => { this.selectProject(target.project); showPanel('asana', target.project.id); };
    const actions = [
      ...(target.project.machine ? [] : [{ id: 'menu-asana-tasks', label: 'Asana tasks', icon: 'list-todo', enabled: true, action: asana, divider: true }]),
      { id: 'menu-project-up', label: 'Move up', enabled: index > 0, action: () => this.moveProject(target.project.id, -1) },
      { id: 'menu-project-down', label: 'Move down', enabled: index >= 0 && index < projects.length - 1, action: () => this.moveProject(target.project.id, 1) },
      { id: 'menu-close-project', label: 'Close project', icon: 'close', enabled: true, action: close, separated: true },
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
        ...(action.separated ? [DropdownMenuSeparator(t)] : []),
        DropdownMenuItem(action.id, t).opacity(action.enabled ? 1 : 0.4)
          .bg(this.projectMenuIndex === i && action.enabled ? t.hover : t.popover)
          .on_hover((inside, cx) => { if (inside && action.enabled) { this.projectMenuIndex = i; cx.notify(); } })
          .on_click(() => activate(action))
          .when(Boolean(action.icon), el => el.child(glyph(action.icon))).child(action.label),
        ...(action.divider ? [DropdownMenuSeparator(t)] : []),
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

  showConversation(visible = true, project = this.projects().find(project => project.active)) {
    if (!project) return;
    setShared('devkits.conversation-visible', { ...(shared('devkits.conversation-visible') || {}), [conversationKey(project)]: visible });
    run(visible ? 'layout.show' : 'layout.hide', { id: 'workspace-view' });
  }

  closeFileTab(cx) {
    const editor = layoutNode(layout(), 'editor');
    if (editor && !editor.hidden && editor.active === 'files' && this.files?.file)
      this.files.closeTab(this.files.file, cx);
  }

  defaultThreadAgent(project, agents) {
    const key = JSON.stringify([project.machine || '', folderKey(project.folder) || project.id]);
    const hidden = shared('devkits.hidden-launchers') || [];
    const available = launcherChoices(agents, shared('devkits.launcher-order') || [])
      .filter(choice => choice.agent && choice.agent.installed !== false && !hidden.includes(choice.key))
      .map(choice => choice.agent);
    return available.find(agent => agent.key === shared('devkits.last-thread-agents')?.[key])
      || available.find(agent => agent.key === shared('devkits.last-thread-agent')) || available[0];
  }

  async repeatThread(cx, projectId) {
    const project = this.projects().find(project => projectId ? project.id === projectId : project.active);
    if (!project) return this.newThread(cx);
    const target = { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name };
    try {
      const agent = this.defaultThreadAgent(project, await this.cachedAgents(project.machine));
      if (!agent) return this.newThread(cx, project.id);
      await this.startThread(agent, target);
    } catch (error) {
      notify({ title: 'Could not start session', body: error.message, level: 'error' });
    }
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

  // An Asana task becomes the thread name and the agent's opening prompt, and leaves Saved once started.
  // `options` picks this session's model and effort; Default leaves the launcher's own.
  async startThread(agent, target = props(), options = {}) {
    const key = JSON.stringify([target.space || folderKey(target.folder || ''), agent?.key || agent?.run,
      target.task?.gid || null]);
    if (startingThreads.has(key)) return;
    startingThreads.add(key);
    try { await this.launchThread(agent, target, options); }
    finally { startingThreads.delete(key); }
  }

  async launchThread(agent, target, options) {
    const task = target.task;
    let argv;
    // A choice made for this session wins; otherwise the profile's own default model and effort apply.
    const profile = shared('devkits.profile-sessions')?.[settingsKey(agent)] || {};
    const session = { model: options.model === undefined ? profile.model : options.model,
      effort: options.effort === undefined ? profile.effort : options.effort };
    const allowed = shared('devkits.session-options')?.[sessionKind(agent)] || {};
    if (allowed.models?.includes(session.model)) session.model = null;
    if (allowed.efforts?.includes(session.effort)) session.effort = null;
    try { argv = agent && sessionArgv(agent, launcherArgv(agent, shared('devkits.codex-permissions')?.[settingsKey(agent)]), session); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); return; }
    // Global rules live on this computer, so only local sessions get them.
    if (argv && !spaces().find(space => space.id === target.space)?.machine) {
      try { argv = rulesArgv(agent, argv, await sessionRules()); } catch {}
    }
    if (task) argv = [...argv, taskPrompt(task)];
    // Closing the launcher destroys its async context; finish reading rules first.
    if (target.overlay) closeOverlay(target.overlay);
    if (task) unsaveTask(target.folder, task.gid);
    this.openThread(target, task?.name || agent?.name, argv, agent?.key, task ? { gid: task.gid, name: task.name, folder: target.folder } : null);
    if (agent?.key) {
      const project = spaces().find(space => space.id === target.space);
      const key = JSON.stringify([project?.machine || '', folderKey(target.folder) || target.space]);
      setShared('devkits.last-thread-agent', agent.key);
      setShared('devkits.last-thread-agents', { ...(shared('devkits.last-thread-agents') || {}), [key]: agent.key });
    }
  }

  // Opens a thread (or a plain terminal, without argv) in the target project and shows it.
  openThread(target, name, argv, profile, task) {
    if (argv && !spaces().find(space => space.id === target.space)?.machine) argv = commandArgv(argv, window()?.platform);
    // Commands do not return the new tab, so the sidebar matches it once it appears.
    if (profile) setShared('devkits.pending-profiles', [...(shared('devkits.pending-profiles') || []), { key: profile,
      space: target.space || null, folder: target.folder, before: spaces().flatMap(space => space.tabs.map(tab => tab.id)), at: Date.now(),
      ...(task ? { task } : {}) }]);
    hidePanels();
    this.showConversation(true, { ...target, id: target.space, machine: spaces().find(space => space.id === target.space)?.machine });
    rememberPanel(target.space, null);
    setShared('devkits.selected-project', null);
    run('layout.select', { stack: 'workspace-view', child: 'main' });
    if (target.space) run('tab.new', { space: target.space, folder: target.folder, ...(argv ? { name, argv } : {}) });
    else run('space.new', { name: target.projectName, folder: target.folder, machine: '', ...(argv ? { tab: name, argv } : {}) });
  }

  // The Asana composer starts the session itself with the chosen agent, model and effort.
  asanaPanel(cx) {
    const project = this.projects().find(project => project.active);
    const hidden = shared('devkits.hidden-launchers') || [];
    const agents = launcherChoices(shared('devkits.agent-cache')?.[JSON.stringify(null)] || [], shared('devkits.launcher-order') || [])
      .filter(choice => choice.agent && !hidden.includes(choice.key)).map(choice => choice.agent);
    return this.asana.render(project, agents,
      (agent, task, options) => this.startThread(agent, { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name, task }, options),
      () => { hidePanels(); rememberPanel(project.id, null); }, cx);
  }

  async close() {
    this.files?.close();
    this.diff?.close();
    await this.login?.close();
  }

  header(t) {
    const space = this.projects().find(s => s.active);
    const win = window();
    const root = layout(), sidebar = root?.children?.find(node => node.id === 'sidebar');
    const inset = win?.platform === 'macos' && !win.fullscreen && sidebar?.hidden
      ? (root.traffic_lights[0] + 64) / settings().zoom : 12;
    // Controls fill the header's height; the project switcher and window buttons sit flush with its edges.
    return h_flex().size_full().pl(inset - 12).items_center().bg(t.background).text_size(13)
      .border_b(1).border_color(t.border)
      .child(DropdownMenuTrigger(h_flex().id('project-switcher').h_full().pl(10).pr(6).gap(6).items_center().rounded(0)
        .text_color(t.foreground).font_medium().hover(el => el.bg(t.hover)).cursor_pointer(), 280,
        (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 280, at,
          props: { view: 'project-picker' } }), 'start', { x: 8, y: 9 }) // Clear of the header's 1px bottom border
        .child(div().max_w(220).truncate().child(space?.name || 'Open project'))
        .child(glyph('chevron-down', 12).text_color(t.muted)))
      // Like Zed, the branch opens a list of the project's branches; it only shows them for now.
      .when(Boolean(space?.branch), el => el.child(DropdownMenuTrigger(h_flex().id('branch-switcher').h_full().px(8).gap(4).items_center().rounded(0)
        .text_size(12).text_color(t.muted).hover(el => el.bg(t.hover)).cursor_pointer().accessibility_label(`Branches of ${space.name}`), 320,
        (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 320, at,
          props: { view: 'branch-menu', folder: space.folder, machine: space.machine || null, branch: space.branch } }), 'start', { x: 8, y: 9 })
        .child(glyph('branch', 12)).child(div().max_w(200).truncate().child(space.branch))))
      .child(div().flex_1())
      .when(Boolean(space), el => el.child(RunControls(t)))
      .when(Boolean(win?.buttons), el => el
        .child(Button('minimize', t, { variant: 'ghost', size: 'icon' }).h_full().w(32).accessibility_label('Minimize')
          .on_click(() => run('window.minimize')).child(glyph('minus')))
        .child(Button('maximize', t, { variant: 'ghost', size: 'icon' }).h_full().w(32).accessibility_label('Maximize / restore')
          .on_click(() => run('window.maximize')).child(glyph('square')))
        .child(Button('close-window', t, { variant: 'ghost', size: 'icon' }).h_full().w(32).accessibility_label('Close window')
          .on_click(() => run('window.close')).child(glyph('close'))));
  }

  brand(t) {
    return div().size_full().bg(t.chrome).border_b(1).border_color(t.border);
  }

  paneHeader(t) {
    const p = panes().find(p => p.pane === props()?.pane);
    if (!p) return div();
    const thread = projectGroups(spaces(), agents()).flatMap(group => group.threads).find(thread => thread.tab.id === p.tab);
    const program = threadProgram(thread, terminals(), p.program);
    const machine = spaces().find(space => space.id === thread?.space)?.machine || null;
    const profile = thread?.agent ? threadProfile(thread.tab, shared('devkits.agent-cache')?.[JSON.stringify(machine)],
      shared('devkits.thread-profiles') || {}) : null;
    const title = thread?.title || p.title || 'Terminal';
    const link = shared('devkits.thread-tasks')?.[p.tab];
    const icon = program?.icon ? (program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)) : glyph('terminal');
    return h_flex().size_full().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .text_size(12).text_color(t.muted).on_click(() => run('pane.focus', { pane: p.pane }))
      .child(div().flex_none().child(icon))
      .child(div().min_w(0).truncate().text_color(t.foreground).child(title))
      .when(Boolean(profile) && profile !== title, el => el.child(div().flex_none().child(profile)))
      .child(div().flex_1())
      .when(Boolean(link), el => el.child(Button(`asana-link-${p.tab}`, t, { variant: 'ghost' }).h(22).px(6).gap(5).text_size(10)
        .border(1).border_color(t.border).accessibility_label(`Show Asana task ${link.name}`)
        .on_click((_event, cx) => { cx.stop_propagation(); this.openTask(thread.space, link); })
        .child(glyph('list-todo', 12)).child('Asana')))
      .child(DropdownMenuTrigger(Button(`new-thread-${p.pane}`, t, { variant: 'ghost', size: 'icon' })
        .accessibility_label('New thread…').child(glyph('plus')), 280,
        (cx, at) => this.newThread(cx, thread?.space, at), 'end'));
  }

  // Opens the thread's project on its Asana panel with the linked task in the preview.
  openTask(spaceId, task) {
    const project = this.projects().find(project => project.id === spaceId);
    if (!project) return;
    this.selectProject(project);
    showPanel('asana', project.id);
    setShared('devkits.asana-focus', { folder: task.folder, gid: task.gid });
  }

  statusBar(t) {
    const space = this.projects().find(s => s.active);
    // The Simulator panel is the devkits-simulator mod; a layout without its block has no simulator button.
    // Other platforms keep the button; the panel says it is unsupported there.
    const simulator = layoutNode(layout(), 'simulator'), editor = layoutNode(layout(), 'editor');
    const conversation = layoutNode(layout(), 'workspace-view');
    const showing = name => Boolean(editor) && !editor.hidden && editor.active === name;
    // Like Zed: the branch sits beside the project in the header; only a remote project names its machine here.
    return h_flex().size_full().pr(4).gap(8).items_center().bg(t.background).border_t(1).border_color(t.border)
      .text_size(11).text_color(t.muted)
      .when(Boolean(space?.machine), el => el.child(h_flex().pl(16).gap(8).items_center().child(glyph('terminal', 12)).child(space.machine)))

      .when(Boolean(space && conversation), el => el
        .child(Button('open-conversation', t, { variant: 'ghost', size: 'icon' }).h_full().rounded(0)
          .bg(conversationVisible(space) ? t.selected : t.background)
          .accessibility_label(conversationVisible(space) ? 'Hide conversation' : 'Show conversation')
          .on_click(() => {
            hidePanels(); rememberPanel(space.id, null);
            this.showConversation(!conversationVisible(space));
          }).child(glyph('agent'))))
      .child(div().flex_1())
      .child(Button('settings', t, { variant: 'ghost', size: 'icon' }).h_full()
        .accessibility_label('Herdr settings')
        .on_click(() => run('app.settings')).child(glyph('gear')))
      .when(Boolean(simulator), el => el
        .child(Button('open-simulator', t, { variant: 'ghost', size: 'icon' })
          .h_full().rounded(0)
          .bg(simulator.hidden ? t.background : t.selected)
          .accessibility_label(simulator.hidden ? 'Show simulator' : 'Hide simulator')
          .on_click(() => run('layout.toggle', { id: 'simulator' }))
          .child(glyph('smartphone'))))
      .when(Boolean(space), el => el
        .child(Button('open-diff', t, { variant: 'ghost', size: 'icon' })
          .h_full().rounded(0)
          .bg(showing('diff') ? t.selected : t.background)
          .accessibility_label(showing('diff') ? 'Hide changes' : 'Show changes')
          .on_click(() => toggleEditor(editor, 'diff'))
          .child(glyph('git-compare')))
        .child(Button('open-files', t, { variant: 'ghost', size: 'icon' })
          .h_full().rounded(0)
          .bg(showing('files') ? t.selected : t.background)
          .accessibility_label(showing('files') ? 'Hide files' : 'Show files')
          .on_click(() => toggleEditor(editor, 'files'))
          .child(glyph('folder'))));
  }

  threadRow(thread, t) {
    const working = thread.status === 'working' || thread.agents.some(agent => agent.status === 'working');
    const isFocused = thread.active;
    const p = threadProgram(thread, terminals());
    const archive = archivable(thread, terminals()) && !this.closeOnlyThreads?.has(thread.tab.id);
    const icon = working ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
      : p?.icon ? (p.tint ? svg(p.icon).size(14).text_color(t.muted) : image(p.icon).size(14)) : glyph('terminal', 14).text_color(t.muted);
    return SidebarMenuButton(`thread-${thread.tab.id}`, isFocused, t)
      .on_hover((hovered, cx) => {
        // A previous row's leave event can arrive after the next row's enter.
        if (!hovered && this.hovered !== thread.tab.id) return;
        const next = hovered ? thread.tab.id : null;
        if (this.hovered === next) return;
        this.hovered = next;
        cx.notify();
      })
      .on_click(() => {
        rememberPanel(thread.space, null);
        this.selectProject(this.projects().find(project => project.id === thread.space));
        this.showConversation(true);
        run('tab.select', { id: thread.tab.id });
      })
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground)
        .when(isFocused, el => el.font_medium()).child(thread.title))
      // Only a Claude or Codex conversation can be archived; terminals simply close.
      .child(Button(`${archive ? 'archive' : 'close'}-thread-${thread.tab.id}`, t, { variant: 'row', size: 'icon-sm' })
        .opacity(this.hovered === thread.tab.id ? 1 : 0)
        .accessibility_label(archive ? 'Archive thread' : 'Close thread')
        .on_click((_event, cx) => {
          cx.stop_propagation();
          if (archive) cx.spawn(async cx => { await this.archiveThread(thread); cx.notify(); });
          else run('tab.close', { id: thread.tab.id });
        })
        .child(glyph(archive ? 'archive' : 'close', 12)));
  }

  // A terminal the thread's agent started with hc run, indented under it; it peeks over the thread when clicked.
  childRow(thread, { terminal, depth, label }, t) {
    const key = `child:${terminal.address}`;
    const p = terminal.program;
    const icon = terminal.status === 'working' ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
      : p?.icon && !p.shell ? (p.tint ? svg(p.icon).size(14).text_color(t.muted) : image(p.icon).size(14)) : glyph('terminal', 14).text_color(t.muted);
    return SidebarMenuButton(`child-${terminal.address}`, false, t).pl(12 + depth * 16)
      .on_hover((hovered, cx) => {
        if (!hovered && this.hovered !== key) return;
        const next = hovered ? key : null;
        if (this.hovered === next) return;
        this.hovered = next;
        cx.notify();
      })
      .on_click(() => {
        rememberPanel(thread.space, null);
        this.selectProject(this.projects().find(project => project.id === thread.space));
        this.showConversation(true);
        run('tab.select', { id: thread.tab.id });
        run('terminal.peek', { terminal: terminal.address });
      })
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(label))
      .child(Button(`end-child-${terminal.address}`, t, { variant: 'row', size: 'icon-sm' })
        .opacity(this.hovered === key ? 1 : 0)
        .accessibility_label(`End ${label}`)
        .on_click((_event, cx) => { cx.stop_propagation(); run('terminal.kill', { terminal: terminal.address }); })
        .child(glyph('close', 12)));
  }

  render(cx) {
    const t = theme();
    if (props()?.view === 'codex-sharing') return this.sharingDialog(t);
    if (props()?.view === 'token-statistics') return this.analytics.render();
    if (props()?.view === 'xcode-storage') return this.xcodeStorage.render();
    if (props()?.view === 'codex-permissions') return div();
    if (props()?.view === 'file-menu') return this.fileMenu.render();
    if (props()?.view === 'files') return this.files.render(this.projects().find(project => project.active), cx);
    if (props()?.view === 'diff') return this.diff.render(this.projects().find(project => project.active), cx);
    if (props()?.view === 'account-login') return this.login.render();
    if (props()?.view === 'header') return this.header(t);
    if (props()?.view === 'run-menu') return this.runMenu.render(t);
    if (props()?.view === 'branch-menu') return this.branchMenu.render(t);
    if (props()?.view === 'usage-details') return this.usageDetails(t);
    if (props()?.view === 'brand') return this.brand(t);
    if (props()?.view === 'pane') return this.paneHeader(t);
    if (props()?.view === 'status') return this.statusBar(t);
    if (props()?.view === 'launcher') return this.launcher(t);
    if (props()?.view === 'asana') return this.asanaPanel(cx);
    if (props()?.view === 'asana-projects') return this.asanaProjects.render();
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
      const previous = shared('devkits.native-selection');
      if (previous !== undefined) {
        hidePanels();
        // Switching projects brings back that project's panel; another tab in the same project is a thread choice.
        if (previous.split(':')[0] === (active?.id || '')) rememberPanel(active?.id, null);
        if (!restorePanel(active?.id)) {
          setShared('devkits.selected-project', null);
          run('layout.select', { stack: 'workspace-view', child: 'main' });
        }
      }
      setShared('devkits.native-selection', selection);
    }
    const workspaces = this.projects();
    const chosen = workspaces.find(p => p.active);
    this.projectLayout ??= new ProjectLayout();
    this.projectLayout.sync(chosen);
    const selectedTab = chosen?.tabs.find(tab => tab.active);
    const defaultSelected = selectedTab && (selectedTab.id === shared('devkits.default-terminals')?.[chosen.id]
      || selectedTab.name === '__devkits_default_terminal__')
      && !all.some(agent => agent.space === chosen.id && agent.tab === selectedTab.id);
    const content = chosen && shared('devkits.asana') === chosen.id ? 'asana' : chosen?.pending || defaultSelected ? 'project-empty' : 'main';
    if (this.shownContent !== content) {
      this.shownContent = content;
      run('layout.select', { stack: 'workspace-view', child: content });
    }
    const conversation = layoutNode(layout(), 'workspace-view');
    const showConversation = content === 'asana' || conversationVisible(chosen);
    if (conversation && conversation.hidden === showConversation)
      run(showConversation ? 'layout.show' : 'layout.hide', { id: 'workspace-view' });
    const defaults = { ...(shared('devkits.default-terminals') || {}) };
    let defaultsChanged = false;
    for (const space of native) {
      if (defaults[space.id]) continue;
      const tab = space.tabs.find(tab => tab.name === '__devkits_default_terminal__');
      if (tab) { defaults[space.id] = tab.id; defaultsChanged = true; }
    }
    if (defaultsChanged) setShared('devkits.default-terminals', defaults);
    if (shared('devkits.pending-profiles')?.length) {
      const resolved = resolveThreadProfiles(native, shared('devkits.pending-profiles'), shared('devkits.thread-profiles') || {},
        Date.now(), shared('devkits.thread-tasks') || {});
      if (resolved.pending.length !== shared('devkits.pending-profiles').length) {
        setShared('devkits.thread-profiles', resolved.profiles);
        setShared('devkits.thread-tasks', resolved.tasks);
        setShared('devkits.pending-profiles', resolved.pending);
      }
    }
    const groups = projectGroups(workspaces, all, defaults);
    const live = terminals();
    const visible = groups.filter(g => !this.folded.has(g.space.id)).flatMap(g => g.threads.flatMap(thread => thread.agents));
    setAgentOrder(visible.map(a => a.address));
    return Sidebar(t)
      .child(this.archiveOpen ? this.archiveList(t) : SidebarContent()
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
            .child(Button(`new-thread-${space.id}`, t, { variant: 'row', size: 'icon' })
              .accessibility_label(`New thread in ${space.name}`)
              .on_click((_event, cx) => {
                cx.stop_propagation();
                this.folded.delete(space.id);
                cx.spawn(async cx => { await this.repeatThread(cx, space.id); });
                cx.notify();
              })
              .child(glyph('plus')).opacity(this.hoveredProject === space.id ? 1 : 0))
            .child(DropdownMenuTrigger(Button(`project-menu-${space.id}`, t, { variant: 'row', size: 'icon' })
              .accessibility_label(`More actions for ${space.name}`), 200,
              (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 200, at,
                props: { view: 'project-menu', project: space } }), 'end', SIDEBAR_MENU)
              .child(glyph('ellipsis')).opacity(this.hoveredProject === space.id ? 1 : 0)))
          .when(!this.folded.has(space.id), el => el.children(threads.flatMap(thread => [this.threadRow(thread, t),
            ...childTerminals(live, thread.agents.map(agent => agent.address)).map(child => this.childRow(thread, child, t))]))
            .when(!threads.length, el => el.child(h_flex().h(32).flex_none().px(12).items_center().text_size(12).text_color(t.muted).child('No threads yet')))))))
      .child(this.accountUsage(t))
      .child(SidebarFooter(t)
        .child(Button('archived-threads', t, { variant: 'ghost', size: 'icon' })
          .accessibility_label(this.archiveOpen ? 'Show threads' : 'Show archived threads')
          .h_full().rounded(0).bg(this.archiveOpen ? t.selected : t.chrome)
          .on_click((_event, cx) => { this.archiveOpen = !this.archiveOpen; cx.notify(); }).child(glyph('archive')))
        .child(div().flex_1()));
  }
}

// Feature views share this view's state and its project, agent and session helpers.
Object.assign(Devkits.prototype, sessionMenu, accountActions, agentUsage, threadArchive);
