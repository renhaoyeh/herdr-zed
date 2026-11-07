import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, Editor, EditorState, TextView } from 'gpui-base';
import { exec, readTextFile, watchFolder, settings, theme, window, props, openOverlay, closeOverlay, notify, shared, setShared } from 'herdr';
import { execShell } from './shell.js';
import { Button } from './components/button.js';
import { TreeItem, TreeItemIcon, TreeItemLabel, GitStatusColor } from './components/tree.js';
import { Empty, EmptyTitle, EmptyDescription } from './components/empty.js';
import { DropdownMenu, DropdownMenuState, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './components/dropdown-menu.js';

const icon = name => svg(`mods/devkits/assets/icons/${name}.svg`).size(14).flex_none();
const LANG = { ts: 'js', tsx: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js', jsonc: 'json', toml: 'yaml', vue: 'html', svelte: 'html' };
const PER_FOLDER = 500, TOTAL = 5000;
// Open tabs are remembered per project folder across reloads and restarts.
// Persisted keys must not contain NUL: Herdr's shared store cuts a key there.
const projectKey = project => JSON.stringify([project.machine || null, project.folder]);
const openDocument = path => ({ path, code: null, markdown: null, error: null, loaded: false, stale: false, request: 0 });

export async function directory(path, on) {
  // Paths are positional arguments; filenames never become shell code.
  const script = 'test -r "$1" && test -x "$1" && test -d "$1" || exit 1; n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; elif [ -f "$p" ]; then kind=f; else continue; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; exit 0';
  const result = await execShell(['-c', script, 'devkits-files', path], { on });
  if (result.code !== 0) throw new Error(result.stderr || 'Cannot read this folder.');
  const fields = result.stdout.split('\0'), entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) entries.push({ name: fields[i + 1], dir: fields[i] === 'd' });
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

// The prefix comes first so paths from the repository root can be made relative to the project.
const STATUS_SCRIPT = 'cd "$1" || exit 0; prefix=$(git rev-parse --show-prefix 2>/dev/null) || exit 0; printf "%s\\0" "$prefix"; '
  + 'git -c core.quotepath=false status --porcelain=v1 -z --untracked-files=all --ignored=matching -- . 2>/dev/null; exit 0';

/**
 * `git status --porcelain -z` as Zed's project panel colors it: each changed path is added or
 * modified, and a folder takes modified when anything inside changed, added when all of it is new.
 */
export function parseStatus(stdout) {
  const fields = stdout.split('\0'), prefix = fields[0] || '', status = new Map();
  for (let i = 1; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    // A rename or copy is followed by its original path.
    if (code[0] === 'R' || code[0] === 'C') i++;
    if (!entry.slice(3).startsWith(prefix)) continue;
    const path = entry.slice(3 + prefix.length).replace(/\/$/, '');
    // Ignored directories cover their descendants, but never recolor their parents.
    if (code === '!!') { status.set(path, 'ignored'); continue; }
    const kind = code === '??' || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified';
    status.set(path, kind);
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) {
      const folder = parts.slice(0, n).join('/'), current = status.get(folder);
      status.set(folder, kind === 'added' && (!current || current === 'added') ? 'added' : 'modified');
    }
  }
  return status;
}

export async function gitStatus(folder, on) {
  const result = await execShell(['-c', STATUS_SCRIPT, 'devkits-status', folder], { on });
  return parseStatus(result.code === 0 ? result.stdout : '');
}

export function fullPath(folder, path) {
  const joined = `${folder.replace(/[/\\]+$/, '')}/${path}`;
  return /^(?:[A-Za-z]:|\\\\|\/\/)/.test(folder) ? joined.replaceAll('/', '\\') : joined;
}

export async function revealPath(folder, path, platform) {
  const full = fullPath(folder, path);
  const result = platform === 'windows' ? await exec('explorer.exe', [`/select,${full}`])
    : platform === 'macos' ? await exec('open', ['-R', full])
      : await exec('xdg-open', [full.slice(0, full.lastIndexOf('/')) || '/']);
  // Explorer can return 1 when delegating to an existing window.
  if (result.code !== 0 && !(platform === 'windows' && result.code === 1)) throw new Error(result.stderr || 'Could not reveal this path.');
}

export class FileMenu {
  init(cx) { this.handle = cx.focus_handle(); this.handle.focus(); this.index = 0; }

  render() {
    const t = theme(), target = props(), platform = window()?.platform;
    const actions = [
      { key: 'relative', label: 'Copy Relative Path' },
      { key: 'full', label: 'Copy Full Path' },
      { key: 'reveal', label: platform === 'windows' ? 'Reveal in File Explorer' : platform === 'macos' ? 'Reveal in Finder' : 'Reveal in File Manager', disabled: Boolean(target.machine) },
    ];
    const choose = (action, cx) => {
      cx.stop_propagation();
      if (action.disabled) return;
      if (action.key === 'reveal') {
        cx.spawn(async () => {
          try { await revealPath(target.folder, target.path, platform); }
          catch (error) { notify({ title: 'Could not reveal path', body: error.message, level: 'error' }); }
          finally { closeOverlay(target.overlay); }
        });
        return;
      }
      cx.write_to_clipboard(action.key === 'relative' ? target.path : fullPath(target.folder, target.path));
      closeOverlay(target.overlay);
    };
    const enabled = actions.map((action, i) => action.disabled ? -1 : i).filter(i => i >= 0);
    return DropdownMenuContent('file-menu', undefined, t).role('menu').accessibility_label('File actions')
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') closeOverlay(target.overlay);
        else if (event.key === 'enter' || event.key === 'space') choose(actions[this.index], cx);
        else if (event.key === 'down' || event.key === 'up') {
          this.index = enabled[(enabled.indexOf(this.index) + (event.key === 'up' ? -1 : 1) + enabled.length) % enabled.length];
          cx.notify();
        } else return;
        cx.stop_propagation();
      })
      .children(actions.flatMap((action, i) => [
        ...(action.key === 'reveal' ? [DropdownMenuSeparator(t)] : []),
        DropdownMenuItem(`file-menu-${action.key}`, t).role('menu_item').accessibility_label(action.label)
          .when(action.disabled, el => el.opacity(0.4).cursor_default())
          .when(!action.disabled && this.index === i, el => el.bg(t.selected))
          .on_hover((inside, cx) => { if (inside && !action.disabled) { this.index = i; cx.notify(); } })
          .on_click((_event, cx) => choose(action, cx)).child(action.label),
      ]));
  }
}

export default class FileViewer {
  init(cx) {
    this.handle = cx.focus_handle();
    this.entries = new Map();
    this.expanded = new Set();
    this.pending = new Set();
    this.dirty = new Set();
    this.errors = new Map();
    this.status = new Map();
    this.limited = new Set();
    this.tabs = []; this.file = null; this.preview = null;
    this.optionsMenu = new DropdownMenuState(cx);
  }

  get doc() { return this.tabs.find(doc => doc.path === this.file) || null; }
  get code() { return this.doc?.code || null; }
  get markdown() { return this.doc ? this.doc.markdown : null; }
  get fileError() { return this.doc?.error || null; }
  get wrapTabs() { return shared('devkits.files-wrap-tabs') === true; }

  close() {
    this.watcher?.cancel(); this.poll?.cancel(); this.queued?.cancel();
    this.queued = null;
    this.context = null;
    for (const doc of this.tabs) doc.code?.release();
    this.tabs = []; this.file = null; this.preview = null;
  }

  /** Saves this project's tabs, writing only when they changed. */
  remember() {
    if (!this.context?.folder) return;
    const key = projectKey(this.context), all = shared('devkits.files-tabs') || {};
    const session = this.tabs.length ? { paths: this.tabs.map(doc => doc.path), file: this.file, preview: this.preview } : undefined;
    if (JSON.stringify(all[key]) === JSON.stringify(session)) return;
    const next = { ...all };
    session ? next[key] = session : delete next[key];
    setShared('devkits.files-tabs', next);
  }

  refresh(project, cx) {
    this.close();
    this.context = project ? { ...project } : null;
    this.entries.clear(); this.expanded.clear(); this.pending.clear(); this.dirty.clear(); this.errors.clear(); this.status = new Map();
    this.cursor = null; this.limited = new Set();
    if (!project?.folder) return;
    this.observe(cx); this.loadFolder('', cx); this.loadStatus(cx);
    const session = shared('devkits.files-tabs')?.[projectKey(project)];
    if (session?.paths?.length) {
      this.tabs = session.paths.map(openDocument); this.preview = session.preview;
      this.activate(session.file, cx);
    }
  }

  observe(cx) {
    const context = this.context;
    this.watchFailed = false;
    if (!context.machine) this.watcher = cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const paths = await watchFolder(context.folder);
          if (this.context !== context) return;
          const rests = paths.map(path => path.slice(context.folder.length).replaceAll('\\', '/'));
          if (!rests.some(rest => !rest.split('/').includes('.git'))) {
            // A commit, checkout or staging change recolors names without changing the tree.
            if (rests.some(rest => /(^|\/)\.git\/(HEAD|index|packed-refs|refs\/|info\/exclude)/.test(rest))) this.loadStatus(cx);
            continue;
          }
          if (!this.queued) this.queued = cx.timer.after(300, cx => {
            this.queued = null;
            if (this.context === context) this.reload(cx);
          });
        }
      } catch { if (this.context === context) this.watchFailed = true; }
    });
    // Remote folders and platforms where native watching fails use a data timer.
    this.poll = cx.timer.every(10000, cx => {
      if (this.context === context && (context.machine || this.watchFailed)) this.reload(cx);
    });
  }

  reload(cx) {
    if (!this.context?.folder) return;
    for (const path of new Set(['', ...this.expanded])) this.loadFolder(path, cx);
    // Background tabs reread when they are next shown.
    for (const doc of this.tabs) doc.stale = true;
    if (this.doc) this.load(this.doc, cx);
    this.loadStatus(cx);
  }

  loadStatus(cx) {
    if (this.statusLoading) { this.statusDirty = true; return; }
    const context = this.context;
    this.statusLoading = true;
    let changed = false;
    cx.spawn(async cx => {
      try {
        const status = await gitStatus(context.folder, context.machine);
        // Repaint only when a color actually changes.
        const same = status.size === this.status.size && [...status].every(([path, kind]) => this.status.get(path) === kind);
        if (this.context === context && !same) { this.status = status; changed = true; }
      } catch {} finally {
        this.statusLoading = false;
        if (this.context === context && this.statusDirty) { this.statusDirty = false; this.loadStatus(cx); }
        if (changed) cx.notify();
      }
    });
  }

  loadFolder(path, cx) {
    if (this.pending.has(path)) { this.dirty.add(path); return; }
    const context = this.context;
    this.pending.add(path); this.errors.delete(path);
    cx.spawn(async cx => {
      try {
        const entries = await directory(path ? `${context.folder}/${path}` : context.folder, context.machine);
        if (this.context !== context) return;
        const used = [...this.entries].filter(([key]) => key !== path).reduce((n, [, rows]) => n + rows.length, 0);
        const count = Math.max(0, Math.min(PER_FOLDER, TOTAL - used));
        this.entries.set(path, entries.slice(0, count));
        // Tracked per folder, so a refresh never hides the notice while other folders reload.
        entries.length > count ? this.limited.add(path) : this.limited.delete(path);
      } catch (error) { if (this.context === context) this.errors.set(path, String(error.message || error)); }
      finally {
        if (this.context === context) {
          this.pending.delete(path);
          if (this.dirty.delete(path)) this.loadFolder(path, cx);
        }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else {
      this.expanded.add(path);
      if (!this.entries.has(path) || this.errors.has(path)) this.loadFolder(path, cx);
    }
    cx.notify();
  }

  /** Opens a file as Zed does: a single click reuses the italic preview tab; pinning keeps it. */
  show(path, cx, pin = false) {
    let doc = this.tabs.find(doc => doc.path === path);
    if (!doc) {
      doc = openDocument(path);
      const previewIndex = this.tabs.findIndex(other => other.path === this.preview);
      if (!pin && previewIndex >= 0) { this.tabs[previewIndex].code?.release(); this.tabs[previewIndex] = doc; }
      else this.tabs.push(doc);
      if (!pin) this.preview = path;
    } else if (pin && this.preview === path) this.preview = null;
    this.file = path;
    this.load(doc, cx);
    this.remember();
    cx.notify();
  }

  activate(path, cx) {
    this.file = this.tabs.some(doc => doc.path === path) ? path : this.tabs[0]?.path || null;
    const doc = this.doc;
    if (doc && (!doc.loaded || doc.stale)) this.load(doc, cx);
    this.remember();
    cx.notify();
  }

  pin(path, cx) {
    if (this.preview === path) this.preview = null;
    this.activate(path, cx);
  }

  closeTab(path, cx) {
    const index = this.tabs.findIndex(doc => doc.path === path);
    if (index < 0) return;
    this.tabs.splice(index, 1)[0].code?.release();
    if (this.preview === path) this.preview = null;
    if (this.hoveredTab === path) this.hoveredTab = null;
    // Closing the shown tab shows its right neighbour, or the left one at the end.
    if (this.file === path) this.activate((this.tabs[index] || this.tabs[index - 1])?.path, cx);
    this.remember();
    cx.notify();
  }

  toggleWrapTabs(cx) {
    setShared('devkits.files-wrap-tabs', !this.wrapTabs);
    cx.notify();
  }

  load(doc, cx) {
    const request = ++doc.request, context = this.context;
    doc.stale = false;
    const current = () => request === doc.request && this.context === context && this.tabs.includes(doc);
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${context.folder}/${doc.path}`, { on: context.machine });
        if (!current()) return;
        if (text === null) throw new Error('This file is no longer available.');
        if (text.includes('\0')) throw new Error('Binary file — no text preview.');
        // shortcut: cap preview rendering at 400k characters; add paging if larger files are needed.
        const value = text.length > 400000 ? text.slice(0, 400000) + '\n… (preview truncated)' : text;
        doc.error = null;
        if (/\.(md|markdown)$/i.test(doc.path)) { doc.markdown = value; return; }
        // Updating the existing editor keeps its scroll position.
        if (doc.code) {
          if (doc.code.value() !== value) doc.code.set_value(value);
          return;
        }
        const ext = doc.path.split('.').pop().toLowerCase(), t = theme();
        doc.code = EditorState.new({ readonly: true, soft_wrap: true, language: LANG[ext] || ext,
          value,
          font_family: settings().font_family, font_size: 13,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch (error) {
        if (current()) {
          doc.code?.release(); doc.code = null;
          doc.markdown = null;
          doc.error = String(error.message || 'Cannot preview this file (unreadable, non-UTF-8, or larger than 1 MiB).');
        }
      } finally {
        if (current()) doc.loaded = true;
        cx.notify();
      }
    });
  }

  rows(prefix = '', depth = 0, out = [], parentIgnored = false) {
    if (depth > 40) return out;
    for (const entry of this.entries.get(prefix) || []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const ignored = parentIgnored || this.status.get(path) === 'ignored';
      out.push({ ...entry, path, depth, ignored });
      if (entry.dir && this.expanded.has(path)) this.rows(path, depth + 1, out, ignored);
    }
    return out;
  }

  navigate(event, cx) {
    const rows = this.rows(), index = rows.findIndex(row => row.path === this.cursor);
    const row = rows[index];
    if (event.key === 'down') this.cursor = rows[Math.min(index + 1, rows.length - 1)]?.path;
    else if (event.key === 'up') this.cursor = rows[Math.max(index - 1, 0)]?.path;
    else if (row && (event.key === 'enter' || event.key === 'space')) row.dir ? this.toggle(row.path, cx) : this.show(row.path, cx);
    else if (row && event.key === 'right' && row.dir && !this.expanded.has(row.path)) this.toggle(row.path, cx);
    else if (row && event.key === 'left') {
      if (row.dir && this.expanded.has(row.path)) this.toggle(row.path, cx);
      else this.cursor = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : row.path;
    } else return;
    cx.stop_propagation(); cx.notify();
  }

  openMenu(path, at, cx) {
    this.handle.focus(); this.cursor = path;
    openOverlay({ mod: 'devkits', kind: 'popup', frame: 'none', width: 224, at,
      props: { view: 'file-menu', folder: this.context.folder, machine: this.context.machine, path } });
    cx.notify();
  }

  render(project, cx) {
    if (this.context?.id !== project?.id || this.context?.folder !== project?.folder || this.context?.machine !== project?.machine) this.refresh(project, cx);
    const t = theme();
    return h_flex().id('file-viewer').flex_row_reverse().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(v_flex().w(240).flex_none().min_h(0).h_full().bg(t.chrome).border_l(1).border_color(t.border)
        .child(h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().child(project?.name || 'Files')))
        .child(v_flex().id('file-tree').flex_1().min_h(0).overflow_y_scrollbar()
          .track_focus(this.handle).on_key_down((event, cx) => this.navigate(event, cx))
          .children(this.rows().map(row => v_flex().flex_none()
            .child(TreeItem(`file-${row.path}`, row.depth, this.cursor === row.path || this.file === row.path, t)
              .accessibility_label(`${row.dir ? 'Folder' : 'File'} ${row.path}`)
              .on_mouse_down('right', (event, cx) => {
                cx.stop_propagation(); this.openMenu(row.path, event.position, cx);
              })
              .on_click((event, cx) => {
                this.handle.focus(); this.cursor = row.path;
                // The first click of a double-click already previewed the file; the second keeps it open.
                row.dir ? event.click_count < 2 && this.toggle(row.path, cx) : this.show(row.path, cx, event.click_count >= 2);
              })
              .child(TreeItemIcon(icon(row.dir ? (this.expanded.has(row.path) ? 'folder-open' : 'folder') : 'file').text_color(row.ignored ? t.dim : t.muted)))
              .child(TreeItemLabel(t).text_color(row.ignored ? t.dim : GitStatusColor[this.status.get(row.path)] || t.foreground)
                .child(row.name)))
            // Only a folder's first read shows Loading; refreshes keep the current rows until the new ones arrive.
            .when(row.dir && this.expanded.has(row.path) && ((this.pending.has(row.path) && !this.entries.has(row.path)) || this.errors.has(row.path)), el => el
              .child(div().px(12).py(4).text_size(11).text_color(t.muted).child(this.errors.get(row.path) || 'Loading…')))))
          .when(!this.entries.get('')?.length, el => el.child(div().p(12).text_size(12).text_color(t.muted)
            .child(this.errors.get('') || (this.pending.has('') ? 'Loading files…' : 'No files'))))
          .when(this.limited.size > 0, el => el.child(div().p(12).text_size(11).text_color(t.muted).child('List limited to 500 entries per folder and 5,000 total.')))))
      .child(v_flex().flex_1().min_w(0).min_h(0).h_full()
        .when(this.tabs.length > 0, el => el.child(this.tabBar(t)))
        .when(Boolean(this.doc), el => el.child(this.markdown !== null ? v_flex().id(`markdown-preview-${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().p(24)
          .child(TextView.markdown(`markdown-${this.file}`, this.markdown).selectable(true).scrollable(false).w_full())
          : this.code ? Editor.new(this.code).flex_1().min_h(0) : Empty(t).flex_1()
          .child(EmptyTitle().child(this.fileError ? 'Preview unavailable' : 'Loading file…'))
          .child(EmptyDescription(t).child(this.fileError || '')))));
  }

  tabBar(t) {
    const wrap = this.wrapTabs, name = path => path.slice(path.lastIndexOf('/') + 1);
    const counts = new Map();
    for (const doc of this.tabs) counts.set(name(doc.path), (counts.get(name(doc.path)) || 0) + 1);
    const list = wrap ? h_flex().flex_wrap() : h_flex().id('file-tab-list').overflow_x_scroll();
    return h_flex().id('file-tabs').flex_none().items_start().bg(t.chrome).border_b(1).border_color(t.border)
      .child(list.flex_1().min_w(0).role('tab_list').accessibility_label('Open files')
        .children(this.tabs.map((doc, index) => {
          const active = doc.path === this.file, preview = doc.path === this.preview, base = name(doc.path);
          const folder = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '';
          return Button(`file-tab-${doc.path}`, t, { variant: 'ghost' }).h(32).max_w(240).pl(12).pr(6).gap(6).justify_start()
            .border_r(1).border_color(t.border).bg(active ? t.background : t.chrome).text_color(active ? t.foreground : t.muted)
            .role('tab').selected(active).set_position(index + 1, this.tabs.length)
            .accessibility_label(`${doc.path}${preview ? ', preview' : ''}`)
            .on_hover((inside, cx) => {
              if (!inside && this.hoveredTab !== doc.path) return;
              this.hoveredTab = inside ? doc.path : null; cx.notify();
            })
            .on_click((event, cx) => event.click_count >= 2 ? this.pin(doc.path, cx) : this.activate(doc.path, cx))
            .on_mouse_down('middle', (_event, cx) => { cx.stop_propagation(); this.closeTab(doc.path, cx); })
            .child(icon('file').text_color(t.muted))
            // Italic alone vanishes in UI fonts without an italic face, so a preview tab is also one step dimmer.
            .child(div().min_w(0).truncate().text_size(12).when(preview, el => el.italic().text_color(active ? t.muted : t.dim)).child(base))
            // Same-named files show their folder, as Zed does.
            .when(counts.get(base) > 1 && Boolean(folder), el => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(folder)))
            .child(Button(`close-file-tab-${doc.path}`, t, { variant: 'row', size: 'icon-sm' })
              .opacity(active || this.hoveredTab === doc.path ? 1 : 0)
              .accessibility_label(`Close ${base}`)
              .on_click((_event, cx) => { cx.stop_propagation(); this.closeTab(doc.path, cx); })
              .child(icon('close').size(12)));
        })))
      .child(DropdownMenu('file-tab-options', this.optionsMenu,
        Button('file-tab-options-trigger', t, { variant: 'ghost', size: 'icon' }).h(32).w(32)
          .accessibility_label('Tab options').child(icon('ellipsis')),
        [{ key: 'wrap-tabs', label: 'Wrap tabs', checked: wrap }],
        (_key, cx) => this.toggleWrapTabs(cx), t, { offset: { x: 8, y: 9 } }));
  }
}
