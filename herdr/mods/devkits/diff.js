import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from 'gpui-base';
import { exec, watchFolder, settings, theme, shared, setShared } from 'herdr';
import { Button } from './components/button.js';
import { TreeItem, TreeItemIcon, TreeItemLabel, GitStatusColor } from './components/tree.js';
import { Empty, EmptyTitle, EmptyDescription } from './components/empty.js';

const icon = name => svg(`mods/devkits/assets/icons/${name}.svg`).size(12).flex_none();
const MAX_BYTES = 4000000, MAX_ROWS = 20000, MAX_LINE = 2000;
const LINE = 20, HEADER = 32, GAP = 8, SEPARATOR = 12;
// Changed lines get a light wash of Zed's version-control colors and changed words a stronger one.
// Working tree (including untracked files) against HEAD, or the empty tree before the first commit.
// A marker line separates tracked changes from untracked files, as Zed's Git panel groups them.
const UNTRACKED = 'devkits-untracked-files';
const SCRIPT = 'cd "$1" || exit 2; git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not a Git repository." >&2; exit 3; }; '
  + 'base=$(git rev-parse --verify -q HEAD) || base=$(git hash-object -t tree /dev/null); '
  + '{ git -c core.quotepath=false diff --no-color --no-ext-diff --find-renames -U3 "$base" --; '
  + `echo ${UNTRACKED}; `
  + 'git -c core.quotepath=false ls-files -z --others --exclude-standard | xargs -0 -n 1 git -c core.quotepath=false diff --no-color --no-ext-diff --no-index -- /dev/null; true; } | head -c ' + MAX_BYTES;

function unquote(path) {
  if (!path.startsWith('"')) return path;
  const escapes = { n: '\n', t: '\t', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' };
  const bytes = [];
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...new TextEncoder().encode(body[i])); continue; }
    const next = body[++i];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(...new TextEncoder().encode(escapes[next] ?? next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
const strip = path => { const value = unquote(path.trim()); return value === '/dev/null' ? null : value.replace(/^[ab]\//, ''); };
const clean = text => { const value = text.replaceAll('\t', '    '); return value.length > MAX_LINE ? value.slice(0, MAX_LINE) + ' …' : value; };

/** Parses unified `git diff` output into one entry per file. */
export function parseDiff(text) {
  const files = [];
  let file = null, oldLine = 0, newLine = 0, untracked = false;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === UNTRACKED) { untracked = true; file = null; }
    else if (line.startsWith('diff --git ')) {
      const header = line.slice(11), half = header.length >> 1;
      const fallback = header.slice(2, half) === header.slice(half + 3) ? strip(header.slice(half + 1)) : null;
      file = { path: fallback, oldPath: fallback, status: 'modified', added: 0, removed: 0, binary: false, untracked, hunks: [] };
      files.push(file);
    } else if (!file) continue;
    else if (!file.hunks.length && line.startsWith('--- ')) file.oldPath = strip(line.slice(4));
    else if (!file.hunks.length && line.startsWith('+++ ')) file.path = strip(line.slice(4));
    else if (!file.hunks.length && line.startsWith('rename from ')) { file.oldPath = unquote(line.slice(12)); file.status = 'renamed'; }
    else if (!file.hunks.length && line.startsWith('rename to ')) file.path = unquote(line.slice(10));
    else if (!file.hunks.length && line.startsWith('new file mode')) file.status = 'added';
    else if (!file.hunks.length && line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (!file.hunks.length && (line.startsWith('Binary files ') || line === 'GIT binary patch')) file.binary = true;
    else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (!match) continue;
      oldLine = Number(match[1]); newLine = Number(match[2]);
      file.hunks.push({ header: line, context: match[3].trim(), lines: [] });
    } else if (file.hunks.length) {
      const hunk = file.hunks.at(-1), kind = line[0], content = clean(line.slice(1));
      if (kind === '+') { hunk.lines.push({ type: 'add', new: newLine++, text: content }); file.added++; }
      else if (kind === '-') { hunk.lines.push({ type: 'del', old: oldLine++, text: content }); file.removed++; }
      else if (kind === ' ') hunk.lines.push({ type: 'ctx', old: oldLine++, new: newLine++, text: content });
    }
  }
  for (const entry of files) {
    if (!entry.path) { entry.path = entry.oldPath; if (entry.status === 'modified') entry.status = 'deleted'; }
    if (!entry.oldPath && entry.status === 'modified') entry.status = 'added';
  }
  return files.filter(entry => entry.path).sort((a, b) => Number(a.untracked) - Number(b.untracked) || a.path.localeCompare(b.path));
}

export async function readDiff(folder, on) {
  const result = await exec('sh', ['-c', SCRIPT, 'devkits-diff', folder], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read changes.');
  return { files: parseDiff(result.stdout), truncated: result.stdout.length >= MAX_BYTES };
}

/** Only commits move HEAD; other .git activity cannot change a working-tree diff against it. */
export const affectsDiff = rest => !rest.split('/').includes('.git') || /(^|\/)\.git\/(HEAD|packed-refs|refs\/)/.test(rest);

/** Marks the changed middle of a replaced line pair, when the pair is similar enough to compare. */
export function changedRanges(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start
    && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const kept = start + end, longest = Math.max(before.length, after.length);
  if (!kept || kept < longest * 0.4) return [null, null];
  return [[start, before.length - end], [start, after.length - end]];
}

/** A hunk's lines as side-by-side pairs: deletions beside the additions that replace them. */
export function pairLines(lines) {
  const pairs = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].type === 'ctx') { pairs.push({ left: lines[i], right: lines[i] }); i++; continue; }
    const dels = [], adds = [];
    while (lines[i]?.type === 'del') dels.push(lines[i++]);
    while (lines[i]?.type === 'add') adds.push(lines[i++]);
    for (let n = 0; n < Math.max(dels.length, adds.length); n++) pairs.push({ left: dels[n] || null, right: adds[n] || null });
  }
  return pairs;
}

const tint = (color, alpha) => `${color}${alpha}`;

/** Zed's Git panel sections, in the multibuffer's order. */
export function changeSections(files) {
  return [['Tracked', files.filter(file => !file.untracked)], ['Untracked', files.filter(file => file.untracked)]]
    .filter(([, entries]) => entries.length).map(([label, entries]) => ({ label, files: entries }));
}

/**
 * Zed's Git panel tree: folders first, and a folder whose only child is a folder
 * shares its row (`apps/desktop`). `prefix` keeps each section's folder keys apart.
 */
export function changeTree(files, collapsed = new Set(), prefix = '') {
  const root = { children: new Map() };
  for (const file of files) {
    let node = root;
    const parts = file.path.split('/');
    for (const name of parts.slice(0, -1)) {
      if (!node.children.has(name)) node.children.set(name, { name, children: new Map() });
      node = node.children.get(name);
    }
    node.children.set(`\0${parts.at(-1)}`, { name: parts.at(-1), file });
  }
  const rows = [];
  const walk = (node, depth, path) => {
    const entries = [...node.children.values()]
      .sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
    for (let entry of entries) {
      if (entry.file) { rows.push({ kind: 'file', name: entry.name, depth, path: entry.file.path, file: entry.file }); continue; }
      let name = entry.name;
      while (entry.children.size === 1 && !entry.children.values().next().value.file) {
        entry = entry.children.values().next().value;
        name += `/${entry.name}`;
      }
      const key = `${prefix}${path}${name}`;
      rows.push({ kind: 'dir', name, depth, path: key });
      if (!collapsed.has(key)) walk(entry, depth + 1, `${path}${name}/`);
    }
  };
  walk(root, 0, '');
  return rows;
}

const splitPath = path => {
  const slash = path.lastIndexOf('/');
  return { name: path.slice(slash + 1), folder: slash > 0 ? path.slice(0, slash) : '' };
};

export default class DiffViewer {
  init(cx) {
    this.files = [];
    this.collapsed = new Set();
    this.folders = new Set();
    this.request = 0;
    this.scroll = VirtualListScrollHandle.new();
  }

  close() {
    this.watcher?.cancel(); this.poll?.cancel(); this.queued?.cancel();
    this.queued = null;
    this.context = null;
    this.request++;
  }

  refresh(project, cx) {
    this.close();
    this.context = project ? { ...project } : null;
    this.files = []; this.collapsed.clear(); this.folders.clear(); this.rowCache = null; this.selected = null;
    this.error = null; this.loaded = false; this.truncated = false;
    if (project?.folder) { this.observe(cx); this.reload(cx); }
  }

  observe(cx) {
    const context = this.context;
    this.watchFailed = false;
    if (!context.machine) this.watcher = cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const paths = await watchFolder(context.folder);
          if (this.context !== context) return;
          if (!paths.some(path => affectsDiff(path.slice(context.folder.length)))) continue;
          if (!this.queued) this.queued = cx.timer.after(200, cx => {
            this.queued = null;
            if (this.context === context) this.reload(cx);
          });
        }
      } catch { if (this.context === context) this.watchFailed = true; }
    });
    this.poll = cx.timer.every(10000, cx => {
      if (this.context === context && (context.machine || this.watchFailed)) this.reload(cx);
    });
  }

  reload(cx) {
    if (this.loading) { this.dirty = true; return; }
    const context = this.context, request = ++this.request;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const { files, truncated } = await readDiff(context.folder, context.machine);
        if (request !== this.request || this.context !== context) return;
        this.files = files; this.truncated = truncated; this.error = null; this.rowCache = null;
      } catch (error) {
        if (request === this.request && this.context === context) { this.files = []; this.rowCache = null; this.error = String(error.message || error); }
      } finally {
        if (this.context === context) {
          this.loading = false; this.loaded = true;
          if (this.dirty) { this.dirty = false; this.reload(cx); }
        }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    this.collapsed.has(path) ? this.collapsed.delete(path) : this.collapsed.add(path);
    this.rowCache = null;
    cx.notify();
  }

  /** Jumps the multibuffer to a file's header, expanding the file if it was collapsed. */
  reveal(path, cx) {
    this.selected = path;
    if (this.collapsed.delete(path)) this.rowCache = null;
    const index = this.rows().rows.findIndex(row => row.key === `file:${path}`);
    if (index >= 0) this.scroll.scroll_to_item(index, 'top');
    cx.notify();
  }

  toggleFolder(path, cx) {
    this.folders.has(path) ? this.folders.delete(path) : this.folders.add(path);
    cx.notify();
  }

  /** Zed's Git panel: collapsible Tracked/Untracked sections holding a tree with indent guides. */
  panel(t) {
    const status = file => file.untracked || file.status === 'added' ? ['square-plus', GitStatusColor.added]
      : file.status === 'deleted' ? ['square-minus', GitStatusColor.deleted] : ['square-dot', GitStatusColor.modified];
    const added = this.files.reduce((n, file) => n + file.added, 0), removed = this.files.reduce((n, file) => n + file.removed, 0);
    // A full-height dock with its own header, as Zed's Git panel sits beside the editor.
    return v_flex().w(280).flex_none().min_h(0).h_full().bg(t.chrome).border_l(1).border_color(t.border)
      .child(h_flex().h(32).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().font_medium().text_color(t.foreground).child('Changes'))
        .child(div().text_color(t.muted).child(`(${this.files.length})`))
        .child(div().flex_1())
        .child(div().text_color(GitStatusColor.added).child(`+${added}`))
        .child(div().text_color(GitStatusColor.deleted).child(`−${removed}`)))
      .child(v_flex().id('diff-files').flex_1().min_h(0).overflow_y_scrollbar().py(4)
        .children(changeSections(this.files).map(section => {
          const key = `section:${section.label}`, open = !this.folders.has(key);
          return v_flex().flex_none()
            .child(TreeItem(`diff-${key}`, 0, false, t).text_color(t.muted)
              .accessibility_label(`${section.label}, ${section.files.length} files`)
              .on_click((_event, cx) => this.toggleFolder(key, cx))
              .child(TreeItemIcon(icon(open ? 'chevron-down' : 'chevron-right')))
              .child(TreeItemLabel(t).text_size(12).text_color(t.muted).child(section.label))
              .child(div().flex_none().px(5).border(1).border_color(t.border).text_size(11).child(String(section.files.length))))
            .when(open, el => el.children(changeTree(section.files, this.folders, `${section.label}:`).map(row => {
              const button = TreeItem(`diff-tree-${row.path}`, row.depth + 1, row.kind === 'file' && this.selected === row.path, t);
              if (row.kind === 'dir') return button.accessibility_label(`Folder ${row.name}`)
                .on_click((_event, cx) => this.toggleFolder(row.path, cx))
                .child(TreeItemIcon(icon(this.folders.has(row.path) ? 'folder' : 'folder-open').text_color(t.muted)))
                .child(TreeItemLabel(t).text_color(t.muted).child(row.name));
              const [glyph, color] = status(row.file);
              return button.accessibility_label(`${row.file.untracked ? 'Untracked' : row.file.status} file ${row.path}`)
                .on_click((_event, cx) => this.reveal(row.path, cx))
                .child(TreeItemIcon(icon(glyph).text_color(color)))
                .child(TreeItemLabel(t).when(row.file.status === 'deleted', el => el.line_through()).child(row.name))
                .when(!row.file.untracked, el => el.child(h_flex().flex_none().gap(4).text_size(11)
                  .child(div().text_color(GitStatusColor.added).child(`+${row.file.added}`))
                  .child(div().text_color(GitStatusColor.deleted).child(`−${row.file.removed}`))));
            })));
        })));
  }

  get split() { return shared('devkits.diff-layout') === 'split'; }

  setLayout(layout, cx) {
    setShared('devkits.diff-layout', layout);
    this.rowCache = null;
    cx.notify();
  }

  /** Fixed-height rows of one multibuffer: file headers, excerpt separators and lines. */
  rows() {
    const split = this.split;
    if (this.rowCache?.split === split) return this.rowCache;
    const rows = [], sizes = [];
    const add = (row, size) => { rows.push(row); sizes.push(size); };
    let limited = false;
    for (const [index, file] of this.files.entries()) {
      if (rows.length >= MAX_ROWS) { limited = true; break; }
      add({ key: `file:${file.path}`, kind: 'file', file, first: index === 0 }, index === 0 ? HEADER : HEADER + GAP);
      if (this.collapsed.has(file.path)) continue;
      if (file.binary || !file.hunks.length) add({ key: `note:${file.path}`, kind: 'note', text: file.binary ? 'Binary file' : 'No content changes' }, HEADER);
      file.hunks.forEach((hunk, h) => {
        if (h) add({ key: `gap:${file.path}:${h}`, kind: 'separator' }, SEPARATOR);
        const pairs = pairLines(hunk.lines);
        for (const pair of pairs) if (pair.left?.type === 'del' && pair.right?.type === 'add' && !pair.left.marks) {
          [pair.left.marks, pair.right.marks] = changedRanges(pair.left.text, pair.right.text);
        }
        if (split) pairs.forEach((pair, n) => add({ key: `pair:${file.path}:${h}:${n}`, kind: 'pair', ...pair }, LINE));
        else hunk.lines.forEach((line, n) => add({ key: `line:${file.path}:${h}:${n}`, kind: 'line', line }, LINE));
      });
    }
    const widest = Math.max(1, ...this.files.flatMap(file => file.hunks.map(hunk => hunk.lines.at(-1) ? Math.max(hunk.lines.at(-1).old || 0, hunk.lines.at(-1).new || 0) : 0)));
    return this.rowCache = { split, rows, sizes, limited, gutter: String(widest).length * 8 + 24 };
  }

  text(line, color, t) {
    const value = line.text || ' ', marks = line.marks;
    // The clip box shrinks; the text inside keeps its own width and starts at the left edge.
    const cell = h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden().text_color(t.foreground);
    const run = text => div().flex_none().whitespace_nowrap().child(text);
    if (!marks) return cell.child(run(value));
    return cell.child(run(value.slice(0, marks[0])))
      .child(run(value.slice(marks[0], marks[1])).bg(tint(color, '4d')))
      .child(run(value.slice(marks[1])));
  }

  /** One side of a line: line number, the hunk bar, then the text, as Zed's gutter draws them. */
  cell(line, number, gutter, t) {
    const color = line?.type === 'add' ? GitStatusColor.added : line?.type === 'del' ? GitStatusColor.deleted : null;
    if (!line) return div().flex_1().min_w(0).h(LINE).bg(t.background);
    return h_flex().flex_1().min_w(0).h(LINE).items_center().overflow_hidden().bg(color ? tint(color, '1a') : t.background)
      .child(div().w(gutter).flex_none().pr(12).text_right().text_color(t.dim).child(number === undefined ? '' : String(number)))
      .child(div().w(3).h_full().flex_none().when(Boolean(color), el => el.bg(color)))
      .child(div().w(8).flex_none())
      .child(this.text(line, color, t))
      .child(div().w(12).flex_none());
  }

  row(row, t, mono, gutter) {
    if (row.kind === 'file') {
      const { file } = row, open = !this.collapsed.has(file.path);
      const { name, folder } = splitPath(file.path);
      return v_flex().w_full().h_full().when(!row.first, el => el.pt(GAP).bg(t.background))
        .child(h_flex().h(HEADER).w_full().px(12).gap(8).items_center().bg(t.chrome).border_y(1).border_color(t.border)
          .cursor_pointer().hover(el => el.bg(t.hover))
          .child(icon(open ? 'chevron-down' : 'chevron-right').text_color(t.muted))
          .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted)
            .child(file.status === 'renamed' ? `${folder}  ← ${file.oldPath}` : folder))
          .when(file.status === 'added' || file.status === 'deleted', el => el.child(div().text_size(11)
            .text_color(file.status === 'added' ? GitStatusColor.added : GitStatusColor.deleted).child(file.status === 'added' ? 'New' : 'Deleted')))
          .when(file.added > 0, el => el.child(div().text_size(11).text_color(GitStatusColor.added).child(`+${file.added}`)))
          .when(file.removed > 0, el => el.child(div().text_size(11).text_color(GitStatusColor.deleted).child(`−${file.removed}`))));
    }
    if (row.kind === 'note') return h_flex().h(HEADER).w_full().px(12).items_center().text_size(12).text_color(t.muted).child(row.text);
    if (row.kind === 'separator') return div().h(SEPARATOR).w_full().bg(t.chrome).border_y(1).border_color(t.border);
    const line = h_flex().h(LINE).w_full().font_family(mono).text_size(13).line_height(`${LINE}px`);
    if (row.kind === 'pair') return line
      .child(this.cell(row.left, row.left?.old, gutter, t))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.cell(row.right, row.right?.new, gutter, t));
    // Unified rows number by the new file; deletions have no new line, as in Zed.
    return line.child(this.cell(row.line, row.line.new, gutter, t));
  }

  render(project, cx) {
    if (this.context?.id !== project?.id || this.context?.folder !== project?.folder || this.context?.machine !== project?.machine) this.refresh(project, cx);
    const t = theme(), mono = settings().font_family, { rows, sizes, limited, gutter } = this.rows(), split = this.split;
    const choice = (id, label, value) => Button(id, t, { variant: 'ghost' }).h(24).px(8)
      .when(split === (value === 'split'), el => el.bg(t.selected).text_color(t.foreground))
      .accessibility_label(`${label} diff${split === (value === 'split') ? ', selected' : ''}`)
      .on_click((_event, cx) => this.setLayout(value, cx)).child(label);
    // The editor and the Git panel are side by side, each with its own 32px header, like Files.
    return h_flex().id('diff-viewer').flex_row_reverse().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .when(this.files.length > 0, el => el.child(this.panel(t)))
      .child(v_flex().flex_1().min_w(0).min_h(0).h_full()
        .child(h_flex().h(32).flex_none().pl(12).pr(4).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
          .child(div().flex_1().min_w(0).truncate().font_medium().child('Uncommitted changes'))
          .child(choice('diff-unified', 'Unified', 'unified'))
          .child(choice('diff-split', 'Split', 'split')))
        .when(this.truncated || limited, el => el.child(div().flex_none().px(12).py(6).text_size(11).text_color(t.muted).border_b(1).border_color(t.border)
          .child('Diff limited to 4 MB and 20,000 rows.')))
        .child(rows.length
          ? v_flex().relative().flex_1().min_h(0)
            .child(v_virtual_list('diff-rows', rows.length, sizes, index => rows[index].key,
              range => rows.slice(range.start, range.end).map(row => this.row(row, t, mono, gutter)))
              .size_full().track_scroll(this.scroll)
              .on_item_click((key, cx) => { if (key.startsWith('file:')) this.toggle(key.slice(5), cx); }))
            .child(Scrollbar.vertical('diff-rows').absolute().inset_0())
          : Empty(t).flex_1()
            .child(EmptyTitle().child(this.error ? 'Changes unavailable' : this.loaded ? 'No changes' : 'Loading changes…'))
            .child(EmptyDescription(t).child(this.error || (this.loaded ? 'The working tree matches HEAD.' : '')))));
  }
}
