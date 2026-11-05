import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, Editor, EditorState, TextView } from 'gpui-base';
import { exec, readTextFile, watchFolder, settings, theme } from 'herdr';
import { Button } from './components/button.js';
import { Empty, EmptyTitle, EmptyDescription } from './components/empty.js';

const icon = name => svg(`mods/devkits/assets/icons/${name}.svg`).size(14).flex_none();
const LANG = { ts: 'js', tsx: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js', jsonc: 'json', toml: 'yaml', vue: 'html', svelte: 'html' };
const PER_FOLDER = 500, TOTAL = 5000;

export async function directory(path, on) {
  // Paths are positional arguments; filenames never become shell code.
  const script = 'test -r "$1" && test -x "$1" && test -d "$1" || exit 1; n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; elif [ -f "$p" ]; then kind=f; else continue; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; exit 0';
  const result = await exec('sh', ['-c', script, 'devkits-files', path], { on });
  if (result.code !== 0) throw new Error(result.stderr || 'Cannot read this folder.');
  const fields = result.stdout.split('\0'), entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) entries.push({ name: fields[i + 1], dir: fields[i] === 'd' });
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export default class FileViewer {
  init(cx) {
    this.handle = cx.focus_handle();
    this.entries = new Map();
    this.expanded = new Set();
    this.pending = new Set();
    this.dirty = new Set();
    this.errors = new Map();
    this.request = 0;
    this.markdown = null;
  }

  close() {
    this.watcher?.cancel(); this.poll?.cancel(); this.queued?.cancel();
    this.queued = null;
    this.context = null;
    this.request++;
    this.code?.release();
    this.code = null;
    this.markdown = null;
  }

  refresh(project, cx) {
    const file = this.context?.folder === project?.folder && this.context?.machine === project?.machine ? this.file : null;
    this.close();
    this.context = project ? { ...project } : null;
    this.entries.clear(); this.expanded.clear(); this.pending.clear(); this.dirty.clear(); this.errors.clear();
    this.cursor = null; this.file = null; this.fileError = null; this.limited = false;
    if (project?.folder) { this.observe(cx); this.loadFolder('', cx); }
    if (file) this.show(file, cx);
  }

  observe(cx) {
    const context = this.context;
    this.watchFailed = false;
    if (!context.machine) this.watcher = cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const paths = await watchFolder(context.folder);
          if (this.context !== context) return;
          if (!paths.some(path => !path.slice(context.folder.length).split('/').includes('.git'))) continue;
          if (!this.queued) this.queued = cx.timer.after(100, cx => {
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
    this.limited = false;
    for (const path of new Set(['', ...this.expanded])) this.loadFolder(path, cx);
    if (this.file) this.show(this.file, cx, true);
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
        if (entries.length > count) this.limited = true;
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

  show(path, cx, updating = false) {
    const request = ++this.request, context = this.context;
    if (!updating) { this.code?.release(); this.code = null; this.markdown = null; }
    this.file = path; this.fileError = null;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${context.folder}/${path}`, { on: context.machine });
        if (request !== this.request || this.context !== context) return;
        if (text === null) throw new Error('This file is no longer available.');
        if (text.includes('\0')) throw new Error('Binary file — no text preview.');
        // shortcut: cap preview rendering at 400k characters; add paging if larger files are needed.
        const value = text.length > 400000 ? text.slice(0, 400000) + '\n… (preview truncated)' : text;
        if (/\.(md|markdown)$/i.test(path)) { this.markdown = value; return; }
        if (this.code) {
          if (this.code.value() !== value) this.code.set_value(value);
          return;
        }
        const ext = path.split('.').pop().toLowerCase(), t = theme();
        this.code = EditorState.new({ readonly: true, soft_wrap: true, language: LANG[ext] || ext,
          value,
          font_family: settings().font_family, font_size: 13,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch (error) {
        if (request === this.request && this.context === context) {
          this.code?.release(); this.code = null;
          this.markdown = null;
          this.fileError = String(error.message || 'Cannot preview this file (unreadable, non-UTF-8, or larger than 1 MiB).');
        }
      } finally { cx.notify(); }
    });
    cx.notify();
  }

  rows(prefix = '', depth = 0, out = []) {
    if (depth > 40) return out;
    for (const entry of this.entries.get(prefix) || []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push({ ...entry, path, depth });
      if (entry.dir && this.expanded.has(path)) this.rows(path, depth + 1, out);
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

  render(project, cx) {
    if (this.context?.id !== project?.id || this.context?.folder !== project?.folder || this.context?.machine !== project?.machine) this.refresh(project, cx);
    const t = theme();
    return h_flex().id('file-viewer').flex_row_reverse().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(v_flex().w(240).flex_none().min_h(0).h_full().bg(t.chrome).border_l(1).border_color(t.border)
        .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().tooltip(project?.folder || '').child(project?.name || 'Files')))
        .child(v_flex().id('file-tree').flex_1().min_h(0).overflow_y_scrollbar().py(6)
          .track_focus(this.handle).on_key_down((event, cx) => this.navigate(event, cx))
          .children(this.rows().map(row => v_flex().flex_none()
            .child(Button(`file-${row.path}`, t, { variant: 'ghost' }).h(28).mx(4).pl(8 + row.depth * 16).pr(8).justify_start()
              .bg(this.cursor === row.path || this.file === row.path ? t.selected : t.chrome)
              .accessibility_label(`${row.dir ? 'Folder' : 'File'} ${row.path}`).tooltip(row.path)
              .on_click((_event, cx) => {
                this.handle.focus(); this.cursor = row.path;
                row.dir ? this.toggle(row.path, cx) : this.show(row.path, cx);
              })
              .child(row.dir ? icon(this.expanded.has(row.path) ? 'chevron-down' : 'chevron-right') : div().w(14).flex_none())
              .when(row.dir, el => el.child(icon('folder')))
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(row.name)))
            .when(row.dir && this.expanded.has(row.path) && (this.pending.has(row.path) || this.errors.has(row.path)), el => el
              .child(div().px(12).py(4).text_size(11).text_color(t.muted).child(this.errors.get(row.path) || 'Loading…')))))
          .when(!this.entries.get('')?.length, el => el.child(div().p(12).text_size(12).text_color(t.muted)
            .child(this.errors.get('') || (this.pending.has('') ? 'Loading files…' : 'No files'))))
          .when(this.limited, el => el.child(div().p(12).text_size(11).text_color(t.muted).child('List limited to 500 entries per folder and 5,000 total.')))))
      .child(v_flex().flex_1().min_w(0).min_h(0).h_full()
        .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(12).tooltip(this.file || '').child(this.file || 'File preview'))
          .child(div().text_size(11).text_color(t.muted).child('Read only')))
        .child(this.markdown !== null ? v_flex().id(`markdown-preview-${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().p(24)
          .child(TextView.markdown(`markdown-${this.file}`, this.markdown).selectable(true).scrollable(false).w_full())
          : this.code ? Editor.new(this.code).flex_1().min_h(0) : Empty(t).flex_1()
          .child(EmptyTitle().child(this.file ? this.fileError ? 'Preview unavailable' : 'Loading file…' : 'Select a file'))
          .child(EmptyDescription(t).child(this.fileError || (this.file ? '' : 'Choose a file from the project tree.')))));
  }
}
