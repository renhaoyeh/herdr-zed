import { AgentClient, openAgentSettings, openAgentLauncher, openSharedMcp, agentAccountName } from './components/agents.js';
import { agentSelection } from './components/agent-selection.js';
import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { agents, spaces, panes, theme, run, props, window, openOverlay, closeOverlay, setAgentOrder, layout, settings, pickFolder, shared, setShared, notify, nextCommand, terminals } from 'herdr';
import { configuredAgents, projectGroups, projectCatalog, folderKey, autoLauncherKey, threadProfile, threadProgram, archivable, childTerminals, terminalLabel, terminalWorking } from './components/session-model.js';
import { terminalArgv } from './components/session-shell.js';
import FileViewer, { FileMenu } from './files.js';
import DiffViewer from './diff.js';
import { BuildRulesSettings } from './diff-ignore-settings.js';
import { GitResultToast, clearGitToast } from './git-result-toast.js';
import WorkspaceEditor from './workspace-editor.js';
import XcodeStorage from './xcode-storage.js';
import { TaskHost, withTaskSnapshot, openTaskComposer, requestTaskOpen, requestTaskSource, requestTaskStart, projectBoardTasks, threadBoardStatus, threadVisibleInSidebar, threadBoardTask, taskLinkForTab, sessionThreadTitle, taskActions, boardStatuses } from './components/tasks.js';
import { UsageClient } from './components/usage.js';
import { SystemMonitor } from './components/system-monitor.js';
import { SystemDisplay, SystemDisplayMenu, openSystemDetails } from './system-display.js';
import { InterfaceSettings, openInterfaceSettings, UsageDisplayMenu, openUsageDisplayMenu, usageStyle, usageShownIn } from './ui-settings.js';
import { ResetDevkits } from './reset-devkits.js';
import { RunControls, RunMenu, runApp } from './run-app.js';
import { BranchMenu } from './branch-menu.js';
import { ProjectLayout, layoutNode, conversationMaximized, maximizeConversation, openTaskBoard, closeTaskBoard, taskMode } from './project-layout.js';
import { threadArchive } from './thread-archive.js';
import { startPanel } from './start-panel.js';
import { DropdownMenu, DropdownMenuState, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button, ToolbarButton } from './components/button.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './components/alert-dialog.js';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenuButton, SidebarTreeMenuButton, SidebarFooter } from './components/sidebar.js';

// A 28px icon button centred in a 32px project row: 8px below the row.
const SIDEBAR_MENU = { x: 0, y: 10 };
import { glyph } from './components/icon.js';

const startingThreads = new Set();
// Asana opens independently above the workspace, bound to its originating project.
// Files and Changes share the editor beside the thread instead, shown or hidden in the layout like the simulator.
const openCalendar = () => openOverlay({ mod: 'devkits-calendar', kind: 'dialog', frame: 'none', modal: false, width: 0.9, height: 0.86,
  props: { view: 'calendar' } });
// Like Zed's dock buttons: close only the side panel, preserving the central document.
const toggleEditor = (_editor, name) => {
  const maximized = Boolean(shared('devkits.conversation-maximized'));
  maximizeConversation(null, false);
  setShared('devkits.right-panel', !maximized && shared('devkits.right-panel') === name ? null : name);
};
const conversationKey = project => JSON.stringify([project.machine || '', folderKey(project.folder) || project.id]);
const conversationVisible = project => Boolean(project && shared('devkits.conversation-visible')?.[conversationKey(project)]);

export default class Devkits extends View {
  agentClient = new AgentClient();
  systemMonitor = new SystemMonitor({ receiver: 'devkits',
    active: () => this.systemDisplay.active(), openDetails: openSystemDetails,
  });
  systemDisplay = new SystemDisplay(this.systemMonitor, props()?.view);
  usageClient = new UsageClient({ context: () => ({ machine: this.projects().find(project => project.active)?.machine || null }),
    active: () => shared('devkits.usage-visible') !== false });
  taskHost = new TaskHost((event, cx) => this.taskNavigation(event, cx));

  init(_props, cx) {
    if (props()?.view === 'reset-devkits') { this.dataReset = new ResetDevkits(); this.dataReset.init(cx); return; }
    this.agentClient.init(cx, (event, cx) => {
      if (event.type === 'start') cx.spawn(async () => { await this.startThread(event.agent, event.target, event.options); });
    }, !props()?.view);
    if (props()?.view === 'diff-ignore-settings') {
      this.buildRulesSettings = new BuildRulesSettings(); this.buildRulesSettings.init(cx); return;
    }
    if (props()?.view === 'ui-settings') {
      this.interfaceSettings = new InterfaceSettings(); this.interfaceSettings.init(cx); return;
    }
    if (props()?.view === 'usage-display-menu') {
      this.usageDisplayMenu = new UsageDisplayMenu(props() || {}); this.usageDisplayMenu.init(cx); return;
    }
    if (props()?.view === 'system-display-menu') {
      this.systemDisplayMenu = new SystemDisplayMenu(props() || {}); this.systemDisplayMenu.init(cx); return;
    }
    if (props()?.view === 'status') {
      clearGitToast(); setShared('devkits.git-output-request', null);
    }
    if (props()?.view === 'pane') { this.threadMenu = new DropdownMenuState(cx); return; }
    if (props()?.view === 'file-menu') {
      this.fileMenu = new FileMenu(); this.fileMenu.init(cx); return;
    }
    if (props()?.view === 'xcode-storage') {
      this.xcodeStorage = new XcodeStorage();
      this.xcodeStorage.init(cx);
      return;
    }
    if (props()?.view === 'status' || (!props()?.view && cx)) {
      this.systemDisplay.init(); this.systemMonitor.init(cx);
    }
    if (!props()?.view && cx) {
      this.taskHost.init(cx);
      cx.timer.every(5000, cx => {
        if ([...(this.archiveChecks?.values() || [])].some(check => !check.pending && check.retryAt <= Date.now())) cx.notify();
      });
      // Shared values survive restarts; discover once for this app session.
      this.usageClient.init(cx);
      for (const machine of new Set([null, ...spaces().map(space => space.machine || null)])) {
        cx.spawn(async () => { try { await this.cachedAgents(machine); } catch {} });
      }
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
        if (command === 'ui-settings') openInterfaceSettings();
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
      cx.spawn(async cx => {
        for (;;) {
          const command = await nextCommand();
          if (command === 'agent-board') { const project = this.projects().find(project => project.active); if (project && !project.machine) this.openBoard(project); }
          if (command === 'close-board') this.closeBoard();
          if (command === 'close-file') this.closeFileTab(cx);
          if (command === 'open-file') {
            const request = shared('devkits.open-file-request'), project = this.projects().find(project => project.active);
            setShared('devkits.open-file-request', null);
            if (project && request) { this.editor.openFile(project, request.path, cx, { on: request.on }); this.editor.focus(); }
          }
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
    this.folded = new Set();
    this.hovered = null;
    this.hoveredProject = null;
    if (['close-project', 'project-menu', 'project-picker'].includes(props()?.view)) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      if (props().view === 'project-picker') this.projectIndex = -1;
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
    return this.renderModel?.projects || projectCatalog(spaces(), shared('devkits.projects') || [], shared('devkits.project-roots') || {}, shared('devkits.selected-project'), shared('devkits.project-order') || []);
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
    setShared('devkits.selected-project', project.id);
    if (!project.pending) run('space.select', { id: project.id });
    if (!taskMode()) run('layout.select', { stack: 'workspace-view', child: project.pending ? 'project-empty' : 'main' });
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
    openAgentLauncher({ space: project.pending ? null : project.id, folder: project.folder, projectName: project.name }, at);
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

  openEditorFile(path, on = null) {
    this.closeBoard();
    maximizeConversation(null, false);
    run('layout.show', { id: 'editor' });
    run('layout.select', { stack: 'editor', child: 'workspace-editor' });
    setShared('devkits.open-file-request', { path, on });
    run('devkits.open-file');
  }

  async repeatThread(cx, projectId) {
    const project = this.projects().find(project => projectId ? project.id === projectId : project.active);
    if (!project) return this.newThread(cx);
    const target = { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name };
    try {
      const { agent, auto } = this.defaultThreadChoice(project, await this.cachedAgents(project.machine));
      if (!agent) return this.newThread(cx, project.id);
      await this.startThread(agent, target, auto ? { auto } : {});
    } catch (error) {
      notify({ title: 'Could not start session', body: error.message, level: 'error' });
    }
  }

  accountName(agent, label) { return agentAccountName(agent, label); }

  cachedAgents(machine, refresh = false) { return this.agentClient.discover(machine, refresh); }

  availableAgents(profiles, machine) { return configuredAgents(profiles, machine ? [] : shared('devkits.agent-configs') || []); }

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
    if (target.task) { requestTaskStart(agent, target, options); return; }
    let argv;
    try { ({ argv } = await this.agentClient.prepare(agent, target, options)); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); return; }
    if (target.overlay) closeOverlay(target.overlay);
    this.closeBoard();
    this.openThread(target, agent?.name, argv, agent?.key, null);
    if (agent?.key) {
      const project = spaces().find(space => space.id === target.space);
      const key = JSON.stringify([project?.machine || '', folderKey(target.folder) || target.space]);
      const remembered = options.auto ? autoLauncherKey : agent.key;
      setShared('devkits.last-thread-agent', remembered);
      setShared('devkits.last-thread-agents', { ...(shared('devkits.last-thread-agents') || {}), [key]: remembered });
    }
  }

  // Opens a thread (or a plain terminal, without argv) in the target project and shows it.
  openThread(target, name, argv, profile, task) {
    if (argv && !spaces().find(space => space.id === target.space)?.machine) argv = terminalArgv(argv, window()?.platform);
    // Commands do not return the new tab, so the sidebar matches it once it appears.
    if (profile || target.restoreArchiveId) setShared('devkits.pending-profiles', [...(shared('devkits.pending-profiles') || []), { key: profile,
      space: target.space || null, folder: target.folder, before: spaces().flatMap(space => space.tabs.map(tab => tab.id)), at: Date.now(),
      ...(task ? { task } : {}), ...(target.restoreArchiveId ? { restoreArchiveId: target.restoreArchiveId } : {}) }]);
    this.showConversation(true, { ...target, id: target.space, machine: spaces().find(space => space.id === target.space)?.machine });
    setShared('devkits.selected-project', null);
    run('layout.select', { stack: 'workspace-view', child: 'main' });
    if (target.space) run('tab.new', { space: target.space, folder: target.folder, ...(argv ? { name, argv } : {}) });
    else run('space.new', { name: target.projectName, folder: target.folder, machine: '', ...(argv ? { tab: name, argv } : {}) });
  }


  openBoard(project) {
    maximizeConversation(null, false);
    if (!project.active) this.selectProject(project);
    openTaskBoard(project);
  }

  closeBoard() { closeTaskBoard(); }





  taskNavigation(event, cx) {
    if (event.type === 'task') {
      const project = this.projects().find(project => project.id === event.project.id || project.machine === event.project.machine && folderKey(project.folder) === folderKey(event.project.folder));
      if (!project) return;
      this.openBoard(project); if (event.gid) setShared('devkits.board-focus', event.gid);
    } else if (event.type === 'close') this.closeBoard();
    else if (event.type === 'close-overlay') closeOverlay(event.overlay);
    else if (event.type === 'project') this.selectProject(event.project);
    else if (event.type === 'thread') {
      this.selectProject(event.project); if (event.tab) run('tab.select', { id: event.tab });
      this.showConversation(true, { ...event.project, ...(event.tab ? { tabs: [{ id: event.tab, active: true }] } : {}) });
    } else if (event.type === 'launch') this.openThread(event.target, event.name, event.argv, event.profile, event.task);
    else if (event.type === 'archive-thread') cx.spawn(async cx => { await this.archiveThread(event.thread); cx.notify(); });
    else if (event.type === 'restore-thread') this.restoreThread(event.entry);
    else if (event.type === 'stop-thread') cx.spawn(async cx => { await this.stopThread(event.thread); cx.notify(); });
  }

  accountUsage(t) {
    if (!usageShownIn('sidebar')) return div().h(0).flex_none();
    return this.usageClient.render(t, { style: usageStyle(), openMenu: at => openUsageDisplayMenu(at, 'sidebar') });
  }

  groupedThreads(space, threads, t, live) {
    threads = threads.filter(thread => threadVisibleInSidebar(space, thread));
    const tasks = space.machine ? [] : projectBoardTasks(space).filter(task => !task.tabs.length && !task.archived && task.source !== 'thread');
    const sessions = threads.filter(thread => threadBoardStatus(space, thread) === null);
    return [...sessions.map(thread => this.renderThreadGroup(thread, t, live)), ...boardStatuses.flatMap(status => {
      const cards = tasks.filter(task => task.status === status.key);
      const rows = threads.filter(thread => threadBoardStatus(space, thread) === status.key);
      if (!rows.length && !cards.length) return [];
      return [h_flex().h(26).flex_none().px(12).gap(6).items_center().text_size(10).text_color(t.muted)
        .child(glyph(status.icon, 12).text_color(status.color)).child(status.label).child(String(rows.length + cards.length)),
        ...cards.map(task => SidebarMenuButton(`board-task-${space.id}-${task.gid}`, false, t)
          .on_click(() => requestTaskOpen(space, task.gid))
          .child(glyph(status.icon, 14).text_color(status.color))
          .child(div().min_w(0).truncate().text_size(13).child(task.name))
          .when(Boolean(task.attention), el => el.child(glyph('clock', 12).text_color(t.blocked).accessibility_label('Action Required')))),
        ...rows.map(thread => this.renderThreadGroup(thread, t, live))];
    })];
  }

  async close() {
    this.agentClient.close();
    this.buildRulesSettings?.close();
    this.systemMonitor.close();
    this.usageClient.close();
    if (this.editor) this.editor.close();
    else this.files?.close();
    this.diff?.close();
  }

  header(t) {
    const space = this.projects().find(s => s.active);
    const win = window();
    const root = layout(), sidebar = root?.children?.find(node => node.id === 'sidebar');
    const inset = win?.platform === 'macos' && !win.fullscreen && sidebar?.hidden
      ? (root.traffic_lights[0] + 64) / settings().zoom : 12;
    // Equal columns keep Run centered independently of project names and window controls.
    return h_flex().size_full().pl(inset - 12).items_center().bg(t.background).text_size(13)
      .border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden()
        .child(DropdownMenuTrigger(h_flex().id('project-switcher').min_w(0).h_full().pl(10).pr(6).gap(6).items_center().rounded(0)
          .text_color(t.foreground).font_medium().hover(el => el.bg(t.hover)).cursor_pointer(), 280,
          (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 280, at,
            props: { view: 'project-picker' } }), 'start', { x: 8, y: 9 }) // Clear of the header's 1px bottom border
          .child(div().min_w(0).max_w(220).truncate().child(space?.name || 'Open project'))
          .child(glyph('chevron-down', 12).text_color(t.muted)))
        // Like Zed, the branch opens a list of the project's branches; it only shows them for now.
        .when(Boolean(space?.branch), el => el.child(DropdownMenuTrigger(h_flex().id('branch-switcher').min_w(0).h_full().px(8).gap(4).items_center().rounded(0)
          .text_size(12).text_color(t.muted).hover(el => el.bg(t.hover)).cursor_pointer().accessibility_label(`Branches of ${space.name}`), 320,
          (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 320, at,
            props: { view: 'branch-menu', folder: space.folder, machine: space.machine || null, branch: space.branch } }), 'start', { x: 8, y: 9 })
          .child(glyph('branch', 12)).child(div().min_w(0).max_w(200).truncate().child(space.branch)))))
      .child(h_flex().flex_1().min_w(0).h_full().items_center().justify_center()
        .when(Boolean(space), el => el.child(RunControls(t))))
      .child(h_flex().flex_1().min_w(0).h_full().items_center().justify_end()
        .child(ToolbarButton('settings', t, { icon: true })
          .accessibility_label('Herdr settings')
          .on_click(() => run('app.settings')).child(glyph('gear')))
        .when(Boolean(win?.buttons), el => el
          .child(Button('minimize', t, { variant: 'ghost', size: 'icon' }).h_full().w(32).accessibility_label('Minimize')
            .on_click(() => run('window.minimize')).child(glyph('minus')))
          .child(Button('maximize', t, { variant: 'ghost', size: 'icon' }).h_full().w(32).accessibility_label('Maximize / restore')
            .on_click(() => run('window.maximize')).child(glyph('square')))
          .child(Button('close-window', t, { variant: 'ghost', size: 'icon' }).h_full().w(32).accessibility_label('Close window')
            .on_click(() => run('window.close')).child(glyph('close')))));
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
    const launchers = this.availableAgents(shared('devkits.agent-cache')?.[JSON.stringify(machine)] || [], machine);
    const label = !secondary && thread?.agent ? threadProfile(thread.tab, launchers, shared('devkits.thread-profiles') || {}) : null;
    // Two Default accounts look alike, so a Default account is named by its signed-in address.
    const profile = label && !machine
      ? this.accountName(launchers.find(agent => agent.key === (shared('devkits.thread-profiles') || {})[thread.tab.id]), label) : label;
    const title = secondary ? p.title || 'Terminal' : thread?.tab.name === '__devkits_default_terminal__' && !thread.agent ? 'Terminal' : thread?.title || p.title || 'Terminal';
    const project = this.projects().find(project => project.id === thread?.space);
    const link = secondary ? null : taskLinkForTab(p.tab, project);
    const maximized = conversationMaximized(project);
    this.threadMenu ??= new DropdownMenuState();
    // Like Zed's agent panel menu, global configuration lives beside Agent settings.
    const codex = !machine && launchers.find(agent => agent.key === 'codex' && agent.installed !== false);
    const actions = secondary ? [{ key: 'close', label: 'Close terminal' }] : [
      { key: 'rules', label: 'Global Rules…', icon: 'book-open' },
      ...(codex ? [{ key: 'mcp', label: 'Shared MCP…', icon: 'settings' }] : []),
      { key: 'settings', label: 'Agent settings…', icon: 'settings', separator: true },
    ];
    const choose = key => key === 'settings' ? openAgentSettings(project && !project.pending ? project.id : null)
      : key === 'rules' ? openAgentSettings(null, 'global-rules') : key === 'mcp' ? openSharedMcp(codex)
        : run('pane.close', { pane: p.pane });
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
        // + then maximize then ⋯, as in Zed's panel toolbars.
        .child(DropdownMenuTrigger(Button(`new-thread-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('New thread…').child(glyph('plus')), 280,
          (cx, at) => this.newThread(cx, thread?.space, at), 'end'))
        .when(Boolean(project && layoutNode(layout(), 'workspace-view')), el => el.child(
          Button(`maximize-thread-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
            .accessibility_label(maximized ? 'Restore thread' : 'Maximize thread')
            .on_click((_event, cx) => {
              cx.stop_propagation();
              maximizeConversation(project, !conversationMaximized(project));
              run('pane.focus', { pane: p.pane });
            }).child(glyph(maximized ? 'minimize' : 'maximize'))))
        .child(DropdownMenu(`thread-actions-${p.pane}`, this.threadMenu,
          Button(`thread-menu-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
            .accessibility_label('Thread options').child(glyph('ellipsis')),
          actions, choose, t, { offset: { x: 8, y: 9 }, fullHeight: true })));
  }

  // All linked tasks return to their project's Tasks workspace.
  openTask(spaceId, task) {
    const project = this.projects().find(project => project.id === spaceId);
    if (!project) return;
    requestTaskOpen(project, task.gid);
  }

  statusBar(t) {
    const space = this.projects().find(s => s.active);
    // The Simulator panel is the devkits-simulator mod; a layout without its block has no simulator button.
    // Other platforms keep the button; the panel says it is unsupported there.
    const simulator = layoutNode(layout(), 'simulator'), editor = layoutNode(layout(), 'editor');
    const conversation = layoutNode(layout(), 'workspace-view');
    const showing = name => Boolean(editor) && shared('devkits.right-panel') === name;
    // Like Zed: the branch sits beside the project in the header; only a remote project names its machine here.
    return h_flex().id('devkits-status').relative().size_full().pr(4).gap(8).items_center().bg(t.background)
      .text_size(11).text_color(t.muted)
      .when(Boolean(space && conversation), el => el
        .child(ToolbarButton('open-conversation', t, { icon: true, disabled: taskMode(), selected: conversationVisible(space) })
          .accessibility_label(conversationVisible(space) ? 'Hide conversation' : 'Show conversation')
          .on_click(() => {
            this.showConversation(!conversationVisible(space));
          }).child(glyph('agent'))))
      .when(Boolean(space?.machine), el => el.child(h_flex().flex_none().gap(8).items_center().child(glyph('terminal', 12)).child(space.machine)))
      .child(this.systemDisplay.renderStatus(t))
      .when(usageShownIn('status'), el => el.child(this.usageClient.renderStatus(t, { openMenu: at => openUsageDisplayMenu(at, 'status') })))
      .child(h_flex().id('status-actions').min_w(0).h_full().overflow_x_scroll().items_center().gap(8)
      .child(h_flex().id('status-workspace-actions').flex_none().h_full().gap(0)
        .when(Boolean(space), el => el
          .child(ToolbarButton('open-asana', t).accessibility_label('Asana')
            .on_click(() => requestTaskSource(space, 'asana'))
            .child(glyph('asana').text_color('#F06A6A')).child('Asana'))
          .child(ToolbarButton('open-mantisbt', t).accessibility_label('MantisBT')
            .on_click(() => requestTaskSource(space, 'mantisbt'))
            .child(image('mods/devkits/assets/mantisbt.png').size(14).flex_none()).child('MantisBT')))
        .child(ToolbarButton('open-calendar', t)
          .accessibility_label('Calendar').on_click(openCalendar).child(glyph('calendar')).child('Calendar'))
        .when(Boolean(space), el => el.child(ToolbarButton('open-tasks', t, { selected: taskMode() })
            .accessibility_label('Tasks')
            .on_click(() => { if (taskMode()) this.closeBoard(); else this.openBoard(space); })
            .child(glyph('columns-3')).child('Tasks')
            .when(projectBoardTasks(space).some(task => !task.archived && task.attention), el => el.child(div().text_color(t.blocked)
              .child(String(projectBoardTasks(space).filter(task => !task.archived && task.attention).length)))))))
      .when(Boolean(space || simulator), el => el
        .child(div().w(1).h(16).flex_none().bg(t.border))
        .child(h_flex().id('status-panel-actions').flex_none().h_full().gap(0)
          .when(Boolean(simulator), el => el
            .child(ToolbarButton('open-simulator', t, { icon: true, disabled: taskMode(), selected: !simulator.hidden })
              .accessibility_label(simulator.hidden ? 'Show simulator' : 'Hide simulator')
              .on_click(() => {
                const maximized = Boolean(shared('devkits.conversation-maximized'));
                maximizeConversation(null, false);
                run(maximized ? 'layout.show' : 'layout.toggle', { id: 'simulator' });
              }).child(glyph('smartphone'))))
          .when(Boolean(space), el => el
            .child(ToolbarButton('open-diff', t, { icon: true, disabled: taskMode(), selected: showing('diff') })
              .accessibility_label(showing('diff') ? 'Hide changes' : 'Show changes')
              .on_click(() => toggleEditor(editor, 'diff'))
              .child(glyph('git-compare')))
            .child(ToolbarButton('open-files', t, { icon: true, disabled: taskMode(), selected: showing('files') })
              .accessibility_label(showing('files') ? 'Hide files' : 'Show files')
              .on_click(() => toggleEditor(editor, 'files'))
              .child(glyph('folder')))))))
      .child(GitResultToast(t, space));
  }

  threadRow(thread, t, trunk = null) {
    const live = this.renderModel?.terminals || terminals();
    const members = (this.renderModel?.panes || panes()).filter(pane => pane.tab === thread.tab.id);
    const primary = members.find(pane => pane.terminal === thread.agents[0]?.address) || members[0];
    const primaryAgent = thread.agents.find(agent => agent.address === primary?.terminal) || thread.agent;
    if (primaryAgent && primaryAgent !== thread.agent)
      thread = { ...thread, agent: primaryAgent, title: sessionThreadTitle(thread.tab, primaryAgent, this.projects().find(project => project.id === thread.space)) };
    const working = thread.status === 'working' || thread.agents.some(agent => agent.status === 'working')
      || terminalWorking(live.find(terminal => terminal.address === primary?.terminal));
    const isFocused = shared('devkits.board-project') !== thread.space && thread.active && (!members.some(pane => pane.focused) || Boolean(primary?.focused));
    const p = threadProgram(thread, live, primary?.program);
    const canArchive = archivable(thread, live);
    const stopping = canArchive && this.threadBusy(thread, live);
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
        this.selectProject(this.projects().find(project => project.id === thread.space));
        run('tab.select', { id: thread.tab.id });
        this.showConversation(true, { ...this.projects().find(project => project.id === thread.space), tabs: [{ id: thread.tab.id, active: true }] });
      })
      .child(div().size(16).mr(8).flex_none().flex().items_center().justify_center().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground)
        .when(isFocused, el => el.font_medium()).child(thread.title))
      .when(Boolean(project && threadBoardTask(project, thread).attention), el => el.child(glyph('clock', 12).text_color(t.blocked).accessibility_label('Action Required')))
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
    const allPanes = this.renderModel?.panes || panes(), members = allPanes.filter(pane => pane.tab === thread.tab.id);
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
    this.renderModel = null;
    try { return withTaskSnapshot(() => this.renderView(cx)); }
    finally { this.renderModel = null; }
  }

  renderView(cx) {
    const t = theme();
    if (props()?.view === 'reset-devkits') return this.dataReset.render(t);
    if (props()?.view === 'diff-ignore-settings') return this.buildRulesSettings.render(t);
    if (props()?.view === 'ui-settings') return this.interfaceSettings.render(t);
    if (props()?.view === 'usage-display-menu') return this.usageDisplayMenu.render(t);
    if (props()?.view === 'system-display-menu') return this.systemDisplayMenu.render(t);
    if (props()?.view === 'xcode-storage') return this.xcodeStorage.render();
    if (props()?.view === 'file-menu') return this.fileMenu.render();
    if (props()?.view === 'editor') {
      const project = this.projects().find(project => project.active);
      if (!project) return this.welcomeView(t, cx);
      return this.editor.render(project, cx, { empty: () => this.projectStartView(project, t, cx) });
    }
    if (props()?.view === 'files') return this.files.render(this.projects().find(project => project.active), cx);
    if (props()?.view === 'diff') return this.diff.render(this.projects().find(project => project.active), cx);
    if (props()?.view === 'header') return this.header(t);
    if (props()?.view === 'run-menu') return this.runMenu.render(t);
    if (props()?.view === 'branch-menu') return this.branchMenu.render(t);
    if (props()?.view === 'brand') return this.brand(t);
    if (props()?.view === 'pane') return this.paneHeader(t, cx);
    if (props()?.view === 'status') return this.statusBar(t);
    if (props()?.view === 'project-empty') return div().size_full().bg(t.canvas);
    if (props()?.view === 'close-project') return this.closePrompt(t);
    if (props()?.view === 'project-menu') return this.projectMenu(t);
    if (props()?.view === 'project-picker') return this.projectPicker(t);
    const all = agents(), native = spaces(), modelPanes = panes();
    const roots = shared('devkits.project-roots') || {};
    const missing = native.filter(s => roots[s.id] === undefined && s.folder);
    if (missing.length) setShared('devkits.project-roots', { ...roots, ...Object.fromEntries(missing.map(s => [s.id, s.folder])) });
    const active = native.find(s => s.active);
    const selection = `${active?.id || ''}:${active?.tabs.find(tab => tab.active)?.id || ''}`;
    if (shared('devkits.native-selection') !== selection) {
      const previous = shared('devkits.native-selection');
      if (typeof previous === 'string') {
            setShared('devkits.selected-project', null);
        if (!taskMode()) run('layout.select', { stack: 'workspace-view', child: 'main' });
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
    const content = chosen?.pending || defaultSelected ? 'project-empty' : 'main';
    const conversation = layoutNode(layout(), 'workspace-view');
    // Project selection and restored layouts can change the stack independently.
    if (!taskMode() && conversation?.active !== content)
      run('layout.select', { stack: 'workspace-view', child: content });
    const showConversation = !taskMode() && conversationVisible(chosen);
    if (conversation && Boolean(conversation.hidden) === showConversation)
      run(showConversation ? 'layout.show' : 'layout.hide', { id: 'workspace-view' });
    const defaults = { ...(shared('devkits.default-terminals') || {}) };
    let defaultsChanged = false;
    for (const space of native) {
      if (defaults[space.id]) continue;
      const tab = space.tabs.find(tab => tab.name === '__devkits_default_terminal__');
      if (tab) { defaults[space.id] = tab.id; defaultsChanged = true; }
    }
    if (defaultsChanged) setShared('devkits.default-terminals', defaults);
    // A split created in the otherwise hidden default shell is user-visible work too.
    const sidebarDefaults = Object.fromEntries(Object.entries(defaults)
      .filter(([, tab]) => modelPanes.filter(pane => pane.tab === tab).length < 2));
    const groups = projectGroups(workspaces, all, sidebarDefaults, sessionThreadTitle);
    for (const group of groups) for (const thread of group.threads)
      if (thread.tab.id === defaults[group.space.id] && !thread.agent) thread.title = 'Terminal';
    const live = terminals();
    this.renderModel = { projects: workspaces, panes: modelPanes, terminals: live };
    const openTabs = new Set(groups.flatMap(group => group.threads.map(thread => thread.tab.id)));
    for (const tab of this.archiveChecks?.keys() || []) if (!openTabs.has(tab)) {
      this.archiveChecks.delete(tab); this.closeOnlyThreads?.delete(tab);
    }
    for (const { threads } of groups) for (const thread of threads) this.prepareThreadArchive(thread, cx, live);
    const visible = groups.filter(g => !this.folded.has(g.space.id)).flatMap(g => g.threads.filter(thread => threadVisibleInSidebar(g.space, thread)).flatMap(thread => thread.agents));
    setAgentOrder(visible.map(a => a.address));
    return this.systemDisplay.sidebarContainer(Sidebar(t))
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
            .when(projectBoardTasks(space).some(task => !task.archived && task.attention), el => el.child(Button(`project-attention-${space.id}`, t, { variant: 'ghost' }).h(24).px(6)
              .text_size(10).text_color(t.blocked).accessibility_label(`Action Required in ${space.name}`)
              .child(String(projectBoardTasks(space).filter(task => !task.archived && task.attention).length))
              .on_click((_event, cx) => { cx.stop_propagation(); this.openBoard(space); setShared('devkits.board-attention', space.id); })))
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
      .child(this.systemDisplay.reservedSidebarContent(this.accountUsage(t)))
      .child(this.systemDisplay.renderSidebar(t))
      .child(SidebarFooter(t)
        .child(Button('archived-threads', t, { variant: 'ghost', size: 'icon' })
          .accessibility_label(this.archiveOpen ? 'Show threads' : 'Show thread history')
          .h_full().rounded(0).bg(this.archiveOpen ? t.selected : t.chrome)
          .on_click((_event, cx) => { this.archiveOpen = !this.archiveOpen; cx.notify(); }).child(glyph('clock')))
        .child(div().flex_1())
        .child(Button('open-interface-settings', t, { variant: 'ghost' }).h_full().px(8).gap(6)
          .accessibility_label('Interface settings').on_click(() => openInterfaceSettings())
          .child(glyph('settings')).child('Interface settings')));
  }
}

// Feature views share this view's state and its project, agent and session helpers.
Object.assign(Devkits.prototype, agentSelection, threadArchive, startPanel);
