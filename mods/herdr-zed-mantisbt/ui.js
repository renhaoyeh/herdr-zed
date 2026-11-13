import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, Input, InputState } from 'gpui-base';
import { run } from 'herdr';
import { TaskSourceController, TaskSourceProjectPicker } from './components/task-source.js';
import { mantisSource } from './source.js';
import { filterProjects } from './source-api.js';
import { readMantisProjects, saveMantisProjects, readMantisIssues, saveMantisIssues } from './connection.js';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { DropdownMenu, DropdownMenuState, DropdownMenuTrigger } from './components/dropdown-menu.js';

// Measured from the bundled MantisBT 2.28 web UI (Ace compact sidebar).
export const mantisTheme = {
  background: '#ffffff', foreground: '#393939', muted: '#555555', border: '#d5d5d5',
  navbar: '#404040', sidebar: '#dbdbdb', sidebarRow: '#e4e4e4',
  solid: '#428bca', solid_foreground: '#ffffff', accent: '#337ab7',
  widget: '#5090c1', breadcrumb: '#e7f2f8', category: '#edf3f4',
  hover: '#eff4f7', selected: '#e7f2f8', row: '#f8f8f8', popover: '#ffffff', input: '#d5d5d5',
  destructive: '#a94442',
};
const rule = '#c4c4c4';
// MantisBT's filter fields. Values come from the loaded issues, so choosing them never asks the server.
const filterFields = [['reporter', 'Reporter'], ['assignee', 'Assigned To'], ['section', 'Status'],
  ['category', 'Category'], ['priority', 'Priority'], ['severity', 'Severity']];
const filterValue = (task, key) => task[key] || '[none]';
const statusColors = { new: '#fcbdbd', feedback: '#e3b7eb', acknowledged: '#ffcd85', confirmed: '#fff494',
  assigned: '#c2dfff', resolved: '#d2f5b0', closed: '#c9ccc4' };
export const issueNumber = gid => String(gid || '').padStart(7, '0');
// The server reports each status's configured color, including custom statuses; the defaults cover older lists.
export const statusColor = task => task.statusColor || statusColors[task.statusName] || statusColors[String(task.section || '').toLowerCase()] || '#e4e4e4';
const glyph = (name, size = 14) => svg(`mods/herdr-zed/assets/icons/${name}.svg`).size(size).flex_none();
const localStamp = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
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
const cell = (value, width, header = false, divider = true) => div().when(Boolean(width), el => el.w(width).flex_none())
  .when(!width, el => el.flex_1().min_w(0)).h_full().px(8).flex().items_center().truncate()
  .when(divider, el => el.border_r(1).border_color(rule))
  .text_color(mantisTheme.foreground).when(header, el => el.font_semibold()).child(value || '—');

export class MantisProjectPicker extends TaskSourceProjectPicker {
  constructor(options = {}) { super({ ...options, source: mantisSource }); }

  close() { this.closed = true; super.close(); }

  applyProjects(projects, cx) {
    const selected = this.projects[this.index]?.gid;
    this.projectList = projects;
    this.projects = filterProjects(projects, this.search.value());
    this.index = Math.max(0, this.projects.findIndex(project => project.gid === selected));
    cx.notify();
  }

  find(cx) {
    this.index = 0;
    if (this.projectList) { this.applyProjects(this.projectList, cx); return; }
    if (this.projectLoad) return;
    this.projectLoad = true; this.loading = true; cx.notify();
    cx.spawn(async cx => {
      try {
        const connection = await this.source.readConnection();
        if (this.closed) return;
        if (!connection?.token) throw new Error('Connect MantisBT first.');
        const cached = await readMantisProjects(connection);
        if (this.closed) return;
        if (cached) {
          this.applyProjects(cached.projects, cx); this.loading = false;
          const age = Date.now() - cached.fetchedAt;
          if (age >= 0 && age < 300_000) { this.projectLoad = false; cx.notify(); return; }
          this.refreshing = true; cx.notify();
        }
        const projects = await this.source.searchProjects(connection, '');
        if (this.closed) return;
        this.applyProjects(projects, cx); this.error = null;
        try { await saveMantisProjects(connection, projects, Date.now()); } catch {}
      } catch (error) {
        if (!this.closed) this.error = this.projectList
          ? `Could not update projects. Showing saved projects. ${error.message}` : error.message;
      }
      if (this.closed) return;
      this.loading = false; this.refreshing = false; this.projectLoad = false; cx.notify();
    });
  }

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
        .when(this.refreshing, el => el.child(div().p(8).child('Updating projects…')))
        .when(Boolean(this.error), el => el.child(div().p(8).text_color(mantisTheme.destructive).child(this.error)))
        .when(!this.loading && !this.refreshing && !this.error && !this.projects.length, el => el.child(div().p(8).child('No matching projects.'))));
  }
}

export default class MantisPanel extends TaskSourceController {
  constructor(options = {}) { super({ ...options, source: options.source || mantisSource }); }

  init(cx) {
    super.init(cx);
    this.tab = 'all';
    this.filter = {}; this.filterMenus = Object.fromEntries(filterFields.map(([key]) => [key, new DropdownMenuState(cx)]));
    this.filtersOpen = true;
    this.fetchingAll = false; this.fetchedPages = 0; this.stopFetch = false;
    this.sortKey = null; this.sortDir = 'desc'; this.cacheTried = false;
    this.issueSearch = InputState.new({ placeholder: 'Search' });
    this.issueSearch.on('change', (_event, cx) => cx.notify());
  }

  reset() { super.reset(); this.filter = {}; this.fetchingAll = false; this.stopFetch = true;
    this.sortKey = null; this.cacheTried = false; }

  open(project, cx) {
    super.open(project, cx);
    this.filter = {};
    this.issueSearch.set_value('');
  }

  allLoaded() { return this.tab === 'mine' || (this.all.loaded && !this.all.next); }

  // MantisBT's REST API ignores handler, status and sort parameters, so every page is read and filtered here.
  // A finished read is saved, so the next session shows it at once and Refresh reads it again.
  fetchAll(cx, restart = false) {
    if (this.fetchingAll || this.loadingMore || (!restart && this.allLoaded())) return;
    const request = this.page, gid = this.loadedGid, credentials = this.credentials();
    let tasks = restart ? [] : this.all.tasks, next = restart ? null : this.all.next, first = restart || !this.all.loaded;
    this.fetchingAll = true; this.loadingMore = true; this.stopFetch = false; this.restarting = restart; this.fetchedPages = 0; cx.notify();
    cx.spawn(async cx => {
      try {
        while (!this.stopFetch && this.page === request && (first || next)) {
          const page = await this.source.projectTasksPage(credentials, gid, next);
          if (this.page !== request) return;
          tasks = this.sourceScope?.all() ? [...new Map([...tasks, ...page.tasks].map(task => [task.gid, task])).values()] : [...tasks, ...page.tasks]; next = page.next; first = false; this.fetchedPages++;
          if (!restart) this.all = { ...this.all, tasks, next, loaded: true };
          cx.notify();
        }
        if (!this.stopFetch && this.page === request && !next) {
          const fetchedAt = Date.now();
          this.all = { tasks, next: null, loaded: true, fetchedAt };
          if (!this.sourceScope?.all()) { try { await saveMantisIssues(credentials, gid, tasks, fetchedAt); } catch {} }
        }
      } catch (error) { if (this.page === request) this.fail(error); }
      if (this.page === request) { this.fetchingAll = false; this.loadingMore = false; }
      cx.notify();
    });
  }

  // The first View Issues load shows the saved full list when there is one, instead of reading a page.
  more(cx) {
    if (!this.sourceScope?.all() && this.tab === 'all' && !this.all.loaded && !this.cacheTried && !this.loadingMore) {
      this.cacheTried = true; this.loadingMore = true;
      const request = this.page, gid = this.loadedGid;
      cx.spawn(async cx => {
        const cached = await readMantisIssues(this.credentials(), gid);
        if (this.page !== request) return;
        this.loadingMore = false;
        if (cached && !this.all.loaded) this.all = { tasks: cached.tasks, next: null, loaded: true, fetchedAt: cached.fetchedAt };
        else super.more(cx);
        cx.notify();
      });
      return;
    }
    super.more(cx);
  }

  activeFilters() { return Object.keys(this.filter).length; }
  toggleFilter(key, value, cx) {
    const chosen = new Set(this.filter[key] || []);
    if (value === null) chosen.clear(); else if (!chosen.delete(value)) chosen.add(value);
    if (chosen.size) this.filter = { ...this.filter, [key]: chosen };
    else { const { [key]: _removed, ...rest } = this.filter; this.filter = rest; }
    cx.notify();
  }

  sortBy(id, cx) {
    this.sortDir = this.sortKey === id ? (this.sortDir === 'asc' ? 'desc' : 'asc') : ['gid', 'createdAt', 'updatedAt'].includes(id) ? 'desc' : 'asc';
    this.sortKey = id; cx.notify();
  }

  sorted(tasks) {
    if (!this.sortKey) return tasks;
    const column = this.displayFields('list').find(field => field.id === this.sortKey);
    const read = task => this.sortKey === 'gid' ? Number(task.gid) : this.sortKey === 'summary' ? task.name
      : ['createdAt', 'updatedAt', 'due', 'section'].includes(this.sortKey) ? task[this.sortKey] : column ? this.fieldValue(task, column) : '';
    const sign = this.sortDir === 'asc' ? 1 : -1;
    return [...tasks].sort((a, b) => {
      const left = read(a) ?? '', right = read(b) ?? '';
      if (left === '' || left === '—') return right === '' || right === '—' ? 0 : 1;
      if (right === '' || right === '—') return -1;
      return sign * (typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true }));
    });
  }

  view() { return 'list'; }
  rows() { return this.issueTasks().map(task => ({ task, depth: 0 })); }
  issueTasks() {
    return this.sorted(this.filteredTasks());
  }
  filteredTasks() {
    const words = this.issueSearch.value().toLowerCase().split(/\s+/).filter(Boolean);
    return (this.tab === 'mine' ? this.mine || [] : this.all.tasks).filter(task =>
      Object.entries(this.filter).every(([key, chosen]) => chosen.has(filterValue(task, key))) && words.every(word =>
        [task.name, issueNumber(task.gid), task.section, task.assignee, task.category, task.herdrProject].filter(Boolean).join(' ').toLowerCase().includes(word)));
  }
  chooseView(tab, cx) {
    this.tab = tab; this.writeState('tab', tab);
    this.settingsOpen = false; this.clearIssue(cx);
    this.handle.focus(); cx.notify();
  }
  back(cx) { this.clearIssue(cx); }

  navbar(close) {
    const ready = this.needsToken === false, bound = this.binding();
    return h_flex().h(45).flex_none().items_center().bg(mantisTheme.navbar).text_color('#ffffff')
      .child(div().w(125).flex_none().pl(15).text_size(18).child('MantisBT'))
      .child(div().flex_1())
      .when(ready && !this.sourceScope?.all(), el => el.child(DropdownMenuTrigger(Button('mantis-project-menu', mantisTheme, { variant: 'ghost' }).h(45).px(14).rounded(0).gap(8)
        .text_color('#ffffff').bg('#555555').accessibility_label('Choose MantisBT project')
        .child(div().max_w(320).truncate().child(bound?.name || 'Select Project')).child(glyph('chevron-down', 12)), 280,
      (_cx, at) => { if (ready) this.openProjectPicker?.(this.folder, at); }, 'end', { x: 0, y: 0 })))
      .when(ready && this.sourceScope?.all(), el => el.child(div().px(14).child(bound.name)))
      .child(Button('mantis-close', mantisTheme, { variant: 'ghost', size: 'icon' }).size(45).rounded(0).text_color('#ffffff')
        .accessibility_label('Close MantisBT tasks').tooltip('Close MantisBT tasks').on_click(close).child(glyph('close', 16)));
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
      .child(nav('mantis-account', 'My Account', 'gear', Boolean(this.settingsOpen) || this.needsToken === true, () => run('herdr-zed.settings:mantisbt')));
  }

  filters() {
    const tasks = this.tab === 'mine' ? this.mine || [] : this.all.tasks;
    const count = this.activeFilters();
    const control = ([key, label]) => {
      const state = this.filterMenus[key], chosen = this.filter[key];
      const values = [...new Set(tasks.map(task => filterValue(task, key)))].sort((a, b) => a.localeCompare(b));
      // Statuses keep the colors shown in the table.
      const colors = key === 'section' ? new Map(tasks.map(task => [task.section, statusColor(task)])) : null;
      return DropdownMenu(`mantis-filter-${key}`, state,
        Button(`mantis-filter-${key}-trigger`, mantisTheme, { variant: 'outline' }).w_full().h(28).px(8).rounded(0).gap(6).justify_between()
          .bg('#ffffff').text_color(mantisTheme.foreground).accessibility_label(`Filter by ${label}`)
          .child(div().min_w(0).truncate().child(chosen?.size ? [...chosen].join(', ') : '[any]')).child(glyph('chevron-down', 12)),
        [{ key: '__any__', label: '[any]', checked: !chosen?.size }, ...values.map(value => ({ key: value, label: value, checked: Boolean(chosen?.has(value)), color: colors?.get(value) }))],
        (value, cx) => { state.open = true; this.toggleFilter(key, value === '__any__' ? null : value, cx); },
        mantisTheme, { align: 'start', offset: { x: 0, y: 4 } });
    };
    const group = fields => v_flex()
      .child(h_flex().bg(mantisTheme.category).font_semibold().border_t(1).border_color(rule)
        .children(fields.map((field, index) => div().flex_1().min_w(0).px(8).py(6).when(index < fields.length - 1, el => el.border_r(1).border_color(rule)).child(field[1]))))
      .child(h_flex().border_t(1).border_color(rule)
        .children(fields.map((field, index) => div().flex_1().min_w(0).p(6).when(index < fields.length - 1, el => el.border_r(1).border_color(rule)).child(control(field)))));
    return widget().id('mantis-filters').mb(22)
      .child(widgetHeader('mantis-filters-header', `Filters${count ? ` (${count})` : ''}`, 'list-todo')
        .child(div().flex_1())
        .child(field(this.issueSearch, 'mantis-search', 'Search MantisBT issues').w(190).h(24))
        .child(Button('mantis-toggle-filters', mantisTheme, { variant: 'ghost', size: 'icon' }).size(28).rounded(0).text_color('#ffffff')
          .accessibility_label(this.filtersOpen ? 'Collapse filters' : 'Expand filters').tooltip(this.filtersOpen ? 'Collapse filters' : 'Expand filters')
          .on_click((_event, cx) => { this.filtersOpen = !this.filtersOpen; cx.notify(); }).child(glyph(this.filtersOpen ? 'chevron-down' : 'chevron-right', 16))))
      .when(this.filtersOpen && this.tab === 'all', el => el.child(h_flex().p(8).gap(8).items_center().border_t(1).border_color(rule)
        .child(this.fetchingAll
          ? button('mantis-fetch-stop', 'Stop', (_event, cx) => { this.stopFetch = true; cx.notify(); })
          : this.allLoaded()
            ? button('mantis-fetch-all', 'Refresh', (_event, cx) => this.fetchAll(cx, true), { disabled: this.loadingMore })
            : button('mantis-fetch-all', 'Fetch all issues', (_event, cx) => this.fetchAll(cx), { disabled: this.loadingMore }))
        .child(div().text_color(mantisTheme.muted).child(this.fetchingAll
          ? `Fetching… ${this.fetchedPages} pages${this.restarting ? ' (the current list stays until it finishes)' : ` · ${this.all.tasks.length} open issues`}`
          : this.allLoaded()
            ? `${this.all.tasks.length} open issues${this.all.fetchedAt ? ` · fetched ${localStamp(this.all.fetchedAt)}` : ''}`
            : 'Fetch every page to filter or sort by status or assignee.'))))
      .when(this.filtersOpen && this.allLoaded(), el => el
        .child(group(filterFields.slice(0, 3))).child(group(filterFields.slice(3)))
        .child(h_flex().p(8).gap(8).items_center().bg('#eeeeee').border_t(1).border_color(rule)
          .child(button('mantis-filter-reset', 'Reset Filter', (_event, cx) => { this.filter = {}; cx.notify(); }, { disabled: !count }))
          .child(div().text_color(mantisTheme.muted).child(`${this.issueTasks().length} of ${tasks.length} issues`))));
  }

  issueList(cx) {
    const tasks = this.issueTasks();
    const columns = this.displayFields('list');
    const loading = this.tab === 'mine' ? this.loading : this.loadingMore;
    const loaded = this.tab === 'mine' ? this.mine !== null : this.all.loaded;
    const sortable = this.allLoaded();
    const head = (id, name, width, divider = true) => {
      const label = h_flex().gap(4).items_center().min_w(0).child(div().truncate().child(name))
        .when(this.sortKey === id, el => el.child(glyph(this.sortDir === 'asc' ? 'chevron-up' : 'chevron-down', 12)));
      const element = cell(label, width, true, divider).id(`mantis-sort-${id}`);
      return sortable ? element.cursor_pointer().hover(el => el.bg('#e4e4e4')).accessibility_label(`Sort by ${name}`)
        .on_click((_event, cx) => this.sortBy(id, cx)) : element;
    };
    const header = h_flex().h(30).flex_none().items_center().bg('#f1f1f1').border_b(1).border_color(mantisTheme.border)
      .children(columns.map(column => head(column.id, column.name, column.width))).child(head('summary', 'Summary', null, false));
    const value = (task, column) => column.id === 'gid'
      ? div().id(`mantis-issue-number-${task.gid}`).text_color(mantisTheme.accent).cursor_pointer().hover(el => el.underline())
        .on_click((_event, cx) => this.show(task, cx)).child(issueNumber(task.gid))
      : column.id === 'section' ? h_flex().gap(5).items_center().min_w(0)
        .child(div().size(18).rounded(3).flex_none().bg(statusColor(task)))
        .child(div().truncate().child(task.section))
        : div().truncate().child(['createdAt', 'updatedAt', 'due'].includes(column.id) ? date(task[column.id], column.id !== 'due') : this.fieldValue(task, column));
    const row = (task, index) => h_flex().id(`mantis-issue-${task.gid}`).h(34).flex_none().items_center()
      .bg(index % 2 ? '#ffffff' : mantisTheme.row).border_b(1).border_color(rule).hover(el => el.bg(mantisTheme.selected))
      .accessibility_label(`${issueNumber(task.gid)}: ${task.name}`)
      .children(columns.map(column => cell(value(task, column), column.width)))
      .child(cell(div().id(`mantis-issue-summary-${task.gid}`).text_color(mantisTheme.accent).truncate().cursor_pointer().hover(el => el.underline())
        .on_click((_event, cx) => this.show(task, cx)).child(task.name), null, false, false));
    return widget().id('mantis-issues')
      .child(widgetHeader('mantis-issues-header', this.tab === 'mine' ? 'Assigned to Me' : 'Viewing Issues', 'columns-3')
        .child(div().px(9).rounded(10).bg('#aabac3').text_size(12).child(`${tasks.length ? '1' : '0'} - ${tasks.length}${this.tab === 'all' && this.all.next ? ' +' : ''}`)))
      .child(v_flex().w_full().min_w(0).overflow_x_scrollbar()
        .child(v_flex().min_w(280 + columns.reduce((total, field) => total + field.width, 0)).child(header).children(tasks.map(row))))
      .when(loading, el => el.child(div().p(12).text_color(mantisTheme.muted).child(this.tab === 'mine'
        ? 'Loading issues assigned to you…' : this.all.loaded ? 'Loading more issues…' : 'Loading issues…')))
      .when(!tasks.length && loaded && !loading && !this.error, el => el.child(div().p(18).text_color(mantisTheme.muted).child(this.issueSearch.value() || this.activeFilters()
        ? 'No loaded issues match the current filter.' : this.tab === 'mine' ? 'No open issues assigned to you.'
          : this.all.next ? 'No open issues on the loaded pages. Load more issues to continue.' : 'No open issues in this project.')))
      .when(this.tab === 'all' && Boolean(this.all.next), el => el.child(h_flex().p(8).bg('#eeeeee').border_t(1).border_color(rule)
        .child(button('mantis-more', this.loadingMore ? 'Loading…' : 'Load more issues', (_event, cx) => this.more(cx), { disabled: this.loadingMore }))));
  }

  detailPage(importTask) {
    const task = this.detail;
    const label = value => div().w(140).flex_none().px(10).py(8).bg(mantisTheme.category).font_semibold().child(value);
    const valueCell = (content, divider = false) => div().flex_1().min_w(0).px(10).py(8).border_l(1).border_color(rule)
      .when(divider, el => el.border_r(1)).child(content);
    const property = (name, value, divider = false) => h_flex().flex_1().min_w(0).min_h(36).border_b(1).border_color(rule)
      .child(label(name)).child(valueCell(value || '—', divider));
    const full = (name, value) => h_flex().min_h(38).border_b(1).border_color(rule).items_stretch()
      .child(label(name)).child(valueCell(value || '—'));
    if (!task) return widget().child(widgetHeader('mantis-detail-header', 'View Issue Details'))
      .child(div().p(20).text_color(this.detailError ? mantisTheme.destructive : mantisTheme.muted).child(this.detailError || 'Loading issue…'));
    const visible = this.displayFields('detail'), standard = visible.filter(field => !field.id.startsWith('custom:'));
    const metadataIds = ['gid', 'projectName', 'category', 'viewStatus', 'createdAt', 'updatedAt'];
    const metadata = standard.filter(field => metadataIds.includes(field.id));
    const properties = standard.filter(field => !metadataIds.includes(field.id) && field.id !== 'tags');
    const value = field => field.id === 'gid' ? issueNumber(task.gid)
      : ['createdAt', 'updatedAt', 'due'].includes(field.id) ? date(task[field.id], field.id !== 'due')
        : field.id === 'section' ? status(task) : this.fieldValue(task, field);
    const status = issue => h_flex().gap(6).items_center().child(div().size(18).rounded(3).flex_none().bg(statusColor(issue))).child(issue.section);
    const metadataCell = (content, last) => div().flex_1().min_w(0).px(6).py(6).when(!last, el => el.border_r(1).border_color(rule)).child(content);
    const children = this.subtasks.get(task.gid);
    return v_flex().gap(22)
      .child(widget().id('mantis-detail')
        .child(widgetHeader('mantis-detail-header', 'View Issue Details')
          .child(div().flex_1()).child(button('mantis-open', 'Open in MantisBT', (_event, cx) => cx.open_url(task.url), { icon: 'external-link' })))
        .when(metadata.length > 0, el => el
          .child(h_flex().bg(mantisTheme.category).font_semibold().border_b(1).border_color(mantisTheme.border)
            .children(metadata.map((field, index) => metadataCell(field.name, index === metadata.length - 1))))
          .child(h_flex().mb(10).border_b(1).border_color(rule)
            .children(metadata.map((field, index) => metadataCell(value(field), index === metadata.length - 1)))))
        .children(properties.reduce((rows, field, index) => {
          if (index % 3 === 0) rows.push([]);
          rows.at(-1).push(field); return rows;
        }, []).map((fields, rowIndex) => h_flex().items_stretch().when(rowIndex === 0, el => el.border_t(1).border_color(rule)).children(fields.map((field, index) => property(field.name, value(field), index < fields.length - 1)))))
        .child(full('Summary', div().font_semibold().child(`${issueNumber(task.gid)}: ${task.name}`)))
        .child(full('Description', task.notes || 'No description.'))
        .children(visible.filter(field => field.id.startsWith('custom:')).map(field =>
          full(field.name, this.fieldValue(task, field)).id(`mantis-custom-detail-${field.id}`)))
        .when(standard.some(field => field.id === 'tags'), el => el.child(full('Tags', task.tags?.join(', ') || 'No tags attached.')))
        .when(Boolean(this.onImport), el => el.child(h_flex().p(10).justify_end().bg('#f5f5f5').border_t(1).border_color(rule)
          .child(button('mantis-import', this.importLabel, () => importTask(task), { primary: true, icon: 'plus', disabled: !task.comments && !task.commentsError })))))
      .when(Boolean(task.parent) || task.subtasks > 0, el => el.child(widget().id('mantis-relationships')
        .child(widgetHeader('mantis-relationships-header', 'Relationships', 'list-tree'))
        .when(task.subtasks > 0 && !children, el => el.child(div().p(12).child('Loading relationships…')))
        .children([...(task.parent ? [{ ...task.parent, relation: 'child of' }] : []), ...(children || []).map(child => ({ ...child, relation: 'parent of' }))]
          .map(related => h_flex().id(`mantis-related-${related.gid}`).min_h(36).items_center().border_b(1).border_color(rule).hover(el => el.bg(mantisTheme.hover)).cursor_pointer()
            .on_click((_event, cx) => this.show(related, cx)).child(cell(related.relation, 100))
            .child(cell(div().id(`mantis-related-number-${related.gid}`).text_color(mantisTheme.accent).hover(el => el.underline()).child(issueNumber(related.gid)), 90))
            .child(cell(related.section ? status(related) : '—', 160)).child(cell(related.assigneeLogin || related.assignee, 150))
            .child(cell(div().id(`mantis-related-summary-${related.gid}`).text_color(mantisTheme.accent).hover(el => el.underline()).child(related.name), null, false, false))))))
      .child(widget().id('mantis-activities').child(widgetHeader('mantis-activities-header', 'Activities', 'clock'))
        .when(Boolean(task.commentsError), el => el.child(div().p(12).text_color(mantisTheme.destructive).child(task.commentsError)))
        .when(!task.comments?.length && !task.commentsError, el => el.child(div().p(12).child('No notes.')))
        .children((task.comments || []).map((comment, index) => h_flex().id(`mantis-note-${comment.gid}`).items_stretch().min_h(90).mx(10).mt(index > 0 ? 12 : 10).when(index === (task.comments.length - 1), el => el.mb(10)).border(1).border_color(rule)
          .child(v_flex().w(185).flex_none().p(12).gap(8).bg('#edf3f4')
            .child(h_flex().gap(6).items_center().child(glyph('agent')).child(comment.authorLogin || comment.author))
            .child(div().text_size(12).text_color(mantisTheme.muted).child(date(comment.at, true)))
            .child(div().text_size(12).child(`~${issueNumber(comment.gid)}`)))
          .child(v_flex().flex_1().min_w(0).border_l(1).border_color(rule)
            .child(v_flex().flex_1().min_w(0).justify_start().p(12).bg('#e8e8e8').child(comment.text))))));
  }

  fieldSettings() {
    const bound = this.binding(), schema = this.fieldSchema?.scope === this.fieldScope() ? this.fieldSchema : null;
    const surface = this.fieldSurface === 'detail' ? 'detail' : 'list';
    const labels = { list: 'List columns', detail: 'Issue details' }, fields = this.fieldOptions(surface);
    return widget().id('mantis-field-settings').mt(22)
      .child(widgetHeader('mantis-fields-header', 'Field Display', 'columns-3'))
      .when(!bound, el => el.child(div().p(12).child('Select a project to configure its fields.')))
      .when(Boolean(bound), el => el
        .child(h_flex().min_h(42).px(12).gap(8).items_center().bg('#f5f5f5').border_b(1).border_color(rule)
          .child(div().font_semibold().child('Project:')).child(div().child(bound.name || bound.gid)))
        .child(h_flex().p(12).gap(8).children(Object.entries(labels).map(([value, title]) =>
          button(`source-fields-${value}`, title, (_event, cx) => { this.cancelFieldDrag(cx); this.fieldSurface = value; cx.notify(); }, { primary: surface === value }))))
        .when(Boolean(schema?.loading), el => el.child(div().px(12).pb(12).text_color(mantisTheme.muted).child('Loading project fields…')))
        .when(Boolean(schema?.error), el => el.child(h_flex().p(12).gap(8).items_center()
          .child(div().flex_1().text_color(mantisTheme.destructive).child(schema.error))
          .child(button('source-fields-retry', 'Retry', (_event, cx) => this.syncFields(cx, true)))))
        .child(h_flex().h(32).items_center().bg(mantisTheme.category).border_t(1).border_b(1).border_color(mantisTheme.border)
          .child(div().w(36).flex_none().h_full().border_r(1).border_color(rule)).child(div().w(85).h_full().flex().items_center().px(12).border_r(1).border_color(rule).font_semibold().child('Display'))
          .child(div().flex_1().h_full().flex().items_center().px(12).font_semibold().child('Field')))
        .child(v_flex().id('mantis-field-rows').on_hover((hovered, cx) => { if (!hovered) this.cancelFieldDrag(cx); })
          .on_key_down((event, cx) => { if (event.key === 'escape' && this.fieldDrag) { this.cancelFieldDrag(cx); cx.stop_propagation(); } })
          .children(fields.map((field, index) => h_flex().id(`source-field-${surface}-${field.id}`).min_h(40).items_center()
          .bg(this.fieldDrag?.target === field.id && this.fieldDrag?.id !== field.id ? mantisTheme.selected : index % 2 ? '#ffffff' : mantisTheme.row)
          .opacity(this.fieldDrag?.id === field.id ? 0.5 : 1).border_b(1).border_color(mantisTheme.border)
          .on_mouse_move((_event, cx) => this.hoverField(surface, field.id, cx))
          .on_mouse_up('left', (_event, cx) => { if (this.fieldDrag) { this.dropField(surface, field.id, cx); cx.stop_propagation(); } })
          .child(div().w(36).h_full().flex_none().flex().items_center().justify_center().border_r(1).border_color(rule).child(Button(`source-field-drag-${surface}-${field.id}`, mantisTheme, { variant: 'ghost', size: 'icon' }).w(36).h(30).cursor_grab()
            .accessibility_label(`Reorder ${field.name}. Drag or use Alt + Up or Down.`).tooltip(`Reorder ${field.name}. Drag or use Alt + Up or Down.`)
            .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); this.startFieldDrag(surface, field.id, cx); })
            .on_key_down((event, cx) => this.fieldDragKey(event, surface, field.id, cx)).child(glyph('grip-vertical'))))
          .child(div().w(85).h_full().flex().items_center().px(12).border_r(1).border_color(rule).child(Checkbox(`source-field-visible-${surface}-${field.id}`, field.visible, mantisTheme)
            .accessibility_label(`Show ${field.name} in ${labels[surface]}`)
            .on_change((_checked, cx) => this.changeField(surface, field.id, 0, cx))))
          .child(div().flex_1().min_w(0).h_full().flex().items_center().px(12).child(field.name))
          )))
        .child(div().p(12).bg('#eeeeee').border_t(1).border_color(rule).text_color(mantisTheme.muted)
          .child('Drag handles to reorder. Changes save on drop. Summary stays visible. Imports keep all loaded fields.')));
  }

  // Without a saved token the page says how to connect; the server and token form lives in the MantisBT Settings page.
  connectEmpty() {
    return v_flex().id('mantis-connect').flex_1().min_h(0).items_center().justify_center().py(32)
      .child(widget().w(360).child(widgetHeader('mantis-connect-header', 'Connect MantisBT', 'gear'))
        .child(v_flex().p(18).gap(12).items_center().text_center()
          .child(div().text_color(mantisTheme.muted).child('Save your server URL and API token in Settings to see your issues here.'))
          .child(button('mantis-connect', 'Open MantisBT settings', () => run('herdr-zed.settings:mantisbt'), { primary: true }))));
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
          .child(h_flex().h(41).flex_none().px(16).gap(8).items_center().bg(mantisTheme.breadcrumb).border_b(1).border_color('#c5dbe8').text_color(mantisTheme.accent)
            .child(glyph('folder', 16)).child(this.binding()?.name || project?.name || 'MantisBT')
            .child(div().text_color(mantisTheme.muted).child('/'))
            .child(this.needsToken ? 'Connect' : this.selected ? 'View Issue Details' : this.tab === 'mine' ? 'My View' : 'View Issues')
            .child(div().flex_1())
            .when(Boolean(this.selected) && ready, el => el.child(button('mantis-back', 'Back to issues', (_event, cx) => this.back(cx), { icon: 'chevron-left' }))))
          .child(v_flex().id('mantis-page-content').flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(16)
            .when(this.needsToken === null, el => el.child(div().p(12).child('Loading connection…')))
            .when(this.needsToken === true, el => el.child(this.connectEmpty()))
            .when(ready && Boolean(this.error), el => el.child(div().p(12).text_color(mantisTheme.destructive).child(this.error)))
            .when(ready && !this.binding(), el => el.child(widget().child(widgetHeader('mantis-select-project', 'Select Project', 'folder'))
              .child(div().p(18).child('Select a MantisBT project from the project menu.'))))
            .when(ready && Boolean(this.binding()), el => el
              .when(Boolean(this.selected), el => el.child(this.detailPage(importTask)))
              .when(!this.selected, el => el.child(this.filters()).child(this.issueList(cx))))
            .child(div().min_h(24).flex_1())
            .child(h_flex().mt(24).pt(10).border_t(1).border_color(rule).gap(4).text_size(12)
              .child('Powered by').child(div().text_color(mantisTheme.accent).child('MantisBT'))))));
  }
}
