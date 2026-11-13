// @ts-check
// Project search data: the git grep script and arguments, and parsing its output into result rows.
import { findInText } from './find.js';

export const LINE = 20, HEADER = 32, GAP = 8;
export const MAX_BYTES = 4000000, MAX_MATCHES = 2000, MAX_TEXT = 500;

// Git lists the files Zed would search: tracked and untracked, without ignored ones.
// Outside a repository it searches the folder as is. Queries are arguments, never shell code.
export const SEARCH_SCRIPT = 'dir=$1; shift; cd "$dir" || exit 2; '
  + 'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then scope=--untracked; else scope=--no-index; fi; '
  + `git -c core.quotepath=false grep $scope -I -n -z -C1 --no-color "$@" | head -c ${MAX_BYTES}`;

/**
 * The `git grep` arguments for a query. Grep only narrows the candidates case-insensitively;
 * find.js decides the matches, so case, whole word and smart case behave as in buffer search.
 * @param {string} query @param {{ regex?: boolean }} options
 */
export function grepArgs(query, { regex = false } = {}, { include = '', exclude = '' } = {}) {
  const includes = globs(include).map(glob => `:(glob)${glob}`), excludes = globs(exclude).map(glob => `:(glob,exclude)${glob}`);
  return ['-i', regex ? '-P' : '-F', '-e', query, '--', ...(includes.length ? includes : ['.']), ...excludes];
}

/**
 * Zed's include/exclude field: comma-separated globs relative to the project. A glob without a
 * slash matches at any depth (`*.js`); a folder name or a trailing slash covers everything inside.
 * @param {string} text @returns {string[]}
 */
export function globs(text) {
  return text.split(',').map(part => part.trim().replace(/^\.\//, '')).filter(Boolean).flatMap(glob => {
    const folder = glob.endsWith('/');
    const base = folder ? glob.slice(0, -1) : glob;
    const anchored = base.includes('/') ? base : `**/${base}`;
    // Without wildcards a name may be a file or a folder, so cover both.
    return folder ? [`${anchored}/**`] : /[*?[]/.test(base) ? [anchored] : [anchored, `${anchored}/**`];
  });
}

/**
 * Parses `git grep -n -z -C1` output into files of lines, keeping matching lines and their neighbours.
 * @param {string} stdout @param {RegExp} pattern
 * @returns {{ files: { path: string, lines: { n: number, text: string, ranges: [number, number][] }[], count: number }[], total: number, limited: boolean }}
 */
export function parseGrep(stdout, pattern) {
  const byPath = new Map();
  for (const raw of stdout.split('\n')) {
    const first = raw.indexOf('\0'), second = first < 0 ? -1 : raw.indexOf('\0', first + 1);
    if (second < 0) continue;
    const path = raw.slice(0, first), n = Number(raw.slice(first + 1, second));
    if (!Number.isInteger(n)) continue;
    let text = raw.slice(second + 1).replace(/\r$/, '');
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push({ n, text, ranges: findInText(text, pattern) });
  }
  const files = [];
  let total = 0, limited = false;
  for (const [path, all] of byPath) {
    if (total >= MAX_MATCHES) { limited = true; break; }
    const hits = new Set(all.filter(line => line.ranges.length).map(line => line.n));
    if (!hits.size) continue;
    // Context comes from grep's candidates; keep only lines next to a real match.
    const lines = all.filter(line => hits.has(line.n) || hits.has(line.n - 1) || hits.has(line.n + 1))
      .map(line => hits.has(line.n) ? line : { ...line, ranges: [] });
    const count = lines.reduce((sum, line) => sum + line.ranges.length, 0);
    files.push({ path, lines, count });
    total += count;
  }
  return { files, total, limited };
}

/** Rows for the result list: a header per file, its lines, and a gap where lines are not consecutive. */
export function resultRows(files) {
  const rows = [], sizes = [];
  for (const [index, file] of files.entries()) {
    rows.push({ key: `file:${file.path}`, kind: 'file', file, first: index === 0 }); sizes.push(index === 0 ? HEADER : HEADER + GAP);
    let previous = null;
    for (const line of file.lines) {
      if (previous !== null && line.n !== previous + 1) { rows.push({ key: `gap:${file.path}:${line.n}`, kind: 'gap' }); sizes.push(LINE); }
      rows.push({ key: `line:${file.path}:${line.n}`, kind: 'line', path: file.path, line }); sizes.push(LINE);
      previous = line.n;
    }
  }
  return { rows, sizes };
}

