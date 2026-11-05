import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { agents, spaces, panes, theme, run, props, window, openOverlay, closeOverlay, setAgentOrder, layout, settings, pickFolder, shared, setShared, knownAgents, notify } from 'herdr';
import { projectGroups, projectCatalog, folderKey } from './model.js';
import { DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { Button } from './components/button.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './components/alert-dialog.js';
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from './components/empty.js';
import { Sidebar, SidebarContent, SidebarGroupLabel, SidebarMenuButton, SidebarFooter } from './components/sidebar.js';

const glyph = (name, size = 14) => svg(`mods/devkits/assets/icons/${name}.svg`).size(size).flex_none();
const stateColor = (status, t) => t[status] || t.muted;

export default class Devkits extends View {
  init(_props, cx) {
    this.folded = new Set();
    this.hovered = null;
    this.hoveredProject = null;
    if (['close-project', 'project-menu', 'project-picker'].includes(props()?.view)) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      if (props().view === 'project-picker') this.projectIndex = -1;
    }
    if (props()?.view === 'launcher') {
      this.launchers = [];
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
        this.selectProject(this.projects().find(p => !p.machine && folderKey(p.folder) === folderKey(folder)));
        cx.notify();
      } catch (error) { notify({ title: 'Could not open project', body: error.message, level: 'error' }); }
      finally { if (overlay) closeOverlay(overlay); }
    });
  }

  projects() {
    return projectCatalog(spaces(), shared('devkits.projects') || [], shared('devkits.project-roots') || {}, shared('devkits.selected-project'));
  }

  selectProject(project) {
    setShared('devkits.selected-project', project.id);
    if (!project.pending) run('space.select', { id: project.id });
    run('layout.select', { stack: 'workspace-view', child: project.pending ? 'project-empty' : 'main' });
  }

  closeProject(project) {
    if (project.pending) { this.finishCloseProject(project); return; }
    openOverlay({ mod: 'devkits', kind: 'dialog', width: 440, height: 220,
      props: { view: 'close-project', project } });
  }

  projectMenu(t) {
    const target = props();
    const close = () => { closeOverlay(target.overlay); this.closeProject(target.project); };
    return DropdownMenuContent('project-menu', 42, t)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'enter') close();
        else if (event.key === 'escape') closeOverlay(target.overlay);
        else return;
        cx.stop_propagation();
      })
      .child(DropdownMenuItem('menu-close-project', t).on_click(close).child(glyph('close')).child('Close workspace'));
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
      .child(DropdownMenuLabel(t).child('Projects'))
      .child(v_flex().id('picker-projects').flex_1().min_h(0).overflow_y_scrollbar().gap(1)
        .children(projects.map((project, index) => DropdownMenuItem(`picker-project-${project.id}`, t)
          .bg(this.projectIndex === index ? t.selected : t.popover)
          .tooltip(project.folder).on_hover((inside, cx) => { if (inside) { this.projectIndex = index; cx.notify(); } })
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
        .child('This ends every session in this workspace, including running agents. Your project files stay on disk.'))
      .child(AlertDialogFooter().children([
        AlertDialogCancel('cancel-close-project', t).on_click(cancel).child('Cancel'),
        AlertDialogAction('confirm-close-project', t).on_click(confirm).child('Close workspace'),
      ]));
  }

  newThread(cx, id, at) {
    const project = this.projects().find(s => id ? s.id === id : s.active);
    if (!project) { this.openProject(cx); return; }
    openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 280, at,
      props: { view: 'launcher', space: project.pending ? null : project.id, folder: project.folder, projectName: project.name } });
  }

  loadAgents(cx) {
    this.loading = true;
    this.launchError = false;
    cx.spawn(async cx => {
      try {
        const project = spaces().find(s => s.id === props().space);
        this.launchers = (await knownAgents({ on: project?.machine })).filter(agent => agent.installed);
      } catch { this.launchError = true; }
      this.loading = false;
      cx.notify();
    });
  }

  startThread(agent) {
    const target = props();
    closeOverlay(target.overlay);
    setShared('devkits.selected-project', null);
    run('layout.select', { stack: 'workspace-view', child: 'main' });
    if (target.space) run('tab.new', { space: target.space, folder: target.folder, ...(agent ? { name: agent.name, argv: agent.run } : {}) });
    else run('space.new', { name: target.projectName, folder: target.folder, machine: '', ...(agent ? { tab: agent.name, argv: agent.run } : {}) });
  }

  launcher(t) {
    const row = (id, name, icon, action, hint) => DropdownMenuItem(id, t).on_click(action)
      .child(div().size(16).flex_none().flex().items_center().justify_center().text_color(t.muted).child(icon))
      .child(div().flex_1().min_w(0).truncate().child(name)).child(div().flex_none().text_size(11).text_color(t.muted).child(hint));
    return DropdownMenuContent('thread-launcher', Math.min(360, 80 + Math.max(1, this.launchers.length) * 33), t)
      .track_focus(this.handle).on_key_down(event => {
        if (event.modifiers.control || event.modifiers.platform || event.modifiers.alt) return;
        const agent = /^[1-9]$/.test(event.key) ? this.launchers[Number(event.key) - 1] : null;
        if (agent?.installed) this.startThread(agent);
      })
      .child(DropdownMenuLabel(t).child('Add session'))
      .child(row('new-terminal', 'Terminal', glyph('terminal'), () => this.startThread(), ''))
      .child(DropdownMenuSeparator(t))
      .child(v_flex().id('thread-launchers').flex_1().min_h(0).overflow_y_scrollbar().gap(1)
        .children(this.launchers.map((agent, i) => row(`start-${agent.key}`, agent.name,
          agent.icon ? (agent.tint ? svg(agent.icon).size(16).text_color(t.foreground) : image(agent.icon).size(16)) : glyph('mark', 16),
          () => this.startThread(agent), i < 9 ? String(i + 1) : '')))
        .when(this.loading, el => el.child(div().p(10).text_size(12).text_color(t.muted).child('Loading agents…')))
        .when(this.launchError, el => el.child(div().id('retry-agents').p(10).text_size(12).text_color(t.muted).cursor_pointer()
          .on_click((_event, cx) => this.loadAgents(cx)).child('Could not load agents. Click to retry.')))
        .when(!this.loading && !this.launchError && !this.launchers.length, el => el.child(div().p(10).text_size(12).text_color(t.muted).child('No installed agents found.'))));
  }

  header(t) {
    const space = this.projects().find(s => s.active);
    const win = window();
    const root = layout(), sidebar = root?.children?.find(node => node.id === 'sidebar');
    const inset = win?.platform === 'macos' && !win.fullscreen && sidebar?.hidden
      ? (root.traffic_lights[0] + 64) / settings().zoom : 12;
    return h_flex().size_full().px(16).pl(inset).gap(12).items_center().bg(t.background).text_size(13)
      .border_b(1).border_color(t.border)
      .child(DropdownMenuTrigger(h_flex().id('project-switcher').h(32).px(8).gap(6).items_center().rounded(6)
        .text_color(t.foreground).font_medium().hover(el => el.bg(t.hover)).cursor_pointer()
        .tooltip(space?.folder || 'Open a project'), 280,
        (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 280, at,
          props: { view: 'project-picker' } }))
        .child(div().max_w(220).truncate().child(space?.name || 'Open project'))
        .child(glyph('chevron-down', 12).text_color(t.muted)))
      .child(div().flex_1())
      .when(Boolean(win?.buttons), el => el
        .child(Button('minimize', t, { variant: 'ghost', size: 'icon' }).tooltip('Minimize').accessibility_label('Minimize')
          .on_click(() => run('window.minimize')).child(glyph('minus')))
        .child(Button('maximize', t, { variant: 'ghost', size: 'icon' }).tooltip('Maximize / restore').accessibility_label('Maximize / restore')
          .on_click(() => run('window.maximize')).child(glyph('square')))
        .child(Button('close-window', t, { variant: 'ghost', size: 'icon' }).tooltip('Close window').accessibility_label('Close window')
          .on_click(() => run('window.close')).child(glyph('close'))));
  }

  brand(t) {
    const mac = window()?.platform === 'macos' && !window()?.fullscreen;
    return h_flex().size_full().pl(mac ? 80 : 16).pr(12).gap(10).items_center().bg(t.chrome)
      .border_b(1).border_color(t.border)
      .child(div().size(28).flex_none().flex().items_center().justify_center().rounded(7)
        .bg(t.solid).text_color(t.solid_foreground).child(glyph('mark', 17)))
      .child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).child('Devkits'));
  }

  paneHeader(t) {
    const p = panes().find(p => p.pane === props()?.pane);
    if (!p) return div();
    const program = p.program;
    const icon = program?.icon ? (program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)) : glyph('terminal');
    return h_flex().size_full().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .text_size(12).text_color(t.muted).on_click(() => run('pane.focus', { pane: p.pane }))
      .child(div().flex_none().tooltip(program?.name || 'Terminal').child(icon))
      .child(div().flex_1().min_w(0).truncate().child(p.cwd || ''))
      .when(Boolean(p.status), el => el.child(h_flex().h(22).px(7).gap(5).items_center().rounded(5)
        .border(1).border_color(t.border).text_size(10).text_color(t.muted)
        .child(div().size(5).rounded(3).bg(stateColor(p.status, t)))
        .child(p.status === 'blocked' ? 'Needs you' : `${p.status[0].toUpperCase()}${p.status.slice(1)}`)))
      .child(Button(`split-right-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).tooltip('Split right').accessibility_label('Split right')
        .on_click(() => run('pane.split', { pane: p.pane, direction: 'right' })).child(glyph('split-right')))
      .child(Button(`split-down-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).tooltip('Split down').accessibility_label('Split down')
        .on_click(() => run('pane.split', { pane: p.pane, direction: 'down' })).child(glyph('split-down')))
      .child(Button(`zoom-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).tooltip(p.zoomed ? 'Restore pane' : 'Zoom pane')
        .accessibility_label(p.zoomed ? 'Restore pane' : 'Zoom pane').on_click(() => run('pane.zoom', { pane: p.pane })).child(glyph('square')))
      .child(Button(`close-${p.pane}`, t, { variant: 'ghost', size: 'icon' }).tooltip('Close pane').accessibility_label('Close pane')
        .on_click(() => run('pane.close', { pane: p.pane })).child(glyph('close')));
  }

  statusBar(t) {
    const space = this.projects().find(s => s.active);
    return h_flex().size_full().px(16).gap(8).items_center().bg(t.background).border_t(1).border_color(t.border)
      .text_size(11).text_color(t.muted).child(glyph('terminal', 12)).child(space?.machine || 'Local workspace')
      .when(Boolean(space?.branch), el => el.child(glyph('branch', 12)).child(space.branch))
      .child(div().flex_1())
      .child(div().id('commands').px(6).py(3).rounded(4).hover(el => el.bg(t.hover)).cursor_pointer()
        .on_click(() => run('app.palette')).child('Commands'));
  }

  emptyProject(t) {
    const project = this.projects().find(p => p.active);
    return Empty(t).size_full().bg(t.background)
      .child(EmptyMedia(t).child(glyph('folder', 24)))
      .child(EmptyTitle().child(project?.name || 'Project'))
      .child(EmptyDescription(t).child(project?.folder || ''))
      .child(EmptyDescription(t).child('Choose an agent to start your first session.'))
      .child(DropdownMenuTrigger(Button('add-first-session', t).mt(8), 280,
        (cx, at) => this.newThread(cx, undefined, at)).child(glyph('plus')).child('Add session'));
  }

  threadRow(thread, t) {
    const agent = thread.agent;
    const isFocused = thread.active;
    const p = agent?.program;
    const icon = p?.icon ? (p.tint ? svg(p.icon).size(14).text_color(t.muted) : image(p.icon).size(14)) : glyph('terminal', 14).text_color(t.muted);
    return SidebarMenuButton(`thread-${thread.tab.id}`, isFocused, t)
      .on_hover((hovered, cx) => { this.hovered = hovered ? thread.tab.id : null; cx.notify(); })
      .tooltip(`${thread.title}\n${p?.name || agent?.app || 'Terminal'} · ${thread.status}`)
      .on_click(() => {
        this.selectProject(this.projects().find(project => project.id === thread.space));
        run('tab.select', { id: thread.tab.id });
      })
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground)
        .when(isFocused, el => el.font_medium()).child(thread.title))
      .child(div().size(5).flex_none().rounded(3).bg(stateColor(thread.status, t)))
      .child(Button(`close-thread-${thread.tab.id}`, t, { variant: 'ghost', size: 'icon-sm' })
        .opacity(isFocused || this.hovered === thread.tab.id ? 1 : 0)
        .tooltip('Close thread').accessibility_label('Close thread')
        .on_click((_event, cx) => { cx.stop_propagation(); run('tab.close', { id: thread.tab.id }); })
        .child(glyph('close', 12)));
  }

  render() {
    const t = theme();
    if (props()?.view === 'header') return this.header(t);
    if (props()?.view === 'brand') return this.brand(t);
    if (props()?.view === 'pane') return this.paneHeader(t);
    if (props()?.view === 'status') return this.statusBar(t);
    if (props()?.view === 'launcher') return this.launcher(t);
    if (props()?.view === 'project-empty') return this.emptyProject(t);
    if (props()?.view === 'close-project') return this.closePrompt(t);
    if (props()?.view === 'project-menu') return this.projectMenu(t);
    if (props()?.view === 'project-picker') return this.projectPicker(t);
    const all = agents(), native = spaces();
    const roots = shared('devkits.project-roots') || {};
    const missing = native.filter(s => roots[s.id] === undefined && s.folder);
    if (missing.length) setShared('devkits.project-roots', { ...roots, ...Object.fromEntries(missing.map(s => [s.id, s.folder])) });
    const active = native.find(s => s.active);
    const selection = `${active?.id || ''}:${active?.tabs.find(tab => tab.active)?.id || ''}`;
    if (shared('devkits.native-selection') !== selection) {
      if (shared('devkits.native-selection') !== undefined) {
        setShared('devkits.selected-project', null);
        run('layout.select', { stack: 'workspace-view', child: 'main' });
      }
      setShared('devkits.native-selection', selection);
    }
    const workspaces = this.projects();
    const chosen = workspaces.find(p => p.active);
    const content = chosen?.pending ? 'project-empty' : 'main';
    if (this.shownContent !== content) {
      this.shownContent = content;
      run('layout.select', { stack: 'workspace-view', child: content });
    }
    const groups = projectGroups(workspaces, all);
    const visible = groups.filter(g => !this.folded.has(g.space.id)).flatMap(g => g.threads.flatMap(thread => thread.agents));
    setAgentOrder(visible.map(a => a.address));
    return Sidebar(t)
      .child(SidebarContent()
        .when(!groups.length, el => el.child(Empty(t).px(16).py(28)
          .child(EmptyMedia(t).child(glyph('folder', 24)))
          .child(EmptyTitle().child('Open a project'))
          .child(EmptyDescription(t).child('Choose a folder to start your workspace.'))
          .child(Button('open-first-project', t).mt(4)
            .on_click((_event, cx) => this.openProject(cx)).child('Open folder…'))))
        .children(groups.map(({ space, threads }) => v_flex().gap(1)
          .child(SidebarGroupLabel(`project-${space.id}`, space.active, t)
            .on_hover((hovered, cx) => { this.hoveredProject = hovered ? space.id : null; cx.notify(); })
            .tooltip(space.folder).on_click((event, cx) => {
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
              .tooltip(`Add session in ${space.name}`).accessibility_label(`Add session in ${space.name}`), 280,
              (cx, at) => this.newThread(cx, space.id, at), 'end')
              .child(glyph('plus')).opacity(this.hoveredProject === space.id ? 1 : 0))
            .child(DropdownMenuTrigger(Button(`project-menu-${space.id}`, t, { variant: 'ghost', size: 'icon' })
              .tooltip(`More actions for ${space.name}`).accessibility_label(`More actions for ${space.name}`), 200,
              (_cx, at) => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 200, at,
                props: { view: 'project-menu', project: space } }), 'end')
              .child(glyph('ellipsis')).opacity(this.hoveredProject === space.id ? 1 : 0)))
          .when(!this.folded.has(space.id), el => el.children(threads.map(thread => this.threadRow(thread, t)))
            .when(!threads.length, el => el.child(div().px(12).py(6).text_size(12).text_color(t.muted).child('No threads yet')))))))
      .child(SidebarFooter(t)
        .child(Button('settings', t, { variant: 'ghost', size: 'icon' }).tooltip('Settings').accessibility_label('Settings')
          .on_click(() => run('app.settings')).child(glyph('settings')))
        .child(div().flex_1()));
  }
}
