import { div } from 'gpui-kit';
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from 'gpui-base';
import { exec } from 'herdr';
import { execShell } from './shell.js';
import { utf8ByteLength } from './utf8.js';
import { Button } from './components/button.js';

const PAGE = 50, LIMIT = 4000000;
const validSha = sha => /^[a-f0-9]{40,64}$/.test(sha || '');

/** NUL separators preserve Unicode, multiline messages and punctuation without shell parsing. */
export function parseCommitHistory(text) {
  const [revision, ...fields] = text.split('\0');
  const entries = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    if (!validSha(fields[i])) continue;
    const message = fields[i + 4].trimEnd().slice(0, 12000);
    entries.push({ sha: fields[i], shortSha: fields[i + 1], author: fields[i + 2],
      at: Number(fields[i + 3]), subject: message.split('\n')[0] || '(No commit message)', message });
  }
  return { revision: validSha(revision) ? revision : null, entries };
}

export async function readCommitHistory(folder, on, revision = null, skip = 0) {
  if (revision !== null && !validSha(revision)) throw new Error('Invalid history revision.');
  if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid history offset.');
  const result = await execShell(['-c', 'cd "$1" || exit 2; '
    + 'git rev-parse --git-dir >/dev/null 2>&1 || { echo "Not a Git repository." >&2; exit 3; }; '
    + 'revision=$(git rev-parse --verify -q "${2:-HEAD}") || exit 0; '
    + 'printf "%s\\0" "$revision"; '
    + 'git -c log.showSignature=false --no-pager log --no-color -z --format="%H%x00%h%x00%an%x00%at%x00%B" '
    + '--max-count=51 --skip="$3" "$revision" --', 'devkits-history', folder, revision || '', String(skip)], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read commit history.');
  const page = parseCommitHistory(result.stdout);
  return { revision: page.revision, entries: page.entries.slice(0, PAGE), hasMore: page.entries.length > PAGE };
}

export async function readCommitSummary(folder, on, sha) {
  if (!validSha(sha)) throw new Error('Invalid commit.');
  const result = await exec('git', ['-C', folder, '-c', 'log.showSignature=false', '--no-pager', 'show',
    '--no-patch', '--no-color', '-z', '--format=%H%x00%h%x00%an%x00%at%x00%B', sha, '--'], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read latest commit.');
  return parseCommitHistory(`${sha}\0${result.stdout}`).entries[0] || null;
}

/** Root commits compare to the empty tree; merge commits compare to their first parent. */
export async function readCommitPatch(folder, on, sha, options = {}) {
  if (!validSha(sha)) throw new Error('Invalid commit.');
  // Enforce the cap in the child process. Slicing stdout after exec has already
  // copied the entire commit into both the host and the script heap.
  const result = await execShell(['-c', 'cd "$1" || exit 2; '
    + 'git cat-file -e "$2^{commit}" || exit; '
    + 'git -c core.quotepath=false -c log.showSignature=false --no-pager show --format= '
    + '--no-color --no-ext-diff --no-textconv --find-renames --diff-merges=first-parent --root -U3 "$2" -- '
    + '| head -c "$3"', 'devkits-commit-diff', folder, sha, String(LIMIT + 1)], { on });
  if (result.code !== 0 || !result.stdout && result.stderr?.trim()) throw new Error(result.stderr.trim() || 'Cannot read commit changes.');
  return { text: result.stdout.slice(0, LIMIT), truncated: await utf8ByteLength(result.stdout, options.yield) > LIMIT };
}

export function commitAge(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.floor(now / 1000 - at));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Date(at * 1000).toISOString().slice(0, 10);
}

export class CommitHistory {
  constructor(cx, parsePreview) {
    this.parsePreview = parsePreview;
    this.focus = cx?.focus_handle?.();
    this.scroll = VirtualListScrollHandle.new();
    this.reset(null);
  }

  reset(context) {
    this.context = context;
    this.version = (this.version || 0) + 1;
    this.selection = (this.selection || 0) + 1;
    this.entries = []; this.revision = null; this.hasMore = false;
    this.loaded = false; this.loading = false; this.dirty = false; this.error = null;
    this.preview = null; this.pending = null; this.previewError = null; this.index = 0; this.keyboard = false;
  }

  load(cx, more = false) {
    if (!this.context) return;
    if (this.loading) { if (!more) this.dirty = true; return; }
    if (more && !this.hasMore) return;
    const context = this.context, version = this.version;
    this.loading = true; this.retryMore = more; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const page = await readCommitHistory(context.folder, context.machine, more ? this.revision : null, more ? this.entries.length : 0);
        if (this.version !== version) return;
        // Keep already paged history when HEAD has not changed.
        if (more || page.revision !== this.revision || !this.loaded) {
          this.entries = more ? [...this.entries, ...page.entries] : page.entries;
          this.revision = page.revision; this.hasMore = page.hasMore;
          this.index = Math.min(this.index, Math.max(0, this.entries.length - 1));
        }
        this.loaded = true;
      } catch (error) {
        if (this.version === version) this.error = String(error.message || error);
      } finally {
        if (this.version === version) {
          this.loading = false;
          if (this.dirty) { this.dirty = false; this.load(cx); }
          cx.notify();
        }
      }
    });
  }

  select(commit, cx) {
    if (!this.context || !commit || this.pending === commit.sha) return;
    this.onSelect?.(commit, cx);
    if (this.preview?.commit.sha === commit.sha && !this.pending) { this.previewError = null; cx.notify(); return; }
    const context = this.context, version = this.version, selection = ++this.selection;
    this.pending = commit.sha; this.previewError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const patch = await readCommitPatch(context.folder, context.machine, commit.sha, { yield: () => cx.sleep?.(0) });
        if (this.version !== version || this.selection !== selection) return;
        const files = await this.parsePreview(patch.text, cx, () => this.version !== version || this.selection !== selection);
        if (this.version !== version || this.selection !== selection) return;
        this.preview = { commit, files, truncated: patch.truncated || Boolean(files?.truncated) };
      } catch (error) {
        if (this.version === version && this.selection === selection) this.previewError = String(error.message || error);
      } finally {
        if (this.version === version && this.selection === selection) { this.pending = null; cx.notify(); }
      }
    });
  }

  loadMore(cx, version, length) {
    if (this.version !== version || this.entries.length !== length || this.loading || this.error || !this.hasMore) return;
    this.load(cx, true);
  }

  row(commit, index, t) {
    const selected = (this.pending || this.preview?.commit.sha) === commit.sha;
    return v_flex().h(56).w_full().min_w(0).px(12).py(8).gap(4).cursor_pointer()
      .bg(selected || this.keyboard && this.index === index ? t.selected : t.chrome).hover(el => el.bg(t.hover))
      .accessibility_label(`${commit.subject}, ${commit.author}, ${commit.shortSha}`)
      .child(div().w_full().truncate().text_size(12).text_color(t.foreground).child(commit.subject))
      .child(h_flex().w_full().gap(8).text_size(11).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child(commit.author))
        .child(div().flex_none().child(commit.shortSha))
        .child(div().flex_none().child(this.pending === commit.sha ? 'Loading…' : commitAge(commit.at))));
  }

  render(t) {
    const length = this.entries.length, version = this.version;
    const count = length + (this.hasMore ? 1 : 0);
    let tailQueued = false;
    const note = text => v_flex().flex_1().items_center().justify_center().p(12).text_size(12).text_color(t.muted).child(text);
    return v_flex().flex_1().min_h(0).relative().track_focus(this.focus)
      .on_key_down((event, cx) => {
        if (!length) return;
        if (event.key === 'down') this.index = Math.min(length - 1, this.index + 1);
        else if (event.key === 'up') this.index = Math.max(0, this.index - 1);
        else if (event.key === 'home') this.index = 0;
        else if (event.key === 'end') this.index = length - 1;
        else if (event.key === 'enter') this.select(this.entries[this.index], cx);
        else return;
        if (this.index >= length - 5) this.loadMore(cx, version, length);
        this.keyboard = true; this.scroll.scroll_to_item(this.index, 'top'); cx.stop_propagation(); cx.notify();
      })
      .when(Boolean(this.error), el => el.child(v_flex().flex_none().p(12).gap(8).text_size(12).text_color(t.muted)
        .child(this.error).child(Button('history-retry', t, { variant: 'secondary' })
          .on_click((_event, cx) => this.load(cx, this.retryMore)).child('Retry'))))
      .child(count ? v_virtual_list('git-history-rows', count, 56,
        index => this.entries[index]?.sha || 'more',
        (range, cx) => Array.from({ length: range.end - range.start }, (_, offset) => {
          const index = range.start + offset, commit = this.entries[index];
          if (commit) return this.row(commit, index, t);
          // Deferred rows have their own element arena on each layout pass.
          // Queue the read after layout and never reuse an eager element here.
          if (!tailQueued) {
            tailQueued = true;
            cx.timer.after(0, cx => this.loadMore(cx, version, length));
          }
          return h_flex().h(56).px(12).items_center().text_size(12).text_color(t.muted)
            .child(this.error ? '' : 'Loading…');
        })).size_full().track_scroll(this.scroll)
        .on_item_click((key, cx) => {
          this.focus?.focus();
          this.keyboard = false;
          if (key !== 'more') { this.index = this.entries.findIndex(entry => entry.sha === key); this.select(this.entries[this.index], cx); }
        }) : note(this.loading ? 'Loading history…' : this.error ? 'History unavailable' : 'No commits yet'))
      .when(count > 0, el => el.child(Scrollbar.vertical('git-history-rows').absolute().inset_0()));
  }
}
