import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, InputState } from 'gpui-base';
import { settings, theme } from 'herdr';
import { execShell } from './shell.js';
import { FindState, compileQuery, textRuns } from './find.js';
import { SEARCH_SCRIPT, LINE, HEADER, GAP, MAX_MATCHES, grepArgs, parseGrep, resultRows } from './search-results.js';
import { FindBar } from './find-bar.js';
import { Empty, EmptyDescription } from './components/empty.js';
import { ToolbarButton } from './components/button.js';
import { Input } from './components/input.js';
import { GitStatusColor } from './components/tree.js';

const icon = name => svg(`mods/herdr-zed/assets/icons/${name}.svg`).size(12).flex_none();
/** Project-wide search (Ctrl+Shift+F), shown as an editor tab. */
export class ProjectSearch {
  init(cx) {
    this.find = new FindState(); this.find.open = true;
    this.find.input = InputState.new({ placeholder: 'Search all files…' });
    this.find.input.on('change', (_event, cx) => this.schedule(cx));
    // Zed's file filters: comma-separated globs, shown under the query with the filter button.
    this.filters = false;
    this.include = InputState.new({ placeholder: 'Include files, e.g. src/, *.js' });
    this.exclude = InputState.new({ placeholder: 'Exclude files, e.g. test/, *.min.js' });
    for (const input of [this.include, this.exclude]) input.on('change', (_event, cx) => this.schedule(cx));
    this.scroll = VirtualListScrollHandle.new();
    this.result = null; this.request = 0; this.running = false; this.error = null; this.index = 0; this.wait = 0;
  }

  focus(cx) {
    this.find.input.focus();
    const length = this.find.query.length;
    if (length) this.find.input.set_selected_range({ start: 0, end: length });
    cx?.notify();
  }

  // Typing waits briefly before searching; Enter and option changes search at once.
  schedule(cx, delay = 300) {
    const wait = ++this.wait;
    cx.spawn(async cx => {
      await cx.sleep(delay);
      if (wait === this.wait) this.search(cx);
    });
  }

  search(cx) {
    this.wait++;
    const project = this.project, query = this.find.query, request = ++this.request;
    const { pattern, error } = compileQuery(query, this.find);
    this.find.error = error;
    if (!project?.folder || !query || !pattern) { this.result = null; this.running = false; this.error = null; cx.notify(); return; }
    this.running = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const output = await execShell(['-c', SEARCH_SCRIPT, 'herdr-zed-search', project.folder, ...grepArgs(query, this.find, this.filterValues())], { on: project.machine });
        if (request !== this.request) return;
        // git grep exits 1 without matches; anything on stderr is a real failure (a bad PCRE pattern, say).
        if (output.stderr?.trim() && !output.stdout) throw new Error(output.stderr.trim().split('\n')[0]);
        const parsed = parseGrep(output.stdout || '', pattern);
        const rows = resultRows(parsed.files);
        // Every match in reading order, for previous and next.
        const matches = rows.rows.flatMap((row, index) => row.kind === 'line' ? row.line.ranges.map(range => ({ row: index, range })) : []);
        this.result = { ...parsed, ...rows, matches, key: this.searchKey() };
        this.index = 0;
        this.scroll.scroll_to_item(0, 'top');
      } catch (error) {
        if (request === this.request) { this.result = null; this.error = String(error.message || error); }
      } finally {
        if (request === this.request) { this.running = false; cx.notify(); }
      }
    });
  }

  // Hidden filters still apply, as in Zed; the button shows when any is set.
  filterValues() { return { include: this.include.value(), exclude: this.exclude.value() }; }

  searchKey() { return JSON.stringify([this.projectKey, this.find.query, this.find.caseSensitive, this.find.wholeWord, this.find.regex, this.filterValues()]); }

  // Enter searches when the query changed; otherwise it moves through the results, as in Zed.
  enter(shift, cx) {
    if (this.result && this.result.key === this.searchKey()) this.step(shift ? -1 : 1, cx);
    else this.search(cx);
  }

  step(delta, cx) {
    const matches = this.result?.matches || [];
    if (!matches.length) return;
    this.index = (this.index + delta + matches.length) % matches.length;
    this.scroll.scroll_to_item(matches[this.index].row, 'center');
    cx.notify();
  }

  setProject(project, cx) {
    const key = project ? `${project.machine || ''}\0${project.folder}` : null;
    if (this.projectKey === key) return;
    this.projectKey = key; this.project = project; this.result = null; this.error = null; this.request++;
    if (this.find.query) this.schedule(cx, 0);
  }

  status() {
    if (!this.find.query) return '';
    const r = this.result;
    // While a new search runs the previous count stays, so the bar does not flicker.
    if (!r) return this.running ? 'Searching…' : '';
    if (!r.total) return 'No results';
    return `${this.index + 1} of ${r.total}${r.limited ? '+' : ''} in ${r.files.length} ${r.files.length === 1 ? 'file' : 'files'}`;
  }

  row(row, index, t, mono) {
    if (row.kind === 'file') {
      const slash = row.file.path.lastIndexOf('/');
      return v_flex().w_full().h_full().when(!row.first, el => el.pt(GAP).bg(t.background))
        .child(h_flex().h(HEADER).w_full().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
          .cursor_pointer().hover(el => el.bg(t.hover))
          .child(icon('file').text_color(t.muted))
          .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child(row.file.path.slice(slash + 1)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(slash > 0 ? row.file.path.slice(0, slash) : ''))
          .child(div().text_size(11).text_color(t.muted).child(String(row.file.count))));
    }
    if (row.kind === 'gap') return h_flex().h(LINE).w_full().pl(12).items_center().text_size(12).text_color(t.dim).child('⋯');
    const { line } = row, value = line.text || ' ';
    const current = this.result?.matches[this.index];
    const hits = line.ranges.map(range => ({ range, current: current?.row === index && current.range === range }));
    return h_flex().h(LINE).w_full().items_center().font_family(mono).text_size(13).line_height(`${LINE}px`)
      .cursor_pointer().hover(el => el.bg(t.hover))
      .child(div().w(56).flex_none().pr(12).text_right().text_color(hits.length ? t.muted : t.dim).child(String(line.n)))
      .child(div().w(3).h_full().flex_none().when(hits.length > 0, el => el.bg(GitStatusColor.modified || t.accent)))
      .child(div().w(8).flex_none())
      .child(h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden().text_color(hits.length ? t.foreground : t.muted)
        .children(textRuns(value.length, null, hits).map(part => div().flex_none().whitespace_nowrap()
          .when(part.hit, el => el.bg(part.current ? t.accent : t.selection).text_color(part.current ? t.accent_foreground : t.foreground))
          .child(value.slice(part.start, part.end)))));
  }

  render(project, cx) {
    this.setProject(project, cx);
    const t = theme(), mono = settings().font_family, result = this.result;
    const rows = result?.rows || [], sizes = result?.sizes || [];
    const empty = this.error || (this.running ? 'Searching…' : !this.find.query ? 'Search every file in this project' : result ? 'No results' : '');
    return v_flex().id('project-search').size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground)
      .child(FindBar('project-search-bar', t, this.find, { label: 'Search all files', status: this.status(), statusWidth: 168,
        extra: ToolbarButton('project-search-filters', t, { icon: true, selected: this.filters || Boolean(this.include.value() || this.exclude.value()) })
          .accessibility_label(`File filters${this.filters ? ', shown' : ''}`).tooltip('Include and exclude files')
          .on_click((_event, cx) => { this.filters = !this.filters; if (this.filters) this.include.focus(); cx.notify(); })
          .child(icon('filter')),
        canStep: Boolean(result?.matches.length), onStep: (delta, cx) => this.step(delta, cx),
        onChange: cx => this.search(cx), onEnter: (shift, cx) => this.enter(shift, cx), onClose: cx => this.onClose?.(cx) }))
      .when(this.filters, el => el.child(h_flex().id('project-search-filters-row').h(44).flex_none().px(12).gap(8).items_center()
        .bg(t.chrome).border_b(1).border_color(t.border)
        .on_key_down((event, cx) => {
          if (event.key === 'enter') { this.search(cx); cx.stop_propagation(); }
          else if (event.key === 'escape') { this.filters = false; this.find.input.focus(); cx.notify(); cx.stop_propagation(); }
        })
        .child(Input.new(this.include, t).id('project-search-include').accessibility_label('Include files').flex_1().min_w(0).h(28))
        .child(Input.new(this.exclude, t).id('project-search-exclude').accessibility_label('Exclude files').flex_1().min_w(0).h(28))))
      .when(Boolean(result?.limited), el => el.child(div().flex_none().px(12).py(6).text_size(11).text_color(t.muted).border_b(1).border_color(t.border)
        .child(`Showing the first ${MAX_MATCHES} matches. Refine the search to see the rest.`)))
      .child(rows.length
        ? v_flex().id('project-search-results').relative().flex_1().min_h(0)
          .child(v_virtual_list('project-search-rows', rows.length, sizes, index => rows[index].key,
            range => rows.slice(range.start, range.end).map((row, i) => this.row(row, range.start + i, t, mono)))
            .size_full().track_scroll(this.scroll)
            .on_item_click((key, cx) => {
              const row = rows.find(row => row.key === key);
              const path = row?.kind === 'file' ? row.file.path : row?.path;
              if (path) this.onOpenFile?.(path, cx);
            }))
          .child(Scrollbar.vertical('project-search-rows').absolute().inset_0())
        : Empty(t).flex_1().p(24).child(EmptyDescription(t).text_size(13).child(empty)));
  }
}
