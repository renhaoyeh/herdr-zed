import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { agents, spaces, panes, theme, run, props, window, openOverlay, closeOverlay, setAgentOrder, layout, settings, pickFolder, shared, setShared, knownAgents, notify, appHome, readTextFile, nextCommand, terminals } from 'herdr';
import { projectGroups, projectCatalog, folderKey, launcherChoices, isAccountLauncher, launcherArgv, sessionArgv, sessionKind, resolveThreadProfiles, threadProfile, threadProgram, archivable, rulesArgv, childTerminals, terminalLabel, terminalWorking, settingsKey } from './model.js';
import { terminalArgv } from './shell-command.js';
import AccountLogin, { accountLabel } from './account-login.js';
import FileViewer, { FileMenu } from './files.js';
import DiffViewer from './diff.js';
import { GitResultToast, clearGitToast } from './git-result-toast.js';
import WorkspaceEditor from './workspace-editor.js';
import Analytics from './analytics.js';
import LocalCalendar from './calendar.js';
import XcodeStorage from './xcode-storage.js';
import AgentBoard from './agent-board.js';
import { observeTaskInput } from './agent-task-evidence.js';
import TaskComposer, { openTaskComposer } from './task-composer.js';
import { rememberBoardTask, threadBoardStatus, projectBoardTasks, setTaskArchived, threadTaskArchived, threadVisibleInSidebar, threadBoardTask, sessionThreadTitle } from './agent-board-state.js';
import { boardStatuses, canStartTask, taskActions } from './agent-board-model.js';
import AsanaPanel, { AsanaProjectPicker, taskPrompt } from './asana.js';
import MantisPanel, { MantisProjectPicker } from './mantisbt.js';
import { sessionMenu } from './session-menu.js';
import { agentProfiles } from './agent-profiles.js';
import { accountActions } from './account-actions.js';
import { agentUsage } from './usage.js';
import { hardwareUsage } from './hardware.js';
import { RunControls, RunMenu, runApp } from './run-app.js';
import { BranchMenu } from './branch-menu.js';
import { ProjectLayout, layoutNode, conversationMaximized, maximizeConversation, openTaskBoard, closeTaskBoard, enforceTaskBoard, taskMode } from './project-layout.js';
import { threadArchive } from './thread-archive.js';
import { sessionRules, ensureRules } from './global-rules.js';
import { DropdownMenu, DropdownMenuState, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button } from './components/button.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './components/alert-dialog.js';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenuButton, SidebarTreeMenuButton, SidebarFooter } from './components/sidebar.js';

// A 28px icon button centred in a 32px project row: 8px below the row.
const SIDEBAR_MENU = { x: 0, y: 10 };
import { glyph } from './components/icon.js';

const startingThreads = new Set();
// Asana opens independently above the workspace, bound to its originating project.
// Files and Changes share the editor beside the thread instead, shown or hidden in the layout like the simulator.
const hidePanels = () => { setShared('devkits.asana', null); };
// Clear legacy inline-panel state when opening an Asana pop-out.
const rememberPanel = (id, name) => { if (id) setShared('devkits.project-panels', { ...(shared('devkits.project-panels') || {}), [id]: name || null }); };
const openAsana = (project, source = 'asana') => {
  hidePanels();
  rememberPanel(project.id, null);
  return openOverlay({ mod: 'devkits', kind: 'dialog', modal: true, frame: 'none',
    width: 0.9, height: 0.86, props: { view: source, project } });
};
const openCalendar = () => openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: true, width: 0.9, height: 0.86,
  props: { view: 'calendar' } });
const restorePanel = () => false;
// Like Zed's dock buttons: close only the side panel, preserving the central document.
const toggleEditor = (_editor, name) => {
  const maximized = Boolean(shared('devkits.conversation-maximized'));
  maximizeConversation(null, false);
  setShared('devkits.right-panel', !maximized && shared('devkits.right-panel') === name ? null : name);
};
const conversationKey = project => JSON.stringify([project.machine || '', folderKey(project.folder) || project.id]);
const conversationVisible = project => Boolean(project && shared('devkits.conversation-visible')?.[conversationKey(project)]);
const agentLoads = new Map();

export default class Devkits extends View {
  init(_props, cx) {
    if (['calendar', 'google-calendar'].includes(props()?.view)) {
      this.calendar = new LocalCalendar(); this.calendar.init(cx); return;
    }
    if (props()?.view === 'status') {
      clearGitToast(); setShared('devkits.git-output-request', null);
    }
    if (props()?.view === 'task-composer') {
      this.taskComposer = new TaskComposer(); this.taskComposer.init(props(), cx);
      cx.spawn(async cx => { try { await this.cachedAgents(props().project?.machine || null); } catch {} cx.notify(); });
      return;
    }
    if (props()?.view === 'pane') { this.threadMenu = new DropdownMenuState(cx); return; }
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
      openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 1040, height: 0.8,
        props: { view: 'manage-launchers', space: target.space } });
      return;
    }
    if (props()?.view === 'usage-details') cx.timer.every(60000, cx => cx.notify());
    if (['hardware-details', 'status'].includes(props()?.view)) {
      this.pollHardware(cx, false);
      cx.timer.every(1000, cx => this.pollHardware(cx));
    }
    if (!props()?.view && cx) {
      cx.timer.every(1500, cx => observeTaskInput(agents(), terminals(), cx));
      // Shared values survive restarts; discover once for this app session.
      setShared('devkits.agent-cache', {});
      this.refreshUsage(cx);
      this.pollHardware(cx, false);
      cx.timer.every(1000, cx => this.pollHardware(cx));
      this.initSkillWatch(cx);
      const activeMachine = this.projects().find(project => project.active)?.machine || null;
      for (const machine of new Set([null, ...spaces().map(space => space.machine || null)])) {
        if (machine === activeMachine) continue;
        cx.spawn(async () => { try { await this.cachedAgents(machine); } catch {} });
      }
      cx.timer.every(60000, cx => this.refreshUsage(cx));
      cx.spawn(async () => { try { await ensureRules(); } catch {} });
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
        if (command === 'new-task') { const project = this.projects().find(project => project.active); if (project) openTaskComposer(project); }
        if (command === 'calendar') openCalendar();
        if (command === 'run') await runApp();
        if (command === 'new-thread') await this.repeatThread(cx);
        if (command === 'reveal-conversation') this.showConversation(true);
        if (command === 'close-board') this.closeBoard();
        if (command === 'agent-board') {
          const project = this.projects().find(project => project.active);
          if (project && !project.machine) {
            this.openBoard(project);
          }
        }
      }
    });
    if (props()?.view === 'editor') {
      this.editor = new WorkspaceEditor(); this.editor.init(cx); this.files = this.editor.files;
      this.agentBoard = new AgentBoard(); this.agentBoard.init(cx);
      cx.spawn(async cx => { try { await this.cachedAgents(null); } catch {} cx.notify(); });
      cx.spawn(async cx => {
        for (;;) {
          const command = await nextCommand();
          if (command === 'agent-board') { const project = this.projects().find(project => project.active); if (project && !project.machine) this.openBoard(project); }
          if (command === 'close-board') this.closeBoard();
          if (command === 'close-file') this.closeFileTab(cx);
          if (command === 'focus' || command === 'focus-editor') this.editor.focus();
        }
      });
      return;
    }
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
    if (['close-project', 'remove-account', 'rename-account', 'project-menu', 'project-picker', 'usage-details', 'hardware-details'].includes(props()?.view)) {
      this.handle = cx.focus_handle();
      if (props().view !== 'rename-account') this.handle.focus();
      if (props().view === 'project-picker') this.projectIndex = -1;
    }
    if (['asana-projects', 'mantisbt-projects'].includes(props()?.view)) {
      this.asanaProjects = props().view === 'mantisbt-projects' ? new MantisProjectPicker() : new AsanaProjectPicker();
      this.asanaProjects.init(props(), cx);
      return;
    }
    if (['asana', 'mantisbt'].includes(props()?.view)) {
      this.asana = props().view === 'mantisbt' ? new MantisPanel() : new AsanaPanel();
      this.asana.init(cx);
      return;
    }
    if (['launcher', 'manage-launchers', 'agent-profile-editor'].includes(props()?.view)) this.initSessionMenu(cx);
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
          if (!taskMode()) run('layout.select', { stack: 'workspace-view', child: 'main' });
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
    if (!taskMode()) run('layout.select', { stack: 'workspace-view', child: project.pending ? 'project-empty' : 'main' });
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
    const actions = [
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
    if (visible && taskMode()) this.closeBoard();
    if (!visible) maximizeConversation(null, false);
    setShared('devkits.conversation-visible', { ...(shared('devkits.conversation-visible') || {}), [conversationKey(project)]: visible });
    run(visible ? 'layout.show' : 'layout.hide', { id: 'workspace-view' });
    if (visible) {
      const pane = panes().find(pane => pane.tab === project.tabs?.find(tab => tab.active)?.id);
      if (pane) run('pane.focus', { pane: pane.pane });
    } else run('devkits.focus-editor');
  }

  closeFileTab(cx) {
    const editor = layoutNode(layout(), 'editor');
    if (editor && !editor.hidden && this.editor) { this.editor.closeActiveTab(cx); return; }
    if (editor && !editor.hidden && (shared('devkits.editor-kind') || editor.active || 'files') === 'files' && this.files?.file)
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
    if (cached) return this.availableAgents(cached, machine);
    if (agentLoads.has(key)) return this.availableAgents(await agentLoads.get(key), machine);
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
    try { return this.availableAgents(await pending, machine); } finally { agentLoads.delete(key); }
  }

  // A task becomes the thread name and the agent's opening prompt.
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
    const config = agent?.profileKey && (shared('devkits.agent-configs') || []).find(item => item.key === agent.key && item.profileKey === agent.profileKey);
    if (agent?.profileKey && !config) {
      notify({ title: 'Agent configuration is unavailable', body: 'Choose another agent configuration.' });
      return;
    }
    const task = target.task;
    if (task) {
      const project = this.projects().find(item => item.id === target.space || (!item.machine && folderKey(item.folder) === folderKey(target.folder))) || { folder: target.folder, tabs: [] };
      const current = projectBoardTasks(project, agents()).find(item => item.gid === task.gid);
      if (current && !taskActions(current).canStart) {
        notify({ title: 'Task is not ready to start', body: 'Move this task to Todo before starting a new session.' });
        return;
      }
    }
    let argv;
    // A choice made for this session wins; otherwise the profile's own default model and effort apply.
    const profile = shared('devkits.profile-sessions')?.[settingsKey(agent)] || {};
    const session = { model: options.model === undefined ? profile.model : options.model,
      effort: options.effort === undefined ? profile.effort : options.effort,
      serviceTier: profile.serviceTier };
    const allowed = shared('devkits.session-options')?.[sessionKind(agent)] || {};
    if (allowed.models?.includes(session.model)) session.model = null;
    if (allowed.efforts?.includes(session.effort)) session.effort = null;
    try { argv = agent && sessionArgv(agent, launcherArgv(agent, shared('devkits.codex-permissions')?.[settingsKey(agent)]), session); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); return; }
    // Global rules live on this computer, so only local sessions get them.
    if (argv && !spaces().find(space => space.id === target.space)?.machine) {
      let rules = null;
      try { rules = await sessionRules(); } catch {}
      argv = rulesArgv(agent, argv, rules, config?.instructions);
    }
    // A local task may be deleted while its launch rules are being read.
    if (task?.source === 'local') {
      const project = this.projects().find(item => item.id === target.space || (!item.machine && folderKey(item.folder) === folderKey(target.folder)));
      if (!project || !canStartTask(projectBoardTasks(project, agents()).find(item => item.gid === task.gid))) return;
    }
    if (task) argv = [...argv, taskPrompt(task)];
    // Closing the launcher destroys its async context; finish reading rules first.
    if (target.overlay) closeOverlay(target.overlay);
    if (task) {
      rememberBoardTask({ folder: target.folder }, task, { status: 'todo', manual: false, seenWorking: false, agentKey: agent.key, agentName: agent.name });
    }
    this.closeBoard();
    this.openThread(target, task?.name || agent?.name, argv, agent?.key, task ? { gid: task.gid, name: task.name, folder: target.folder, ...(task.source ? { source: task.source } : {}) } : null);
    if (agent?.key) {
      const project = spaces().find(space => space.id === target.space);
      const key = JSON.stringify([project?.machine || '', folderKey(target.folder) || target.space]);
      setShared('devkits.last-thread-agent', agent.key);
      setShared('devkits.last-thread-agents', { ...(shared('devkits.last-thread-agents') || {}), [key]: agent.key });
    }
  }

  // Opens a thread (or a plain terminal, without argv) in the target project and shows it.
  openThread(target, name, argv, profile, task) {
    if (argv && !spaces().find(space => space.id === target.space)?.machine) argv = terminalArgv(argv, window()?.platform);
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

  // Asana only picks a source. Review its content in the normal task composer.
  asanaPanel(cx) {
    const project = props().project || this.projects().find(project => project.active);
    return this.asana.render(project,
      task => { closeOverlay(props().overlay); openTaskComposer(project, null, 'todo', task); },
      () => closeOverlay(props().overlay), cx);
  }

  openBoard(project) {
    maximizeConversation(null, false);
    if (!project.active) this.selectProject(project);
    openTaskBoard(project);
  }

  closeBoard() { closeTaskBoard(); }

  taskAssignees(project) {
    const available = this.availableAgents(shared('devkits.agent-cache')?.[JSON.stringify(project?.machine || null)] || [], project?.machine);
    const hidden = shared('devkits.hidden-launchers') || [];
    return launcherChoices(available, shared('devkits.launcher-order') || [])
      .filter(choice => choice.agent && choice.agent.installed !== false && !hidden.includes(choice.key))
      .map(choice => ({ ...choice.agent, name: isAccountLauncher(choice.agent) ? accountLabel(choice.name) : choice.name }));
  }

  boardPanel(project, cx) {
    const launchers = this.taskAssignees(project);
    return this.agentBoard.render(project, agents(), launchers, {
      asana: () => openAsana(project),
      mantisbt: () => openAsana(project, 'mantisbt'),
      archive: (task, eventCx) => {
        const currentProject = this.projects().find(item => item.id === project.id) || project;
        const current = projectBoardTasks(currentProject, agents()).find(item => item.gid === task.gid);
        if (!taskActions(current).canArchive) return;
        task = current;
        if (!task.tabs.length) { setTaskArchived(project, task, true); return; }
        const thread = projectGroups([project], agents(), {}, sessionThreadTitle).flatMap(group => group.threads).find(thread => task.tabs.some(tab => tab.id === thread.tab.id));
        if (thread) eventCx.spawn(async cx => { await this.archiveThread(thread); cx.notify(); });
      },
      restore: task => {
        const entry = (shared('devkits.archived-threads') || []).find(entry => entry.id === task.archiveId);
        if (entry) this.restoreThread(entry);
        else setTaskArchived(project, task, false);
      },
      close: () => this.closeBoard(),
      thread: id => {
        this.selectProject(project);
        run('tab.select', { id });
        this.showConversation(true, { ...project, tabs: [{ id, active: true }] });
      },
      start: (agent, task, options, eventCx) => eventCx.spawn(async cx => {
        const currentProject = this.projects().find(item => item.id === project.id) || project;
        if (!canStartTask(projectBoardTasks(currentProject, agents()).find(item => item.gid === task.gid))) return;
        try { await this.startThread(agent, { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name, task }, options); }
        catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); }
        cx.notify();
      }),
    }, cx);
  }

  groupedThreads(space, threads, t, live) {
    threads = threads.filter(thread => threadVisibleInSidebar(space, thread));
    const tasks = space.machine ? [] : projectBoardTasks(space, agents()).filter(task => !task.tabs.length && !task.archived && task.source !== 'thread');
    const sessions = threads.filter(thread => threadBoardStatus(space, thread) === null);
    return [...sessions.map(thread => this.renderThreadGroup(thread, t, live)), ...boardStatuses.flatMap(status => {
      const cards = tasks.filter(task => task.status === status.key);
      const rows = threads.filter(thread => threadBoardStatus(space, thread) === status.key);
      if (!rows.length && !cards.length) return [];
      return [h_flex().h(26).flex_none().px(12).gap(6).items_center().text_size(10).text_color(t.muted)
        .child(glyph(status.icon, 12).text_color(status.color)).child(status.label).child(String(rows.length + cards.length)),
        ...cards.map(task => SidebarMenuButton(`board-task-${space.id}-${task.gid}`, false, t)
          .on_click(() => { this.openBoard(space); setShared('devkits.board-focus', task.gid); })
          .child(glyph(status.icon, 14).text_color(status.color))
          .child(div().min_w(0).truncate().text_size(13).child(task.name))),
        ...rows.map(thread => this.renderThreadGroup(thread, t, live))];
    })];
  }

  async close() {
    this.calendar?.close?.();
    this.closeSkillWatch();
    this.sharingPoll?.cancel();
    this.taskComposer?.saveDraft();
    if (this.editor) this.editor.close();
    else this.files?.close();
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

  paneHeader(t, cx) {
    const p = panes().find(p => p.pane === props()?.pane);
    if (!p) return div();
    const thread = projectGroups(spaces(), agents(), {}, sessionThreadTitle).flatMap(group => group.threads).find(thread => thread.tab.id === p.tab);
    const members = panes().filter(pane => pane.tab === p.tab);
    const primary = members.find(pane => pane.terminal === thread?.agents[0]?.address) || members[0];
    const secondary = members.length > 1 && primary?.pane !== p.pane;
    const program = secondary ? p.program : threadProgram(thread, terminals(), p.program);
    const machine = spaces().find(space => space.id === thread?.space)?.machine || null;
    const profile = !secondary && thread?.agent ? threadProfile(thread.tab, this.availableAgents(shared('devkits.agent-cache')?.[JSON.stringify(machine)] || [], machine),
      shared('devkits.thread-profiles') || {}) : null;
    const title = secondary ? p.title || 'Terminal' : thread?.tab.name === '__devkits_default_terminal__' && !thread.agent ? 'Terminal' : thread?.title || p.title || 'Terminal';
    const link = secondary ? null : shared('devkits.thread-tasks')?.[p.tab];
    const project = this.projects().find(project => project.id === thread?.space);
    const maximized = conversationMaximized(project);
    this.threadMenu ??= new DropdownMenuState();
    const actions = [{ key: 'close', label: secondary ? 'Close terminal' : 'Close thread' }];
    const choose = () => secondary ? run('pane.close', { pane: p.pane }) : run('tab.close', { id: p.tab });
    const terminal = terminals().find(terminal => terminal.address === p.terminal);
    const working = terminalWorking({ ...terminal, status: p.status || terminal?.status });
    const icon = working ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
      : program?.icon ? (program.tint ? svg(program.icon).size(14).text_color(p.focused ? t.foreground : t.muted) : image(program.icon).size(14)) : glyph('terminal').text_color(p.focused ? t.foreground : t.muted);
    return h_flex().id(`pane-header-${p.pane}`).size_full().pl(12).gap(8).items_center()
      .bg(p.focused ? t.selected : t.chrome).border_b(1).border_color(p.focused ? t.accent : t.border)
      .text_size(12).text_color(t.muted).on_click(() => run('pane.focus', { pane: p.pane }))
      .child(div().flex_none().child(icon))
      .child(div().min_w(0).truncate().text_color(p.focused ? t.foreground : t.muted)
        .when(Boolean(p.focused), el => el.font_medium()).child(title))
      .when(Boolean(profile) && profile !== title, el => el.child(div().flex_none().child(profile)))
      .child(div().flex_1())
      .when(Boolean(link), el => el.child(Button(`asana-link-${p.tab}`, t, { variant: 'ghost' }).h(22).px(6).gap(5).text_size(10)
        .border(1).border_color(t.border).accessibility_label(`Show task ${link.name}`)
        .on_click((_event, cx) => { cx.stop_propagation(); this.openTask(thread.space, link); })
        .child(glyph('list-todo', 12)).child(link.source === 'local' ? 'Task' : 'Asana')))
      .child(h_flex().h_full().flex_none().items_center()
        .when(Boolean(project && layoutNode(layout(), 'workspace-view')), el => el.child(
          Button(`maximize-thread-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
            .accessibility_label(maximized ? 'Restore thread' : 'Maximize thread')
            .on_click((_event, cx) => {
              cx.stop_propagation();
              maximizeConversation(project, !conversationMaximized(project));
              run('pane.focus', { pane: p.pane });
            }).child(glyph(maximized ? 'minimize' : 'maximize'))))
        .child(DropdownMenuTrigger(Button(`new-thread-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('New thread…').child(glyph('plus')), 280,
          (cx, at) => this.newThread(cx, thread?.space, at), 'end'))
        .child(DropdownMenu(`thread-actions-${p.pane}`, this.threadMenu,
          Button(`thread-menu-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
            .accessibility_label('Thread options').child(glyph('ellipsis')),
          actions, choose, t, { offset: { x: 8, y: 9 }, fullHeight: true })));
  }

  // All linked tasks return to their project's Tasks workspace.
  openTask(spaceId, task) {
    const project = this.projects().find(project => project.id === spaceId);
    if (!project) return;
    this.openBoard(project); setShared('devkits.board-focus', task.gid);
  }

  statusBar(t) {
    const space = this.projects().find(s => s.active);
    // The Simulator panel is the devkits-simulator mod; a layout without its block has no simulator button.
    // Other platforms keep the button; the panel says it is unsupported there.
    const simulator = layoutNode(layout(), 'simulator'), editor = layoutNode(layout(), 'editor');
    const conversation = layoutNode(layout(), 'workspace-view');
    const showing = name => Boolean(editor) && shared('devkits.right-panel') === name;
    // Like Zed: the branch sits beside the project in the header; only a remote project names its machine here.
    return h_flex().relative().size_full().pr(4).gap(8).items_center().bg(t.background).border_t(1).border_color(t.border)
      .text_size(11).text_color(t.muted)
      .when(Boolean(space?.machine), el => el.child(h_flex().pl(16).gap(8).items_center().child(glyph('terminal', 12)).child(space.machine)))

      .when(Boolean(space && conversation), el => el
        .child(Button('open-conversation', t, { variant: 'ghost', size: 'icon' }).disabled(taskMode()).h_full().rounded(0)
          .bg(conversationVisible(space) ? t.selected : t.background)
          .accessibility_label(conversationVisible(space) ? 'Hide conversation' : 'Show conversation')
          .on_click(() => {
            hidePanels(); rememberPanel(space.id, null);
            this.showConversation(!conversationVisible(space));
          }).child(glyph('agent'))))
      .child(this.systemStatus(t))
      .child(Button('settings', t, { variant: 'ghost', size: 'icon' }).h_full()
        .accessibility_label('Herdr settings')
        .on_click(() => run('app.settings')).child(glyph('gear')))
      .when(Boolean(simulator), el => el
        .child(Button('open-simulator', t, { variant: 'ghost', size: 'icon' }).disabled(taskMode())
          .h_full().rounded(0)
          .bg(simulator.hidden ? t.background : t.selected)
          .accessibility_label(simulator.hidden ? 'Show simulator' : 'Hide simulator')
          .on_click(() => {
            const maximized = Boolean(shared('devkits.conversation-maximized'));
            maximizeConversation(null, false);
            run(maximized ? 'layout.show' : 'layout.toggle', { id: 'simulator' });
          })
          .child(glyph('smartphone'))))
      .when(Boolean(space), el => el
        .child(Button('open-diff', t, { variant: 'ghost', size: 'icon' }).disabled(taskMode())
          .h_full().rounded(0)
          .bg(showing('diff') ? t.selected : t.background)
          .accessibility_label(showing('diff') ? 'Hide changes' : 'Show changes')
          .on_click(() => toggleEditor(editor, 'diff'))
          .child(glyph('git-compare')))
        .child(Button('open-files', t, { variant: 'ghost', size: 'icon' }).disabled(taskMode())
          .h_full().rounded(0)
          .bg(showing('files') ? t.selected : t.background)
          .accessibility_label(showing('files') ? 'Hide files' : 'Show files')
          .on_click(() => toggleEditor(editor, 'files'))
          .child(glyph('folder'))))
      .child(Button('system-monitor-settings', t, { variant: 'ghost' }).h_full().px(8).text_size(11)
        .accessibility_label('System monitor settings').on_click(() => this.openHardware('settings')).child('System'))
      .child(Button('open-calendar', t, { variant: 'ghost', size: 'icon' }).h_full().rounded(0)
        .accessibility_label('Calendar').on_click(openCalendar).child(glyph('calendar')))
      .when(Boolean(space), el => el.child(Button('open-tasks', t, { variant: 'ghost' }).h_full().rounded(0).px(10).gap(6)
        .bg(taskMode() ? t.selected : t.background)
        .accessibility_label('Tasks')
        .on_click(() => { if (taskMode()) this.closeBoard(); else this.openBoard(space); })
        .child(glyph('columns-3', 14)).child('Tasks')))
      .child(GitResultToast(t, space));
  }

  threadRow(thread, t, trunk = null) {
    const members = panes().filter(pane => pane.tab === thread.tab.id);
    const primary = members.find(pane => pane.terminal === thread.agents[0]?.address) || members[0];
    const primaryAgent = thread.agents.find(agent => agent.address === primary?.terminal) || thread.agent;
    if (primaryAgent && primaryAgent !== thread.agent)
      thread = { ...thread, agent: primaryAgent, title: sessionThreadTitle(thread.tab, primaryAgent, this.projects().find(project => project.id === thread.space)) };
    const working = thread.status === 'working' || thread.agents.some(agent => agent.status === 'working')
      || terminalWorking(terminals().find(terminal => terminal.address === primary?.terminal));
    const isFocused = shared('devkits.board-project') !== thread.space && thread.active && (!members.some(pane => pane.focused) || Boolean(primary?.focused));
    const p = threadProgram(thread, terminals(), primary?.program);
    const canArchive = archivable(thread, terminals());
    const stopping = canArchive && this.threadBusy(thread);
    const archive = canArchive && !stopping && !this.closeOnlyThreads?.has(thread.tab.id);
    const checkingArchive = archive && Boolean(this.archiveChecks?.get(thread.tab.id)?.pending);
    const project = this.projects().find(project => project.id === thread.space);
    const archiveDisabled = Boolean(archive && project && !taskActions({ ...threadBoardTask(project, thread), agents: thread.agents }).canArchive);
    const icon = working ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
      : p?.icon ? (p.tint ? svg(p.icon).size(14).text_color(t.muted) : image(p.icon).size(14)) : glyph('terminal', 14).text_color(t.muted);
    return SidebarTreeMenuButton(`thread-${thread.tab.id}`, isFocused, t, 0, trunk)
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
        run('tab.select', { id: thread.tab.id });
        this.showConversation(true, { ...this.projects().find(project => project.id === thread.space), tabs: [{ id: thread.tab.id, active: true }] });
      })
      .child(div().size(16).mr(8).flex_none().flex().items_center().justify_center().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground)
        .when(isFocused, el => el.font_medium()).child(thread.title))
      // Only a Claude or Codex conversation can be archived; terminals simply close.
      .child(Button(`${stopping ? 'stop' : archive ? 'archive' : 'close'}-thread-${thread.tab.id}`, t, { variant: 'row', size: 'icon-sm' })
        .ml(8).opacity(this.hovered === thread.tab.id && !archiveDisabled ? 1 : 0)
        .accessibility_label(stopping ? 'Stop generation' : archive ? 'Archive thread' : 'Close thread')
        .disabled(checkingArchive || archiveDisabled || this.stoppingThreads?.has(thread.tab.id) || false)
        .on_click((_event, cx) => {
          cx.stop_propagation();
          if (checkingArchive || archiveDisabled || (!stopping && canArchive && this.threadBusy(thread))) return;
          if (stopping) cx.spawn(async cx => { await this.stopThread(thread); cx.notify(); });
          else if (archive) cx.spawn(async cx => { await this.archiveThread(thread); cx.notify(); });
          else run('tab.close', { id: thread.tab.id });
        })
        .child(glyph(stopping ? 'square' : archive ? 'archive' : 'close', 12)));
  }

  renderThreadGroup(thread, t, live) {
    const entries = this.paneEntries(thread, live);
    const hasPeers = entries.some(entry => entry.depth === 0);
    const lastPeer = entries.reduce((last, entry, index) => entry.depth === 0 ? index + 1 : last, 0);
    const bracket = index => hasPeers ? { visible: index <= lastPeer, first: index === 0, last: index === lastPeer } : null;
    return v_flex().id(`thread-group-${thread.tab.id}`).flex_none()
      .child(this.threadRow(thread, t, bracket(0)))
      .children(entries.map((entry, index) => this.childRow(thread, { ...entry, trunk: bracket(index + 1) }, t)));
  }

  paneEntries(thread, live) {
    const allPanes = panes(), members = allPanes.filter(pane => pane.tab === thread.tab.id);
    const primary = members.find(pane => pane.terminal === thread.agents[0]?.address) || members[0];
    const byAddress = new Map(members.filter(pane => pane.terminal).map(pane => [pane.terminal, pane]));
    const external = new Set(allPanes.filter(pane => pane.tab !== thread.tab.id).map(pane => pane.terminal));
    const terminals = live.filter(terminal => !external.has(terminal.address));
    const seen = new Set(), rows = [];
    const entry = (terminal, depth, pane) => ({ terminal: pane ? { ...terminal, address: pane.terminal || pane.pane,
      program: pane.program, status: pane.status || terminal?.status } : terminal, depth, pane,
      label: pane?.title?.trim() || pane?.mod || (terminal ? terminalLabel(terminal) : 'Terminal') });
    const descendants = address => {
      if (!address) return;
      seen.add(address);
      for (const child of childTerminals(terminals, [address], 1, Infinity, seen))
        rows.push(entry(child.terminal, child.depth, byAddress.get(child.terminal.address)));
    };
    descendants(primary?.terminal || thread.agents[0]?.address);
    const hasPaneAncestor = pane => {
      const visited = new Set([pane.terminal]);
      let parent = terminals.find(terminal => terminal.address === pane.terminal)?.parent;
      while (parent && !visited.has(parent)) {
        if (byAddress.has(parent)) return true;
        visited.add(parent); parent = terminals.find(terminal => terminal.address === parent)?.parent;
      }
      return false;
    };
    const appendPeer = pane => {
      const address = pane.terminal || pane.pane;
      if (pane === primary || seen.has(address)) return;
      rows.push(entry(terminals.find(terminal => terminal.address === pane.terminal), 0, pane));
      descendants(address);
    };
    members.filter(pane => !hasPaneAncestor(pane)).forEach(appendPeer);
    // Retain native panes even while parent metadata is missing or inconsistent.
    members.forEach(appendPeer);
    return rows;
  }

  // A terminal the thread's agent started with hc run, indented under it; it peeks over the thread when clicked.
  childRow(thread, { terminal, depth, label, pane, trunk }, t) {
    const key = pane ? `pane:${pane.pane}` : `child:${terminal.address}`;
    const p = terminal.program;
    const icon = terminalWorking(terminal) ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
      : p?.icon && !p.shell ? (p.tint ? svg(p.icon).size(14).text_color(t.muted) : image(p.icon).size(14)) : glyph('terminal', 14).text_color(t.muted);
    return SidebarTreeMenuButton(pane ? `thread-pane-${pane.pane}` : `child-${terminal.address}`, Boolean(pane?.focused), t, depth, trunk)
      .accessibility_label(`${depth ? 'Child task' : 'Parallel pane'}: ${label}`)
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
        run('tab.select', { id: thread.tab.id });
        this.showConversation(true, { ...this.projects().find(project => project.id === thread.space), tabs: [{ id: thread.tab.id, active: true }] });
        if (pane) run('pane.focus', { pane: pane.pane });
        else run('terminal.peek', { terminal: terminal.address });
      })
      .child(div().size(16).mr(8).flex_none().flex().items_center().justify_center().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(depth ? 12 : 13).text_color(depth ? t.muted : t.foreground).child(label))
      .child(Button(pane ? `close-pane-${pane.pane}` : `end-child-${terminal.address}`, t, { variant: 'row', size: 'icon-sm' })
        .ml(8).opacity(this.hovered === key ? 1 : 0)
        .accessibility_label(pane ? `Close ${label}` : `End ${label}`)
        .on_click((_event, cx) => {
          cx.stop_propagation();
          if (pane) run('pane.close', { pane: pane.pane });
          else run('terminal.kill', { terminal: terminal.address });
        })
        .child(glyph('close', 12)));
  }

  render(cx) {
    const t = theme();
    if (['calendar', 'google-calendar'].includes(props()?.view)) return this.calendar.render();
    if (props()?.view === 'codex-sharing') return this.sharingDialog(t);
    if (props()?.view === 'token-statistics') return this.analytics.render();
    if (props()?.view === 'xcode-storage') return this.xcodeStorage.render();
    if (props()?.view === 'codex-permissions') return div();
    if (props()?.view === 'file-menu') return this.fileMenu.render();
    if (props()?.view === 'task-composer') return this.taskComposer.render(this.taskAssignees(props().project));
    if (props()?.view === 'editor') {
      const project = this.projects().find(project => project.active);
      return project && taskMode()
        ? this.boardPanel(project, cx) : this.editor.render(project, cx);
    }
    if (props()?.view === 'files') return this.files.render(this.projects().find(project => project.active), cx);
    if (props()?.view === 'diff') return this.diff.render(this.projects().find(project => project.active), cx);
    if (props()?.view === 'account-login') return this.login.render();
    if (props()?.view === 'header') return this.header(t);
    if (props()?.view === 'run-menu') return this.runMenu.render(t);
    if (props()?.view === 'branch-menu') return this.branchMenu.render(t);
    if (props()?.view === 'usage-details') return this.usageDetails(t);
    if (props()?.view === 'hardware-details') return this.hardwareDetails(t);
    if (props()?.view === 'brand') return this.brand(t);
    if (props()?.view === 'pane') return this.paneHeader(t, cx);
    if (props()?.view === 'status') return this.statusBar(t);
    if (props()?.view === 'launcher') return this.launcher(t);
    if (['asana', 'mantisbt'].includes(props()?.view)) return this.asanaPanel(cx);
    if (['asana-projects', 'mantisbt-projects'].includes(props()?.view)) return this.asanaProjects.render();
    if (props()?.view === 'manage-launchers') return this.manageLaunchers(t);
    if (props()?.view === 'agent-profile-editor') return this.agentProfileEditor(t);
    if (props()?.view === 'remove-account') return this.removeAccountPrompt(t);
    if (props()?.view === 'rename-account') return this.renameAccountPrompt(t);
    if (props()?.view === 'project-empty') return div().size_full().bg(t.background);
    if (props()?.view === 'close-project') return this.closePrompt(t);
    if (props()?.view === 'project-menu') return this.projectMenu(t);
    if (props()?.view === 'project-picker') return this.projectPicker(t);
    if (cx) this.refreshUsage(cx, false);
    const all = agents(), native = spaces(), modelPanes = panes();
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
          if (!taskMode()) run('layout.select', { stack: 'workspace-view', child: 'main' });
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
      && !all.some(agent => agent.space === chosen.id && agent.tab === selectedTab.id)
      && modelPanes.filter(pane => pane.tab === selectedTab.id).length < 2;
    const content = chosen && shared('devkits.asana') === chosen.id ? 'asana' : chosen?.pending || defaultSelected ? 'project-empty' : 'main';
    if (!taskMode() && this.shownContent !== content) {
      this.shownContent = content;
      run('layout.select', { stack: 'workspace-view', child: content });
    }
    const conversation = layoutNode(layout(), 'workspace-view');
    const showConversation = !taskMode() && (content === 'asana' || conversationVisible(chosen));
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
    // A split created in the otherwise hidden default shell is user-visible work too.
    const sidebarDefaults = Object.fromEntries(Object.entries(defaults)
      .filter(([, tab]) => modelPanes.filter(pane => pane.tab === tab).length < 2));
    const groups = projectGroups(workspaces, all, sidebarDefaults, sessionThreadTitle);
    for (const group of groups) for (const thread of group.threads)
      if (thread.tab.id === defaults[group.space.id] && !thread.agent) thread.title = 'Terminal';
    const live = terminals();
    observeTaskInput(all, live, cx);
    const openTabs = new Set(groups.flatMap(group => group.threads.map(thread => thread.tab.id)));
    for (const tab of this.archiveChecks?.keys() || []) if (!openTabs.has(tab)) {
      this.archiveChecks.delete(tab); this.closeOnlyThreads?.delete(tab);
    }
    for (const { threads } of groups) for (const thread of threads) this.prepareThreadArchive(thread, cx);
    // Observe progress even while a project's rows are collapsed or the board is closed.
    for (const { space } of groups) projectBoardTasks(space, all);
    const visible = groups.filter(g => !this.folded.has(g.space.id)).flatMap(g => g.threads.filter(thread => threadVisibleInSidebar(g.space, thread)).flatMap(thread => thread.agents));
    setAgentOrder(visible.map(a => a.address));
    return Sidebar(t)
      .when(Boolean(this.hardwareResize), el => el.cursor_row_resize())
      .on_size_change((size, cx) => {
        if (this.hardwareSidebarAvailable !== size.height) { this.hardwareSidebarAvailable = size.height; cx.notify(); }
      })
      .on_mouse_move((event, cx) => this.resizeHardwareSidebar(event, cx))
      .on_mouse_up('left', (_event, cx) => this.endHardwareResize(cx))
      .on_hover((inside, cx) => { if (!inside) this.endHardwareResize(cx); })
      .child(this.archiveOpen ? this.archiveList(t) : SidebarContent()
        .children(groups.map(({ space, threads }, index) => SidebarGroup(index > 0, t)
          .child(SidebarGroupLabel(`project-${space.id}`, space.active, t).pr(0)
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
            .child(Button(`new-thread-${space.id}`, t, { variant: 'row', size: 'icon' }).h_full().w(32)
              .accessibility_label(`New thread in ${space.name}`)
              .on_click((_event, cx) => {
                cx.stop_propagation();
                this.folded.delete(space.id);
                cx.spawn(async cx => { await this.repeatThread(cx, space.id); });
                cx.notify();
              })
              .child(glyph('plus')).opacity(this.hoveredProject === space.id ? 1 : 0))
            .child(DropdownMenuTrigger(Button(`project-menu-${space.id}`, t, { variant: 'row', size: 'icon' }).h_full().w(32)
              .accessibility_label(`More actions for ${space.name}`), 200,
              (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 200, at,
                props: { view: 'project-menu', project: space } }), 'end', SIDEBAR_MENU)
              .child(glyph('ellipsis')).opacity(this.hoveredProject === space.id ? 1 : 0)))
          .when(!this.folded.has(space.id), el => el
            .children(this.groupedThreads(space, threads, t, live))
            .when(!threads.some(thread => threadVisibleInSidebar(space, thread)) && (space.machine || !projectBoardTasks(space).some(task => !task.archived && (task.source !== 'thread' || task.tabs.length > 0))), el => el.child(h_flex().h(32).flex_none().px(12).items_center().text_size(12).text_color(t.muted).child(threads.length ? 'No active threads' : 'No threads yet')))))))
      .child(this.accountUsage(t).on_size_change((size, cx) => {
        if (this.hardwareQuotaHeight !== size.height) { this.hardwareQuotaHeight = size.height; cx.notify(); }
      }))
      .child(this.systemUsage(t))
      .child(SidebarFooter(t)
        .child(Button('archived-threads', t, { variant: 'ghost', size: 'icon' })
          .accessibility_label(this.archiveOpen ? 'Show threads' : 'Show thread history')
          .h_full().rounded(0).bg(this.archiveOpen ? t.selected : t.chrome)
          .on_click((_event, cx) => { this.archiveOpen = !this.archiveOpen; cx.notify(); }).child(glyph('clock')))
        .child(div().flex_1()));
  }
}

// Feature views share this view's state and its project, agent and session helpers.
Object.assign(Devkits.prototype, sessionMenu, agentProfiles, accountActions, agentUsage, hardwareUsage, threadArchive);
