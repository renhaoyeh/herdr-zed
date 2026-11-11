import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { agents, spaces, panes, theme, run, props, window, openOverlay, closeOverlay, setAgentOrder, layout, settings, pickFolder, shared, setShared, notify, nextCommand, terminals, knownAgents, hc } from 'herdr';
import { projectGroups, projectCatalog, folderKey, threadTitle, threadProgram, childTerminals, terminalLabel, agentReportedWorking } from './components/session-model.js';
import FileViewer, { FileMenu } from './files.js';
import DiffViewer from './diff.js';
import { GitResultToast, clearGitToast } from './git-result-toast.js';
import WorkspaceEditor from './workspace-editor.js';
import { BranchMenu } from './branch-menu.js';
import { ProjectLayout, layoutNode, conversationMaximized, maximizeConversation } from './project-layout.js';
import { NativeLauncher } from './native-launcher.js';
import { createNativeThread } from './native-threads.js';
import { startPanel } from './start-panel.js';
import { threadArchive, historyEligible } from './thread-archive.js';
import { startThreadResume } from './thread-resume.js';
import { SettingsNav, SettingsPage, SettingsHeader, openSettings, settingsPageKey } from './settings.js';
import { GitAuthorDialog } from './git-author-settings.js';
import { ExtensionSlot, ExtensionSurfaceSlot, refreshExtensions, openExtension, extensionCatalog, openGitAction, activeLauncher, publishWorkspaceRect, recordSize, WORK_WIDTH_KEY, SIDEBAR_HEIGHT_KEY, closeWorkspacePanel, visibleSurfaceCount, syncExtensionLayout } from './extensions.js';
import { pollLaunchIntake } from './launch-intake.js';
import { readNewTerminalCommand } from './components/extension-contract.js';
import { workspaceTopAnchor } from './extension-model.js';
import { usableWorkspaceRect, WORKSPACE_RECT_KEY } from './components/workspace-overlay.js';
import { threadDecorations, decorationTone } from './decorations.js';
import { DropdownMenu, DropdownMenuState, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button, ToolbarButton, TOOLBAR_GLYPH, ROW_GLYPH } from './components/button.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from './components/alert-dialog.js';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarTreeMenuButton, SidebarFooter } from './components/sidebar.js';

// Provider decoration badge: a small outlined pill in the decoration's tone; subtitles are plain muted text.
const decorationBadge = (decoration, t) => {
  const color = decorationTone(t, decoration.tone);
  return div().flex_none().flex().items_center().px(5).h(16).rounded(8).border(1).border_color(color)
    .text_size(10).text_color(color).child(decoration.badge);
};

// A 28px icon button centred in a 32px project row: 8px below the row.
const SIDEBAR_MENU = { x: 0, y: 10 };
import { glyph } from './components/icon.js';

// Like Zed's dock buttons: close only the side panel, preserving the central document.
const toggleEditor = (_editor, name) => {
  const maximized = Boolean(shared('herdr-zed.conversation-maximized'));
  maximizeConversation(null, false);
  setShared('herdr-zed.right-panel', !maximized && shared('herdr-zed.right-panel') === name ? null : name);
};
const conversationKey = project => JSON.stringify([project.machine || '', folderKey(project.folder) || project.id]);
const hasConversation = (project, all, modelPanes) => {
  const tab = project?.tabs?.find(tab => tab.active);
  if (!tab || project.pending) return false;
  if (tab.id !== shared('herdr-zed.default-terminals')?.[project.id] && tab.name !== '__herdr_zed_default_terminal__') return true;
  return (all || agents()).some(agent => agent.space === project.id && agent.tab === tab.id)
    || (modelPanes || panes()).filter(pane => pane.tab === tab.id).length > 1;
};
const conversationVisible = (project, all, modelPanes) => Boolean(hasConversation(project, all, modelPanes)
  && shared('herdr-zed.conversation-visible')?.[conversationKey(project)]);

// A child or pane row is named by what it is: its title, its program, or its command. A terminal id (t3, an address)
// is never a name, so a bare terminal reads as "Terminal".
const rowLabel = (pane, terminal) => {
  const ids = new Set([pane?.pane, pane?.terminal, terminal?.address].filter(Boolean));
  const name = value => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text && !ids.has(text) && !/^[tp]\d+$/.test(text) ? text : null;
  };
  return name(pane?.title) || name(pane?.mod) || name(pane?.program?.name) || name(terminal?.program?.name)
    || name(terminal?.name) || name(terminal?.agent) || (terminal ? name(terminalLabel(terminal)) : null) || 'Terminal';
};

// The thread history list is open in the sidebar. Shared, so the sidebar's last row (its own layout block) can toggle it.
const HISTORY_OPEN = 'herdr-zed.history-open';
const historyOpen = () => Boolean(shared(HISTORY_OPEN));

export default class HerdrZed extends View {
  init(_props, cx) {
    const view = props()?.view;
    if (view === 'launcher') { this.launcher = new NativeLauncher(); this.launcher.init(cx); return; }
    if (view === 'settings-nav') { this.settingsNav = new SettingsNav(); return; }
    if (view === 'settings-header') { this.settingsHeader = new SettingsHeader(); return; }
    if (view === 'settings-page') { this.settingsPage = new SettingsPage(); this.settingsPage.init(cx); return; }
    if (view === 'commit-author') { this.authorDialog = new GitAuthorDialog(); this.authorDialog.init(cx); return; }
    if (view === 'status-tools') { clearGitToast(); setShared('herdr-zed.git-output-request', null); return; }
    if (view === 'pane') { this.threadMenu = new DropdownMenuState(cx); return; }
    if (view === 'file-menu') { this.fileMenu = new FileMenu(); this.fileMenu.init(cx); return; }
    if (view === 'branch-menu') { this.branchMenu = new BranchMenu(); this.branchMenu.init(cx); return; }
    if (view === 'header') {
      cx.spawn(async cx => { await refreshExtensions(); cx.notify(); });
      this.launchIntake = { handled: [] };
      this.launchTimer = cx.timer.every(100, () => this.pollLaunches());
      this.threadResume = startThreadResume(cx);
      cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === 'new-thread') this.newThread(cx);
        if (command === 'reveal-conversation') this.showConversation(true);
        // herdr-zed.settings opens the General page; herdr-zed.settings:<key> a shell page (general, git, extensions)
        // or an extension's page (ARCHITECTURE §2.1).
        if (command === 'settings') openSettings('general', this.projects().find(project => project.active));
        if (command === 'extensions') openSettings('extensions', this.projects().find(project => project.active));
        if (command.startsWith('settings:')) openSettings(settingsPageKey(command.slice('settings:'.length)), this.projects().find(project => project.active));
        if (command === 'extensions-refresh') { await refreshExtensions(); cx.notify(); }
        if (command.startsWith('extension:')) openExtension(command.slice('extension:'.length), this.projects().find(project => project.active));
        // herdr-zed.new-terminal: the Agents picker's Terminal row (ARCHITECTURE §3.1). Same tab as the native Terminal.
        const terminal = readNewTerminalCommand(command, spaces().map(space => ({ id: space.id, machine: space.machine || null })));
        if (terminal) this.newTerminal(terminal);
      }
      });
    }
    if (view === 'editor') {
      this.editor = new WorkspaceEditor(); this.editor.init(cx); this.files = this.editor.files;
      cx.spawn(async cx => {
        for (;;) {
          const command = await nextCommand();
          if (command === 'close-file') this.closeFileTab(cx);
          if (command === 'open-file') {
            const request = shared('herdr-zed.open-file-request'), project = this.projects().find(project => project.active);
            setShared('herdr-zed.open-file-request', null);
            if (project && request) { this.editor.openFile(project, request.path, cx, { on: request.on }); this.editor.focus(); }
          }
          if (command === 'focus' || command === 'focus-editor') this.editor.focus();
        }
      });
      return;
    }
    if (view === 'files') { this.files = new FileViewer(); this.files.init(cx); return; }
    if (view === 'diff') { this.diff = new DiffViewer(); this.diff.init(cx); return; }
    this.folded = new Set(); this.hovered = null; this.hoveredProject = null;
    if (['close-project', 'project-menu', 'project-picker'].includes(view)) {
      this.handle = cx.focus_handle(); this.handle.focus(); this.projectIndex = -1;
    }
  }

  openProject(cx) {
    const target = props();
    const overlay = target?.view === 'project-picker' ? target.overlay : null;
    cx.spawn(async cx => {
      try {
        const folder = await pickFolder({ prompt: 'Open project' });
        if (!folder) return;
        const saved = shared('herdr-zed.projects') || [];
        if (!saved.some(path => folderKey(path) === folderKey(folder))) setShared('herdr-zed.projects', [...saved, folder]);
        const project = this.projects().find(p => !p.machine && folderKey(p.folder) === folderKey(folder));
        if (project.pending) {
          setShared('herdr-zed.selected-project', null);
          run('layout.select', { stack: 'workspace-view', child: 'main' });
          run('space.new', { name: project.name, folder, machine: '', tab: '__herdr_zed_default_terminal__' });
        } else this.selectProject(project);
        cx.notify();
      } catch (error) { notify({ title: 'Could not open project', body: error.message, level: 'error' }); }
      finally { if (overlay) closeOverlay(overlay); }
    });
  }

  projects() {
    return this.renderModel?.projects || projectCatalog(spaces(), shared('herdr-zed.projects') || [], shared('herdr-zed.project-roots') || {}, shared('herdr-zed.selected-project'), shared('herdr-zed.project-order') || []);
  }

  moveProject(id, direction) {
    const projects = this.projects();
    const from = projects.findIndex(project => project.id === id);
    const to = from + direction;
    if (from >= 0 && to >= 0 && to < projects.length) {
      projects.splice(to, 0, projects.splice(from, 1)[0]);
      setShared('herdr-zed.project-order', projects.map(project => JSON.stringify([project.machine || '', folderKey(project.folder) || project.id])));
    }
  }

  selectProject(project) {
    if (project.id !== shared('herdr-zed.selected-project')) closeWorkspacePanel();
    setShared('herdr-zed.selected-project', project.id);
    if (!project.pending) run('space.select', { id: project.id });
    run('layout.select', { stack: 'workspace-view', child: project.pending ? 'project-empty' : 'main' });
  }

  closeProject(project) {
    if (project.pending) { this.finishCloseProject(project); return; }
    openOverlay({ mod: 'herdr-zed', kind: 'dialog', frame: 'none', modal: true, width: 440, height: 220,
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
      // Move up/down have no icon in assets/icons, so the menu's items all stay icon-less (design.md, Icons and hover).
      { id: 'menu-close-project', label: 'Close project', enabled: true, action: close, separated: true },
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
    if (!project.machine) setShared('herdr-zed.projects', (shared('herdr-zed.projects') || []).filter(folder => folderKey(folder) !== folderKey(project.folder)));
    if (shared('herdr-zed.selected-project') === project.id) setShared('herdr-zed.selected-project', null);
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
        Button('confirm-close-project', t, { variant: 'destructive' }).on_click(confirm).child('Close project'),
      ]));
  }

  // Fields handed to a provider launcher's picker and settings as flat props, like the native picker (the Agents
  // mod reads props().space, .folder, .projectName, .machine; Herdr adds props().overlay itself).
  launcherTarget(project) {
    return { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name, machine: project.machine || null };
  }

  // Long-lived intake (ARCHITECTURE §3.1): claim unhandled requests, open the valid ones, then reconcile pending tabs.
  pollLaunches() {
    pollLaunchIntake({ shared, setShared, spaces, run, closeOverlay, notify, launcherId: activeLauncher()?.id }, this.launchIntake, Date.now());
  }

  // The Agents Terminal row's request (herdr-zed.new-terminal): exactly the native picker's Terminal choice.
  newTerminal(terminal) {
    if (!terminal.ok) { notify({ title: 'Terminal request rejected', body: terminal.error, level: 'error' }); return; }
    try { createNativeThread(null, terminal.value); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); }
  }

  // Decorations are read from the shared envelopes of the active decorators (ARCHITECTURE §3.3).
  decorationsNow() {
    return threadDecorations(extensionCatalog().resolved?.decorators || [], key => shared(key));
  }

  newThread(cx, id, at) {
    const project = this.projects().find(project => id ? project.id === id : project.active);
    if (!project) { this.openProject(cx); return; }
    const launcher = activeLauncher(), width = launcher ? launcher.picker.width : 280;
    // A keyboard or command open has no pointer anchor: it centres at the top of the work area (review L10).
    const anchor = at ?? workspaceTopAnchor(usableWorkspaceRect(shared(WORKSPACE_RECT_KEY)), width, settings().zoom);
    if (launcher) {
      openOverlay({ mod: launcher.mod, kind: 'popup', frame: 'none', width, at: anchor,
        props: { view: launcher.picker.view, ...this.launcherTarget(project) } });
      return;
    }
    openOverlay({ mod: 'herdr-zed', kind: 'popup', frame: 'none', width: 280, at: anchor,
      props: { view: 'launcher', ...this.launcherTarget(project) } });
  }

  showConversation(visible = true, project = this.projects().find(project => project.active)) {
    if (!project) return;
    if (!visible) maximizeConversation(null, false);
    setShared('herdr-zed.conversation-visible', { ...(shared('herdr-zed.conversation-visible') || {}), [conversationKey(project)]: visible });
    run(visible && hasConversation(project) ? 'layout.show' : 'layout.hide', { id: 'workspace-view' });
    if (visible) {
      const pane = panes().find(pane => pane.tab === project.tabs?.find(tab => tab.active)?.id);
      if (pane) run('pane.focus', { pane: pane.pane });
    } else run('herdr-zed.focus-editor');
  }

  closeFileTab(cx) {
    const editor = layoutNode(layout(), 'editor');
    if (editor && !editor.hidden && this.editor) { this.editor.closeActiveTab(cx); return; }
    if (editor && !editor.hidden && (shared('herdr-zed.editor-kind') || editor.active || 'files') === 'files' && this.files?.file)
      this.files.closeTab(this.files.file, cx);
  }

  openEditorFile(path, on = null) {
    maximizeConversation(null, false);
    run('layout.show', { id: 'editor' });
    run('layout.select', { stack: 'editor', child: 'workspace-editor' });
    setShared('herdr-zed.open-file-request', { path, on });
    run('herdr-zed.open-file');
  }

  repeatThread(cx, id, at) { this.newThread(cx, id, at); }

  cachedAgents(machine) { return knownAgents({ on: machine }).then(items => items.filter(agent => agent.installed)); }

  startThread(agent, target) {
    try { createNativeThread(agent, target); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); }
  }

  // The status an agent reports for the thread (working, blocked or done), or null. A plain terminal reports none:
  // its tab status or a foreground process never draws the agent marks.
  agentStatus(thread, live = terminals()) {
    const reported = thread.agents.map(agent => live.find(terminal => terminal.address === agent.address)?.status || agent.status);
    return ['working', 'blocked', 'done'].find(status => reported.includes(status)) || null;
  }

  threadBusy(thread, live = terminals()) {
    return ['working', 'blocked'].includes(this.agentStatus(thread, live));
  }

  async stopThread(thread) {
    if (this.stoppingThreads?.has(thread.tab.id)) return;
    (this.stoppingThreads ||= new Set()).add(thread.tab.id);
    try {
      const live = terminals();
      for (const agent of thread.agents.filter(agent => ['working', 'blocked'].includes(
        live.find(terminal => terminal.address === agent.address)?.status || agent.status))) {
        const result = await hc(['interrupt', agent.address]);
        if (result.code) throw new Error(result.stderr?.trim() || 'Could not stop generation.');
      }
    } catch (error) { notify({ title: 'Could not stop generation', body: error.message, level: 'error' }); }
    finally { this.stoppingThreads.delete(thread.tab.id); }
  }

  groupedThreads(space, threads, t, live) { return threads.map(thread => this.renderThreadGroup(thread, t, live)); }

  async close() {
    this.settingsPage?.close();
    this.authorDialog?.close();
    if (this.editor) this.editor.close(); else this.files?.close();
    this.diff?.close();
  }

  header(t) {
    const space = this.projects().find(s => s.active);
    const win = window();
    const catalog = extensionCatalog();
    const workflow = catalog.resolved?.settings?.find(entry => entry.mod === catalog.resolved?.launcher?.mod);
    const root = layout(), sidebar = root?.children?.find(node => node.id === 'sidebar');
    const inset = win?.platform === 'macos' && !win.fullscreen && sidebar?.hidden
      ? (root.traffic_lights[0] + 64) / settings().zoom : 12;
    // Equal columns keep Run centered independently of project names and window controls.
    return h_flex().size_full().pl(inset - 12).items_center().bg(t.background).text_size(13)
      .on_size_change(size => recordSize(WORK_WIDTH_KEY, size.width))
      .border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden()
        .child(DropdownMenuTrigger(h_flex().id('project-switcher').min_w(0).h_full().pl(10).pr(6).gap(6).items_center().rounded(0)
          .text_color(t.foreground).font_medium().hover(el => el.bg(t.hover)).cursor_pointer(), 280,
          (_cx, at) => openOverlay({ mod: 'herdr-zed', kind: 'popup', frame: 'none', width: 280, at,
            props: { view: 'project-picker' } }), 'start', { x: 8, y: 9 }) // Clear of the header's 1px bottom border
          .child(div().min_w(0).max_w(220).truncate().child(space?.name || 'Open project'))
          .child(glyph('chevron-down', 12).text_color(t.muted)))
        // Like Zed, the branch opens a list of the project's branches; it only shows them for now.
        .when(Boolean(space?.branch), el => el.child(DropdownMenuTrigger(h_flex().id('branch-switcher').min_w(0).h_full().px(8).gap(4).items_center().rounded(0)
          .text_size(12).text_color(t.muted).hover(el => el.bg(t.hover)).cursor_pointer().accessibility_label(`Branches of ${space.name}`), 320,
          (_cx, at) => openOverlay({ mod: 'herdr-zed', kind: 'popup', frame: 'none', width: 320, at,
            props: { view: 'branch-menu', folder: space.folder, machine: space.machine || null, branch: space.branch } }), 'start', { x: 8, y: 9 })
          .child(glyph('branch', 12)).child(div().min_w(0).max_w(200).truncate().child(space.branch)))))
      .child(h_flex().flex_1().min_w(0).h_full().items_center().justify_center()
        )
      .child(h_flex().flex_1().min_w(0).h_full().items_center().justify_end()
        .when(Boolean(workflow), el => el.child(ToolbarButton('header-agents', t, { icon: true }).h_full()
          .tooltip(workflow.title).accessibility_label(workflow.title)
          .on_click(() => openSettings(settingsPageKey(workflow.id), this.projects().find(project => project.active)))
          .child(glyph('agent', TOOLBAR_GLYPH))))
        .child(ToolbarButton('header-extensions', t, { icon: true }).h_full()
          .tooltip('Extensions').accessibility_label('Extensions')
          .on_click(() => openSettings('extensions', this.projects().find(project => project.active)))
          .child(glyph('extensions', TOOLBAR_GLYPH)))
        .child(ToolbarButton('settings', t, { icon: true }).h_full()
          .tooltip('Settings').accessibility_label('Settings')
          .on_click(() => openSettings('general', this.projects().find(project => project.active))).child(glyph('gear', TOOLBAR_GLYPH)))
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
    const thread = projectGroups(spaces(), agents(), {}, threadTitle).flatMap(group => group.threads).find(thread => thread.tab.id === p.tab);
    const members = panes().filter(pane => pane.tab === p.tab);
    const primary = members.find(pane => pane.terminal === thread?.agents[0]?.address) || members[0];
    const secondary = members.length > 1 && primary?.pane !== p.pane;
    const program = secondary ? p.program : threadProgram(thread, terminals(), p.program);
    const title = secondary ? p.title || 'Terminal' : thread?.tab.name === '__herdr_zed_default_terminal__' && !thread.agent ? 'Terminal' : thread?.title || p.title || 'Terminal';
    const project = this.projects().find(project => project.id === thread?.space);
    const maximized = conversationMaximized(project);
    this.threadMenu ??= new DropdownMenuState();
    const decoration = this.decorationsNow().get(thread?.tab.id);
    const actions = [{ key: 'close', label: secondary ? 'Close terminal' : 'Close thread', icon: 'close' }];
    const choose = () => run('pane.close', { pane: p.pane });
    const terminal = terminals().find(terminal => terminal.address === p.terminal);
    const working = agentReportedWorking(terminal, p.status || terminal?.status);
    const icon = working ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
      : program?.icon ? (program.tint ? svg(program.icon).size(14).text_color(p.focused ? t.foreground : t.muted) : image(program.icon).size(14)) : glyph('terminal').text_color(p.focused ? t.foreground : t.muted);
    return h_flex().id(`pane-header-${p.pane}`).size_full().pl(12).gap(8).items_center()
      .bg(p.focused ? t.selected : t.chrome).border_b(1).border_color(p.focused ? t.accent : t.border)
      .text_size(12).text_color(t.muted).on_click(() => run('pane.focus', { pane: p.pane }))
      .child(div().flex_none().child(icon))
      .child(div().min_w(0).truncate().text_color(p.focused ? t.foreground : t.muted)
        .when(Boolean(p.focused), el => el.font_medium()).child(title))
      .when(Boolean(decoration?.subtitle), el => el.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(decoration.subtitle)))
      .when(Boolean(decoration?.badge), el => el.child(decorationBadge(decoration, t)))
      .child(div().flex_1())
      .child(h_flex().h_full().flex_none().items_center()
        // + then maximize then ⋯, as in Zed's panel toolbars.
        .child(DropdownMenuTrigger(ToolbarButton(`new-thread-${p.pane}`, t, { icon: true }).h_full()
          .tooltip('New thread…').accessibility_label('New thread…').child(glyph('plus', TOOLBAR_GLYPH)), 280,
          (cx, at) => this.newThread(cx, thread?.space, at), 'end'))
        .when(Boolean(project && layoutNode(layout(), 'workspace-view')), el => el.child(
          ToolbarButton(`maximize-thread-${p.pane}`, t, { icon: true }).h_full()
            .tooltip(maximized ? 'Restore thread' : 'Maximize thread').accessibility_label(maximized ? 'Restore thread' : 'Maximize thread')
            .on_click((_event, cx) => {
              cx.stop_propagation();
              maximizeConversation(project, !conversationMaximized(project));
              run('pane.focus', { pane: p.pane });
            }).child(glyph(maximized ? 'minimize' : 'maximize', TOOLBAR_GLYPH))))
        .child(DropdownMenu(`thread-actions-${p.pane}`, this.threadMenu,
          ToolbarButton(`thread-menu-${p.pane}`, t, { icon: true }).h_full()
            .tooltip('Thread options').accessibility_label('Thread options').child(glyph('ellipsis', TOOLBAR_GLYPH)),
          actions, choose, t, { offset: { x: 8, y: 9 }, fullHeight: true })));
  }



  // The status row is three layout blocks (layouts/herdr-zed.json, extension-surfaces.js): `status` (left: thread
  // toggle and machine), the status.right surfaces, and `status-tools` (right: extension actions, dock toggles,
  // then Changes and Files). statusTools is sized to its content by the layout transform.
  statusBar(t) {
    const space = this.projects().find(project => project.active), conversation = layoutNode(layout(), 'workspace-view');
    const group = h_flex().id('herdr-zed-status-context').flex_none().h_full().gap(8).items_center()
      .when(Boolean(space && conversation && hasConversation(space)), el => el.child(ToolbarButton('open-conversation', t,
        { icon: true, selected: conversationVisible(space) }).h_full()
        .tooltip(conversationVisible(space) ? 'Hide thread' : 'Show thread')
        .accessibility_label(conversationVisible(space) ? 'Hide thread' : 'Show thread')
        .on_click(() => this.showConversation(!conversationVisible(space))).child(glyph('agent', TOOLBAR_GLYPH))))
      .when(Boolean(space?.machine), el => el.child(h_flex().flex_none().gap(8).items_center().child(glyph('terminal', 12)).child(space.machine)));
    return h_flex().id('herdr-zed-status').relative().size_full().items_center().bg(t.background)
      .text_size(11).text_color(t.muted).child(group);
  }

  statusTools(t) {
    const space = this.projects().find(project => project.active), editor = layoutNode(layout(), 'editor');
    const showing = name => Boolean(editor) && shared('herdr-zed.right-panel') === name;
    const actions = ExtensionSlot('status.right', t, space), dock = ExtensionSurfaceSlot('dock.right', t);
    // Groups use spacing only; the layout owns the status bar's top boundary.
    syncExtensionLayout();
    return h_flex().id('herdr-zed-status-tools').relative().h_full().flex_none().pr(4).gap(8).items_center().bg(t.background)
      .text_size(11).text_color(t.muted)
      .children([actions, dock].filter(Boolean))
      // The toast is an absolute layer anchored to this block; it sits in the zero-gap group so it adds no spacing.
      .child(h_flex().id('status-panel-actions').flex_none().h_full().gap(0)
        .child(ToolbarButton('open-diff', t, { icon: true, selected: showing('diff'), disabled: !space }).h_full()
          .accessibility_label(showing('diff') ? 'Hide changes' : 'Show changes')
          .tooltip('Changes').on_click(() => toggleEditor(editor, 'diff')).child(glyph('git-compare', TOOLBAR_GLYPH)))
        .child(ToolbarButton('open-files', t, { icon: true, selected: showing('files'), disabled: !space }).h_full()
          .accessibility_label(showing('files') ? 'Hide files' : 'Show files')
          .tooltip('Files').on_click(() => toggleEditor(editor, 'files')).child(glyph('folder', TOOLBAR_GLYPH)))
        .child(GitResultToast(t, space)));
  }

  threadRow(thread, t, trunk = null) {
    const live = this.renderModel?.terminals || terminals();
    const members = (this.renderModel?.panes || panes()).filter(pane => pane.tab === thread.tab.id);
    const primary = members.find(pane => pane.terminal === thread.agents[0]?.address) || members[0];
    const primaryAgent = thread.agents.find(agent => agent.address === primary?.terminal) || thread.agent;
    if (primaryAgent && primaryAgent !== thread.agent)
      thread = { ...thread, agent: primaryAgent, title: threadTitle(thread.tab, primaryAgent, this.projects().find(project => project.id === thread.space)) };
    // Spinner, blocked and done marks come from an agent's report only; a terminal without an agent shows its icon.
    const reported = this.agentStatus(thread, live);
    const isFocused = thread.active && (!members.some(pane => pane.focused) || Boolean(primary?.focused));
    const p = threadProgram(thread, live, primary?.program);
    const stopping = this.threadBusy(thread, live);
    const archivable = !stopping && historyEligible(thread, live);
    const decoration = (this.renderModel?.decorations || this.decorationsNow()).get(thread.tab.id);
    const icon = reported === 'working' ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
      : reported === 'blocked' ? glyph('circle-alert', 14).text_color(t.blocked).accessibility_label('Blocked')
      : reported === 'done' ? glyph('circle-check', 14).text_color(t.done).accessibility_label('Done')
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
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground)
          .when(isFocused, el => el.font_medium()).child(thread.title))
        .when(Boolean(decoration?.subtitle), el => el.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(decoration.subtitle)))
        .when(Boolean(decoration?.badge), el => el.child(decorationBadge(decoration, t))))
      .child(ToolbarButton(`${stopping ? 'stop' : archivable ? 'archive' : 'close'}-thread-${thread.tab.id}`, t, { icon: true, row: true })
        .ml(8).opacity(this.hovered === thread.tab.id ? 1 : 0)
        .tooltip(stopping ? 'Stop generation' : archivable ? 'Archive conversation' : 'Close thread')
        .accessibility_label(stopping ? 'Stop generation' : archivable ? 'Archive conversation' : 'Close thread')
        .disabled(this.stoppingThreads?.has(thread.tab.id) || false)
        .on_click((_event, cx) => {
          cx.stop_propagation();
          if (stopping) cx.spawn(async cx => { await this.stopThread(thread); cx.notify(); });
          else if (archivable) cx.spawn(async cx => { await this.archiveThread(thread); cx.notify(); });
          else run('tab.close', { id: thread.tab.id });
        }).child(glyph(stopping ? 'square' : archivable ? 'archive' : 'close', ROW_GLYPH)));
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
      label: rowLabel(pane, terminal) });
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
    const icon = agentReportedWorking(terminal) ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
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
      .child(ToolbarButton(pane ? `close-pane-${pane.pane}` : `end-child-${terminal.address}`, t, { icon: true, row: true })
        .ml(8).opacity(this.hovered === key ? 1 : 0)
        .tooltip(pane ? `Close ${label}` : `End ${label}`)
        .accessibility_label(pane ? `Close ${label}` : `End ${label}`)
        .on_click((_event, cx) => {
          cx.stop_propagation();
          if (pane) run('pane.close', { pane: pane.pane });
          else run('terminal.kill', { terminal: terminal.address });
        })
        .child(glyph('close', ROW_GLYPH)));
  }

  render(cx) {
    this.renderModel = null;
    publishWorkspaceRect();
    try { return this.renderView(cx); }
    finally { this.renderModel = null; }
  }

  renderView(cx) {
    const t = theme();
    if (props()?.view === 'settings-nav') return this.settingsNav.render(t);
    if (props()?.view === 'settings-header') return this.settingsHeader.render(t);
    if (props()?.view === 'settings-page') return this.settingsPage.render(t);
    if (props()?.view === 'commit-author') return this.authorDialog.render(t);
    if (props()?.view === 'launcher') return this.launcher.render(t);
    if (props()?.view === 'file-menu') return this.fileMenu.render();
    if (props()?.view === 'editor') {
      const project = this.projects().find(project => project.active);
      if (!project) return this.welcomeView(t, cx);
      return this.editor.render(project, cx, { empty: () => this.projectStartView(project, t, cx) });
    }
    if (props()?.view === 'files') return this.files.render(this.projects().find(project => project.active), cx);
    if (props()?.view === 'diff') return this.diff.render(this.projects().find(project => project.active), cx);
    if (props()?.view === 'header') return this.header(t);
    if (props()?.view === 'branch-menu') return this.branchMenu.render(t);
    if (props()?.view === 'brand') return this.brand(t);
    if (props()?.view === 'sidebar-history') return this.sidebarHistory(t);
    if (props()?.view === 'pane') return this.paneHeader(t, cx);
    if (props()?.view === 'status') return this.statusBar(t);
    if (props()?.view === 'status-tools') return this.statusTools(t);
    if (props()?.view === 'project-empty') return div().size_full().bg(t.canvas);
    if (props()?.view === 'close-project') return this.closePrompt(t);
    if (props()?.view === 'project-menu') return this.projectMenu(t);
    if (props()?.view === 'project-picker') return this.projectPicker(t);
    const all = agents(), native = spaces(), modelPanes = panes();
    const roots = shared('herdr-zed.project-roots') || {};
    const missing = native.filter(s => roots[s.id] === undefined && s.folder);
    if (missing.length) setShared('herdr-zed.project-roots', { ...roots, ...Object.fromEntries(missing.map(s => [s.id, s.folder])) });
    const active = native.find(s => s.active);
    const selection = `${active?.id || ''}:${active?.tabs.find(tab => tab.active)?.id || ''}`;
    if (shared('herdr-zed.native-selection') !== selection) {
      const previous = shared('herdr-zed.native-selection');
      if (typeof previous === 'string') {
            setShared('herdr-zed.selected-project', null);
        run('layout.select', { stack: 'workspace-view', child: 'main' });
      }
      setShared('herdr-zed.native-selection', selection);
    }
    const workspaces = this.projects();
    const chosen = workspaces.find(p => p.active);
    this.projectLayout ??= new ProjectLayout();
    this.projectLayout.sync(chosen);
    const content = hasConversation(chosen, all, modelPanes) ? 'main' : 'project-empty';
    const conversation = layoutNode(layout(), 'workspace-view');
    // Project selection and restored layouts can change the stack independently.
    if (conversation?.active !== content)
      run('layout.select', { stack: 'workspace-view', child: content });
    const showConversation = conversationVisible(chosen, all, modelPanes);
    if (conversation && Boolean(conversation.hidden) === showConversation)
      run(showConversation ? 'layout.show' : 'layout.hide', { id: 'workspace-view' });
    const defaults = { ...(shared('herdr-zed.default-terminals') || {}) };
    let defaultsChanged = false;
    for (const space of native) {
      if (defaults[space.id]) continue;
      const tab = space.tabs.find(tab => tab.name === '__herdr_zed_default_terminal__');
      if (tab) { defaults[space.id] = tab.id; defaultsChanged = true; }
    }
    if (defaultsChanged) setShared('herdr-zed.default-terminals', defaults);
    // A split created in the otherwise hidden default shell is user-visible work too.
    const sidebarDefaults = Object.fromEntries(Object.entries(defaults)
      .filter(([, tab]) => modelPanes.filter(pane => pane.tab === tab).length < 2));
    const groups = projectGroups(workspaces, all, sidebarDefaults, threadTitle);
    for (const group of groups) for (const thread of group.threads)
      if (thread.tab.id === defaults[group.space.id] && !thread.agent) thread.title = 'Terminal';
    const live = terminals();
    this.renderModel = { projects: workspaces, panes: modelPanes, terminals: live, decorations: this.decorationsNow() };
    const visible = groups.filter(group => !this.folded.has(group.space.id)).flatMap(group => group.threads.flatMap(thread => thread.agents));
    setAgentOrder(visible.map(a => a.address));
    const list = (historyOpen() ? this.historyList(t) : SidebarContent()
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
            .child(DropdownMenuTrigger(ToolbarButton(`new-thread-${space.id}`, t, { icon: true, row: true })
              .tooltip(`New thread in ${space.name}`).accessibility_label(`New thread in ${space.name}`)
              .child(glyph('plus', ROW_GLYPH)).opacity(this.hoveredProject === space.id ? 1 : 0), 280,
              (cx, at) => {
                this.folded.delete(space.id);
                cx.spawn(async cx => { await this.repeatThread(cx, space.id, at); });
                cx.notify();
              }, 'start', SIDEBAR_MENU))
            .child(DropdownMenuTrigger(ToolbarButton(`project-menu-${space.id}`, t, { icon: true, row: true })
              .tooltip(`More actions for ${space.name}`).accessibility_label(`More actions for ${space.name}`), 200,
              (_cx, at) => openOverlay({ mod: 'herdr-zed', kind: 'popup', frame: 'none', width: 200, at,
                props: { view: 'project-menu', project: space } }), 'end', SIDEBAR_MENU)
              .child(glyph('ellipsis', ROW_GLYPH)).opacity(this.hoveredProject === space.id ? 1 : 0)))
          .when(!this.folded.has(space.id), el => el
            .children(this.groupedThreads(space, threads, t, live))
            .when(!threads.length, el => el.child(h_flex().h(32).flex_none().px(12).items_center().text_size(12).text_color(t.muted).child('No threads yet')))))));
    // design.md, Separators: a divider between the threads and the sidebar surfaces, when one is shown. The history
    // row is its own layout block below them (layouts/herdr-zed.json).
    return Sidebar(t).on_size_change(size => recordSize(SIDEBAR_HEIGHT_KEY, size.height))
      .child(list.when(visibleSurfaceCount('sidebar.bottom') > 0, el => el.border_b(1).border_color(t.border)));
  }

  // The sidebar's last row (design.md, Sidebar): the thread history toggle.
  sidebarHistory(t) {
    const open = historyOpen();
    return SidebarFooter(t).px(4).gap(0)
      .child(ToolbarButton('zed-thread-history', t, { icon: true, selected: open }).h_full()
        .tooltip(open ? 'Show threads' : 'Show thread history')
        .accessibility_label(open ? 'Show threads' : 'Show thread history')
        .on_click((_event, cx) => { setShared(HISTORY_OPEN, !open); cx.notify(); }).child(glyph('clock', TOOLBAR_GLYPH)))
      .child(div().flex_1());
  }
}

Object.assign(HerdrZed.prototype, startPanel);
Object.assign(HerdrZed.prototype, threadArchive);
