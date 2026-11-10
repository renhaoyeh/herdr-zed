import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, Editor, EditorState } from 'gpui-base';
import { watchFolder, settings, theme, shared, setShared, notify } from 'herdr';
import { execShell } from './shell.js';
import { readBuildRules, withBuildRulesFile } from './diff-ignore.js';
import { openBuildRules } from './diff-ignore-settings.js';
import { openGitAuthor } from './git-author-settings.js';
import { utf8ByteLength } from './utf8.js';
import { Button } from './components/button.js';
import { DropdownMenu, DropdownMenuState } from './components/dropdown-menu.js';
import { Select, SelectState } from './components/select.js';
import { TreeItem, TreeItemIcon, TreeItemLabel, GitStatusColor } from './components/tree.js';
import { Empty, EmptyDescription } from './components/empty.js';
import { CommitHistory, readCommitSummary } from './git-history.js';
import { GitGraph } from './git-graph.js';
import { SidePanelLayout, SidePanelState } from './components/side-panel.js';
import { gitAccount, setGitAccount, readGitAccounts, gitAuthArgs } from './git-auth.js';
import { showGitToast, clearGitToast } from './git-result-toast.js';

const icon = name => svg(`mods/devkits/assets/icons/${name}.svg`).size(12).flex_none();
// Native virtual lists accept at most 10,000 per-item sizes, including chrome rows.
const MAX_BYTES = 4000000, MAX_ROWS = 10000, MAX_LINE = 2000;
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
const INDEX_SCRIPT = 'cd "$1" || exit 2; git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not a Git repository." >&2; exit 3; }; '
  + 'cd "$(git rev-parse --show-toplevel)" || exit 2; '
  + 'base=$(git rev-parse --verify -q HEAD) || base=$(git hash-object -t tree /dev/null); '
  + 'printf "%s\\0%s\\0" "$base" "$PWD"; '
  + '{ git diff --no-ext-diff --no-textconv --find-renames --raw --numstat -z "$base" -- || exit; '
  + 'printf "\\0"; git ls-files -z --others --exclude-standard; printf "\\0"; '
  + 'if [ -n "$2" ]; then git ls-files -z --others --exclude-standard '
  + '| git -c core.excludesFile="$2" check-ignore --no-index --stdin -z; fi; } | head -c ' + (MAX_BYTES + 1);
const PATCH_SCRIPT = 'cd "$1" || exit 2; '
  + '{ if [ "$3" = untracked ]; then '
  + 'git -c core.quotepath=false diff --no-color --no-ext-diff --no-textconv --no-index -U3 -- /dev/null "$4"; '
  + 'else git -c core.quotepath=false diff --no-color --no-ext-diff --no-textconv --find-renames -U3 "$2" -- ":(literal)$4" ":(literal)$5"; fi; } '
  + '| head -n "$6" | head -c "$7"';

function unquote(path) {
  if (!path.startsWith('"')) return path;
  const escapes = { n: '\n', t: '\t', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' };
  const body = path.slice(1, -1);
  return body.replace(/((?:\\[0-7]{3})+)|\\(.)/g, (_match, octal, escaped) => {
    if (!octal) return escapes[escaped] ?? escaped;
    const encoded = octal.replace(/\\([0-7]{3})/g, (_match, value) => `%${parseInt(value, 8).toString(16).padStart(2, '0')}`);
    try { return decodeURIComponent(encoded); } catch { return '\ufffd'; }
  });
}
const strip = path => { const value = unquote(path.trim()); return value === '/dev/null' ? null : value.replace(/^[ab]\//, ''); };
const clean = text => {
  // Clip before expanding tabs: a single generated/minified line can be megabytes.
  const value = text.slice(0, MAX_LINE + 1).replaceAll('\t', '    ');
  return value.length > MAX_LINE ? value.slice(0, MAX_LINE) + ' …' : value;
};

/** Parses unified `git diff` output into one entry per file. */
export function parseDiff(text) {
  const parser = parseDiffBatches(text);
  let next;
  do { next = parser.next(); } while (!next.done);
  return next.value;
}

/** Do not split a patch into an unbounded array before enforcing the line budget. */
export function* parseDiffBatches(text, limit = MAX_ROWS) {
  const files = [];
  let file = null, oldLine = 0, newLine = 0, untracked = false, count = 0, structures = 0, offset = 0, batch = 0;
  while (offset < text.length) {
    if (++batch % 128 === 0) yield;
    const end = text.indexOf('\n', offset), stop = end < 0 ? text.length : end;
    const raw = text.slice(offset, stop);
    offset = stop + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === UNTRACKED) { untracked = true; file = null; }
    else if (line.startsWith('diff --git ')) {
      if (++structures > MAX_ROWS) { files.truncated = true; break; }
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
      if (++structures > MAX_ROWS) { files.truncated = true; break; }
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (!match) continue;
      oldLine = Number(match[1]); newLine = Number(match[2]);
      file.hunks.push({ header: line, context: match[3].trim(), lines: [] });
    } else if (file.hunks.length) {
      const kind = line[0];
      if (kind !== '+' && kind !== '-' && kind !== ' ') continue;
      if (count >= limit) { files.truncated = true; break; }
      count++;
      const hunk = file.hunks.at(-1), content = clean(line.slice(1));
      if (kind === '+') { hunk.lines.push({ type: 'add', new: newLine++, text: content }); file.added++; }
      else if (kind === '-') { hunk.lines.push({ type: 'del', old: oldLine++, text: content }); file.removed++; }
      else if (kind === ' ') hunk.lines.push({ type: 'ctx', old: oldLine++, new: newLine++, text: content });
    }
  }
  for (const entry of files) {
    if (!entry.path) { entry.path = entry.oldPath; if (entry.status === 'modified') entry.status = 'deleted'; }
    if (!entry.oldPath && entry.status === 'modified') entry.status = 'added';
  }
  const result = files.filter(entry => entry.path).sort((a, b) => Number(a.untracked) - Number(b.untracked) || a.path.localeCompare(b.path));
  Object.defineProperty(result, 'truncated', { value: Boolean(files.truncated) });
  return result;
}

export async function parseDiffAsync(text, cx, cancelled) {
  const parser = parseDiffBatches(text);
  for (;;) {
    await cx.sleep(0);
    if (cancelled?.()) { parser.return(); return null; }
    const next = parser.next();
    if (next.done) return next.value;
  }
}

/** NUL-delimited Git records preserve tabs, newlines and renames in file names. */
export function parseDiffIndex(text) {
  const parser = parseDiffIndexBatches(text);
  let next;
  do { next = parser.next(); } while (!next.done);
  return next.value;
}

function* parseDiffIndexBatches(text) {
  let offset = 0, truncated = false;
  const field = () => {
    const end = text.indexOf('\0', offset);
    if (end < 0) { if (offset < text.length) truncated = true; offset = text.length; return null; }
    const value = text.slice(offset, end); offset = end + 1; return value;
  };
  const base = field(), root = field(), files = [], byPath = new Map();
  if (!/^[a-f0-9]{40,64}$/.test(base || '')) throw new Error('Cannot read Git revision.');
  if (!root) throw new Error('Cannot read Git root.');
  let record, batch = 0;
  while ((record = field())) {
    if (++batch % 128 === 0) yield;
    if (record[0] === ':') {
      const code = record.split(' ').at(-1)[0], oldPath = field();
      const path = code === 'R' || code === 'C' ? field() : oldPath;
      if (path === null) break;
      if (files.length >= MAX_ROWS) { truncated = true; continue; }
      const file = { path, oldPath, status: ({ A: 'added', D: 'deleted', R: 'renamed' })[code] || 'modified',
        added: 0, removed: 0, binary: false, untracked: false, hunks: [], deferred: true };
      files.push(file); byPath.set(path, file);
    } else {
      const first = record.indexOf('\t'), second = record.indexOf('\t', first + 1);
      let path = record.slice(second + 1);
      if (!path) { field(); path = field(); }
      const file = byPath.get(path);
      if (file) {
        file.added = Number(record.slice(0, first)) || 0; file.removed = Number(record.slice(first + 1, second)) || 0;
        file.binary = record[0] === '-';
      }
    }
  }
  while ((record = field())) {
    if (++batch % 128 === 0) yield;
    if (files.length >= MAX_ROWS) { truncated = true; continue; }
    const file = { path: record, oldPath: null, status: 'added', added: 0, removed: 0,
      binary: false, untracked: true, buildOutput: false, hunks: [], deferred: true };
    files.push(file); byPath.set(record, file);
  }
  while ((record = field())) {
    if (++batch % 128 === 0) yield;
    const file = byPath.get(record);
    if (file?.untracked) file.buildOutput = true;
  }
  return { base, root, files: files.sort((a, b) => Number(a.untracked) - Number(b.untracked) || a.path.localeCompare(b.path)), truncated };
}

export async function readDiffIndex(folder, on, options = {}) {
  const result = await withBuildRulesFile(options.buildRules, on,
    path => execShell(['-c', INDEX_SCRIPT, 'devkits-diff-index', folder, path], { on }));
  if (result.code !== 0 || /(^|\n)(fatal|error):/.test(result.stderr || '')) throw new Error(result.stderr.trim() || 'Cannot read changes.');
  const parser = parseDiffIndexBatches(result.stdout);
  let next;
  do {
    await options.yield?.();
    if (options.cancelled?.()) { parser.return(); return null; }
    next = parser.next();
  } while (!next.done);
  const index = next.value;
  index.truncated ||= await utf8ByteLength(result.stdout, options.yield) > MAX_BYTES;
  return index;
}

/** Zed's ordered buffer loads, with a shared budget and a yield between batches.
 * Reference: crates/git_ui/src/diff_multibuffer.rs::refresh (Zed).
 * One process response at a time; never retain a second repository-wide patch.
 */
export async function readDiff(folder, on, options = {}) {
  const index = options.index || await readDiffIndex(folder, on, options);
  if (!index) return null;
  const { base, root, files, truncated: indexTruncated } = index;
  const previous = new Map((options.previous || []).map(file => [file.path, file]));
  const pause = async () => { await options.yield?.(); return !options.cancelled?.(); };
  if (!await pause()) return null;
  options.onIndex?.(files.slice(), indexTruncated);
  const budget = options.budget || { bytes: 0, lines: 0 };
  let truncated = indexTruncated, completed = 0;
  const priority = files.find(file => file.path === options.priority);
  const ordered = priority ? [priority, ...files.filter(file => file !== priority)] : files;
  for (const file of ordered) {
    if (!await pause()) return null;
    if (budget.bytes >= MAX_BYTES || budget.lines >= MAX_ROWS || options.include && !options.include(file)) {
      if (!options.include || options.include(file)) truncated = true;
      continue;
    }
    // Bound both short-line/object explosions and long lines before they cross
    // the native/JS boundary. One extra byte/line detects a truncated response.
    const remaining = MAX_BYTES - budget.bytes, remainingLines = MAX_ROWS - budget.lines;
    const result = await execShell(['-c', PATCH_SCRIPT, 'devkits-diff-file', root, base,
      file.untracked ? 'untracked' : 'tracked', file.path, file.oldPath || file.path,
      String(remainingLines + 64), String(remaining + 1)], { on });
    if (!await pause()) return null;
    if (result.code !== 0 || !result.stdout && result.stderr?.trim()) throw new Error(result.stderr?.trim() || 'Cannot read changes.');
    const text = result.stdout;
    const fileBytes = await utf8ByteLength(text, options.yield);
    if (options.cancelled?.()) return null;
    // A compact two-word fingerprint lets unchanged files reuse their parsed
    // buffers without keeping the raw patch alive alongside the line objects.
    let hash = 2166136261, check = 5381, outputLines = 0;
    for (let i = 0; i < text.length; i++) {
      if (i % 8192 === 0 && !await pause()) return null;
      const value = text.charCodeAt(i);
      if (value === 10) outputLines++;
      hash = Math.imul(hash ^ value, 16777619); check = Math.imul(check, 33) ^ value;
    }
    const signature = `${text.length}:${hash}:${check}:${file.untracked}:${file.buildOutput}:${file.status}:${file.added}:${file.removed}:${file.oldPath}`;
    const old = previous.get(file.path);
    if (old?.signature === signature && !old.deferred) Object.assign(file, old);
    else {
      const parser = parseDiffBatches(text, remainingLines);
      let next;
      do { if (!await pause()) return null; next = parser.next(); } while (!next.done);
      const parsed = next.value.find(entry => entry.path === file.path) || next.value[0];
      if (parsed) {
        file.hunks = parsed.hunks; file.binary = parsed.binary;
        if (file.untracked) { file.added = parsed.added; file.removed = parsed.removed; }
      }
      file.deferred = false; file.signature = signature;
      file.truncated = next.value.truncated || outputLines >= remainingLines + 64 || fileBytes > remaining;
    }
    budget.bytes += fileBytes;
    for (const hunk of file.hunks) budget.lines += hunk.lines.length;
    truncated ||= Boolean(file.truncated);
    if (++completed % 4 === 0) options.progress?.(files.slice(), truncated);
  }
  // Preserve identity when an event did not change the visible preview.
  const stable = files.map(file => {
    const old = previous.get(file.path);
    const same = old && (file.deferred && old.deferred
      ? ['status', 'oldPath', 'added', 'removed', 'binary', 'untracked', 'buildOutput'].every(key => file[key] === old[key])
      : !file.deferred && old.signature === file.signature);
    return same ? old : file;
  });
  return { files: stable.length === options.previous?.length && stable.every((file, i) => file === options.previous[i]) ? options.previous : stable, truncated };
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
  { key: 'push-tags', label: 'Push Tags', progress: 'Pushing tags…', args: ['push', '--tags'] },
  { key: 'publish', label: 'Publish', progress: 'Publishing…', args: ['push', '--set-upstream'] },
  { key: 'republish', label: 'Republish', progress: 'Publishing…', args: ['push', '--set-upstream'] },
  { key: 'force-push', label: 'Force Push (with lease)', progress: 'Pushing…', args: ['push', '--force-with-lease'] },
];

export async function gitRemoteAction(folder, on, action, remote, account) {
  const operation = gitActions.find(item => item.key === action);
  if (!operation) throw new Error('Unknown Git operation.');
  const publish = action === 'publish' || action === 'republish';
  if (publish && !remote) throw new Error('Choose a Git remote to publish to.');
  if (action === 'push-tags' && !remote) throw new Error('Choose a Git remote to push tags to.');
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
export function changeTree(files, collapsed = new Set(), prefix = '', pathFor = file => file.path) {
  const root = { children: new Map() };
  for (const file of files) {
    let node = root;
    const parts = pathFor(file).split('/');
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

export const isBuildOutput = file => Boolean(file.untracked && file.buildOutput);

// A non-repository workspace can contain independent repositories. Inspect only
// immediate children, including worktrees whose .git marker is a file.
export async function readRepositories(folder, on) {
  const result = await execShell(['-c', 'cd "$1" || exit 2; '
    + 'if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then printf ".\\0"; exit 0; fi; '
    + 'for p in ./* ./.[!.]* ./..?*; do '
    + '[ -d "$p" ] && { [ -d "$p/.git" ] || [ -f "$p/.git" ]; } || continue; '
    + '[ "$(git -C "$p" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || continue; '
    + 'printf "%s\\0" "${p#./}"; done', 'devkits-repositories', folder], { on });
  if (result.code !== 0) throw new Error(result.stderr || 'Could not read repositories.');
  return result.stdout.split('\0').filter(Boolean).sort((a, b) => a.localeCompare(b));
}

const repositoryProjectKey = project => JSON.stringify([project.machine || null, project.folder]);
const repositoryFolder = (project, name) => name === '.' ? project.folder : `${project.folder.replace(/[/\\]+$/, '')}/${name}`;
// NUL cannot be a directory name, so this never collides with a repository.
const ALL_REPOSITORIES = '\0all';

/** Read all indexes before patches, retaining repository identity and one shared budget. */
export async function readAllDiff(project, repositories, options = {}) {
  const groups = [], errors = [], budget = { bytes: 0, lines: 0 };
  const previous = new Map((options.previous || []).map(file => [file.path, file]));
  let truncated = false;
  const scoped = (name, files) => files.map(file => {
    const path = `${name}/${file.path}`, old = previous.get(path);
    return old?.sourceFile === file ? old : { ...file, path, repository: name, sourcePath: file.path,
      oldPath: file.oldPath ? `${name}/${file.oldPath}` : file.oldPath, sourceFile: file };
  });
  const collect = () => groups.flatMap(group => group.files);
  for (const name of repositories) {
    await options.yield?.();
    if (options.cancelled?.()) return null;
    try {
      const index = await readDiffIndex(repositoryFolder(project, name), project.machine, options);
      if (!index || options.cancelled?.()) return null;
      truncated ||= index.truncated;
      groups.push({ name, index, files: scoped(name, index.files) });
    } catch (error) {
      if (options.cancelled?.()) return null;
      errors.push(`${name}: ${error.message || error}`);
      groups.push({ name, files: (options.previous || []).filter(file => file.repository === name) });
    }
  }
  options.onIndex?.(collect(), truncated);
  const priority = groups.find(group => group.files.some(file => file.path === options.priority));
  for (const group of priority ? [priority, ...groups.filter(group => group !== priority)] : groups) {
    if (!group.index) continue;
    const name = group.name;
    try {
      const result = await readDiff(repositoryFolder(project, name), project.machine, {
        ...options, index: group.index, budget,
        previous: (options.previous || []).filter(file => file.repository === name).map(file => file.sourceFile),
        priority: group.files.find(file => file.path === options.priority)?.sourcePath,
        onIndex: undefined,
        progress: (files, limited) => {
          group.files = scoped(name, files); truncated ||= limited;
          options.progress?.(collect(), truncated);
        },
      });
      if (!result || options.cancelled?.()) return null;
      group.files = scoped(name, result.files); truncated ||= result.truncated;
      options.progress?.(collect(), truncated);
    } catch (error) {
      if (options.cancelled?.()) return null;
      errors.push(`${name}: ${error.message || error}`);
      group.files = (options.previous || []).filter(file => file.repository === name);
    }
  }
  const files = collect();
  return { files: files.length === options.previous?.length && files.every((file, i) => file === options.previous[i])
    ? options.previous : files, truncated, error: errors.join('\n') || null };
}

export default class DiffViewer {
  init(cx) {
    this.sidePanel = new SidePanelState(() => shared('devkits.side-panel-width') || 280, width => setShared('devkits.side-panel-width', width));
    this.files = [];
    this.collapsed = new Set();
    this.folders = new Set();
    this.request = 0;
    this.rowStart = null;
    this.scroll = VirtualListScrollHandle.new();
    this.fileScroll = VirtualListScrollHandle.new();
    this.workingScroll = this.scroll; this.commitScrolls = new Map();
    this.gitMenu = new DropdownMenuState(cx);
    this.optionsMenu = new DropdownMenuState(cx);
    this.fileViewMenu = new DropdownMenuState(cx);
    this.repositoryMenu = new SelectState(cx);
    this.repositories = [];
    this.rulesRevision = shared('devkits.diff-build-rules-revision') || 0;
    this.panelTab = 'changes';
    this.history = new CommitHistory(cx, (text, cx, cancelled) => {
      this.rowCache = null; this.collapsed.clear(); this.selected = null;
      this.scroll.scroll_to_item(0, 'top');
      return cx?.sleep ? parseDiffAsync(text, cx, cancelled) : parseDiff(text);
    });
    this.history.onSelect = (commit, cx) => {
      if (commit) {
        this.previewCommit = commit;
        if (!this.commitScrolls.has(commit.sha)) this.commitScrolls.set(commit.sha, VirtualListScrollHandle.new());
        this.scroll = this.commitScrolls.get(commit.sha);
      }
      this.graphMode = false;
      this.previewMode = true; this.output?.release(); this.output = null;
      this.onOpen?.(commit ? { kind: 'commit', commit } : undefined, cx);
    };
  }

  close() {
    this.rowTask?.cancel(); this.rowTask = null; this.rowJob = null;
    this.rowBuilder?.return(); this.rowBuilder = null;
    this.visibleRows = null; this.pendingReveal = null;
    this.rowStart = null;
    this.visible = null; this.jump = null;
    this.files = []; this.rowCache = null; this.filteredFileCache = null; this.treeCache = null;
    this.toastTimer?.cancel(); this.toastTimer = null; clearGitToast(this.context);
    this.output?.release(); this.output = null;
    this.watcher?.cancel(); this.poll?.cancel(); this.queued?.cancel();
    this.queued = null;
    this.context = null; this.previewMode = false;
    this.project = null; this.repositories = []; this.repositoryMenu.open = false; this.discovering = false;
    this.previewCommit = null;
    this.expandedCommitMessage = null;
    this.history.reset(null);
    this.graph?.reset(null); this.graphMode = false; this.graphReturn = false;
    this.latestCommit = null; this.latestRevision = null;
    this.commitScrolls.clear(); this.scroll = this.workingScroll;
    this.request++;
  }

  refresh(project, cx, selection = null) {
    this.close();
    this.project = project ? { ...project } : null;
    this.repositories = selection?.repositories || [];
    this.context = project ? { ...project } : null;
    if (selection) {
      this.context.allRepositories = selection.name === ALL_REPOSITORIES;
      this.context.folder = this.context.allRepositories ? project.folder : repositoryFolder(project, selection.name);
    }
    if (project) this.context.workspaceFolder = project.folder;
    this.discovering = Boolean(project?.folder && !selection);
    this.nativeBranch = this.context?.folder === project?.folder ? project?.branch || null : null;
    this.history.reset(this.allRepositories ? null : this.context);
    this.graph?.reset(this.allRepositories ? null : this.context);
    if (this.allRepositories) this.panelTab = 'changes';
    this.files = []; this.collapsed.clear(); this.folders.clear(); this.rowCache = null; this.selected = null;
    this.error = null; this.loaded = false; this.indexLoaded = false; this.truncated = false;
    this.loading = false; this.dirty = false;
    this.pushState = null; this.pushStateError = null; this.pushResult = null;
    this.accounts = null; this.accountsError = null; this.accountsLoading = false;
    this.gitMenu.open = false; this.gitMenu.page = null;
    this.optionsMenu.open = false;
    this.fileViewMenu.open = false;
    if (project?.folder) {
      const context = this.context;
      // refresh is called by render. Starting watchers/Git reads here shares
      // that first frame's script budget; History.load also notifies its view.
      // Resume with a task context after render, and ignore a project left meanwhile.
      cx.spawn(async cx => {
        await cx.sleep(0);
        if (this.context !== context) return;
        if (!selection) {
          try {
            const repositories = await readRepositories(project.folder, project.machine);
            if (this.context !== context) return;
            this.repositories = repositories;
            const saved = shared('devkits.git-repository')?.[repositoryProjectKey(project)];
            const name = saved === ALL_REPOSITORIES && repositories.some(name => name !== '.')
              ? saved : repositories.includes(saved) ? saved : repositories[0];
            context.allRepositories = name === ALL_REPOSITORIES;
            if (name && !this.allRepositories) context.folder = repositoryFolder(project, name);
            if (this.allRepositories) this.panelTab = 'changes';
            this.nativeBranch = context.folder === project.folder ? project.branch || null : null;
            this.history.reset(this.allRepositories ? null : context); this.graph?.reset(this.allRepositories ? null : context);
          } catch (error) {
            if (this.context !== context) return;
            this.discovering = false;
            this.error = String(error.message || error); this.loaded = true; cx.notify(); return;
          }
        }
        this.discovering = false;
        this.observe(cx);
        this.reload(cx);
        if (this.panelTab === 'history' && !this.allRepositories) this.history.load(cx);
        cx.notify();
      });
    }
  }

  selectRepository(name, cx) {
    if (!this.project || !(name === ALL_REPOSITORIES && this.repositories.some(name => name !== '.') || this.repositories.includes(name))) return;
    if (name === ALL_REPOSITORIES ? this.allRepositories : !this.allRepositories && repositoryFolder(this.project, name) === this.context?.folder) return;
    const project = this.project, repositories = this.repositories;
    setShared('devkits.git-repository', { ...(shared('devkits.git-repository') || {}), [repositoryProjectKey(project)]: name });
    this.refresh(project, cx, { repositories, name });
    this.onRepositoryChange?.(cx);
    this.showChanges(cx);
    cx.notify();
  }

  get allRepositories() { return Boolean(this.context?.allRepositories); }

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
      if (this.context !== context) return;
      if (context.machine || this.watchFailed) this.reload(cx);
      else cx.spawn(async cx => {
        try {
          const rules = await readBuildRules();
          if (this.context === context && rules.text !== this.buildRulesText) this.reload(cx);
        } catch (error) {
          if (this.context === context) { this.error = error.message; cx.notify(); }
        }
      });
    });
  }

  reload(cx) {
    if (this.loading) { this.dirty = true; return; }
    const context = this.context, request = ++this.request;
    this.loading = true;
    if (this.graphMode) this.graph?.load(cx);
    let changed = !this.loaded;
    cx.spawn(async cx => {
      try {
        const buildRules = await readBuildRules();
        if (request !== this.request || this.context !== context) return;
        this.buildRulesText = buildRules?.text;
        const [diff, state] = await Promise.all([
          (this.allRepositories ? options => readAllDiff(this.project, this.repositories, options)
            : options => readDiff(context.folder, context.machine, options))({
            previous: this.files, priority: this.selected, buildRules,
            include: file => this.includeFile(file),
            yield: () => cx.sleep?.(0),
            cancelled: () => request !== this.request || this.context !== context,
            onIndex: (files, truncated) => {
              if (this.loaded || request !== this.request || this.context !== context) return;
              this.indexLoaded = true; this.files = files; this.truncated = truncated; this.rowCache = null; cx.notify();
            },
            progress: (files, truncated) => {
              if (this.loaded || request !== this.request || this.context !== context) return;
              this.files = files; this.truncated = truncated; this.rowCache = null; cx.notify();
            },
          }),
          this.allRepositories ? Promise.resolve({ value: null })
            : readPushState(context.folder, context.machine).then(value => ({ value }), error => ({ error: String(error.message || error) })),
        ]);
        if (!diff || request !== this.request || this.context !== context) return;
        if (JSON.stringify(state.value) !== JSON.stringify(this.pushState) || (state.error || null) !== this.pushStateError) {
          const changedHead = state.value?.revision !== this.pushState?.revision;
          this.pushState = state.value; this.pushStateError = state.error || null; changed = true;
          if (changedHead && this.panelTab === 'history') this.history.load(cx);
          if (changedHead) this.loadLatestCommit(state.value?.revision, cx);
        }
        // Like Zed, keep what is shown until the result actually differs; most events change nothing.
        if (diff.files !== this.files || diff.truncated !== this.truncated || (diff.error || null) !== this.error) {
          this.files = diff.files; this.truncated = diff.truncated;
          this.error = diff.error || null; this.rowCache = null; changed = true;
        }
      } catch (error) {
        if (request === this.request && this.context === context) {
          this.error = String(error.message || error); changed = true;
          this.pushState = null; this.pushStateError = this.error;
        }
      } finally {
        if (request === this.request && this.context === context) {
          this.loading = false; this.loaded = true;
          if (this.dirty) { this.dirty = false; this.reload(cx); }
        }
        if (changed && request === this.request && this.context === context) cx.notify();
      }
    });
  }

  push(cx) { this.remoteAction('push', cx); }

  loadLatestCommit(sha, cx) {
    if (this.latestRevision === sha) return;
    this.latestRevision = sha || null;
    if (!sha) { this.latestCommit = null; return; }
    const context = this.context;
    cx.spawn(async cx => {
      try {
        const commit = await readCommitSummary(context.folder, context.machine, sha);
        if (this.context === context && this.latestRevision === sha) { this.latestCommit = commit; cx.notify(); }
      } catch { if (this.context === context && this.latestRevision === sha) this.latestRevision = null; }
    });
  }

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
    if (action === 'publish' || action === 'republish' || action === 'push-tags') {
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
    this.toastTimer?.cancel(); this.toastTimer = null; clearGitToast(this.context);
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
            this.loadLatestCommit(state.revision, cx);
          }
        } catch {}
      }
      this.pushing = null;
      if (this.context === context) {
        if (this.graphMode) this.graph?.load(cx);
        this.pushResult = { message, failed };
        this.resultTitle = `${operation.label} ${failed ? 'failed' : 'completed'}`;
        showGitToast(context, this.resultTitle, failed);
        if (!failed) this.toastTimer = cx.timer.after(5000, cx => {
          clearGitToast(context); this.toastTimer = null; cx.notify();
        });
        this.reload(cx);
      } else notify({ title: `${operation.label} ${failed ? 'failed' : 'completed'}`, body: context.name || context.folder, level: failed ? 'error' : 'success' });
      cx.notify();
    });
  }

  pushUnavailable(action = 'push') {
    if (this.allRepositories) return 'Select a repository for Git operations';
    if (!this.pushState) return this.pushStateError || (this.loaded ? 'Git branch unavailable' : 'Loading branch…');
    if (action !== 'fetch' && action !== 'push-tags' && !this.pushState.branch) return 'Check out a branch first';
    if (action !== 'fetch' && action !== 'push-tags' && !this.pushState.committed) return 'Create a commit first';
    if (!this.pushState.remote) return 'No Git remote configured';
    return null;
  }

  loadAccounts(cx) {
    if (this.allRepositories) return;
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
    clearGitToast(this.context);
    cx.notify();
  }

  outputView(t) {
    return v_flex().id('git-output').size_full().min_w(0).min_h(0)
      .child(h_flex().h(32).flex_none().pl(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(`Git output: ${this.outputTitle}`))
        .child(Button('git-output-close', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
          .accessibility_label('Close Git output').child(icon('close'))
          .on_click((_event, cx) => { this.output.release(); this.output = null; cx.notify(); })))
      .child(Editor.new(this.output).flex_1().min_h(0));
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
      { key: 'account:default', label: 'Default', description: 'Git authentication · keep commit author', checked: !account, disabled: Boolean(this.pushing) },
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
      { key: 'push-tags', label: 'Push Tags', description: 'All local tags', disabled: Boolean(this.pushUnavailable('push-tags')) },
      { key: 'force-push', label: 'Force Push (with lease)', disabled: pushUnavailable },
      { key: 'accounts', label: 'GitHub account…', description: accountLabel, separator: true, disabled: Boolean(this.pushing) },
      { key: 'commit-author', label: 'Commit author…' },
    ];
    const choose = (key, cx) => {
      if (key === 'commit-author') {
        openGitAuthor(this.context);
      } else if (key === 'accounts' || key === 'accounts-retry') {
        this.gitMenu.page = 'accounts'; this.gitMenu.index = 0; this.gitMenu.open = true;
        this.loadAccounts(cx);
      } else if (key.startsWith('account:')) {
        if (this.pushing) return;
        const chosen = key === 'account:default' ? null : this.accounts?.[Number(key.slice(8))];
        if (key !== 'account:default' && !chosen?.available) return;
        if (chosen) openGitAuthor(this.context, chosen);
        else setGitAccount(this.context, null);
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
              .child(icon('chevron-down')), items, choose, t, { side: 'top', offset: { x: 0, y: 15 } })))); // 8px above the footer's top border
  }

  toggle(path, cx) {
    if (this.files.find(file => file.path === path)?.deferred) {
      this.selected = path; this.collapsed.delete(path); this.reload(cx);
    } else {
      this.collapsed.has(path) ? this.collapsed.delete(path) : this.collapsed.add(path);
    }
    this.rowCache = null;
    cx.notify();
  }

  /** Jumps the multibuffer to a file's header, expanding the file if it was collapsed. */
  reveal(path, cx) {
    this.graphMode = false;
    this.scroll = this.workingScroll;
    this.previewMode = false; this.onOpen?.({ kind: 'changes' }, cx);
    this.output?.release(); this.output = null;
    this.selected = path;
    const deferred = this.files.find(file => file.path === path)?.deferred;
    if (deferred) this.reload(cx);
    this.pendingReveal = path;
    if (this.collapsed.delete(path)) this.rowCache = null;
    let rows = this.rows(cx), index = rows.rows.findIndex(row => row.key === `file:${path}`);
    if (index < 0 && rows.limited) {
      this.rowStart = path; this.rowCache = null;
      rows = this.rows(cx); index = rows.rows.findIndex(row => row.key === `file:${path}`);
    }
    if (index >= 0 && !this.rowJob) { this.scrollToTop(rows, index, cx); if (!deferred) this.pendingReveal = null; }
    cx.notify();
  }

  /**
   * `scroll_to_item(…, 'top')` only scrolls to the nearer edge: a header above the
   * viewport lands at its top, but one below lands at its bottom and a visible one
   * does not move. Those first scroll until the header's top is just past the
   * viewport's, at most one row further, then align it once that frame is laid out.
   */
  scrollToTop(rows, index, cx) {
    const jump = this.jump = {};
    if (this.visible?.rows === rows.rows && index <= this.visible.start) { this.scroll.scroll_to_item(index, 'top'); return; }
    const { sizes } = rows, height = this.viewportHeight || 0;
    let past = index, extent = sizes[index];
    while (past < sizes.length - 1 && extent <= height) extent += sizes[++past];
    this.scroll.scroll_to_item(past, 'top');
    if (past === index) return;
    const frame = this.listFrame;
    const finish = () => { if (this.jump === jump && this.rowCache === rows) this.scroll.scroll_to_item(index, 'top'); };
    if (!cx?.spawn) { finish(); return; }
    cx.spawn(async cx => {
      for (let tries = 0; tries < 120 && this.listFrame === frame; tries++) await cx.sleep(4);
      finish();
      cx.notify();
    });
  }

  toggleFolder(path, cx) {
    this.folders.has(path) ? this.folders.delete(path) : this.folders.add(path);
    cx.notify();
  }

  get commitPreview() {
    if (!this.previewMode) return null;
    if (this.previewCommit && this.history.preview?.commit.sha !== this.previewCommit.sha)
      return { commit: this.previewCommit, files: [], pending: this.history.pending === this.previewCommit.sha };
    return this.history.preview;
  }

  commitHeader(preview, t) {
    const commit = preview.commit, message = (commit.message || commit.subject || '').trim();
    const hasMore = message.includes('\n'), expanded = this.expandedCommitMessage === commit.sha;
    return v_flex().id('commit-details').flex_none().px(12).py(8).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().h(20).gap(6).items_center().text_size(11).text_color(t.muted)
        .child(div().flex_none().child(commit.author))
        .when(hasMore, el => el.child(Button('commit-description-toggle', t, { variant: 'ghost', size: 'icon-sm' })
          .accessibility_label(expanded ? 'Fold commit description' : 'Expand commit description')
          .child(icon(expanded ? 'chevron-down' : 'chevron-right'))
          .on_click((_event, cx) => { this.expandedCommitMessage = expanded ? null : commit.sha; cx.notify(); })))
        .child(div().min_w(0).truncate().child(new Date(commit.at * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC'))))
      .child(div().id('commit-description').text_size(13)
        .when(!expanded, el => el.h(20).line_height('20px').truncate())
        .when(expanded, el => el.max_h(240).overflow_y_scrollbar())
        .child(expanded ? message : message.split('\n')[0]));
  }
  get fileView() { return shared('devkits.diff-file-view') === 'list' ? 'list' : 'tree'; }

  setFileView(view, cx) {
    setShared('devkits.diff-file-view', view);
    cx.notify();
  }

  includeFile(file) {
    return !isBuildOutput(file);
  }

  visibleFiles(files) {
    this.filteredFileCache ||= new WeakMap();
    if (!this.filteredFileCache.has(files)) {
      const visible = files.filter(file => this.includeFile(file));
      this.filteredFileCache.set(files, visible.length === files.length ? files : visible);
    }
    return this.filteredFileCache.get(files);
  }

  get displayFiles() { return this.visibleFiles(this.commitPreview?.files || this.files); }

  panelSettingsItems() {
    const files = this.panelTab === 'history' ? this.commitPreview?.files || [] : this.files;
    return [
      { key: 'list', label: 'List', checked: this.fileView === 'list' },
      { key: 'tree', label: 'Tree', checked: this.fileView === 'tree' },
      { key: 'filter-rules', label: 'Filter rules…', separator: true, description: `${files.length - this.visibleFiles(files).length} hidden` },
    ];
  }

  choosePanelSetting(key, cx) {
    if (key === 'filter-rules') openBuildRules();
    else if (key === 'list' || key === 'tree') this.setFileView(key, cx);
  }

  showChanges(cx) {
    this.graphMode = false;
    this.scroll = this.workingScroll;
    this.rowStart = null;
    if (this.output || this.previewMode) this.rowCache = null;
    this.output?.release(); this.output = null; this.previewMode = false;
    this.onOpen?.({ kind: 'changes' }, cx); cx.notify();
  }

  openCommit(commit, cx, preview) {
    if (this.discovering || this.allRepositories) return;
    this.rowCache = null; this.selected = null; this.pendingReveal = null; this.rowStart = null;
    if (preview) {
      this.history.selection++;
      this.history.pending = null; this.history.previewError = null;
      this.history.preview = preview; this.history.onSelect(commit, cx);
    } else if (this.history.pending === commit.sha) this.history.onSelect(commit, cx);
    else this.history.select(commit, cx);
    cx.notify();
  }

  openGraph(cx) {
    if (this.discovering || this.allRepositories) return;
    if (!this.graph) {
      this.graph = new GitGraph(cx, (text, cx, cancelled) => cx?.sleep ? parseDiffAsync(text, cx, cancelled) : parseDiff(text));
      this.graph.fileRows = changeTree;
      this.graph.reset(this.context);
      this.graph.onClose = cx => { this.graphMode = false; cx.notify(); };
      this.graph.onOpen = (commit, cx, path, preview) => {
        this.graphReturn = true;
        this.collapsed.clear();
        this.openCommit(commit, cx, preview);
        this.selected = path || null;
        this.pendingReveal = path || null;
        cx.notify();
      };
    }
    this.graphMode = true; this.output?.release(); this.output = null;
    this.graph.load(cx); this.graph.focus?.focus(); this.onOpen?.({ kind: 'graph' }, cx); cx.notify();
  }

  setPanelTab(tab, cx) {
    if (tab === 'history' && this.allRepositories) return;
    if (this.panelTab === tab) { cx.notify(); return; }
    this.panelTab = tab;
    if (tab === 'history' && !this.discovering) { this.history.load(cx); this.history.focus?.focus(); }
    cx.notify();
  }

  fileRows(files) {
    const folders = [...this.folders].join('\0'), view = this.fileView;
    if (this.treeCache?.files === files && this.treeCache.folders === folders && this.treeCache.view === view) return this.treeCache.rows;
    const rows = [];
    const sections = this.allRepositories
      ? this.repositories.flatMap(name => changeSections(files.filter(file => file.repository === name))
        .map(section => ({ ...section, label: `${name} · ${section.label}` })))
      : changeSections(files);
    for (const section of sections) {
      const path = `section:${section.label}`, open = !this.folders.has(path);
      rows.push({ kind: 'section', key: path, path, section, open });
      if (!open) continue;
      const entries = view === 'list'
        ? section.files.map(file => ({ kind: 'file', name: file.sourcePath || file.path, depth: 0, path: file.path, file }))
        : changeTree(section.files, this.folders, `${section.label}:`, file => file.sourcePath || file.path);
      for (const row of entries) rows.push({ ...row, key: `${row.kind}:${row.path}` });
    }
    this.treeCache = { files, folders, view, rows };
    return rows;
  }

  fileRow(row, t) {
    if (row.kind === 'section') return TreeItem(`diff-${row.key}`, 0, false, t, { deferred: true }).text_color(t.muted)
      .accessibility_label(`${row.section.label}, ${row.section.files.length} files`)
      .child(TreeItemIcon(icon(row.open ? 'chevron-down' : 'chevron-right')))
      .child(TreeItemLabel(t).text_size(12).text_color(t.muted).child(row.section.label))
      .child(div().flex_none().px(5).border(1).border_color(t.border).text_size(11).child(String(row.section.files.length)));
    const button = TreeItem(`diff-tree-${row.path}`, row.depth + 1, row.kind === 'file' && this.selected === row.path, t, { deferred: true });
    if (row.kind === 'dir') return button.accessibility_label(`Folder ${row.name}`)
      .child(TreeItemIcon(icon(this.folders.has(row.path) ? 'folder' : 'folder-open').text_color(t.muted)))
      .child(TreeItemLabel(t).text_color(t.muted).child(row.name));
    const [glyph, color] = row.file.untracked || row.file.status === 'added' ? ['square-plus', GitStatusColor.added]
      : row.file.status === 'deleted' ? ['square-minus', GitStatusColor.deleted] : ['square-dot', GitStatusColor.modified];
    return button.accessibility_label(`${row.file.untracked ? 'Untracked' : row.file.status} file ${row.path}`)
      .child(TreeItemIcon(icon(glyph).text_color(color)))
      .child(TreeItemLabel(t).when(row.file.status === 'deleted', el => el.line_through()).child(row.name))
      .when(!row.file.untracked, el => el.child(h_flex().flex_none().gap(4).text_size(11)
        .child(div().text_color(GitStatusColor.added).child(`+${row.file.added}`))
        .child(div().text_color(GitStatusColor.deleted).child(`−${row.file.removed}`))));
  }

  /** Zed's Git panel: collapsible Tracked/Untracked sections in list or tree form. */
  panel(t) {
    const files = this.visibleFiles(this.files);
    const fileRows = this.fileRows(files);
    const added = files.reduce((n, file) => n + file.added, 0), removed = files.reduce((n, file) => n + file.removed, 0);
    const tab = (key, label) => Button(`git-tab-${key}`, t, { variant: 'ghost' }).flex_1().min_w(0).h(32).px(8).gap(4)
      .when(this.panelTab === key, el => el.bg(t.selected).text_color(t.foreground))
      .accessibility_label(`${label}${this.panelTab === key ? ', selected' : ''}`)
      .on_click((_event, cx) => this.setPanelTab(key, cx)).child(label);
    // A full-height dock with its own header, as Zed's Git panel sits beside the editor.
    return v_flex().size_full().min_h(0).bg(t.chrome).border_l(1).border_color(t.border)
      // Native Popup reserves 8px at the window edge. Give the field the same
      // inset so an edge-mounted dock does not shift only its expanded list.
      .when(this.repositories.some(name => name !== '.'), el => el.child(h_flex().h(32).flex_none().min_w(0).px(8)
        .border_b(1).border_color(t.border)
        .child(Select('git-repository', this.repositoryMenu,
          this.allRepositories ? ALL_REPOSITORIES : this.repositories.find(name => repositoryFolder(this.project, name) === this.context?.folder),
          [{ key: ALL_REPOSITORIES, label: 'All', icon: 'folder', color: t.muted },
            ...this.repositories.map(name => ({ key: name, label: name, icon: 'folder', color: t.muted }))],
          'Git repository', (name, cx) => this.selectRepository(name, cx), t, { fullWidth: true }))))
      .child(h_flex().h(32).flex_none().items_center().border_b(1).border_color(t.border).text_size(12)
        .child(tab('changes', this.indexLoaded || this.loaded || files.length ? `Changes (${files.length})` : 'Changes'))
        .child(tab('history', 'History').disabled(this.allRepositories)))
      .when(this.panelTab !== 'history', el => el.child(h_flex().id('diff-files-toolbar').h(32).flex_none().gap(0)
        .items_center().border_b(1).border_color(t.border)
        .child(Button('diff-view', t, { variant: 'ghost' }).h_full().px(8).gap(4).text_size(12).text_color(t.muted)
          .on_click((_event, cx) => this.showChanges(cx))
          .accessibility_label('Uncommitted diff')
          .child(icon('git-compare')).child('View Diff')
          .when(files.length > 0, el => el
            .child(div().text_size(11).text_color(GitStatusColor.added).child(`+${added}`))
            .child(div().text_size(11).text_color(GitStatusColor.deleted).child(`−${removed}`))))
        .child(div().flex_1())
        .child(DropdownMenu('diff-file-view', this.fileViewMenu,
          Button('diff-file-view-trigger', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
            .accessibility_label('Git panel settings').child(icon('settings')),
          this.panelSettingsItems(), (key, cx) => this.choosePanelSetting(key, cx), t,
          { offset: { x: 0, y: 9 }, fullHeight: true })))) // 8px below the toolbar's bottom border
      .when(this.panelTab !== 'history' && this.files.length > files.length, el => el.child(h_flex().h(24).flex_none().px(8)
        .items_center().text_size(11).text_color(t.muted)
        .child(div().min_w(0).truncate().child(`${this.files.length - files.length} hidden · Filters in settings`))))
      .child(this.panelTab === 'history' ? this.history.render(t) : v_flex().id('diff-files').relative().flex_1().min_h(0).py(4)
        .child(v_virtual_list('diff-files-list', fileRows.length, 28, index => fileRows[index].key,
          range => fileRows.slice(range.start, range.end).map(row => this.fileRow(row, t)))
          .size_full().track_scroll(this.fileScroll).on_item_click((key, cx) => {
            if (key.startsWith('file:')) this.reveal(key.slice(5), cx);
            else this.toggleFolder(key.startsWith('dir:') ? key.slice(4) : key, cx);
          }))
        .child(Scrollbar.vertical('diff-files-list').absolute().inset_0()))
      .when(this.panelTab !== 'history', el => el.child(this.allRepositories
        ? h_flex().h(38).flex_none().px(10).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
          .child(div().min_w(0).truncate().child('Select a repository for Git operations'))
        : this.pushFooter(t)))
      .when(this.panelTab === 'changes' && Boolean(this.latestCommit), el => el.child(h_flex().id('git-latest-commit').h(32).flex_none()
        .border_t(1).border_color(t.border)
        .child(Button('git-view-latest-commit', t, { variant: 'ghost' }).flex_1().min_w(0).h_full().px(10).justify_start()
          .accessibility_label(`View commit ${this.latestCommit.shortSha}`).child(div().truncate().text_size(12).child(this.latestCommit.subject))
          .on_click((_event, cx) => this.openCommit(this.latestCommit, cx)))
        .child(Button('git-open-graph', t, { variant: 'ghost', size: 'icon' }).size(32)
          .accessibility_label('Open Git Graph').child(icon('git-graph').size(14)).on_click((_event, cx) => this.openGraph(cx)))));
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
      collapsed: [...this.collapsed].join('\0'), start: this.rowStart };
    const matches = value => value && Object.keys(options).every(key => value[key] === options[key]);
    if (matches(this.rowCache)) return this.rowCache;
    if (!cx?.spawn || !options.files.length) {
      this.rowTask?.cancel(); this.rowTask = null; this.rowJob = null;
      this.rowBuilder?.return(); this.rowBuilder = null;
      const builder = this.buildRows(options);
      let next;
      do { next = builder.next(); } while (!next.done);
      if (!options.files.length) this.visible = null;
      return this.rowCache = this.visibleRows = next.value;
    }
    if (!matches(this.rowJob)) {
      this.rowTask?.cancel();
      this.rowBuilder?.return();
      const job = this.rowJob = options;
      const builder = this.rowBuilder = this.buildRows(options);
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
          this.rowBuilder = null;
          const index = next.value.rows.findIndex(row => row.key === `file:${this.pendingReveal}`);
          if (index < 0 && next.value.limited && job.start !== this.pendingReveal
            && job.files.some(file => file.path === this.pendingReveal)) {
            this.rowStart = this.pendingReveal; this.rowCache = null; cx.notify(); return;
          }
          if (index >= 0) this.scrollToTop(next.value, index, cx);
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
    const { split, width, charWidth } = options, collapsed = new Set(options.collapsed.split('\0'));
    const start = options.start ? options.files.findIndex(file => file.path === options.start) : 0;
    const files = start > 0 ? options.files.slice(start) : options.files;
    let widest = 1;
    for (const file of files) {
      yield;
      for (const hunk of file.hunks) {
        const last = hunk.lines.at(-1);
        if (last) widest = Math.max(widest, last.old || 0, last.new || 0);
      }
    }
    const gutter = String(widest).length * 8 + 24;
    const cellWidth = split ? (width - 1) / 2 : width;
    const columns = options.wrap !== false && width ? Math.max(2, Math.floor((cellWidth - gutter - 24) / (charWidth || 13))) : Infinity;
    let textColumns = 0;
    const rows = [], sizes = [];
    const add = (row, size) => {
      if (rows.length >= MAX_ROWS) { limited = true; return false; }
      rows.push(row); sizes.push(size); return true;
    };
    let limited = start > 0;
    files: for (const [index, file] of files.entries()) {
      yield;
      if (rows.length >= MAX_ROWS) { limited = true; break; }
      add({ key: `file:${file.path}`, kind: 'file', file, first: index === 0 }, index === 0 ? HEADER : HEADER + GAP);
      if (collapsed.has(file.path)) continue;
      if (file.binary || !file.hunks.length) add({ key: `note:${file.path}`, kind: 'note', text: file.deferred ? 'Select this file to load its diff' : file.binary ? 'Binary file' : 'No content changes' }, HEADER);
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

  render(project, cx, parts = false) {
    const revision = shared('devkits.diff-build-rules-revision') || 0;
    if (revision !== this.rulesRevision) {
      this.rulesRevision = revision;
      cx.spawn(async cx => { await cx.sleep(0); if (this.context && !this.discovering) this.reload(cx); });
    }
    const workspace = this.project || this.context;
    if (workspace?.id !== project?.id || workspace?.folder !== project?.folder || workspace?.machine !== project?.machine) this.refresh(project, cx);
    this.nativeBranch = this.context?.folder === project?.folder ? project?.branch || null : null;
    if (this.graphMode && !this.output) {
      const t = theme();
      const body = div().id('diff-viewer').relative().size_full().min_h(0).bg(t.background).text_color(t.foreground)
        .child(this.graph.render(t, this.managedTabs));
      if (parts) return { content: body, panel: this.panel(t) };
      return div().size_full().child(SidePanelLayout('diff-split', this.sidePanel, body, this.panel(t)));
    }
    const t = theme(), mono = settings().font_family, { rows, sizes, limited, gutter, contentWidth, wrap } = this.rows(cx), split = this.split;
    const preview = this.commitPreview;
    const choice = (id, label, value) => Button(id, t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
      .when(split === (value === 'split'), el => el.bg(t.selected).text_color(t.foreground))
      .accessibility_label(`${label} diff${split === (value === 'split') ? ', selected' : ''}`)
      .on_click((_event, cx) => this.setLayout(value, cx)).child(icon(`diff-${value}`).size(16));
    // The editor and the Git panel are side by side, each with its own 32px header, like Files; drag the line between them.
    const content = this.output ? this.outputView(t) : v_flex().size_full().min_w(0).min_h(0)
        .child(h_flex().h(32).flex_none().pl(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
          .when(Boolean(!this.managedTabs && this.graphReturn && this.previewMode), el => el.child(Button('diff-back-to-graph', t, { variant: 'ghost', size: 'icon' })
            .h_full().w(32).accessibility_label('Back to Git Graph').child(icon('chevron-left'))
            .on_click((_event, cx) => this.openGraph(cx))))
          .child(div().flex_1().min_w(0).truncate().font_medium().child(preview ? `Commit ${preview.commit.shortSha}` : 'Uncommitted changes'))
          .when(rows.length > 0, el => el
            .child(choice('diff-unified', 'Unified', 'unified'))
            .child(choice('diff-split', 'Split', 'split')))
          .child(DropdownMenu('diff-options', this.optionsMenu,
            Button('diff-options-trigger', t, { variant: 'ghost', size: 'icon' }).h_full().w(32)
              .accessibility_label('Diff options').child(icon('ellipsis')),
            [{ key: 'wrap', label: 'Wrap', checked: this.wrap }],
            (_key, cx) => this.toggleWrap(cx), t, { offset: { x: 8, y: 9 }, fullHeight: true })))
        .when(Boolean(preview), el => el.child(this.commitHeader(preview, t)))
        .when(!preview && this.allRepositories && Boolean(this.error) && rows.length > 0,
          el => el.child(div().flex_none().px(12).py(6).text_size(12).text_color(t.muted).child(this.error)))
        .when(this.panelTab === 'history' && Boolean(this.history.previewError), el => el.child(div().flex_none().px(12).py(8).text_size(12).text_color(t.muted)
          .child(this.history.previewError)))
        .when((preview ? preview.truncated : this.truncated) || limited, el => el.child(div().flex_none().px(12).py(6).text_size(11).text_color(t.muted).border_b(1).border_color(t.border)
          .child('Diff limited to 4 MB and 10,000 rows.')))
        .child(rows.length
          ? v_flex().id('diff-viewport').relative().flex_1().min_h(0)
            .on_size_change((size, cx) => {
              this.viewportHeight = size.height;
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
              range => {
                // The first call per frame measures one row; the second is the visible range.
                if (range.end - range.start > 1 || rows.length === 1) this.visible = { rows, start: range.start };
                this.listFrame = (this.listFrame || 0) + 1;
                return rows.slice(range.start, range.end).map(row => this.row(row, t, mono, gutter));
              })
              .size_full().when(wrap === false, el => el.w(contentWidth).flex_none()).track_scroll(this.scroll)
              .on_item_click((key, cx) => { if (key.startsWith('file:')) this.toggle(key.slice(5), cx); })))
            .child(Scrollbar.vertical('diff-rows').absolute().inset_0())
          : Empty(t).flex_1().p(24).gap(4).font_family('Geist')
            .child(EmptyDescription(t).text_size(13).child(preview?.pending ? 'Loading commit…' : this.rowJob ? 'Loading changes…' : !this.displayFiles.length && (preview?.files || this.files).length ? 'All changed files are hidden by filters in Git panel settings' : preview ? this.history.previewError ? 'Commit changes unavailable' : 'No file changes in this commit' : this.error ? 'Changes unavailable' : this.loaded ? 'No uncommitted changes' : 'Loading changes…'))
            .when(!preview && Boolean(this.error), el => el.child(EmptyDescription(t).child(this.error))));
    const body = div().id('diff-viewer').relative().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(content);
    if (parts) return { content: body, panel: this.panel(t) };
    return div().size_full().child(SidePanelLayout('diff-split', this.sidePanel, body, this.panel(t)));
  }
}
