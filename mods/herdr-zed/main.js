import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { agents, spaces, panes, theme, run, props, window, openOverlay, closeOverlay, setAgentOrder, layout, settings, pickFolder, shared, setShared, notify, nextCommand, terminals, knownAgents, hc } from 'herdr';
import { projectGroups, projectCatalog, folderKey, threadTitle, threadProgram, childTerminals, terminalLabel, terminalWorking } from './components/session-model.js';
import FileViewer, { FileMenu } from './files.js';
import DiffViewer from './diff.js';
import { BuildRulesSettings } from './diff-ignore-settings.js';
import { GitResultToast, clearGitToast } from './git-result-toast.js';
import WorkspaceEditor from './workspace-editor.js';
import { BranchMenu } from './branch-menu.js';
import { ProjectLayout, layoutNode, conversationMaximized, maximizeConversation } from './project-layout.js';
import { NativeLauncher } from './native-launcher.js';
import { createNativeThread } from './native-threads.js';
import { startPanel } from './start-panel.js';
import { threadArchive, historyEligible } from './thread-archive.js';
import { GitAuthorSettings } from './git-author-settings.js';
import { ExtensionsManager, openExtensions } from './extensions-manager.js';
import { ExtensionSlot, ExtensionSurfaceSlot, refreshExtensions, openExtension } from './extensions.js';
import { DropdownMenu, DropdownMenuState, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button, ToolbarButton } from './components/button.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './components/alert-dialog.js';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarTreeMenuButton, SidebarFooter } from './components/sidebar.js';

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

export default class HerdrZed extends View {
  init(_props, cx) {
    const view = props()?.view;
    if (view === 'extensions') { this.extensionsManager = new ExtensionsManager(); this.extensionsManager.init(cx); return; }
    if (view === 'launcher') { this.launcher = new NativeLauncher(); this.launcher.init(cx); return; }
    if (view === 'diff-ignore-settings') { this.buildRulesSettings = new BuildRulesSettings(); this.buildRulesSettings.init(cx); return; }
    if (view === 'status') { clearGitToast(); setShared('herdr-zed.git-output-request', null); }
    if (view === 'pane') { this.threadMenu = new DropdownMenuState(cx); return; }
    if (view === 'file-menu') { this.fileMenu = new FileMenu(); this.fileMenu.init(cx); return; }
    if (view === 'branch-menu') { this.branchMenu = new BranchMenu(); this.branchMenu.init(cx); return; }
    if (view === 'git-author-settings') { this.gitAuthorSettings = new GitAuthorSettings(); this.gitAuthorSettings.init(cx); return; }
    if (view === 'header') {
      cx.spawn(async cx => { await refreshExtensions(); cx.notify(); });
      cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === 'new-thread') this.newThread(cx);
        if (command === 'reveal-conversation') this.showConversation(true);
        if (command === 'extensions') openExtensions();
        if (command === 'extensions-refresh') { await refreshExtensions(); cx.notify(); }
        if (command.startsWith('extension:')) openExtension(command.slice('extension:'.length), this.projects().find(project => project.active));
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
    setShared('herdr-zed.selected-project', project.id);
    if (!project.pending) run('space.select', { id: project.id });
    run('layout.select', { stack: 'workspace-view', child: project.pending ? 'project-empty' : 'main' });
  }

  closeProject(project) {
    if (project.pending) { this.finishCloseProject(project); return; }
    openOverlay({ mod: 'herdr-zed', kind: 'dialog', frame: 'none', width: 440, height: 220,
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
        AlertDialogAction('confirm-close-project', t).on_click(confirm).child('Close project'),
      ]));
  }

  newThread(cx, id, at) {
    const project = this.projects().find(project => id ? project.id === id : project.active);
    if (!project) { this.openProject(cx); return; }
    openOverlay({ mod: 'herdr-zed', kind: 'popup', frame: 'none', width: 280, at,
      props: { view: 'launcher', space: project.pending ? null : project.id, folder: project.folder,
        projectName: project.name, machine: project.machine || null } });
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

  repeatThread(cx, id) { this.newThread(cx, id); }

  cachedAgents(machine) { return knownAgents({ on: machine }).then(items => items.filter(agent => agent.installed)); }

  startThread(agent, target) {
    try { createNativeThread(agent, target); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); }
  }

  threadBusy(thread, live = terminals()) {
    return ['working', 'blocked'].includes(thread.status) || thread.agents.some(agent =>
      ['working', 'blocked'].includes(live.find(terminal => terminal.address === agent.address)?.status || agent.status));
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
    this.buildRulesSettings?.close();
    this.gitAuthorSettings?.close();
    if (this.editor) this.editor.close(); else this.files?.close();
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
    const thread = projectGroups(spaces(), agents(), {}, threadTitle).flatMap(group => group.threads).find(thread => thread.tab.id === p.tab);
    const members = panes().filter(pane => pane.tab === p.tab);
    const primary = members.find(pane => pane.terminal === thread?.agents[0]?.address) || members[0];
    const secondary = members.length > 1 && primary?.pane !== p.pane;
    const program = secondary ? p.program : threadProgram(thread, terminals(), p.program);
    const title = secondary ? p.title || 'Terminal' : thread?.tab.name === '__herdr_zed_default_terminal__' && !thread.agent ? 'Terminal' : thread?.title || p.title || 'Terminal';
    const project = this.projects().find(project => project.id === thread?.space);
    const maximized = conversationMaximized(project);
    this.threadMenu ??= new DropdownMenuState();
    const actions = [{ key: 'close', label: secondary ? 'Close terminal' : 'Close thread', icon: 'close' }];
    const choose = () => run('pane.close', { pane: p.pane });
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
      .child(div().flex_1())
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



  statusBar(t) {
    const space = this.projects().find(project => project.active), editor = layoutNode(layout(), 'editor');
    const conversation = layoutNode(layout(), 'workspace-view');
    const showing = name => Boolean(editor) && shared('herdr-zed.right-panel') === name;
    return h_flex().id('herdr-zed-status').relative().size_full().pr(4).gap(8).items_center().bg(t.background)
      .text_size(11).text_color(t.muted)
      .when(Boolean(space && conversation), el => el.child(ToolbarButton('open-conversation', t,
        { icon: true, disabled: !hasConversation(space), selected: conversationVisible(space) })
        .accessibility_label(conversationVisible(space) ? 'Hide conversation' : 'Show conversation')
        .on_click(() => this.showConversation(!conversationVisible(space))).child(glyph('agent'))))
      .when(Boolean(space?.machine), el => el.child(h_flex().flex_none().gap(8).items_center().child(glyph('terminal', 12)).child(space.machine)))
      .child(div().flex_1())
      .children([ExtensionSlot('status.right', t, space)].filter(Boolean))
      .children([ExtensionSurfaceSlot('dock.right', t)].filter(Boolean))
      .child(ToolbarButton('manage-extensions', t, { icon: true }).accessibility_label('Manage extensions')
        .on_click(openExtensions).child(glyph('extensions', 16)))
      .when(Boolean(space), el => el.child(h_flex().id('status-panel-actions').flex_none().h_full().gap(0)
        .child(ToolbarButton('open-diff', t, { icon: true, selected: showing('diff') })
          .accessibility_label(showing('diff') ? 'Hide changes' : 'Show changes')
          .on_click(() => toggleEditor(editor, 'diff')).child(glyph('git-compare')))
        .child(ToolbarButton('open-files', t, { icon: true, selected: showing('files') })
          .accessibility_label(showing('files') ? 'Hide files' : 'Show files')
          .on_click(() => toggleEditor(editor, 'files')).child(glyph('folder')))))
      .child(GitResultToast(t, space));
  }

  threadRow(thread, t, trunk = null) {
    const live = this.renderModel?.terminals || terminals();
    const members = (this.renderModel?.panes || panes()).filter(pane => pane.tab === thread.tab.id);
    const primary = members.find(pane => pane.terminal === thread.agents[0]?.address) || members[0];
    const primaryAgent = thread.agents.find(agent => agent.address === primary?.terminal) || thread.agent;
    if (primaryAgent && primaryAgent !== thread.agent)
      thread = { ...thread, agent: primaryAgent, title: threadTitle(thread.tab, primaryAgent, this.projects().find(project => project.id === thread.space)) };
    const working = thread.status === 'working' || thread.agents.some(agent => agent.status === 'working')
      || terminalWorking(live.find(terminal => terminal.address === primary?.terminal));
    const isFocused = thread.active && (!members.some(pane => pane.focused) || Boolean(primary?.focused));
    const p = threadProgram(thread, live, primary?.program);
    const stopping = this.threadBusy(thread, live);
    const archivable = !stopping && historyEligible(thread, live);
    const icon = working ? glyph('loader', 14).text_color(t.working).spin(900).accessibility_label('Working')
      : thread.status === 'blocked' ? glyph('circle-alert', 14).text_color(t.blocked).accessibility_label('Blocked')
      : thread.status === 'done' ? glyph('circle-check', 14).text_color(t.done).accessibility_label('Done')
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
      .child(Button(`${stopping ? 'stop' : archivable ? 'archive' : 'close'}-thread-${thread.tab.id}`, t, { variant: 'row', size: 'icon-sm' })
        .ml(8).opacity(this.hovered === thread.tab.id ? 1 : 0)
        .accessibility_label(stopping ? 'Stop generation' : archivable ? 'Archive conversation' : 'Close thread')
        .disabled(this.stoppingThreads?.has(thread.tab.id) || false)
        .on_click((_event, cx) => {
          cx.stop_propagation();
          if (stopping) cx.spawn(async cx => { await this.stopThread(thread); cx.notify(); });
          else if (archivable) cx.spawn(async cx => { await this.archiveThread(thread); cx.notify(); });
          else run('tab.close', { id: thread.tab.id });
        }).child(glyph(stopping ? 'square' : archivable ? 'archive' : 'close', 12)));
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
    try { return this.renderView(cx); }
    finally { this.renderModel = null; }
  }

  renderView(cx) {
    const t = theme();
    if (props()?.view === 'extensions') return this.extensionsManager.render(t);
    if (props()?.view === 'diff-ignore-settings') return this.buildRulesSettings.render(t);
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
    if (props()?.view === 'git-author-settings') return this.gitAuthorSettings.render(t);
    if (props()?.view === 'brand') return this.brand(t);
    if (props()?.view === 'pane') return this.paneHeader(t, cx);
    if (props()?.view === 'status') return this.statusBar(t);
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
    this.renderModel = { projects: workspaces, panes: modelPanes, terminals: live };
    const visible = groups.filter(group => !this.folded.has(group.space.id)).flatMap(group => group.threads.flatMap(thread => thread.agents));
    setAgentOrder(visible.map(a => a.address));
    return Sidebar(t)
      .child(this.archiveOpen ? this.historyList(t) : SidebarContent()
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
              (_cx, at) => openOverlay({ mod: 'herdr-zed', kind: 'popup', frame: 'none', width: 200, at,
                props: { view: 'project-menu', project: space } }), 'end', SIDEBAR_MENU)
              .child(glyph('ellipsis')).opacity(this.hoveredProject === space.id ? 1 : 0)))
          .when(!this.folded.has(space.id), el => el
            .children(this.groupedThreads(space, threads, t, live))
            .when(!threads.length, el => el.child(h_flex().h(32).flex_none().px(12).items_center().text_size(12).text_color(t.muted).child(threads.length ? 'No active threads' : 'No threads yet')))))))
      .child(SidebarFooter(t)
        .child(Button('zed-thread-history', t, { variant: 'ghost', size: 'icon' })
          .accessibility_label(this.archiveOpen ? 'Show threads' : 'Show thread history')
          .h_full().rounded(0).bg(this.archiveOpen ? t.selected : t.chrome)
          .on_click((_event, cx) => { this.archiveOpen = !this.archiveOpen; cx.notify(); }).child(glyph('clock')))
        .child(div().flex_1()));
  }
}

Object.assign(HerdrZed.prototype, startPanel);
Object.assign(HerdrZed.prototype, threadArchive);
