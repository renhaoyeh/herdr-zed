import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, Input, InputState } from 'gpui-base';
import { TaskSourceController, TaskSourceProjectPicker } from './components/task-source.js';
import { mantisSource } from './source.js';
import { Button } from './components/button.js';
import { DropdownMenuTrigger } from './components/dropdown-menu.js';

// Measured from the bundled MantisBT 2.28 web UI (Ace compact sidebar).
export const mantisTheme = {
  background: '#ffffff', foreground: '#393939', muted: '#555555', border: '#d5d5d5',
  navbar: '#404040', sidebar: '#dbdbdb', sidebarRow: '#e4e4e4',
  solid: '#428bca', solid_foreground: '#ffffff', accent: '#337ab7',
  widget: '#5090c1', breadcrumb: '#e7f2f8', category: '#edf3f4',
  hover: '#eff4f7', selected: '#e7f2f8', row: '#f8f8f8', popover: '#ffffff', input: '#d5d5d5',
  destructive: '#a94442',
};
const statusColors = { new: '#fcbdbd', feedback: '#e3b7eb', acknowledged: '#ffcd85', confirmed: '#fff494',
  assigned: '#c2dfff', resolved: '#d2f5b0', closed: '#c9ccc4' };
export const issueNumber = gid => String(gid || '').padStart(7, '0');
export const statusColor = task => statusColors[task.statusName] || statusColors[String(task.section || '').toLowerCase()] || '#e4e4e4';
const glyph = (name, size = 14) => svg(`mods/devkits/assets/icons/${name}.svg`).size(size).flex_none();
const date = (value, time = false) => value ? value.slice(0, time ? 16 : 10).replace('T', ' ') : '—';
const button = (id, label, action, { primary = false, icon, disabled = false } = {}) => Button(id, mantisTheme, { variant: primary ? 'default' : 'outline' })
  .h(30).px(10).gap(5).rounded(3).border(1).border_color(primary ? mantisTheme.solid : '#8fbce3')
  .bg(primary ? mantisTheme.solid : '#ffffff').text_color(primary ? '#ffffff' : mantisTheme.accent).text_size(13)
  .disabled(disabled).accessibility_label(label).on_click(action)
  .when(Boolean(icon), el => el.child(glyph(icon))).child(label);
const field = (state, id, label) => Input.new(state).id(id).accessibility_label(label).h(30).px(6)
  .rounded(0).border(1).border_color(mantisTheme.input).bg('#ffffff').text_color(mantisTheme.foreground).text_size(13);
const widgetHeader = (id, title, icon = 'list-todo') => h_flex().id(id).h(32).flex_none().px(10).gap(6).items_center()
  .bg(mantisTheme.widget).text_color('#ffffff').text_size(18).child(glyph(icon, 16)).child(title);
const widget = () => v_flex().flex_none().border(1).border_color(mantisTheme.widget).bg('#ffffff');
const cell = (value, width, header = false) => div().when(Boolean(width), el => el.w(width).flex_none())
  .when(!width, el => el.flex_1().min_w(0)).h_full().px(8).flex().items_center().truncate()
  .text_color(header ? mantisTheme.accent : mantisTheme.foreground).when(header, el => el.font_semibold()).child(value || '—');

export class MantisProjectPicker extends TaskSourceProjectPicker {
  constructor(options = {}) { super({ ...options, source: mantisSource }); }

  render() {
    return v_flex().id('mantis-project-picker').w_full().h(360).p(4).gap(4).border(1).border_color(mantisTheme.border)
      .bg('#ffffff').text_color(mantisTheme.foreground).font_family('Open Sans').text_size(13).track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === 'escape') this.close();
        else if (event.key === 'enter') this.choose(this.projects[this.index]);
        else if ((event.key === 'down' || event.key === 'up') && this.projects.length)
          this.index = (this.index + (event.key === 'down' ? 1 : this.projects.length - 1)) % this.projects.length;
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(field(this.search, 'mantis-project-search', 'Search MantisBT projects').w_full())
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(this.projects.map((project, index) => h_flex().id(`mantis-project-${project.gid}`).h(32).px(8).gap(8).items_center()
          .bg(this.index === index ? mantisTheme.selected : '#ffffff').hover(el => el.bg(mantisTheme.hover)).cursor_pointer()
          .on_hover((inside, cx) => { if (inside) { this.index = index; cx.notify(); } })
          .on_click(() => this.choose(project)).child(glyph('folder')).child(project.name)))
        .when(this.loading && !this.projects.length, el => el.child(div().p(8).child('Loading projects…')))
        .when(Boolean(this.error), el => el.child(div().p(8).text_color(mantisTheme.destructive).child(this.error)))
        .when(!this.loading && !this.error && !this.projects.length, el => el.child(div().p(8).child('No matching projects.'))));
  }
}

export default class MantisPanel extends TaskSourceController {
  constructor(options = {}) { super({ ...options, source: mantisSource }); }

  init(cx) {
    super.init(cx);
    this.tab = 'all';
    this.statusFilter = null;
    this.filtersOpen = false;
    this.issueSearch = InputState.new({ placeholder: 'Search' });
    this.issueSearch.on('change', (_event, cx) => cx.notify());
  }

  reset() { super.reset(); this.statusFilter = null; }

  open(project, cx) {
    super.open(project, cx);
    this.statusFilter = null;
    this.issueSearch.set_value('');
  }

  view() { return 'list'; }
  rows() { return this.issueTasks().map(task => ({ task, depth: 0 })); }
  issueTasks() {
    const words = this.issueSearch.value().toLowerCase().split(/\s+/).filter(Boolean);
    return (this.tab === 'mine' ? this.mine || [] : this.all.tasks).filter(task =>
      (!this.statusFilter || task.section === this.statusFilter) && words.every(word =>
        [task.name, issueNumber(task.gid), task.section, task.assignee, task.category].filter(Boolean).join(' ').toLowerCase().includes(word)));
  }
  chooseView(tab, cx) {
    this.tab = tab; this.writeState('tab', tab);
    this.settingsOpen = false; this.selected = null; this.detail = null; this.detailRequest = null;
    this.handle.focus(); cx.notify();
  }
  back(cx) { this.selected = null; this.detail = null; this.detailRequest = null; cx.notify(); }

  navbar(close) {
    const ready = this.needsToken === false, bound = this.binding();
    return h_flex().h(45).flex_none().items_center().bg(mantisTheme.navbar).text_color('#ffffff')
      .child(div().w(125).flex_none().pl(15).text_size(18).child('MantisBT'))
      .child(div().flex_1())
      .child(DropdownMenuTrigger(Button('mantis-project-menu', mantisTheme, { variant: 'ghost' }).h(45).px(14).rounded(0).gap(8)
        .text_color('#ffffff').bg('#555555').accessibility_label('Choose MantisBT project').disabled(!ready)
        .child(div().max_w(320).truncate().child(bound?.name || 'Select Project')).child(glyph('chevron-down', 12)), 360,
      (_cx, at) => { if (ready) this.openProjectPicker?.(this.folder, at); }, 'end', { x: 0, y: 0 }))
      .child(Button('mantis-close', mantisTheme, { variant: 'ghost', size: 'icon' }).size(45).rounded(0).text_color('#ffffff')
        .accessibility_label('Close MantisBT tasks').on_click(close).child(glyph('close', 16)));
  }

  sidebar() {
    const nav = (id, label, icon, active, action) => Button(id, mantisTheme, { variant: 'ghost' }).w_full().h(60).flex_none().flex_col().gap(4).items_center().justify_center()
      .border_b(1).border_l(3).border_color(active ? mantisTheme.widget : '#ffffff')
      .bg(active ? '#f4faff' : mantisTheme.sidebarRow).text_color(active ? mantisTheme.widget : '#555555')
      .hover(el => el.bg('#ffffff').text_color(active ? mantisTheme.widget : '#555555')).cursor_pointer()
      .accessibility_label(label).disabled(this.tokenBusy).on_click(action)
      .child(glyph(icon, 20)).child(div().text_size(13).when(active, el => el.font_semibold()).child(label));
    return v_flex().w(125).h_full().flex_none().border_r(1).border_color('#a9c7df').bg(mantisTheme.sidebar)
      .child(nav('mantis-my-view', 'My View', 'house', !this.settingsOpen && this.needsToken === false && this.tab === 'mine', (_event, cx) => this.chooseView('mine', cx)))
      .child(nav('mantis-view-issues', 'View Issues', 'list-todo', !this.settingsOpen && this.needsToken === false && this.tab === 'all', (_event, cx) => this.chooseView('all', cx)))
      .child(nav('mantis-account', 'My Account', 'gear', Boolean(this.settingsOpen) || this.needsToken === true, (_event, cx) => this.openSettings(cx)));
  }

  filters() {
    const tasks = this.tab === 'mine' ? this.mine || [] : this.all.tasks;
    const sections = [...new Set(tasks.map(task => task.section))];
    return widget().id('mantis-filters').mb(22)
      .child(widgetHeader('mantis-filters-header', `Filters${this.statusFilter ? `: ${this.statusFilter}` : ''}`, 'list-todo')
        .child(div().flex_1())
        .child(field(this.issueSearch, 'mantis-search', 'Search MantisBT issues').w(190).h(24))
        .child(Button('mantis-toggle-filters', mantisTheme, { variant: 'ghost', size: 'icon' }).size(28).rounded(0).text_color('#ffffff')
          .accessibility_label(this.filtersOpen ? 'Collapse filters' : 'Expand filters')
          .on_click((_event, cx) => { this.filtersOpen = !this.filtersOpen; cx.notify(); }).child(glyph(this.filtersOpen ? 'chevron-down' : 'chevron-right', 16))))
      .when(this.filtersOpen, el => el.child(h_flex().min_h(48).p(8).gap(6).items_center().flex_wrap()
        .child(div().px(8).font_semibold().child('Status'))
        .children([null, ...sections].map(section => button(`mantis-filter-${section || 'all'}`, section || '[any]', (_event, cx) => {
          this.statusFilter = section; cx.notify();
        }, { primary: this.statusFilter === section })))));
  }

  issueList(cx) {
    const tasks = this.issueTasks();
    const loading = this.tab === 'mine' ? this.loading : this.loadingMore;
    const loaded = this.tab === 'mine' ? this.mine !== null : this.all.loaded;
    const header = h_flex().h(30).flex_none().items_center().bg('#f1f1f1').border_b(1).border_color(mantisTheme.border)
      .child(cell('P', 38, true)).child(cell('ID', 82, true)).child(cell('#', 34, true)).child(cell('Category', 92, true))
      .child(cell('Severity', 80, true)).child(cell('Status', 190, true)).child(cell('Updated', 104, true)).child(cell('Summary', null, true));
    const row = (task, index) => h_flex().id(`mantis-issue-${task.gid}`).h(34).flex_none().items_center()
      .bg(index % 2 ? '#ffffff' : mantisTheme.row).border_b(1).border_color('#dddddd').hover(el => el.bg(mantisTheme.selected)).cursor_pointer()
      .accessibility_label(`${issueNumber(task.gid)}: ${task.name}`).on_click((_event, cx) => this.show(task, cx))
      .child(cell(div().w(12).h(3).bg(task.priorityId >= 40 ? '#dd5a43' : '#ffb900'), 38))
      .child(cell(div().id(`mantis-issue-number-${task.gid}`).text_color(mantisTheme.accent).hover(el => el.underline()).child(issueNumber(task.gid)), 82))
      .child(cell(task.noteCount ? String(task.noteCount) : ' ', 34)).child(cell(task.category, 92)).child(cell(task.severity, 80))
      .child(cell(h_flex().gap(5).items_center().min_w(0).child(div().size(18).rounded(3).flex_none().bg(statusColor(task)))
        .child(div().truncate().text_color(mantisTheme.accent).child(`${task.section}${task.assignee ? ` (${task.assigneeLogin || task.assignee})` : ''}`)), 190))
      .child(cell(date(task.updatedAt), 104)).child(cell(div().id(`mantis-issue-summary-${task.gid}`).text_color(mantisTheme.accent).truncate().hover(el => el.underline()).child(task.name)));
    return widget().id('mantis-issues')
      .child(widgetHeader('mantis-issues-header', this.tab === 'mine' ? 'Assigned to Me' : 'Viewing Issues', 'columns-3')
        .child(div().px(9).rounded(10).bg('#aabac3').text_size(12).child(`${tasks.length ? '1' : '0'} - ${tasks.length}${this.tab === 'all' && this.all.next ? ' +' : ''}`)))
      .child(v_flex().min_w(820).child(header).children(tasks.map(row)))
      .when(loading, el => el.child(div().p(12).text_color(mantisTheme.muted).child(this.tab === 'mine'
        ? 'Loading issues assigned to you…' : this.all.loaded ? 'Loading more issues…' : 'Loading issues…')))
      .when(!tasks.length && loaded && !loading && !this.error, el => el.child(div().p(18).text_color(mantisTheme.muted).child(this.issueSearch.value() || this.statusFilter
        ? 'No loaded issues match the current filter.' : this.tab === 'mine' ? 'No open issues assigned to you.'
          : this.all.next ? 'No open issues on the loaded pages. Load more issues to continue.' : 'No open issues in this project.')))
      .when(this.tab === 'all' && Boolean(this.all.next), el => el.child(h_flex().p(8).bg('#eeeeee')
        .child(button('mantis-more', this.loadingMore ? 'Loading…' : 'Load more issues', (_event, cx) => this.more(cx), { disabled: this.loadingMore }))));
  }

  detailPage(importTask) {
    const task = this.detail;
    const label = value => div().w(145).flex_none().h_full().px(10).py(8).bg(mantisTheme.category).font_semibold().child(value);
    const property = (name, value) => h_flex().flex_1().min_w(0).min_h(36).border_b(1).border_color('#dddddd')
      .child(label(name)).child(div().flex_1().min_w(0).px(10).py(8).child(value || '—'));
    const full = (name, value) => h_flex().min_h(38).border_b(1).border_color('#dddddd').items_stretch()
      .child(label(name)).child(div().flex_1().min_w(0).px(10).py(10).child(value || '—'));
    const metadataCell = (value, heading = false) => div().flex_1().min_w(0).h_full().px(6).flex().items_center().truncate()
      .when(heading, el => el.bg(mantisTheme.category).font_semibold())
      .when(!heading, el => el.text_color(mantisTheme.accent)).child(value || '—');
    const status = issue => h_flex().gap(6).items_center().child(div().size(18).rounded(3).bg(statusColor(issue))).child(issue.section);
    if (!task) return widget().child(widgetHeader('mantis-detail-header', 'View Issue Details'))
      .child(div().p(20).text_color(this.detailError ? mantisTheme.destructive : mantisTheme.muted).child(this.detailError || 'Loading issue…'));
    const children = this.subtasks.get(task.gid);
    return v_flex().gap(22)
      .child(widget().id('mantis-detail')
        .child(widgetHeader('mantis-detail-header', 'View Issue Details')
          .child(div().flex_1()).child(button('mantis-open', 'Open in MantisBT', (_event, cx) => cx.open_url(task.url), { icon: 'external-link' })))
        .child(h_flex().h(30).border_b(1).border_color('#dddddd')
          .children(['ID', 'Project', 'Category', 'View Status', 'Date Submitted', 'Last Update'].map(title => metadataCell(title, true))))
        .child(h_flex().h(30).mb(8).border_b(1).border_color('#dddddd')
          .children([issueNumber(task.gid), task.projectName || this.binding()?.name, task.category, task.viewStatus,
            date(task.createdAt, true), date(task.updatedAt, true)].map(value => metadataCell(value))))
        .child(h_flex().child(property('Reporter', task.reporter)).child(property('Assigned To', task.assigneeLogin || task.assignee || '—')).child(property('Due Date', date(task.due))))
        .child(h_flex().child(property('Priority', task.priority)).child(property('Severity', task.severity)).child(property('Reproducibility', task.reproducibility)))
        .child(h_flex().mb(8).child(property('Status', status(task))).child(property('Resolution', task.resolution))
          .child(div().flex_1().border_b(1).border_color('#dddddd')))
        .child(full('Summary', div().font_semibold().child(`${issueNumber(task.gid)}: ${task.name}`)))
        .child(full('Description', task.notes || 'No description.'))
        .child(full('Tags', task.tags?.join(', ') || 'No tags attached.'))
        .child(h_flex().p(10).justify_end().bg('#f5f5f5')
          .child(button('mantis-import', this.importLabel, () => importTask(task), { primary: true, icon: 'plus', disabled: !this.onImport || (!task.comments && !task.commentsError) }))))
      .when(Boolean(task.parent) || task.subtasks > 0, el => el.child(widget().id('mantis-relationships')
        .child(widgetHeader('mantis-relationships-header', 'Relationships', 'list-tree'))
        .when(task.subtasks > 0 && !children, el => el.child(div().p(12).child('Loading relationships…')))
        .children([...(task.parent ? [{ ...task.parent, relation: 'child of' }] : []), ...(children || []).map(child => ({ ...child, relation: 'parent of' }))]
          .map(related => h_flex().id(`mantis-related-${related.gid}`).min_h(36).items_center().border_b(1).border_color('#dddddd').hover(el => el.bg(mantisTheme.hover)).cursor_pointer()
            .on_click((_event, cx) => this.show(related, cx)).child(cell(related.relation, 100))
            .child(cell(div().id(`mantis-related-number-${related.gid}`).text_color(mantisTheme.accent).hover(el => el.underline()).child(issueNumber(related.gid)), 90))
            .child(cell(related.section ? status(related) : '—', 160)).child(cell(related.assigneeLogin || related.assignee, 150))
            .child(cell(div().id(`mantis-related-summary-${related.gid}`).text_color(mantisTheme.accent).hover(el => el.underline()).child(related.name)))))))
      .child(widget().id('mantis-activities').child(widgetHeader('mantis-activities-header', 'Activities', 'clock'))
        .when(Boolean(task.commentsError), el => el.child(div().p(12).text_color(mantisTheme.destructive).child(task.commentsError)))
        .when(!task.comments?.length && !task.commentsError, el => el.child(div().p(12).child('No notes.')))
        .children((task.comments || []).map(comment => h_flex().id(`mantis-note-${comment.gid}`).min_h(90).border_b(1).border_color('#dddddd')
          .child(v_flex().w(185).flex_none().p(12).gap(8).bg('#edf3f4').text_color(mantisTheme.accent)
            .child(h_flex().gap(6).items_center().child(glyph('agent')).child(comment.authorLogin || comment.author))
            .child(div().text_size(12).text_color(mantisTheme.muted).child(date(comment.at, true)))
            .child(div().text_size(12).child(`~${issueNumber(comment.gid)}`)))
          .child(div().flex_1().min_w(0).p(12).bg('#e8e8e8').child(comment.text)))));
  }

  connectionPage(close) {
    const back = cx => { this.settingsOpen = false; this.tokenInput.set_value(''); this.error = null; cx.notify(); };
    const row = (title, content) => h_flex().min_h(52).border_b(1).border_color('#dddddd')
      .child(div().w(180).flex_none().px(12).py(16).bg(mantisTheme.category).font_semibold().child(title))
      .child(div().flex_1().min_w(0).p(12).child(content));
    return widget().id('mantis-connection').child(widgetHeader('mantis-account-header', 'My Account — API Tokens', 'gear'))
      .child(row('Server URL', field(this.serverInput, 'mantis-server', 'MantisBT server URL').w_full()))
      .child(row('API Token', h_flex().gap(8).items_center()
        .child(field(this.tokenInput, 'mantis-token', 'MantisBT personal access token').flex_1().min_w(0))
        .child(button('mantis-copy-token', this.tokenCopied ? 'Copied' : 'Copy', (_event, cx) => this.copyToken(cx), { disabled: !this.tokenInput.value().trim() }))))
      .child(div().p(12).child('Create an API Token in MantisBT → My Account → API Tokens. Save keeps your settings even if the connection fails.'))
      .when(Boolean(this.error), el => el.child(div().p(12).text_color(mantisTheme.destructive).child(this.error)))
      .child(h_flex().p(12).gap(8).bg('#eeeeee')
        .child(button('mantis-save-token', this.tokenBusy ? 'Saving…' : 'Save', (_event, cx) => this.saveToken(cx), { primary: true, disabled: this.tokenBusy }))
        .child(button('mantis-cancel-token', 'Cancel', (_event, cx) => this.token ? back(cx) : close(), { disabled: this.tokenBusy }))
        .when(Boolean(this.token), el => el.child(button('mantis-clear-token', 'Clear saved token', (_event, cx) => this.clearToken(cx), { disabled: this.tokenBusy }))));
  }

  panel(project, importTask, close, cx) {
    if (this.folder !== (project?.folder || null)) this.open(project, cx);
    this.sync(cx);
    const ready = this.needsToken === false && !this.settingsOpen;
    return v_flex().id('mantis-panel').size_full().min_h(0).overflow_hidden().font_family('Open Sans').text_size(13)
      .bg('#ffffff').text_color(mantisTheme.foreground).border(1).border_color('#b7b7b7').track_focus(this.handle)
      .on_mouse_down('right', (_event, cx) => cx.stop_propagation()).on_click((_event, cx) => cx.stop_propagation())
      .on_scroll_wheel((_event, cx) => cx.stop_propagation())
      .on_key_down((event, cx) => {
        if (event.key === 'escape' && this.selected) { this.back(cx); cx.stop_propagation(); }
        else if (ready && !this.selected) this.navigate(event, cx);
      })
      .child(this.navbar(close))
      .child(h_flex().flex_1().min_h(0).items_stretch().child(this.sidebar())
        .child(v_flex().flex_1().h_full().min_w(0).min_h(0).p(8).gap(10)
          .child(h_flex().h(41).flex_none().px(16).gap(8).items_center().bg(mantisTheme.breadcrumb).text_color(mantisTheme.accent)
            .child(glyph('folder', 16)).child(this.binding()?.name || project?.name || 'MantisBT')
            .child(div().text_color(mantisTheme.muted).child('/'))
            .child(this.settingsOpen || this.needsToken ? 'My Account' : this.selected ? 'View Issue Details' : this.tab === 'mine' ? 'My View' : 'View Issues')
            .child(div().flex_1())
            .when(Boolean(this.selected) && ready, el => el.child(button('mantis-back', 'Back to issues', (_event, cx) => this.back(cx), { icon: 'chevron-left' }))))
          .child(v_flex().id('mantis-page-content').flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(16)
            .when(this.needsToken === null, el => el.child(div().p(12).child('Loading connection…')))
            .when(this.needsToken === true || this.settingsOpen, el => el.child(this.connectionPage(close)))
            .when(ready && Boolean(this.error), el => el.child(div().p(12).text_color(mantisTheme.destructive).child(this.error)))
            .when(ready && !this.binding(), el => el.child(widget().child(widgetHeader('mantis-select-project', 'Select Project', 'folder'))
              .child(div().p(18).child('Select a MantisBT project from the project menu.'))))
            .when(ready && Boolean(this.binding()), el => el
              .when(Boolean(this.selected), el => el.child(this.detailPage(importTask)))
              .when(!this.selected, el => el.child(this.filters()).child(this.issueList(cx))))
            .child(div().min_h(24).flex_1())
            .child(h_flex().mt(24).pt(10).border_t(1).border_color('#dddddd').gap(4).text_size(12)
              .child('Powered by').child(div().text_color(mantisTheme.accent).child('MantisBT'))))));
  }
}
