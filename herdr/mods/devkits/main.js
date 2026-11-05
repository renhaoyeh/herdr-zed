import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { agents, spaces, panes, theme, run, props, window, openOverlay, closeOverlay, setAgentOrder, layout, settings, pickFolder, shared, setShared, knownAgents, notify } from 'herdr';
import { projectGroups, projectCatalog, folderKey } from './model.js';

const stop = (_event, cx) => cx.stop_propagation();
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

  button(id, icon, tooltip, action, t) {
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.muted).hover(el => el.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .tooltip(tooltip).on_mouse_down('left', stop).on_click(action).child(glyph(icon));
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
    return v_flex().id('project-menu').w_full().h(44).p(4).bg(t.popover).text_color(t.foreground).text_size(12)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'enter') close();
        else if (event.key === 'escape') closeOverlay(target.overlay);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().id('menu-close-project').h(36).px(10).gap(8).items_center().rounded(6)
        .hover(el => el.bg(t.hover)).cursor_pointer().on_click(close).child(glyph('close')).child('Close workspace'));
  }

  projectPicker(t) {
    const projects = this.projects();
    const choose = (project, cx) => {
      if (project) { closeOverlay(props().overlay); this.selectProject(project); }
      else this.openProject(cx);
    };
    return v_flex().id('project-picker').w_full().h(Math.min(360, 80 + projects.length * 33)).p(4)
      .rounded(8).border(1).border_color(t.border).shadow_md()
      .bg(t.popover).text_color(t.foreground).text_size(13).track_focus(this.handle)
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
      .child(div().h(28).flex_none().px(8).flex().items_center().font_medium().text_size(12).text_color(t.muted).child('Projects'))
      .child(v_flex().id('picker-projects').flex_1().min_h(0).overflow_y_scrollbar().gap(1)
        .children(projects.map((project, index) => h_flex().id(`picker-project-${project.id}`).h(32).flex_none().px(8).gap(8)
          .items_center().rounded(4).bg(this.projectIndex === index ? t.selected : t.popover)
          .tooltip(project.folder).on_hover((inside, cx) => { if (inside) { this.projectIndex = index; cx.notify(); } })
          .hover(el => el.bg(t.hover)).cursor_pointer().on_click((_event, cx) => choose(project, cx))
          .child(glyph('folder').text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(project.name))
          .child(div().size(14).flex_none().when(project.active, el => el.child(glyph('check').text_color(t.foreground)))))))
      .child(div().h(1).flex_none().my(4).bg(t.border))
      .child(h_flex().id('picker-open-folder').h(32).flex_none().px(8).gap(8).items_center().rounded(4)
        .bg(this.projectIndex === projects.length ? t.selected : t.popover).hover(el => el.bg(t.hover)).cursor_pointer()
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
    return v_flex().id('close-project-dialog').size_full().p(20).gap(16).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') cancel();
        else if (event.key === 'enter') confirm();
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(16).font_semibold().child(`Close ${target.project.name}?`))
      .child(div().flex_1().text_size(13).text_color(t.muted)
        .child('This ends every session in this workspace, including running agents. Your project files stay on disk.'))
      .child(h_flex().gap(8).justify_end().children([
        div().id('cancel-close-project').h(32).px(12).flex().items_center().rounded(6).border(1).border_color(t.input)
          .text_size(12).cursor_pointer().hover(el => el.bg(t.hover)).on_click(cancel).child('Cancel'),
        div().id('confirm-close-project').h(32).px(12).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground)
          .text_size(12).cursor_pointer().hover(el => el.opacity(0.9)).on_click(confirm).child('Close workspace'),
      ]));
  }

  newThread(cx, id) {
    const project = this.projects().find(s => id ? s.id === id : s.active);
    if (!project) { this.openProject(cx); return; }
    openOverlay({ mod: 'devkits', kind: 'popup', width: 280, height: 360,
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
    const row = (id, name, icon, action, hint) => h_flex().id(id).h(36).px(10).gap(10).items_center().rounded(6)
      .text_color(t.foreground).hover(el => el.bg(t.hover)).cursor_pointer().on_click(action).child(icon)
      .child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.muted).child(hint));
    return v_flex().id('thread-launcher').w_full().h(Math.min(460, 104 + Math.max(1, this.launchers.length) * 38))
      .p(6).gap(4).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down(event => {
        if (event.modifiers.control || event.modifiers.platform || event.modifiers.alt) return;
        const agent = /^[1-9]$/.test(event.key) ? this.launchers[Number(event.key) - 1] : null;
        if (agent?.installed) this.startThread(agent);
      })
      .child(div().px(10).py(8).text_size(11).text_color(t.muted).child('Add session'))
      .child(row('new-terminal', 'Terminal', glyph('terminal'), () => this.startThread(), ''))
      .child(div().h(1).mx(4).my(4).bg(t.border))
      .child(v_flex().id('thread-launchers').flex_1().min_h(0).overflow_y_scrollbar().gap(2)
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
      .child(h_flex().id('project-switcher').h(32).px(8).gap(6).items_center().rounded(6)
        .text_color(t.foreground).font_medium().hover(el => el.bg(t.hover)).cursor_pointer()
        .tooltip(space?.folder || 'Open a project').on_mouse_down('left', stop)
        .on_click(() => openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 280,
          at: { x: (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 280) + inset, y: 48 },
          props: { view: 'project-picker' } }))
        .child(div().max_w(220).truncate().child(space?.name || 'Open project'))
        .child(glyph('chevron-down', 12).text_color(t.muted)))
      .child(div().flex_1())
      .when(Boolean(win?.buttons), el => el
        .child(this.button('minimize', 'minus', 'Minimize', () => run('window.minimize'), t))
        .child(this.button('maximize', 'square', 'Maximize / restore', () => run('window.maximize'), t))
        .child(this.button('close-window', 'close', 'Close window', () => run('window.close'), t)));
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
      .child(this.button(`split-right-${p.pane}`, 'split-right', 'Split right', () => run('pane.split', { pane: p.pane, direction: 'right' }), t))
      .child(this.button(`split-down-${p.pane}`, 'split-down', 'Split down', () => run('pane.split', { pane: p.pane, direction: 'down' }), t))
      .child(this.button(`zoom-${p.pane}`, 'square', p.zoomed ? 'Restore pane' : 'Zoom pane', () => run('pane.zoom', { pane: p.pane }), t))
      .child(this.button(`close-${p.pane}`, 'close', 'Close pane', () => run('pane.close', { pane: p.pane }), t));
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
    return v_flex().size_full().items_center().justify_center().gap(12).bg(t.background).text_color(t.foreground)
      .child(div().size(48).flex().items_center().justify_center().rounded(10).border(1).border_color(t.border)
        .child(glyph('folder', 24).text_color(t.muted)))
      .child(div().text_size(18).font_semibold().child(project?.name || 'Project'))
      .child(div().text_size(12).text_color(t.muted).child(project?.folder || ''))
      .child(div().text_size(13).text_color(t.muted).child('Choose an agent to start your first session.'))
      .child(h_flex().id('add-first-session').mt(8).h(34).px(12).gap(8).items_center().rounded(6)
        .bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer()
        .on_click((_event, cx) => this.newThread(cx)).child(glyph('plus')).child('Add session'));
  }

  threadRow(thread, t) {
    const agent = thread.agent;
    const isFocused = thread.active;
    const p = agent?.program;
    const icon = p?.icon ? (p.tint ? svg(p.icon).size(14).text_color(t.muted) : image(p.icon).size(14)) : glyph('terminal', 14).text_color(t.muted);
    return h_flex().id(`thread-${thread.tab.id}`).h(32).flex_none().mx(6).px(8).gap(8).items_center().rounded(4)
      .bg(isFocused ? t.selected : t.chrome).hover(el => el.bg(t.hover)).cursor_pointer()
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
      .child(div().id(`close-thread-${thread.tab.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(4)
        .opacity(isFocused || this.hovered === thread.tab.id ? 1 : 0)
        .text_color(t.muted).hover(el => el.bg(t.raised).text_color(t.foreground)).cursor_pointer()
        .tooltip('Close thread').on_mouse_down('left', stop)
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
    return v_flex().id('devkits-sidebar').size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .child(v_flex().id('project-list').flex_1().min_h(0).overflow_y_scrollbar().gap(8).pt(4)
        .when(!groups.length, el => el.child(v_flex().px(16).py(28).gap(10).items_center().text_center()
          .child(div().size(40).flex().items_center().justify_center().rounded(10).border(1).border_color(t.border).bg(t.raised)
            .child(glyph('folder', 20).text_color(t.muted)))
          .child(div().text_size(13).font_medium().child('Open a project'))
          .child(div().text_size(12).text_color(t.muted).child('Choose a folder to start your workspace.'))
          .child(div().id('open-first-project').mt(4).px(12).py(7).rounded(6)
            .bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer()
            .on_click((_event, cx) => this.openProject(cx)).child('Open folder…'))))
        .children(groups.map(({ space, threads }) => v_flex().gap(1)
          .child(h_flex().id(`project-${space.id}`).h(32).px(8).gap(4).items_center().text_size(12).font_medium().cursor_pointer()
            .text_color(space.active ? t.foreground : t.muted).hover(el => el.bg(t.hover))
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
            .child(this.button(`new-thread-${space.id}`, 'plus', `Add session in ${space.name}`, (_event, cx) => {
              cx.stop_propagation(); this.newThread(cx, space.id);
            }, t).opacity(this.hoveredProject === space.id ? 1 : 0))
            .child(this.button(`project-menu-${space.id}`, 'ellipsis', `More actions for ${space.name}`, (_event, cx) => {
              cx.stop_propagation(); openOverlay({ mod: 'devkits', kind: 'popup', width: 200, height: 44,
                props: { view: 'project-menu', project: space } });
            }, t).opacity(this.hoveredProject === space.id ? 1 : 0)))
          .when(!this.folded.has(space.id), el => el.children(threads.map(thread => this.threadRow(thread, t)))
            .when(!threads.length, el => el.child(div().px(12).py(6).text_size(12).text_color(t.muted).child('No threads yet')))))))
      .child(h_flex().id('sidebar-bottom-bar').h(32).flex_none().px(4).gap(4).border_t(1).border_color(t.border).items_center()
        .child(this.button('settings', 'settings', 'Settings', () => run('app.settings'), t))
        .child(div().flex_1()));
  }
}
