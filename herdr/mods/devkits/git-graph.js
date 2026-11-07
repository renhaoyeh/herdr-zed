import { div, svg, PathBuilder } from 'gpui-kit';
import { h_flex, v_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, Input, InputState, TextView } from 'gpui-base';
import { shared, setShared } from 'herdr';
import { Button } from './components/button.js';
import { DropdownMenu, DropdownMenuState, DropdownMenuContent, DropdownMenuItem } from './components/dropdown-menu.js';
import { SidePanelLayout, SidePanelState } from './components/side-panel.js';
import { GitStatusColor, TreeItem, TreeItemIcon, TreeItemLabel } from './components/tree.js';
import { CommitHistory } from './git-history.js';
import { readGraphPage, searchGraph, graphRows, graphDate } from './git-graph-data.js';

const GRAPH_ROW = 28, GRAPH_LANE = 14;
const graphIcon = name => svg(`mods/devkits/assets/icons/${name}.svg`).size(14).flex_none();
const graphColumns = ['Refs', 'Graph', 'Description', 'Date', 'Author', 'Commit'];
const graphFractions = [0.18, 0.14, 0.35, 0.13, 0.11, 0.09];
const graphMinimums = [90, 60, 180, 90, 90, 75];

export class GitGraph {
  constructor(cx, parsePreview) {
    this.focus = cx?.focus_handle?.();
    this.menuFocus = cx?.focus_handle?.();
    this.scroll = VirtualListScrollHandle.new();
    this.fileScroll = VirtualListScrollHandle.new();
    this.details = new CommitHistory(cx, parsePreview);
    this.columnMenu = new DropdownMenuState(cx);
    this.side = new SidePanelState(() => shared('devkits.graph-details-width') || 300,
      width => setShared('devkits.graph-details-width', width));
    this.input = InputState.new({ placeholder: 'Search commits…' });
    this.input.on('change', (_event, cx) => this.queueSearch(cx));
    this.reset(null);
  }

  reset(context) {
    this.searchTimer?.cancel(); this.searchTimer = null;
    this.version = (this.version || 0) + 1;
    this.searchVersion = (this.searchVersion || 0) + 1;
    this.context = context; this.snapshot = null; this.entries = [];
    this.loading = false; this.loaded = false; this.hasMore = false; this.dirty = false; this.error = null;
    this.index = -1; this.selected = null; this.menu = null; this.drag = null;
    this.matches = []; this.match = -1; this.searching = false; this.searchError = null; this.target = null;
    this.layout = { rows: [], width: 1 }; this.paths = new Map();
    this.details.reset(context);
    this.columnMenu.open = false;
    this.metadataCollapsed = false; this.messageCollapsed = false;
    this.collapsedFolders = new Set();
  }

  load(cx, more = false) {
    if (!this.context || more && !this.hasMore) return;
    if (this.loading) { if (!more) this.dirty = true; return; }
    const context = this.context, version = this.version;
    this.loading = true; this.retryMore = more; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const page = await readGraphPage(context.folder, context.machine, more ? this.snapshot : null, more ? this.entries.length : 0);
        if (version !== this.version) return;
        if (more || !this.loaded || page.snapshot.revision !== this.snapshot?.revision) {
          this.entries = more ? [...this.entries, ...page.entries] : page.entries;
          this.snapshot = page.snapshot; this.hasMore = page.hasMore;
          this.layout = graphRows(this.entries, page.snapshot.head);
          this.index = this.selected ? this.entries.findIndex(entry => entry.sha === this.selected.sha) : -1;
          if (this.index < 0 && this.selected && !this.hasMore) this.clearSelection(cx);
          if (!more && this.input.value().trim()) this.queueSearch(cx);
        }
        this.loaded = true;
      } catch (error) { if (version === this.version) this.error = String(error.message || error); }
      finally {
        if (version === this.version) {
          this.loading = false;
          if (this.dirty) { this.dirty = false; this.load(cx); }
          else this.revealTarget(cx);
          cx.notify();
        }
      }
    });
  }

  select(index, cx) {
    const commit = this.entries[index];
    if (!commit) return;
    if (this.selected?.sha !== commit.sha) { this.collapsedFolders.clear(); this.fileScroll.scroll_to_item(0, 'top'); }
    this.index = index; this.selected = commit;
    this.details.select(commit, cx); cx.notify();
  }

  clearSelection(cx) {
    this.selected = null; this.index = -1;
    this.details.reset(this.context); cx.notify();
  }

  openSelected(cx, path) {
    if (this.selected) this.onOpen?.(this.selected, cx, path, this.details.preview?.commit.sha === this.selected.sha ? this.details.preview : null);
  }

  queueSearch(cx) {
    this.searchTimer?.cancel();
    const version = ++this.searchVersion;
    this.matches = []; this.match = -1; this.target = null; this.searchError = null;
    const query = this.input.value().trim(), context = this.context, snapshot = this.snapshot;
    this.searching = Boolean(query && snapshot);
    if (this.searching) this.searchTimer = cx.timer.after(250, cx => {
      this.searchTimer = null;
      cx.spawn(async cx => {
        try {
          const matches = await searchGraph(context.folder, context.machine, snapshot, query, Boolean(this.matchCase));
          if (version !== this.searchVersion) return;
          this.matches = matches;
          if (matches.length) this.nextMatch(1, cx);
        } catch (error) { if (version === this.searchVersion) this.searchError = String(error.message || error); }
        finally { if (version === this.searchVersion) { this.searching = false; cx.notify(); } }
      });
    });
    cx.notify();
  }

  nextMatch(direction, cx) {
    if (!this.matches.length) return;
    this.match = (this.match + direction + this.matches.length) % this.matches.length;
    this.target = this.matches[this.match]; this.revealTarget(cx); cx.notify();
  }

  revealTarget(cx) {
    if (!this.target) return;
    const index = this.entries.findIndex(entry => entry.sha === this.target);
    if (index >= 0) {
      this.target = null; this.select(index, cx); this.scroll.scroll_to_item(index, 'center');
    } else if (this.hasMore && !this.error) this.load(cx, true);
    else if (!this.loading) {
      // A hash can resolve to an object that is no longer reachable from our snapshot.
      this.matches = this.matches.filter(sha => sha !== this.target); this.target = null;
      this.match = Math.min(this.match, this.matches.length - 1);
    }
  }

  key(event, cx) {
    const command = event.modifiers?.platform || event.modifiers?.control;
    if (command && event.key === 'f') this.input.focus();
    else if (event.key === 'escape') {
      if (this.menu) this.menu = null;
      else if (this.selected) this.clearSelection(cx);
      else return;
    } else if (event.key === 'enter') this.openSelected(cx);
    else if (['up', 'down', 'home', 'end', 'pageup', 'pagedown'].includes(event.key)) {
      const last = this.entries.length - 1;
      const index = event.key === 'home' ? 0 : event.key === 'end' ? last
        : this.index + ({ up: -1, down: 1, pageup: -15, pagedown: 15 }[event.key]);
      this.select(Math.max(0, Math.min(last, index)), cx);
      this.scroll.scroll_to_item(Math.max(0, this.index), 'center');
      if (this.index >= last - 5) this.load(cx, true);
    } else return;
    cx.stop_propagation(); cx.notify();
  }

  get hidden() {
    const saved = shared('devkits.graph-hidden-columns');
    return Array.isArray(saved) ? [...new Set(saved.filter(i => Number.isInteger(i) && i >= 0 && i < 6))].slice(0, 5) : [];
  }
  get fractions() {
    const saved = shared('devkits.graph-column-widths');
    return Array.isArray(saved) && saved.length === 6 && saved.every(n => Number.isFinite(n) && n > 0) ? saved : graphFractions;
  }

  columnWidths() {
    const hidden = this.hidden, fractions = this.drag?.fractions || this.fractions;
    const available = Math.max(200, this.tableWidth || 800), total = fractions.reduce((n, f, i) => n + (hidden.includes(i) ? 0 : f), 0);
    return fractions.map((fraction, i) => hidden.includes(i) ? 0
      : Math.max(graphMinimums[i], i === 1 ? this.layout.width * GRAPH_LANE + 12 : 0, Math.round(available * fraction / total)));
  }

  resize(event, cx) {
    if (!this.drag) return;
    const { x, index, next, widths } = this.drag;
    const delta = Math.max(graphMinimums[index] - widths[index], Math.min(widths[next] - graphMinimums[next], event.position.x - x));
    const updated = widths.slice(); updated[index] += delta; updated[next] -= delta;
    this.drag.fractions = updated.map((width, i) => width || this.fractions[i] * (this.tableWidth || 800));
    cx.notify();
  }

  endResize(cx) {
    if (!this.drag) return;
    if (this.drag.fractions) {
      const sum = this.drag.fractions.reduce((a, b) => a + b, 0);
      setShared('devkits.graph-column-widths', this.drag.fractions.map(n => n / sum));
    }
    this.drag = null; cx.notify();
  }

  refs(commit, row, t) {
    return h_flex().w_full().min_w(0).h_full().gap(4).justify_end().overflow_hidden()
      .children((this.snapshot?.refs[commit.sha] || []).map(ref => h_flex().flex_none().h(20).px(5).gap(3)
        .bg(t.chrome).border(1).border_color(row.head || ref.head ? t.accent : t.border)
        .text_size(11).text_color(ref.head ? t.foreground : t.muted)
        .child(graphIcon(ref.kind === 'tag' ? 'tag' : 'branch').size(11))
        .child(div().max_w(140).truncate().when(ref.head, el => el.font_semibold()).child(ref.name))));
  }

  graph(row, width, t, hasRefs = false) {
    const colors = [t.ansi4 || t.accent, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1];
    const center = GRAPH_ROW / 2, x = lane => 10 + lane * GRAPH_LANE;
    const result = div().relative().w(width).h(GRAPH_ROW).flex_none();
    if (hasRefs) {
      const key = `refs:${row.lane}`;
      let path = this.paths.get(key);
      if (!path) {
        path = PathBuilder.stroke(1).move_to(0, center).line_to(x(row.lane) - 4, center).dash_array([2, 3]).build();
        this.paths.set(key, path);
      }
      result.child(globalThis.window.paint_path(path, colors[row.color % colors.length] || t.accent).absolute().top(0).left(0).w(width).h(GRAPH_ROW));
    }
    for (const edge of row.edges) {
      const key = `${edge.half}:${edge.from}:${edge.to}`;
      let path = this.paths.get(key);
      if (!path) {
        const start = edge.half === 'top' ? 0 : center, end = edge.half === 'top' ? center : GRAPH_ROW;
        const builder = PathBuilder.stroke(1.5).move_to(x(edge.from), start);
        if (edge.from === edge.to) builder.line_to(x(edge.to), end);
        else builder.cubic_bezier_to(x(edge.to), end, x(edge.from), end, x(edge.to), start);
        path = builder.build(); this.paths.set(key, path);
      }
      result.child(globalThis.window.paint_path(path, colors[edge.color % colors.length] || t.accent).absolute().top(0).left(0).w(width).h(GRAPH_ROW));
    }
    const color = colors[row.color % colors.length] || t.accent;
    return result.child(div().absolute().left(x(row.lane) - 4).top(center - 4).size(8).rounded(4)
      .bg(row.merge ? t.background : color).border(row.head ? 2 : 1.5).border_color(row.head ? t.foreground : color));
  }

  row(commit, index, widths, t) {
    const row = this.layout.rows[index], matched = this.matchSet?.has(commit.sha);
    const cells = [() => this.refs(commit, row, t), () => this.graph(row, Math.max(widths[1], this.layout.width * GRAPH_LANE + 12), t,
      widths[0] > 0 && Boolean(this.snapshot?.refs[commit.sha]?.length)),
      () => div().truncate().text_color(t.foreground).child(commit.subject),
      () => div().truncate().child(graphDate(commit.at)), () => div().truncate().child(commit.author),
      () => div().font_family('Geist Mono').truncate().child(commit.shortSha)];
    return h_flex().h(GRAPH_ROW).w_full().min_w(0).text_size(12).text_color(t.muted)
      .bg(this.selected?.sha === commit.sha ? t.selected : matched ? t.raised : t.background)
      .hover(el => el.bg(t.hover)).cursor_pointer().accessibility_label(`${commit.subject}, ${commit.author}, ${commit.shortSha}`)
      .children(cells.flatMap((cell, i) => widths[i] ? [div().w(widths[i]).h_full().flex_none().px(i === 1 ? 0 : 8)
        .flex().items_center().overflow_hidden().child(cell())] : []));
  }

  table(t) {
    const widths = this.columnWidths(), total = widths.reduce((a, b) => a + b, 0);
    const count = this.entries.length + (this.hasMore ? 1 : 0), length = this.entries.length, version = this.version;
    let queued = false;
    this.matchSet = new Set(this.matches);
    const note = text => div().flex_1().flex().items_center().justify_center().p(16).text_size(13).text_color(t.muted).child(text);
    return v_flex().id('git-graph-table').relative().size_full().min_w(0).min_h(0)
      .on_size_change((size, cx) => { if (this.tableWidth !== size.width) { this.tableWidth = size.width; cx.notify(); } })
      .on_mouse_move((event, cx) => this.resize(event, cx))
      .on_mouse_up('left', (_event, cx) => this.endResize(cx))
      .on_hover((inside, cx) => { if (!inside) this.endResize(cx); })
      .when(Boolean(this.error), el => el.child(h_flex().flex_none().px(8).py(6).gap(8).text_size(12).text_color(t.muted)
        .child(div().flex_1().child(this.error)).child(Button('graph-retry', t, { variant: 'secondary' }).h(24).px(8)
          .on_click((_event, cx) => this.load(cx, this.retryMore)).child('Retry'))))
      .child(v_flex().id('graph-horizontal').flex_1().min_h(0).overflow_x_scrollbar()
        .child(v_flex().w(total).flex_none().h_full()
          .child(h_flex().h(28).flex_none().bg(t.chrome).border_b(1).border_color(t.border)
            .on_mouse_down('right', (_event, cx) => { this.menu = { columns: true, x: 8, y: 64, index: 0 }; cx.notify(); })
            .children(graphColumns.flatMap((label, i) => {
            if (!widths[i]) return [];
            const next = widths.findIndex((width, j) => j > i && width > 0);
            return [div().relative().h_full().w(widths[i]).flex_none().px(8).flex().items_center().text_size(11).text_color(t.muted)
              .child(label).when(next >= 0, el => el.child(div().id(`graph-resize-${i}`).absolute().right(-3).top(0).bottom(0).w(6).cursor_col_resize()
                .on_mouse_down('left', (event, cx) => { cx.stop_propagation(); this.drag = { x: event.position.x, index: i, next, widths }; })
                .on_click((event, cx) => { if (event.click_count >= 2) { setShared('devkits.graph-column-widths', null); this.drag = null; cx.notify(); } })))];
          })))
          .child(count ? v_virtual_list('git-graph-rows', count, GRAPH_ROW, index => this.entries[index]?.sha || 'graph-more',
            (range, cx) => Array.from({ length: range.end - range.start }, (_, offset) => {
              const index = range.start + offset, commit = this.entries[index];
              if (commit) return this.row(commit, index, widths, t);
              if (!queued) { queued = true; cx.timer.after(0, cx => {
                if (this.version === version && this.entries.length === length && !this.error && !this.loading) this.load(cx, true);
              }); }
              return h_flex().h(GRAPH_ROW).px(8).items_center().text_size(12).text_color(t.muted).child(this.error ? '' : 'Loading…');
            })).flex_1().min_h(0).w_full().track_scroll(this.scroll)
            .on_item_click((sha, cx) => {
              this.focus?.focus(); this.menu = null;
              if (sha !== 'graph-more') this.select(this.entries.findIndex(entry => entry.sha === sha), cx);
            })
            .on_click((event, cx) => { if (event.click_count >= 2) this.openSelected(cx); })
            .on_item_secondary_click((sha, _event, cx) => {
              const commit = this.entries.find(entry => entry.sha === sha);
              if (commit) { this.menu = { commit, x: 8, y: 64, index: 0 }; cx.notify(); }
            })
            : note(this.loading ? 'Loading…' : this.error ? 'History unavailable' : 'No commits found'))))
      .when(count > 0, el => el.child(Scrollbar.vertical('git-graph-rows').absolute().top(28).bottom(0).right(0).w(10)));
  }

  detailPanel(t) {
    const commit = this.selected, preview = this.details.preview?.commit.sha === commit.sha ? this.details.preview : null;
    const files = this.visibleFiles?.(preview?.files || []) || preview?.files || [];
    const tree = shared('devkits.graph-file-tree') !== false;
    const rows = tree && this.fileRows ? this.fileRows(files, this.collapsedFolders)
      : files.map(file => ({ kind: 'file', name: file.path, path: file.path, depth: 0, file }));
    const total = name => files.reduce((n, file) => n + file[name], 0);
    const date = graphDate(commit.at, false);
    return v_flex().size_full().min_w(0).border_l(1).border_color(t.border).bg(t.background).text_size(12)
      .child(v_flex().relative().flex_none().p(8).gap(8)
        .child(h_flex().h(20).justify_between()
          .child(Button('graph-metadata-toggle', t, { variant: 'ghost', size: 'icon-sm' })
            .accessibility_label('Toggle commit details').child(graphIcon(this.metadataCollapsed ? 'chevron-right' : 'chevron-down'))
            .on_click((_event, cx) => { this.metadataCollapsed = !this.metadataCollapsed; cx.notify(); }))
          .when(this.metadataCollapsed, el => el.child(div().truncate().text_color(t.muted).child(`${commit.author} · ${commit.shortSha}`)))
          .child(Button('graph-detail-close', t, { variant: 'ghost', size: 'icon-sm' }).accessibility_label('Close commit details').child(graphIcon('close'))
            .on_click((_event, cx) => this.clearSelection(cx))))
        .when(!this.metadataCollapsed, el => el
          .child(v_flex().items_center().gap(4)
            .child(div().size(32).rounded(16).bg(t.selected).flex().items_center().justify_center().text_color(t.foreground)
              .child(commit.author.split(/\s+/).slice(0, 2).map(s => Array.from(s)[0] || '').join('')))
            .child(div().font_medium().child(commit.author))
            .child(div().text_size(11).text_color(t.muted).child(date))
            .child(this.refs(commit, this.layout.rows[this.index] || {}, t).h(22).justify_center()))
          .child(Button('graph-copy-email', t, { variant: 'ghost' }).w_full().h(24).px(0).justify_start().min_w(0)
            .accessibility_label('Copy author email').child(div().truncate().child(commit.email || commit.author))
            .on_click((_event, cx) => cx.write_to_clipboard(commit.email || commit.author)))
          .child(Button('graph-copy-sha', t, { variant: 'ghost' }).w_full().h(24).px(0).justify_start().min_w(0)
            .accessibility_label('Copy commit SHA').child(div().font_family('Geist Mono').truncate().child(commit.sha))
            .on_click((_event, cx) => cx.write_to_clipboard(commit.sha)))))
      .child(v_flex().flex_none().max_h(220).border_y(1).border_color(t.border)
        .child(Button('graph-message-toggle', t, { variant: 'ghost' }).w_full().h(28).px(8).justify_start().gap(4)
          .child(graphIcon(this.messageCollapsed ? 'chevron-right' : 'chevron-down')).child('Message')
          .on_click((_event, cx) => { this.messageCollapsed = !this.messageCollapsed; cx.notify(); }))
        .when(!this.messageCollapsed, el => el.child(div().id('graph-commit-message').max_h(180).overflow_y_scrollbar().px(12).pb(10)
          .child(TextView.markdown(`graph-message-${commit.sha}`, commit.message || commit.subject).selectable(true).scrollable(false).w_full().text_size(12)))))
      .child(h_flex().flex_none().h(32).px(8).gap(8).text_color(t.muted)
        .child(div().flex_1().child(`${files.length} Changed ${files.length === 1 ? 'File' : 'Files'}`))
        .child(Button('graph-file-tree-toggle', t, { variant: 'ghost', size: 'icon-sm' }).accessibility_label(tree ? 'Show flat view' : 'Show tree view')
          .when(tree, el => el.bg(t.selected)).child(graphIcon('list-tree'))
          .on_click((_event, cx) => { setShared('devkits.graph-file-tree', !tree); this.fileScroll.scroll_to_item(0, 'top'); cx.notify(); }))
        .child(div().text_color(GitStatusColor.added).child(`+${total('added')}`))
        .child(div().text_color(GitStatusColor.deleted).child(`−${total('removed')}`)))
      .when(Boolean(this.details.previewError), el => el.child(v_flex().flex_none().p(8).gap(6).text_color(t.muted)
        .child(this.details.previewError).child(Button('graph-detail-retry', t, { variant: 'secondary' }).h(24)
          .child('Retry').on_click((_event, cx) => this.details.select(commit, cx)))))
      .when(Boolean(preview?.truncated), el => el.child(div().px(8).py(4).text_size(11).text_color(t.muted).child('Diff limited to 4 MB.')))
      .child(v_flex().id('graph-changed-files').relative().flex_1().min_h(0)
        .when(this.details.pending === commit.sha, el => el.child(div().p(12).text_color(t.muted).child('Loading…')))
        .when(Boolean(preview) && !files.length, el => el.child(div().p(12).text_color(t.muted)
          .child(preview.files.length ? 'All changed files are hidden by Hide lock files' : 'No file changes in this commit')))
        .when(rows.length > 0, el => el.child(v_virtual_list('graph-commit-files', rows.length, 28, index => `${rows[index].kind}:${rows[index].path}`,
          range => rows.slice(range.start, range.end).map(row => {
            const file = row.file;
            return TreeItem(`graph-file-${row.path}`, row.depth, false, t, { deferred: true }).bg(t.background)
              .child(TreeItemIcon(graphIcon(file ? file.status === 'added' ? 'square-plus' : file.status === 'deleted' ? 'square-minus' : 'square-dot'
                : this.collapsedFolders.has(row.path) ? 'folder' : 'folder-open')
                .text_color(!file ? t.muted : file.status === 'added' ? GitStatusColor.added : file.status === 'deleted' ? GitStatusColor.deleted : GitStatusColor.modified)))
              .child(TreeItemLabel(t).text_size(12).child(row.name));
          })).size_full().track_scroll(this.fileScroll).on_item_click((key, cx) => {
            const row = rows.find(row => `${row.kind}:${row.path}` === key);
            if (!row) return;
            if (row.kind === 'dir') {
              this.collapsedFolders.has(row.path) ? this.collapsedFolders.delete(row.path) : this.collapsedFolders.add(row.path); cx.notify();
            } else this.openSelected(cx, row.path);
          })).child(Scrollbar.vertical('graph-commit-files').absolute().inset_0())))
      .child(Button('graph-view-changes', t, { variant: 'secondary' }).m(8).h(28).child('View Commit')
        .on_click((_event, cx) => this.openSelected(cx)));
  }

  contextMenu(t) {
    const menu = this.menu;
    const hidden = this.hidden;
    const actions = menu.columns ? graphColumns.map((label, index) => ({ label, checked: !hidden.includes(index),
      disabled: hidden.length === 5 && !hidden.includes(index), run: () => setShared('devkits.graph-hidden-columns',
        hidden.includes(index) ? hidden.filter(i => i !== index) : [...hidden, index]) })) : [
      { label: 'View Changes', run: cx => { this.selected = menu.commit; this.openSelected(cx); } },
      { label: 'Copy Commit SHA', run: cx => cx.write_to_clipboard(menu.commit.sha) },
      { label: 'Copy Commit Message', run: cx => cx.write_to_clipboard(menu.commit.message) },
    ];
    const choose = (index, cx) => { if (actions[index].disabled) return; this.menu = null; actions[index].run(cx); this.focus?.focus(); cx.notify(); };
    return DropdownMenuContent('graph-context-menu', undefined, t).absolute().left(menu.x).top(menu.y).w(224)
      .track_focus(this.menuFocus).on_mouse_down_out((_event, cx) => { this.menu = null; this.focus?.focus(); cx.stop_propagation(); cx.notify(); })
      .on_key_down((event, cx) => {
        if (event.key === 'escape') { this.menu = null; this.focus?.focus(); }
        else if (event.key === 'enter') choose(menu.index, cx);
        else if (['up', 'down'].includes(event.key)) menu.index = (menu.index + (event.key === 'up' ? actions.length - 1 : 1)) % actions.length;
        else return;
        cx.stop_propagation(); cx.notify();
      }).children(actions.map((action, i) => DropdownMenuItem(`graph-action-${i}`, t).when(menu.index === i, el => el.bg(t.selected))
        .when(Boolean(action.disabled), el => el.opacity(0.4).cursor_default())
        .on_hover((inside, cx) => { if (inside) { menu.index = i; cx.notify(); } })
        .child(div().flex_1().child(action.label))
        .when(Boolean(action.checked), el => el.child(graphIcon('check')))
        .on_click((_event, cx) => choose(i, cx))));
  }

  render(t, embedded = false) {
    const hidden = this.hidden;
    const table = this.table(t);
    return v_flex().id('git-graph').relative().size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground)
      .track_focus(this.focus).on_key_down((event, cx) => this.key(event, cx))
      .on_size_change((size, cx) => { this.size = size; })
      .on_mouse_down('right', (event, cx) => {
        if (!this.menu || !event.local_position) return;
        this.menu.x = Math.max(0, Math.min(event.local_position.x, (this.size?.width || 800) - 224));
        this.menu.y = Math.max(32, Math.min(event.local_position.y, (this.size?.height || 600) - (this.menu.columns ? 208 : 112)));
        this.menuFocus?.focus(); cx.stop_propagation(); cx.notify();
      })
      .when(!embedded, el => el.child(h_flex().h(32).flex_none().pl(12).bg(t.chrome).border_b(1).border_color(t.border)
        .child(graphIcon('git-graph')).child(div().flex_1().pl(6).text_size(12).child('Git Graph'))
        .child(DropdownMenu('graph-columns', this.columnMenu,
          Button('graph-column-trigger', t, { variant: 'ghost', size: 'icon' }).size(32).accessibility_label('Git Graph columns').child(graphIcon('ellipsis')),
          graphColumns.map((label, index) => ({ key: index, label, checked: !hidden.includes(index), disabled: hidden.length === 5 && !hidden.includes(index) })),
          (index, cx) => { setShared('devkits.graph-hidden-columns', hidden.includes(index) ? hidden.filter(i => i !== index) : [...hidden, index]); cx.notify(); },
          t, { fullHeight: true }))
        .child(Button('graph-close', t, { variant: 'ghost', size: 'icon' }).size(32).accessibility_label('Close Git Graph')
          .child(graphIcon('close')).on_click((_event, cx) => this.onClose?.(cx)))))
      .child(h_flex().h(44).flex_none().p(6).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().flex_1().min_w(0).h(32).border(1).border_color(t.border).bg(t.chrome)
          .on_key_down((event, cx) => {
            if (event.key === 'escape') { this.focus?.focus(); cx.stop_propagation(); }
            else if (event.key === 'enter') { this.nextMatch(event.modifiers?.shift ? -1 : 1, cx); cx.stop_propagation(); }
          })
          .child(Input.new(this.input).id('graph-search').flex_1().min_w(0).h(30).px(6).rounded(0).border(0).text_size(12)
            .accessibility_label('Search commits'))
          .child(Button('graph-match-case', t, { variant: 'ghost' }).h(30).w(30).px(0).child('Aa')
            .accessibility_label('Match case').when(Boolean(this.matchCase), el => el.bg(t.selected).text_color(t.foreground))
            .on_click((_event, cx) => { this.matchCase = !this.matchCase; this.queueSearch(cx); })))
        .child(Button('graph-prev-match', t, { variant: 'ghost', size: 'icon' }).size(28).accessibility_label('Previous match')
          .on_click((_event, cx) => this.nextMatch(-1, cx)).child(graphIcon('chevron-left')))
        .child(Button('graph-next-match', t, { variant: 'ghost', size: 'icon' }).size(28).accessibility_label('Next match')
          .on_click((_event, cx) => this.nextMatch(1, cx)).child(graphIcon('chevron-right')))
        .child(div().w(64).text_size(11).text_color(t.muted).child(this.searching ? 'Searching…' : `${this.matches.length ? this.match + 1 : 0}/${this.matches.length}`)))
      .when(Boolean(this.searchError), el => el.child(div().px(8).py(4).text_size(12).text_color(t.muted).child(this.searchError)))
      .child(div().flex_1().min_w(0).min_h(0).child(this.selected ? SidePanelLayout('graph-details', this.side, table, this.detailPanel(t)) : table))
      .when(Boolean(this.menu), el => el.child(this.contextMenu(t)));
  }
}
