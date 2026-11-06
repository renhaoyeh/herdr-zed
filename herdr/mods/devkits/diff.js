import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, Editor, EditorState } from 'gpui-base';
import { watchFolder, settings, theme, shared, setShared, notify } from 'herdr';
import { execShell } from './shell.js';
import { Button } from './components/button.js';
import { DropdownMenu, DropdownMenuState } from './components/dropdown-menu.js';
import { TreeItem, TreeItemIcon, TreeItemLabel, GitStatusColor } from './components/tree.js';
import { Empty, EmptyDescription } from './components/empty.js';
import { CommitHistory } from './git-history.js';
import { gitAccount, setGitAccount, readGitAccounts, gitAuthArgs } from './git-auth.js';

const icon = name => svg(`mods/devkits/assets/icons/${name}.svg`).size(12).flex_none();
const MAX_BYTES = 4000000, MAX_ROWS = 20000, MAX_LINE = 2000;
const LINE = 20, HEADER = 32, GAP = 8, SEPARATOR = 12;
// Code uses a monospace font. Reserve two columns for wide/fallback glyphs;
// combining marks stay attached to their preceding character without using a column.
const zeroWidth = /[\p{Mark}\u200d\ufe0e\ufe0f]/u;
const wide = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{1f000}-\u{1ffff}\u{20000}-\u{3ffff}]/u;

/** Soft-wrap a source line into visual rows, preserving text and UTF-16 highlight offsets. */
export function wrapLine(line, columns) {
  if (!line) return [];
  columns = Math.max(2, columns);
  // Most lines already fit. Avoid walking every character (and running Unicode
  // expressions for each) inside the native renderer's script budget.
  if (line.text.length * 2 <= columns || (line.text.length <= columns && !wide.test(line.text))) return [line];
  const parts = [];
  let start = 0, offset = 0, used = 0, boundary = 0, hasText = false;
  for (const char of line.text) {
    const width = zeroWidth.test(char) ? 0 : wide.test(char) ? 2 : 1;
    if (used + width > columns && offset > start) {
      const end = boundary > start ? boundary : offset;
      parts.push([start, end]);
      start = end;
      // A word moved to the next row; include the characters already scanned in it.
      used = 0;
      for (const kept of line.text.slice(start, offset)) used += zeroWidth.test(kept) ? 0 : wide.test(kept) ? 2 : 1;
      hasText = used > 0;
      boundary = start;
      if (used + width > columns && offset > start) {
        parts.push([start, offset]);
        start = offset; used = 0; hasText = false;
      }
    }
    used += width;
    offset += char.length;
    if (/\s/u.test(char)) { if (hasText) boundary = offset; }
    else hasText = true;
  }
  parts.push([start, line.text.length]);
  return parts.map(([start, end], index) => {
    const marks = line.marks && [Math.max(start, line.marks[0]), Math.min(end, line.marks[1])];
    return { ...line, text: line.text.slice(start, end), old: index ? undefined : line.old, new: index ? undefined : line.new,
      marks: marks && marks[0] < marks[1] ? [marks[0] - start, marks[1] - start] : null };
  });
}
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

export async function readDiffText(folder, on) {
  const result = await execShell(['-c', SCRIPT, 'devkits-diff', folder], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read changes.');
  return result.stdout;
}

export async function readDiff(folder, on) {
  const text = await readDiffText(folder, on);
  return { files: parseDiff(text), truncated: text.length >= MAX_BYTES };
}

/** Read only refs and configuration; this must also work in a clean or unborn repository. */
export async function readPushState(folder, on) {
  const result = await execShell(['-c', 'cd "$1" || exit 2; '
    + 'git rev-parse --git-dir >/dev/null 2>&1 || exit 3; '
    + 'branch=$(git symbolic-ref --quiet --short HEAD); commit=$(git rev-parse --verify -q HEAD); '
    + 'counts=$(git rev-list --left-right --count "HEAD...@{upstream}" 2>/dev/null); '
    + 'upstream=; if [ -n "$branch" ]; then upstream=$(git for-each-ref --format="%(upstream)" "refs/heads/$branch"); fi; '
    + 'push_remote=$(git config --get "branch.$branch.pushRemote" || git config --get remote.pushDefault || git config --get "branch.$branch.remote"); '
    + 'printf "%s\n%s\n%s\n%s\n%s\n" "$branch" "$commit" "$counts" "$upstream" "$push_remote"; git remote', 'devkits-push-state', folder], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read Git branch.');
  const [branch, commit, counts, upstream, configuredRemote, ...remoteLines] = result.stdout.split(/\r?\n/);
  const remotes = remoteLines.filter(Boolean);
  const match = /^(\d+)\s+(\d+)$/.exec(counts || '');
  return { branch: branch || null, committed: /^[a-f0-9]{40,64}$/.test(commit || ''), remote: remotes.length > 0, remotes,
    upstream: !upstream ? 'none' : match ? 'tracked' : 'gone',
    pushRemote: configuredRemote || (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null),
    ahead: match ? Number(match[1]) : null, behind: match ? Number(match[2]) : null, revision: commit || null };
}

export async function pushBranch(folder, on) {
  return gitRemoteAction(folder, on, 'push');
}

const gitActions = [
  { key: 'fetch', label: 'Fetch', progress: 'Fetching…', args: ['fetch'] },
  { key: 'pull', label: 'Pull', progress: 'Pulling…', args: ['pull'] },
  { key: 'pull-rebase', label: 'Pull (Rebase)', progress: 'Rebasing…', args: ['pull', '--rebase'] },
  { key: 'push', label: 'Push', progress: 'Pushing…', args: ['push'] },
  { key: 'publish', label: 'Publish', progress: 'Publishing…', args: ['push', '--set-upstream'] },
  { key: 'republish', label: 'Republish', progress: 'Publishing…', args: ['push', '--set-upstream'] },
  { key: 'force-push', label: 'Force Push (with lease)', progress: 'Pushing…', args: ['push', '--force-with-lease'] },
];

export async function gitRemoteAction(folder, on, action, remote, account) {
  const operation = gitActions.find(item => item.key === action);
  if (!operation) throw new Error('Unknown Git operation.');
  const publish = action === 'publish' || action === 'republish';
  if (publish && !remote) throw new Error('Choose a Git remote to publish to.');
  const args = [...operation.args, ...(remote ? ['--', remote] : action === 'fetch' ? ['--all'] : [])];
  const script = 'cd "$1" || exit 2; shift; '
    + (publish ? 'branch=$(git symbolic-ref --quiet --short HEAD) || exit 3; set -- "$@" "HEAD:refs/heads/$branch"; ' : '')
    + 'GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git "$@"';
  const result = await execShell(['-c', script,
    'devkits-git', folder, ...gitAuthArgs(account), ...args], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${operation.label} failed.`);
}

/** Only commits move HEAD; other .git activity cannot change a working-tree diff against it. */
export const affectsDiff = rest => {
  rest = rest.replaceAll('\\', '/');
  return !rest.split('/').includes('.git') || /(^|\/)\.git\/(HEAD|packed-refs|refs\/)/.test(rest);
};

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
export function pairLines(lines, limit = Infinity) {
  const pairs = [];
  for (let i = 0; i < lines.length && pairs.length < limit;) {
    if (lines[i].type === 'ctx') { pairs.push({ left: lines[i], right: lines[i] }); i++; continue; }
    // Locate replacements without allocating arrays for the entire change block.
    // Only materialize pairs that can fit in the multibuffer's remaining rows.
    const deleted = i;
    while (lines[i]?.type === 'del') i++;
    const added = i, remaining = limit - pairs.length;
    while (i - added < remaining && lines[i]?.type === 'add') i++;
    const count = Math.min(remaining, Math.max(added - deleted, i - added));
    for (let n = 0; n < count; n++) pairs.push({
      left: n < added - deleted ? lines[deleted + n] : null,
      right: n < i - added ? lines[added + n] : null,
    });
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

// Match dependency lockfiles by basename, including nested workspaces.
export const isLockFile = path => /(?:\.lock|(?:^|-)lock\.(?:json|ya?ml)|^npm-shrinkwrap\.json|^bun\.lockb)$/i.test(path.split(/[\\/]/).at(-1));

export default class DiffViewer {
  init(cx) {
    this.files = [];
    this.collapsed = new Set();
    this.folders = new Set();
    this.request = 0;
    this.scroll = VirtualListScrollHandle.new();
    this.gitMenu = new DropdownMenuState(cx);
    this.optionsMenu = new DropdownMenuState(cx);
    this.panelTab = 'changes';
    this.history = new CommitHistory(cx, text => {
      this.rowCache = null; this.collapsed.clear(); this.selected = null;
      this.scroll.scroll_to_item(0, 'top');
      return parseDiff(text);
    });
  }

  close() {
    this.rowTask?.cancel(); this.rowTask = null; this.rowJob = null;
    this.visibleRows = null; this.pendingReveal = null;
    this.toastTimer?.cancel(); this.toastTimer = null; this.toastVisible = false;
    this.output?.release(); this.output = null;
    this.watcher?.cancel(); this.poll?.cancel(); this.queued?.cancel();
    this.queued = null;
    this.context = null;
    this.history.reset(null);
    this.request++;
  }

  refresh(project, cx) {
    this.close();
    this.context = project ? { ...project } : null;
    this.nativeBranch = project?.branch || null;
    this.history.reset(this.context);
    this.files = []; this.collapsed.clear(); this.folders.clear(); this.rowCache = null; this.selected = null;
    this.error = null; this.loaded = false; this.truncated = false; this.diffText = null;
    this.loading = false; this.dirty = false;
    this.pushState = null; this.pushStateError = null; this.pushResult = null;
    this.accounts = null; this.accountsError = null; this.accountsLoading = false;
    this.gitMenu.open = false; this.gitMenu.page = null;
    this.optionsMenu.open = false;
    if (project?.folder) {
      const context = this.context;
      // refresh is called by render. Starting watchers/Git reads here shares
      // that first frame's script budget; History.load also notifies its view.
      // Resume with a task context after render, and ignore a project left meanwhile.
      cx.spawn(async cx => {
        await cx.sleep(0);
        if (this.context !== context) return;
        this.observe(cx);
        this.reload(cx);
        if (this.panelTab === 'history') this.history.load(cx);
      });
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
          if (!rests.some(rest => affectsDiff(rest) || /(^|\/)\.git\/config$/.test(rest))) continue;
          if (!this.queued) this.queued = cx.timer.after(500, cx => {
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
    let changed = !this.loaded;
    cx.spawn(async cx => {
      try {
        const [text, state] = await Promise.all([
          readDiffText(context.folder, context.machine),
          readPushState(context.folder, context.machine).then(value => ({ value }), error => ({ error: String(error.message || error) })),
        ]);
        if (request !== this.request || this.context !== context) return;
        if (JSON.stringify(state.value) !== JSON.stringify(this.pushState) || (state.error || null) !== this.pushStateError) {
          const changedHead = state.value?.revision !== this.pushState?.revision;
          this.pushState = state.value; this.pushStateError = state.error || null; changed = true;
          if (changedHead && this.panelTab === 'history') this.history.load(cx);
        }
        // Like Zed, keep what is shown until the result actually differs; most events change nothing.
        if (text !== this.diffText || this.error) {
          this.diffText = text; this.files = parseDiff(text); this.truncated = text.length >= MAX_BYTES;
          this.error = null; this.rowCache = null; changed = true;
        }
      } catch (error) {
        if (request === this.request && this.context === context) {
          this.diffText = null; this.files = []; this.rowCache = null; this.error = String(error.message || error); changed = true;
          this.pushState = null; this.pushStateError = this.error;
        }
      } finally {
        if (this.context === context) {
          this.loading = false; this.loaded = true;
          if (this.dirty) { this.dirty = false; this.reload(cx); }
        }
        if (changed) cx.notify();
      }
    });
  }

  push(cx) { this.remoteAction('push', cx); }

  primaryRemoteAction() {
    const state = this.pushState;
    if (!state?.branch || !state.committed) return 'fetch';
    if (state.upstream === 'none') return 'publish';
    if (state.upstream === 'gone') return 'republish';
    return state.behind > 0 ? 'pull' : state.ahead > 0 ? 'push' : 'fetch';
  }

  remoteAction(action, cx, remote) {
    if (this.pushing || this.pushUnavailable(action)) return;
    if (action === 'push' && ['none', 'gone'].includes(this.pushState.upstream)) {
      action = this.pushState.upstream === 'gone' ? 'republish' : 'publish';
    }
    if (action === 'publish' || action === 'republish') {
      remote ||= this.pushState.pushRemote;
      if (!remote) {
        this.gitMenu.page = action; this.gitMenu.index = 0; this.gitMenu.open = true;
        this.gitMenu.focus?.focus(); cx.notify();
        return;
      }
    }
    const operation = gitActions.find(item => item.key === action);
    if (!operation) return;
    const context = this.context;
    this.toastTimer?.cancel(); this.toastTimer = null; this.toastVisible = false;
    this.pushing = context; this.operation = operation; this.pushResult = null;
    this.gitMenu.open = false; this.gitMenu.page = null;
    cx.notify();
    cx.spawn(async cx => {
      let message = `${operation.label} completed.`, failed = false;
      try { await gitRemoteAction(context.folder, context.machine, action, remote, gitAccount(context)); }
      catch (error) { message = String(error.message || error); failed = true; }
      // Read the new ahead/behind counts before re-enabling the button, so it never shows the pre-push counts.
      if (this.context === context) {
        try {
          const state = await readPushState(context.folder, context.machine);
          if (this.context === context) {
            if (state.revision !== this.pushState?.revision && this.panelTab === 'history') this.history.load(cx);
            this.pushState = state; this.pushStateError = null;
          }
        } catch {}
      }
      this.pushing = null;
      if (this.context === context) {
        this.pushResult = { message, failed };
        this.resultTitle = `${operation.label} ${failed ? 'failed' : 'completed'}`;
        this.toastVisible = true;
        if (!failed) this.toastTimer = cx.timer.after(5000, cx => {
          this.toastVisible = false; this.toastTimer = null; cx.notify();
        });
        this.reload(cx);
      } else notify({ title: `${operation.label} ${failed ? 'failed' : 'completed'}`, body: context.name || context.folder, level: failed ? 'error' : 'success' });
      cx.notify();
    });
  }

  pushUnavailable(action = 'push') {
    if (!this.pushState) return this.pushStateError || (this.loaded ? 'Git branch unavailable' : 'Loading branch…');
    if (action !== 'fetch' && !this.pushState.branch) return 'Check out a branch first';
    if (action !== 'fetch' && !this.pushState.committed) return 'Create a commit first';
    if (!this.pushState.remote) return 'No Git remote configured';
    return null;
  }

  loadAccounts(cx) {
    if (this.accountsLoading) return;
    const context = this.context;
    this.accountsLoading = true; this.accountsError = null;
    cx.spawn(async cx => {
      try {
        const accounts = await readGitAccounts(context.machine);
        if (this.context === context) this.accounts = accounts;
      } catch {
        if (this.context === context) this.accountsError = 'Run gh auth login on this machine, then retry.';
      } finally {
        if (this.context === context) { this.accountsLoading = false; cx.notify(); }
      }
    });
  }

  openLog(cx) {
    if (!this.pushResult) return;
    this.output?.release();
    this.outputTitle = this.resultTitle;
    this.output = EditorState.new({ readonly: true, soft_wrap: true,
      value: this.pushResult.message, font_family: settings().font_family, font_size: 13 });
    this.toastVisible = false;
    cx.notify();
  }

  outputView(t) {
    return v_flex().id('git-output').flex_1().min_w(0).min_h(0).h_full()
      .child(h_flex().h(32).flex_none().pl(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(`Git output: ${this.outputTitle}`))
        .child(Button('git-output-close', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('Close Git output').child(icon('close'))
          .on_click((_event, cx) => { this.output.release(); this.output = null; cx.notify(); })))
      .child(Editor.new(this.output).flex_1().min_h(0));
  }

  resultToast(t) {
    return h_flex().id('git-result-toast').absolute().bottom(48).right(12).max_w(480)
      .px(12).py(8).gap(8).items_center().bg(t.chrome).border(1).border_color(t.border)
      .child(icon(this.pushResult.failed ? 'circle-alert' : 'circle-check')
        .text_color(this.pushResult.failed ? t.destructive || t.foreground : t.muted))
      .child(div().min_w(0).text_size(12).child(this.resultTitle))
      .when(this.pushResult.failed, el => el.child(Button('git-view-log', t, { variant: 'secondary' }).h(26).px(8)
        .child('View Log').on_click((_event, cx) => this.openLog(cx))))
      .child(Button('git-toast-close', t, { variant: 'ghost', size: 'icon-sm' })
        .accessibility_label('Dismiss Git notification').child(icon('close'))
        .on_click((_event, cx) => { this.toastVisible = false; cx.notify(); }));
  }

  pushFooter(t) {
    const branch = this.nativeBranch || this.pushState?.branch;
    const action = this.primaryRemoteAction();
    const operation = gitActions.find(item => item.key === action);
    const unavailable = this.pushUnavailable(action);
    const { ahead, behind } = this.pushState || {};
    const counts = `${behind > 0 ? `↓${behind} ` : ''}${ahead > 0 ? `↑${ahead} ` : ''}`;
    const pushUnavailable = Boolean(this.pushUnavailable('push'));
    const page = this.gitMenu.page;
    const account = gitAccount(this.context);
    const accountLabel = account?.login || 'Default';
    const items = page === 'accounts' ? [
      { key: 'back', label: '‹ Git operations' },
      { key: 'account:default', label: 'Default', checked: !account, disabled: Boolean(this.pushing) },
      ...(this.accounts || []).map((entry, index) => ({ key: `account:${index}`,
        label: entry.login, description: `${entry.host}${entry.available ? '' : ' · Sign in required'}`,
        checked: account?.host === entry.host && account?.login === entry.login,
        disabled: Boolean(this.pushing) || !entry.available })),
      ...(this.accountsLoading ? [{ key: 'accounts-loading', label: 'Loading accounts…', disabled: true }]
        : this.accountsError ? [{ key: 'accounts-error', label: 'Could not load accounts', description: 'Run gh auth login, then Retry', disabled: true }]
          : !this.accounts?.length ? [{ key: 'accounts-empty', label: 'No signed-in accounts', description: 'Run gh auth login', disabled: true }] : []),
      { key: 'accounts-retry', label: this.accountsError ? 'Retry' : 'Refresh accounts', disabled: this.accountsLoading },
    ] : page ? [
      { key: 'back', label: '‹ Git operations' },
      ...(this.pushState?.remotes || []).map(remote => ({ key: `remote:${remote}`, label: remote })),
      ...(page === 'fetch' && this.pushState?.remotes.length > 1 ? [{ key: 'all', label: 'All' }] : []),
    ] : [
      { key: 'fetch', label: 'Fetch', disabled: Boolean(this.pushUnavailable('fetch')) },
      { key: 'fetch-from', label: 'Fetch From…', disabled: Boolean(this.pushUnavailable('fetch')) },
      { key: 'pull', label: 'Pull', disabled: Boolean(this.pushUnavailable('pull')) },
      { key: 'pull-rebase', label: 'Pull (Rebase)', disabled: Boolean(this.pushUnavailable('pull-rebase')) },
      { key: 'push', label: 'Push', disabled: pushUnavailable, separator: true },
      { key: 'push-to', label: 'Push To…', disabled: pushUnavailable },
      { key: 'force-push', label: 'Force Push (with lease)', disabled: pushUnavailable },
      { key: 'accounts', label: 'GitHub account…', description: accountLabel, separator: true, disabled: Boolean(this.pushing) },
    ];
    const choose = (key, cx) => {
      if (key === 'accounts' || key === 'accounts-retry') {
        this.gitMenu.page = 'accounts'; this.gitMenu.index = 0; this.gitMenu.open = true;
        this.loadAccounts(cx);
      } else if (key.startsWith('account:')) {
        if (this.pushing) return;
        const chosen = key === 'account:default' ? null : this.accounts?.[Number(key.slice(8))];
        if (key !== 'account:default' && !chosen?.available) return;
        setGitAccount(this.context, chosen);
        this.gitMenu.page = null;
      } else if (key === 'back' || key === 'fetch-from' || key === 'push-to') {
        this.gitMenu.page = key === 'back' ? null : key === 'fetch-from' ? 'fetch' : 'push';
        this.gitMenu.index = 0; this.gitMenu.open = true;
      } else this.remoteAction(page || key, cx, page && key !== 'all' ? key.slice(7) : undefined);
    };
    return v_flex().id('diff-git-footer').flex_none().border_t(1).border_color(t.border)
      .child(h_flex().h(38).px(8).gap(8).items_center()
        .child(icon('branch').text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground)
          .accessibility_label(`Current branch: ${branch || (this.pushState ? 'Detached HEAD' : 'unavailable')}`)
          .child(branch || (this.pushState ? 'Detached HEAD' : '—')))
        .child(h_flex().flex_none().items_center()
          .child(Button('diff-push', t).h(26).px(10).font_medium()
            .disabled(Boolean(this.pushing || unavailable))
            .accessibility_label(`${operation.label} current branch${ahead == null ? '' : `, ${ahead} commits ahead, ${behind} commits behind upstream`}`)
            .on_click((_event, cx) => this.remoteAction(action, cx)).child(this.pushing ? this.operation.progress : `${counts}${operation.label}`))
          .child(DropdownMenu('diff-git-actions', this.gitMenu,
            Button('diff-git-menu', t, { size: 'icon' }).w(24).h(26).border_l(1).border_color(t.chrome)
              .disabled(Boolean(this.pushing)).accessibility_label('More Git operations')
              .child(icon('chevron-down')), items, choose, t, { side: 'top' }))));
  }

  toggle(path, cx) {
    this.collapsed.has(path) ? this.collapsed.delete(path) : this.collapsed.add(path);
    this.rowCache = null;
    cx.notify();
  }

  /** Jumps the multibuffer to a file's header, expanding the file if it was collapsed. */
  reveal(path, cx) {
    this.output?.release(); this.output = null;
    this.selected = path;
    this.pendingReveal = path;
    if (this.collapsed.delete(path)) this.rowCache = null;
    const index = this.rows(cx).rows.findIndex(row => row.key === `file:${path}`);
    if (index >= 0 && !this.rowJob) { this.scroll.scroll_to_item(index, 'top'); this.pendingReveal = null; }
    cx.notify();
  }

  toggleFolder(path, cx) {
    this.folders.has(path) ? this.folders.delete(path) : this.folders.add(path);
    cx.notify();
  }

  get commitPreview() { return this.panelTab === 'history' ? this.history.preview : null; }
  get hideLockFiles() { return shared('devkits.diff-hide-lock-files') !== false; }

  visibleFiles(files) {
    if (!this.hideLockFiles) return files;
    this.lockFileCache ||= new WeakMap();
    if (!this.lockFileCache.has(files)) this.lockFileCache.set(files, files.filter(file => !isLockFile(file.path)));
    return this.lockFileCache.get(files);
  }

  get displayFiles() { return this.visibleFiles(this.commitPreview?.files || this.files); }

  toggleLockFiles(cx) {
    setShared('devkits.diff-hide-lock-files', !this.hideLockFiles);
    this.rowCache = null; this.selected = null; this.pendingReveal = null;
    this.scroll.scroll_to_item(0, 'top');
    cx.notify();
  }

  setPanelTab(tab, cx) {
    this.output?.release(); this.output = null;
    if (this.panelTab === tab) { cx.notify(); return; }
    this.panelTab = tab; this.rowCache = null; this.collapsed.clear(); this.selected = null;
    this.scroll.scroll_to_item(0, 'top');
    if (tab === 'history') { this.history.load(cx); this.history.focus?.focus(); }
    cx.notify();
  }

  /** Zed's Git panel: collapsible Tracked/Untracked sections holding a tree with indent guides. */
  panel(t) {
    const files = this.visibleFiles(this.files);
    const status = file => file.untracked || file.status === 'added' ? ['square-plus', GitStatusColor.added]
      : file.status === 'deleted' ? ['square-minus', GitStatusColor.deleted] : ['square-dot', GitStatusColor.modified];
    const added = files.reduce((n, file) => n + file.added, 0), removed = files.reduce((n, file) => n + file.removed, 0);
    const tab = (key, label) => Button(`git-tab-${key}`, t, { variant: 'ghost' }).flex_1().min_w(0).h(32).px(8).gap(4)
      .when(this.panelTab === key, el => el.bg(t.selected).text_color(t.foreground))
      .accessibility_label(`${label}${this.panelTab === key ? ', selected' : ''}`)
      .on_click((_event, cx) => this.setPanelTab(key, cx)).child(label);
    // A full-height dock with its own header, as Zed's Git panel sits beside the editor.
    return v_flex().w(280).flex_none().min_h(0).h_full().bg(t.chrome).border_l(1).border_color(t.border)
      .child(h_flex().h(32).flex_none().items_center().border_b(1).border_color(t.border).text_size(12)
        .child(tab('changes', `Changes (${files.length})`).when(files.length > 0, el => el
          .child(div().text_color(GitStatusColor.added).child(`+${added}`))
          .child(div().text_color(GitStatusColor.deleted).child(`−${removed}`))))
        .child(tab('history', 'History')))
      .child(this.panelTab === 'history' ? this.history.render(t) : v_flex().id('diff-files').flex_1().min_h(0).overflow_y_scrollbar().py(4)
        .children(changeSections(files).map(section => {
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
        })))
      .child(this.pushFooter(t));
  }

  get split() { return shared('devkits.diff-layout') === 'split'; }
  get wrap() { return shared('devkits.diff-wrap') !== false; }

  toggleWrap(cx) {
    setShared('devkits.diff-wrap', !this.wrap);
    this.rowCache = null;
    cx.notify();
  }

  setLayout(layout, cx) {
    setShared('devkits.diff-layout', layout);
    this.rowCache = null;
    cx.notify();
  }

  rows(cx) {
    const options = { files: this.displayFiles, split: this.split, wrap: this.wrap, width: this.width, charWidth: this.charWidth,
      collapsed: [...this.collapsed].join('\0') };
    const matches = value => value && Object.keys(options).every(key => value[key] === options[key]);
    if (matches(this.rowCache)) return this.rowCache;
    if (!cx?.spawn || !options.files.length) {
      const builder = this.buildRows(options);
      let next;
      do { next = builder.next(); } while (!next.done);
      return this.rowCache = next.value;
    }
    if (!matches(this.rowJob)) {
      this.rowTask?.cancel();
      const job = this.rowJob = options;
      const builder = this.buildRows(options);
      this.rowTask = cx.spawn(async cx => {
        // Leave render before doing any work, then give each small batch a fresh
        // native script budget. Never publish rows from an obsolete build.
        for (;;) {
          await cx.sleep(0);
          if (this.rowJob !== job) return;
          const next = builder.next();
          if (!next.done) continue;
          this.rowCache = this.visibleRows = next.value;
          this.rowTask = null; this.rowJob = null;
          const index = next.value.rows.findIndex(row => row.key === `file:${this.pendingReveal}`);
          if (index >= 0) this.scroll.scroll_to_item(index, 'top');
          this.pendingReveal = null;
          cx.notify();
          return;
        }
      });
    }
    return this.visibleRows || { rows: [], sizes: [], gutter: 32, limited: false };
  }

  /** Fixed-height visual rows, built in bounded batches outside native render. */
  *buildRows(options) {
    const { files, split, width, charWidth } = options, collapsed = new Set(options.collapsed.split('\0'));
    const widest = Math.max(1, ...files.flatMap(file => file.hunks.map(hunk => hunk.lines.at(-1) ? Math.max(hunk.lines.at(-1).old || 0, hunk.lines.at(-1).new || 0) : 0)));
    const gutter = String(widest).length * 8 + 24;
    const cellWidth = split ? (width - 1) / 2 : width;
    const columns = options.wrap !== false && width ? Math.max(2, Math.floor((cellWidth - gutter - 24) / (charWidth || 13))) : Infinity;
    let textColumns = 0;
    const rows = [], sizes = [];
    const add = (row, size) => {
      if (rows.length >= MAX_ROWS) { limited = true; return false; }
      rows.push(row); sizes.push(size); return true;
    };
    let limited = false;
    files: for (const [index, file] of files.entries()) {
      yield;
      if (rows.length >= MAX_ROWS) { limited = true; break; }
      add({ key: `file:${file.path}`, kind: 'file', file, first: index === 0 }, index === 0 ? HEADER : HEADER + GAP);
      if (collapsed.has(file.path)) continue;
      if (file.binary || !file.hunks.length) add({ key: `note:${file.path}`, kind: 'note', text: file.binary ? 'Binary file' : 'No content changes' }, HEADER);
      for (const [h, hunk] of file.hunks.entries()) {
        if (h) add({ key: `gap:${file.path}:${h}`, kind: 'separator' }, SEPARATOR);
        // One extra pair lets the row builder detect truncation in Split too.
        const pairs = pairLines(hunk.lines, MAX_ROWS - rows.length + 1);
        yield;
        for (const [n, pair] of pairs.entries()) {
          if (n % 16 === 0) yield;
          if (options.wrap === false) for (const line of [pair.left, pair.right]) {
            let count = 0;
            for (const char of line?.text || '') count += zeroWidth.test(char) ? 0 : wide.test(char) ? 2 : 1;
            textColumns = Math.max(textColumns, count);
          }
          if (pair.left?.type === 'del' && pair.right?.type === 'add' && !pair.left.marks) {
            [pair.left.marks, pair.right.marks] = changedRanges(pair.left.text, pair.right.text);
          }
        }
        if (split) {
          for (const [n, pair] of pairs.entries()) {
            if (n % 4 === 0) yield;
            const left = wrapLine(pair.left, columns), right = wrapLine(pair.right, columns);
            for (let part = 0; part < Math.max(left.length, right.length); part++) {
              if (!add({ key: `pair:${file.path}:${h}:${n}:${part}`, kind: 'pair', left: left[part], right: right[part] }, LINE)) break files;
            }
          }
        } else for (const [n, line] of hunk.lines.entries()) {
          if (n % 4 === 0) yield;
          for (const [part, wrapped] of wrapLine(line, columns).entries()) {
            if (!add({ key: `line:${file.path}:${h}:${n}:${part}`, kind: 'line', line: wrapped }, LINE)) break files;
          }
        }
      }
    }
    const contentWidth = options.wrap === false
      ? Math.max(width || 0, (textColumns * (charWidth || 13) + gutter + 24) * (split ? 2 : 1) + (split ? 1 : 0))
      : width;
    return { ...options, rows, sizes, limited, gutter, contentWidth };
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
        .child(h_flex().h(HEADER).w_full().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
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
    this.nativeBranch = project?.branch || null;
    const t = theme(), mono = settings().font_family, { rows, sizes, limited, gutter, contentWidth, wrap } = this.rows(cx), split = this.split;
    const preview = this.commitPreview;
    const choice = (id, label, value) => Button(id, t, { variant: 'ghost', size: 'icon' }).size(24)
      .when(split === (value === 'split'), el => el.bg(t.selected).text_color(t.foreground))
      .accessibility_label(`${label} diff${split === (value === 'split') ? ', selected' : ''}`)
      .on_click((_event, cx) => this.setLayout(value, cx)).child(icon(`diff-${value}`).size(16));
    // The editor and the Git panel are side by side, each with its own 32px header, like Files.
    return h_flex().id('diff-viewer').relative().flex_row_reverse().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(this.panel(t))
      .child(this.output ? this.outputView(t) : v_flex().flex_1().min_w(0).min_h(0).h_full()
        .child(h_flex().h(32).flex_none().pl(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
          .child(div().flex_1().min_w(0).truncate().font_medium().child(preview ? `Commit ${preview.commit.shortSha}` : 'Uncommitted changes'))
          .when(rows.length > 0, el => el
            .child(choice('diff-unified', 'Unified', 'unified'))
            .child(choice('diff-split', 'Split', 'split')))
          .child(DropdownMenu('diff-options', this.optionsMenu,
            Button('diff-options-trigger', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
              .accessibility_label('Diff options').child(icon('ellipsis')),
            [{ key: 'wrap', label: 'Wrap', checked: this.wrap },
              { key: 'hide-lock-files', label: 'Hide lock files', checked: this.hideLockFiles }],
            (key, cx) => key === 'wrap' ? this.toggleWrap(cx) : this.toggleLockFiles(cx), t)))
        .when(Boolean(preview), el => el.child(v_flex().flex_none().max_h(160).overflow_y_scrollbar().px(12).py(8).gap(4).border_b(1).border_color(t.border)
          .child(div().text_size(11).text_color(t.muted).child(`${preview.commit.author} · ${new Date(preview.commit.at * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`))
          .child(div().text_size(13).child(preview.commit.message))))
        .when(this.panelTab === 'history' && Boolean(this.history.previewError), el => el.child(div().flex_none().px(12).py(8).text_size(12).text_color(t.muted)
          .child(this.history.previewError)))
        .when((preview ? preview.truncated : this.truncated) || limited, el => el.child(div().flex_none().px(12).py(6).text_size(11).text_color(t.muted).border_b(1).border_color(t.border)
          .child('Diff limited to 4 MB and 20,000 rows.')))
        .child(rows.length
          ? v_flex().id('diff-viewport').relative().flex_1().min_h(0)
            .on_size_change((size, cx) => {
              if (this.width === size.width) return;
              this.width = size.width;
              cx.notify();
            })
            .child(div().id('diff-character-width').absolute().invisible().flex_none().font_family(mono).text_size(13).whitespace_nowrap()
              .child('0000000000').on_size_change((size, cx) => {
                const width = size.width / 10;
                if (width <= 0 || this.charWidth === width) return;
                this.charWidth = width;
                cx.notify();
              }))
            .child(v_flex().id(wrap === false ? 'diff-horizontal' : 'diff-wrapped').size_full().min_w(0)
              .when(wrap === false, el => el.overflow_x_scrollbar())
              .child(v_virtual_list('diff-rows', rows.length, sizes, index => rows[index].key,
              range => rows.slice(range.start, range.end).map(row => this.row(row, t, mono, gutter)))
              .size_full().when(wrap === false, el => el.w(contentWidth).flex_none()).track_scroll(this.scroll)
              .on_item_click((key, cx) => { if (key.startsWith('file:')) this.toggle(key.slice(5), cx); })))
            .child(Scrollbar.vertical('diff-rows').absolute().inset_0())
          : Empty(t).flex_1().p(24).gap(4).font_family('Geist')
            .child(EmptyDescription(t).text_size(13).child(this.rowJob ? 'Loading changes…' : !this.displayFiles.length && (preview?.files || this.files).length ? 'All changed files are hidden by Hide lock files' : preview ? 'No file changes in this commit' : this.error ? 'Changes unavailable' : this.loaded ? 'No uncommitted changes' : 'Loading changes…'))
            .when(!preview && Boolean(this.error), el => el.child(EmptyDescription(t).child(this.error)))))
      .when(this.toastVisible, el => el.child(this.resultToast(t)));
  }
}
