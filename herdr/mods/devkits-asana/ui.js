import { div, svg } from 'gpui-kit';
import { v_flex, h_flex, Input, TextView } from 'gpui-base';
import { theme, settings } from 'herdr';
import { sourcePathKey as folderKey } from './components/task-source-model.js';
import { TaskSourceController, TaskSourceProjectPicker } from './components/task-source.js';
import { asanaSource } from './source.js';
import { previewWidthAt, statusKind, avatarColor, initials, dueLabel, relativeTime } from './components/task-source-model.js';
import { Button } from './components/button.js';
import { DialogDescription } from './components/dialog.js';
import { DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel } from './components/dropdown-menu.js';

const glyph = (name, size = 14) => svg(`mods/devkits/assets/icons/${name}.svg`).size(size).flex_none();
// Asana owns its palette; the host theme chooses only light or dark mode.
// Reference: Asana project List view (the main canvas is #1e1f21 in dark mode).
export function asanaTheme(host = theme()) {
  const color = String(host.background || '#1e1f21').replace('#', '');
  const rgb = color.length === 3 ? color.split('').map(c => parseInt(c + c, 16))
    : [0, 2, 4].map(i => parseInt(color.slice(i, i + 2), 16));
  const light = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 150;
  return light ? {
    background: '#ffffff', chrome: '#f9f8f8', popover: '#ffffff', foreground: '#1e1f21',
    muted: '#6d6e6f', hover: '#f9f8f8', selected: '#e9f2fe', border: '#edeae9', input: '#cfcbcb',
    solid: '#4573d2', solid_foreground: '#ffffff', destructive: '#c92f54',
    working: '#f1bd6c', done: '#58a182', accent: '#4573d2', project: '#a9e5e2',
  } : {
    background: '#1e1f21', chrome: '#252628', popover: '#1e1f21', foreground: '#f5f4f3',
    muted: '#a2a0a2', hover: '#363639', selected: '#2b3b55', border: '#424244', input: '#565557',
    solid: '#4573d2', solid_foreground: '#ffffff', destructive: '#f06a6a',
    working: '#f1bd6c', done: '#5da283', accent: '#a4cafe', project: '#a9e5e2',
  };
}

// Asana controls use their own geometry inside the project's Sera shell.
const asanaButton = (id, t, options = {}) => Button(id, t, options).rounded(t.appearance === 'linear' ? 999 : 6)
  .when(options.variant === 'outline', el => el.border(1).border_color(t.input));

export class AsanaProjectPicker extends TaskSourceProjectPicker {
  constructor(options = {}) { super({ ...options, source: asanaSource }); }

  render() {
    const t = asanaTheme(), current = this.getBinding(this.folder)?.gid;
    return DropdownMenuContent('asana-project-picker', 360, t).rounded(8).shadow_lg().overflow_hidden().p(8).font_family('Arial').track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === 'escape') this.close();
        else if (event.key === 'enter') this.choose(this.projects[this.index]);
        else if ((event.key === 'down' || event.key === 'up') && this.projects.length)
          this.index = (this.index + (event.key === 'down' ? 1 : this.projects.length - 1)) % this.projects.length;
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(Input.new(this.search).id('asana-project-search').accessibility_label(`Search ${this.source.name} projects`)
        .h(36).flex_none().px(10).rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(13))
      .child(DropdownMenuLabel(t).text_size(12).child('Projects'))
      .child(v_flex().id('asana-project-list').flex_1().min_h(0).overflow_y_scrollbar().gap(1)
        .children(this.projects.map((project, index) => DropdownMenuItem(`asana-project-${project.gid}`, t).rounded(4)
          .bg(this.index === index ? t.selected : t.popover)
          .on_hover((inside, cx) => { if (inside) { this.index = index; cx.notify(); } })
          .on_click(() => this.choose(project))
          .child(glyph('list-todo').text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(project.name))
          .child(div().flex_none().text_size(11).text_color(t.muted).child(project.workspace))
          .child(div().size(14).flex_none().when(project.gid === current, el => el.child(glyph('check'))))))
        .when(this.loading && !this.projects.length, el => el.child(div().p(8).text_size(12).text_color(t.muted).child('Searching…')))
        .when(Boolean(this.error), el => el.child(div().p(8).text_size(12).text_color(t.destructive || t.foreground).child(this.error)))
        .when(!this.loading && !this.error && !this.projects.length, el => el.child(div().p(8).text_size(12).text_color(t.muted).child('No matching projects.'))));
  }
}


export default class AsanaPanel extends TaskSourceController {
  constructor(options = {}) { super({ ...options, source: asanaSource }); }

  toolbar(t, close) {
    const ready = this.needsToken === false;
    const bound = this.binding();
    const toggle = (id, label, active, action) => asanaButton(id, t, { variant: 'ghost' }).h(28).px(10)
      .when(active, el => el.bg(t.selected).text_color(t.accent))
      .accessibility_label(`${label}${active ? ', selected' : ''}`)
      .on_click((_event, cx) => { action(); cx.notify(); }).child(label);
    const tab = (id, label, active, action) => div().id(id).h(36).px(4).gap(6).flex().items_center()
      .border_b(2).border_color(active ? t.muted : t.background).text_size(14)
      .text_color(active ? t.foreground : t.muted).cursor_pointer().hover(el => el.bg(t.hover))
      .accessibility_label(`${label}${active ? ', selected' : ''}`)
      .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => { action(); cx.notify(); })
      .child(glyph(label === 'List' ? 'list-todo' : 'columns-3', 14)).child(label);
    return v_flex().flex_none().bg(t.background)
      .child(h_flex().h(56).px(24).gap(12).items_center()
        .child(div().size(32).rounded(6).bg(t.project).flex().items_center().justify_center()
          .child(glyph('list-todo', 20).text_color('#1e1f21')))
        .child(DropdownMenuTrigger(asanaButton('asana-project-menu', t, { variant: 'ghost' }).h(36).px(4).gap(8).text_size(20).font_semibold().text_color(t.foreground)
          .accessibility_label(`Choose ${this.source.name} project`).disabled(!ready)
          .on_mouse_down('left', (_event, cx) => cx.stop_propagation()), 360,
          (_cx, at) => { if (ready) this.openProjectPicker?.(this.folder, at); }, 'start', { x: 0, y: 4 })
          .child(div().max_w(400).truncate().child(bound?.name || `Choose ${this.source.name} project`))
          .child(glyph('chevron-down', 14).text_color(t.muted)))
        .child(div().flex_1())
        .when(this.needsToken !== null && !this.settingsOpen, el => el.child(asanaButton('asana-settings', t, { variant: 'ghost', size: 'icon' })
          .disabled(this.tokenBusy).accessibility_label(`${this.source.name} settings`)
          .on_click((_event, cx) => this.openSettings(cx))
          .child(glyph('gear', 14))))
        .child(asanaButton('asana-close', t, { variant: 'ghost', size: 'icon' }).rounded(6).accessibility_label(`Close ${this.source.name} tasks`)
          .on_mouse_down('left', (_event, cx) => cx.stop_propagation()).on_click(close).child(glyph('close'))))
      .when(ready && Boolean(bound) && !this.settingsOpen, el => el
        .child(h_flex().h(36).px(24).gap(20).items_center().border_b(1).border_color(t.border)
          .child(tab('asana-view-list', 'List', this.view() === 'list', () => this.writeState('view', 'list')))
          .child(tab('asana-view-board', 'Board', this.view() === 'board', () => this.writeState('view', 'board'))))
        .child(h_flex().h(56).px(24).gap(8).items_center()
          .on_mouse_down('left', (_event, cx) => cx.stop_propagation()).border_b(1).border_color(t.border)
          .children([['mine', 'Mine'], ['all', 'All']].map(([value, label]) =>
            toggle(`asana-tab-${value}`, label, this.tab === value, () => { this.tab = value; this.writeState('tab', value); })))
          .child(div().flex_1())
          .child(Input.new(this.search).id('asana-search').accessibility_label('Search tasks')
            .w(200).h(30).px(10).rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12))
          ));
  }

  status(section, t, size = 14) {
    const kind = statusKind(section);
    return glyph({ done: 'circle-check', started: 'circle-half', backlog: 'circle-dashed', todo: 'circle' }[kind], size)
      .text_color(kind === 'done' ? t.done : kind === 'started' ? t.working : t.muted);
  }

  avatar(task, t, size = 18) {
    if (!task.assignee) return glyph('circle-dashed', size - 2).text_color(t.muted).accessibility_label('Unassigned');
    return div().size(size).flex_none().rounded_full().overflow_hidden().bg(avatarColor(task.assigneeGid || task.assignee))
      .flex().items_center().justify_center().accessibility_label(task.assignee)
      .child(div().text_size(Math.round(size / 2)).font_medium().text_color('#ffffff').child(initials(task.assignee)));
  }

  due(task, t) {
    const due = dueLabel(task.due);
    return div().flex_none().text_size(12).text_color(due.overdue ? t.destructive || t.ansi1 : t.muted).child(due.text);
  }

  // Asana section headings sit between ruled task groups.
  sectionLabel(group, t) {
    return h_flex().h(52).flex_none().px(24).gap(8).items_center().border_b(1).border_color(t.border)
      .child(glyph('chevron-down', 12).text_color(t.muted))
      .child(div().min_w(0).truncate().text_size(16).font_semibold().child(group.name))
      .child(div().flex_none().text_size(12).text_color(t.muted).child(String(group.tasks.length)));
  }

  // Section headers, task rows and Load more, in display order.
  listItems() {
    const nested = !this.search.value().trim();
    const items = this.groups().flatMap(group => [{ key: `section:${group.name}`, group },
      ...group.tasks.flatMap(task => [{ key: `task:${task.gid}`, task, depth: 0, section: group.name, nested },
        ...(nested && this.expanded.has(task.gid) ? (this.subtasks.get(task.gid) || []).map(sub => ({ key: `task:${sub.gid}:${task.gid}`, task: sub, depth: 1 })) : [])])]);
    if (this.tab === 'all' && this.all.next) items.push({ key: 'more' });
    return items;
  }

  // Asana's task table keeps assignees and due dates in aligned columns.
  // A plain scroll list: pages keep it to a few hundred rows, and hover then stays in GPUI instead of rebuilding rows in script each frame.
  list(t) {
    const row = item => {
      if (item.group) return this.sectionLabel(item.group, t);
      if (!item.task) return h_flex().id('asana-load-more').h(36).flex_none().px(16).gap(8).items_center().text_size(12).text_color(t.muted)
        .cursor_pointer().hover(el => el.bg(t.hover)).on_click((_event, cx) => this.more(cx))
        .child(glyph('chevron-down', 12)).child(this.loadingMore ? 'Loading…' : 'Load more tasks');
      const { task, depth } = item;
      return h_flex().id(`asana-${item.key}`).h(38).flex_none().pl(24 + depth * 22).pr(24).gap(10).items_center().border_b(1).border_color(t.border).cursor_pointer()
        .accessibility_label(task.name)
        .bg(this.selected === task.gid ? t.selected : t.background).hover(el => el.bg(this.selected === task.gid ? t.selected : t.hover))
        .on_click((_event, cx) => { this.handle.focus(); this.show(task, cx); })
        .child(glyph('circle-check', 16).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(task.name))
        .when(item.nested && task.subtasks > 0, el => el.child(h_flex().id(`asana-expand-${task.gid}`).h(20).px(6).gap(4).flex_none().items_center()
          .rounded(4).border(1).border_color(t.border).text_size(11).text_color(t.muted).cursor_pointer().hover(el => el.bg(t.hover))
          .accessibility_label(`${this.expanded.has(task.gid) ? 'Hide' : 'Show'} ${task.subtasks} subtasks`)
          .on_click((_event, cx) => { cx.stop_propagation(); this.toggleExpanded(task, cx); })
          .child(glyph(this.expanded.has(task.gid) ? 'chevron-down' : 'chevron-right', 10)).child(String(task.subtasks))))
        .when(Boolean(task.parent) && !depth, el => el.child(div().flex_none().max_w(200).truncate().text_size(12).text_color(t.muted).child(`↳ ${task.parent}`)))
        .child(h_flex().w(120).h_full().pl(12).border_l(1).border_color(t.border).flex_none().items_center().child(this.avatar(task, t, 24)))
        .child(h_flex().w(120).h_full().pl(12).border_l(1).border_color(t.border).flex_none().items_center().child(this.due(task, t)));
    };
    return v_flex().id('asana-list').flex_1().min_h(0)
      .child(h_flex().h(34).px(24).gap(10).flex_none().items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(div().flex_1().child('Task name'))
        .child(div().w(120).h_full().pl(12).border_l(1).border_color(t.border).flex_none().flex().items_center().child('Assignee'))
        .child(div().w(120).h_full().pl(12).border_l(1).border_color(t.border).flex_none().flex().items_center().child('Due date')))
      .child(v_flex().id('asana-list-rows').flex_1().min_h(0).overflow_y_scrollbar().children(this.listItems().map(row)));
  }

  board(t) {
    return h_flex().id('asana-board').flex_1().min_h(0).overflow_x_scrollbar().bg(t.chrome).p(24).gap(16)
      .children(this.groups().map(group => v_flex().w(300).flex_none().h_full().min_h(0)
        .child(h_flex().h(40).flex_none().px(4).gap(8).items_center()
          .child(this.status(group.name, t))
          .child(div().text_size(12).font_medium().child(group.name))
          .child(div().text_size(12).text_color(t.muted).child(String(group.tasks.length))))
        .child(v_flex().id(`asana-column-${group.name}`).flex_1().min_h(0).overflow_y_scrollbar().gap(8)
          .children(group.tasks.map(task => v_flex().id(`asana-card-${task.gid}`).flex_none().p(16).gap(12).rounded(8).cursor_pointer()
            .bg(this.selected === task.gid ? t.selected : t.background).border(1).border_color(this.selected === task.gid ? t.solid : t.border)
            .hover(el => el.border_color(t.solid)).accessibility_label(task.name)
            .on_click((_event, cx) => { this.handle.focus(); this.show(task, cx); })
            .when(Boolean(task.parent), el => el.child(div().truncate().text_size(11).text_color(t.muted).child(`↳ ${task.parent}`)))
            .child(div().text_size(13).font_medium().child(task.name))
            .child(h_flex().gap(8).items_center()
              .child(this.status(group.name, t, 12))
              .when(task.subtasks > 0, el => el.child(h_flex().h(20).px(6).items_center().rounded(4).border(1).border_color(t.border)
                .text_size(11).text_color(t.muted).child(`${task.subtasks} subtasks`)))
              .child(div().flex_1())
              .child(this.due(task, t))
              .child(this.avatar(task, t))))))))
      .when(this.tab === 'all' && Boolean(this.all.next), el => el.child(asanaButton('asana-load-more', t, { variant: 'outline' }).flex_none()
        .on_click((_event, cx) => this.more(cx)).child(this.loadingMore ? 'Loading…' : 'Load more tasks')));
  }

  connect(t, close) {
    const back = cx => { this.settingsOpen = false; this.tokenInput.set_value(''); this.error = null; cx.notify(); };
    return v_flex().flex_1().max_w(560).p(32).gap(16)
      .when(Boolean(this.token), el => el.child(h_flex().child(asanaButton('asana-settings-back', t, { variant: 'ghost' }).gap(6).disabled(this.tokenBusy)
        .on_click((_event, cx) => back(cx)).child(glyph('chevron-left', 14)).child('Back to tasks'))))
      .child(div().text_size(24).font_semibold().child(`${this.source.name} settings`))
      .when(Boolean(this.source.server), el => el
        .child(div().text_size(14).font_medium().child('Server URL'))
        .child(Input.new(this.serverInput).id('source-server').accessibility_label(`${this.source.name} server URL`)
          .w_full().h(36).px(10).rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(13)))
      .child(div().text_size(14).font_medium().child('Personal access token'))
      .child(DialogDescription(t).child(this.token ? 'Your saved token is masked below. Replace it to change accounts, or clear it below.'
        : this.source.tokenHelp))
      .child(h_flex().gap(8).items_center()
        .child(Input.new(this.tokenInput).id('asana-token').accessibility_label(`${this.source.name} personal access token`)
        .flex_1().min_w(0).h(36).px(10).rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(13))
        .child(asanaButton('asana-copy-token', t, { variant: 'outline' }).w(80).h(36).disabled(!this.tokenInput.value().trim())
          .accessibility_label('Copy personal access token').on_click((_event, cx) => this.copyToken(cx))
          .child(this.tokenCopied ? 'Copied' : 'Copy')))
      .when(Boolean(this.error), el => el.child(div().id('asana-error').text_size(12).text_color(t.destructive).child(this.error)))
      .child(h_flex().gap(8)
        .child(asanaButton('asana-save-token', t).disabled(this.tokenBusy).on_click((_event, cx) => this.saveToken(cx)).child(this.tokenBusy ? 'Saving…' : this.token ? 'Save token' : 'Connect'))
        .child(asanaButton('asana-cancel-token', t, { variant: 'outline' }).disabled(this.tokenBusy)
          .on_click((_event, cx) => this.token ? back(cx) : close()).child('Cancel'))
        .when(Boolean(this.token), el => el.child(asanaButton('asana-clear-token', t, { variant: 'outline' }).text_color(t.destructive)
          .disabled(this.tokenBusy).on_click((_event, cx) => this.clearToken(cx)).child('Clear saved token'))));
  }

  // Asana's task detail pane, with properties followed by description and activity.
  preview(t, importTask) {
    const task = this.detail;
    const subtasks = task ? this.subtasks.get(task.gid) : null;
    const width = this.previewWidth();
    const property = (label, value) => h_flex().h(36).gap(12).items_center()
      .child(div().w(112).flex_none().text_size(12).text_color(t.muted).child(label))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center().text_size(13).children([].concat(value)));
    return v_flex().id('asana-preview').when(Boolean(width), el => el.w(width).flex_none()).when(!width, el => el.flex_1().min_w(0))
      .min_h(0).h_full().bg(t.background).border_l(1).border_color(t.border)
      .child(h_flex().h(48).flex_none().pl(16).pr(8).gap(6).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().text_color(t.muted)
          .child(div().flex_none().max_w(160).truncate().child(this.binding()?.name || this.source.name))
          .when(Boolean(task?.parent), el => el.child('›').child(div().id('asana-parent-crumb').min_w(0).truncate().cursor_pointer()
            .hover(el => el.text_color(t.foreground)).on_click((_event, cx) => this.show(task.parent, cx)).child(task.parent.name))))
        .when(Boolean(task), el => el
          .child(asanaButton('asana-open', t, { variant: 'ghost' }).h(28).px(8).accessibility_label(`Open in ${this.source.name}`)
            .on_click((_event, cx) => cx.open_url(task.url)).child(`Open in ${this.source.name}`)))
        .child(asanaButton('asana-close-preview', t, { variant: 'ghost', size: 'icon' }).accessibility_label('Close preview')
          .on_click((_event, cx) => { this.selected = null; this.detail = null; cx.notify(); }).child(glyph('close'))))
      .child(v_flex().id(`asana-preview-${this.selected}`).flex_1().min_h(0).overflow_y_scrollbar().px(32).py(28).gap(24)
        .when(!task, el => el.child(div().text_size(13).text_color(this.detailError ? t.destructive || t.foreground : t.muted)
          .child(this.detailError || 'Loading…')))
        .when(Boolean(task), el => el
          .child(div().text_size(24).font_semibold().line_height('32px').child(task.name))
          .child(v_flex().gap(2)
            .child(property('Status', [this.status(task.section, t), div().child(task.section || 'No section')]))
            .child(property('Assignee', [this.avatar(task, t), div().text_color(task.assignee ? t.foreground : t.muted).child(task.assignee || 'Unassigned')]))
            .child(property('Due date', task.due ? this.due(task, t).text_size(13) : div().text_color(t.muted).child('No due date'))))
          .child(div().text_size(12).text_color(t.muted).child('Description'))
          .child(task.notes.trim() ? TextView.markdown(`asana-notes-${task.gid}`, task.notes).selectable(true).scrollable(false).w_full()
            : div().text_size(13).text_color(t.muted).child('No description.'))
          .when(task.subtasks > 0, el => el.child(v_flex().gap(4)
            .child(h_flex().gap(8).items_center().text_size(13).font_medium()
              .child('Subtasks').child(div().text_color(t.muted).font_normal().child(String(task.subtasks))))
            .child(v_flex().rounded(6).overflow_hidden().border(1).border_color(t.border)
              .when(!subtasks, el => el.child(div().p(12).text_size(12).text_color(t.muted).child('Loading…')))
              .children((subtasks || []).map((sub, index) => h_flex().id(`asana-subtask-${sub.gid}`).h(36).flex_none().px(12).gap(10).items_center()
                .when(index > 0, el => el.border_t(1).border_color(t.border))
                .cursor_pointer().hover(el => el.bg(t.hover))
                .on_click((_event, cx) => this.show(sub, cx))
                .child(this.status(null, t))
                .child(div().flex_1().min_w(0).truncate().text_size(13).child(sub.name))
                .child(this.due(sub, t))
                .child(this.avatar(sub, t)))))))
          .child(v_flex().gap(12)
            .child(h_flex().gap(8).items_center().text_size(13).font_medium()
              .child('Activity').when(Boolean(task.comments?.length), el => el.child(div().text_color(t.muted).font_normal().child(String(task.comments.length)))))
            .when(!task.comments, el => el.child(div().text_size(12).text_color(t.muted).child('Loading comments…')))
            .when(Boolean(task.commentsError), el => el.child(div().text_size(12).text_color(t.destructive || t.foreground).child(task.commentsError)))
            .when(Boolean(task.comments) && !task.comments.length && !task.commentsError, el => el.child(div().text_size(12).text_color(t.muted).child('No comments.')))
            .children((task.comments || []).map(comment => h_flex().id(`asana-comment-${comment.gid}`).gap(10).items_start()
              .child(this.avatar({ assignee: comment.author, assigneeGid: comment.authorGid }, t, 22))
              .child(v_flex().flex_1().min_w(0).gap(4)
                .child(h_flex().gap(8).items_center().text_size(12)
                  .child(div().font_medium().child(comment.author))
                  .child(div().text_color(t.muted).child(relativeTime(comment.at))))
                .child(TextView.markdown(`asana-comment-text-${comment.gid}`, comment.text).selectable(true).scrollable(false).w_full())))))))
      .when(Boolean(task), el => el.child(v_flex().flex_none().p(12).gap(8).border_t(1).border_color(t.border).bg(t.chrome)
        .child(h_flex().items_center().justify_end()
          .child(asanaButton('asana-import', t).h(28).px(10).accessibility_label(this.importLabel)
            .disabled(!this.onImport || (!task.comments && !task.commentsError))
            .on_click(() => importTask(task)).child(this.importLabel)))));
  }

  panel(project, importTask, close, cx) {
    if (this.folder !== (project?.folder || null)) this.open(project, cx);
    this.sync(cx);
    // A thread's Asana link asks for its task; the preview shows it once the token is known.
    const focus = this.readState('focus');
    if (focus && this.needsToken === false && folderKey(focus.folder) === folderKey(this.folder)) {
      this.writeState('focus', null);
      if (this.selected !== focus.gid) this.show({ gid: focus.gid }, cx);
    }
    const t = asanaTheme();
    const ready = this.needsToken === false && !this.settingsOpen, bound = Boolean(this.binding());
    const rows = ready && bound ? this.rows() : [];
    const empty = !bound ? `Choose the ${this.source.name} project for this project from the menu above.`
      : this.search.value().trim() ? 'No matching tasks.' : this.tab === 'mine' ? 'No open tasks assigned to you in this project.' : 'No open tasks in this project.';
    const status = text => div().p(12).text_size(12).text_color(t.muted).child(text);
    const stopResize = () => {
      if (!this.resizing) return;
      this.resizing = false;
      if (this.width) this.writeState('preview-width', this.width);
    };
    return v_flex().id('asana-panel').size_full().min_h(0).rounded(10).shadow_xl().overflow_hidden().font_family('Arial').border(1).border_color(t.border).bg(t.background).text_color(t.foreground)
      .on_mouse_down('right', (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => cx.stop_propagation())
      .on_scroll_wheel((_event, cx) => cx.stop_propagation())
      .when(Boolean(this.resizing), el => el.cursor_col_resize())
      .on_mouse_move((event, cx) => {
        if (!this.resizing) return;
        this.width = previewWidthAt(event.bounds, event.position.x, settings().zoom || 1);
        cx.notify();
      })
      .on_mouse_up('left', (_event, cx) => { stopResize(); cx.notify(); })
      .on_hover((inside, cx) => { if (!inside) { stopResize(); cx.notify(); } })
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (!this.settingsOpen && this.needsToken === false) this.navigate(event, cx);
      })
      .child(this.toolbar(t, close))
      .child(h_flex().flex_1().min_h(0)
        .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
        .child(v_flex().flex_1().min_w(0).min_h(0).h_full()
          .when(this.needsToken === null || (this.loading && !this.settingsOpen), el => el.child(status('Loading…')))
          .when(this.needsToken === true || this.settingsOpen, el => el.child(this.connect(t, close)))
          .when(ready && Boolean(this.error), el => el.child(div().id('asana-error').p(12).text_size(12)
            .text_color(t.destructive || t.foreground).child(this.error)))
          .when(ready && !this.loading && !this.error && !rows.length, el => el.child(status(empty)))
          .when(ready && bound && rows.length > 0, el => el.child(this.view() === 'board' ? this.board(t) : this.list(t))))
        .when(Boolean(this.selected) && ready, el => el
          .child(div().id('asana-resize').w(4).h_full().flex_none().cursor_col_resize()
            .bg(this.resizing ? t.border : t.background).hover(el => el.bg(t.border))
            .accessibility_label('Resize preview')
            .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); this.width = this.previewWidth(); this.resizing = true; cx.notify(); }))
          .child(this.preview(t, importTask))));
  }

  // The tasks and the preview split the space evenly until the divider is dragged; the dragged width is remembered.
  previewWidth() {
    return this.resizing ? this.width : this.readState('preview-width') || null;
  }
}
