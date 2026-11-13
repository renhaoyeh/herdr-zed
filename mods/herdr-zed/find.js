// @ts-check
// Text search with Zed's buffer-search rules: plain text or regex, optional whole word,
// and smart case (a query with an uppercase letter matches case exactly).

/** @typedef {{ caseSensitive?: boolean, wholeWord?: boolean, regex?: boolean }} FindOptions */

/**
 * Compiles a query to a global regex, or explains why it cannot.
 * @param {string} query @param {FindOptions} [options]
 * @returns {{ pattern: RegExp | null, error: string | null }}
 */
export function compileQuery(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  if (!query) return { pattern: null, error: null };
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // As in Zed, a word boundary is only required where the query itself starts or ends with a word character.
  if (wholeWord) {
    const word = /[\p{L}\p{N}_]/u;
    if (regex || word.test(query[0])) source = `(?<![\\p{L}\\p{N}_])(?:${source})`;
    if (regex || word.test(query.at(-1) || '')) source = `(?:${source})(?![\\p{L}\\p{N}_])`;
  }
  const exact = caseSensitive || /\p{Lu}/u.test(query);
  try { return { pattern: new RegExp(source, exact ? 'gu' : 'giu'), error: null }; }
  catch (error) { return { pattern: null, error: String(/** @type {Error} */ (error).message || error) }; }
}

/**
 * Every match of `pattern` in `text`, as [start, end) ranges. Empty matches are skipped.
 * @param {string} text @param {RegExp | null} pattern
 * @returns {[number, number][]}
 */
export function findInText(text, pattern) {
  if (!pattern || !text) return [];
  const out = /** @type {[number, number][]} */ ([]);
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (match[0].length) out.push([start, start + match[0].length]);
  }
  return out;
}

/**
 * Splits text into runs at mark and match boundaries, so each run has one background.
 * @param {number} length
 * @param {[number, number] | null | undefined} marks the changed range of a modified line
 * @param {{ range: [number, number], current: boolean }[]} hits
 * @returns {{ start: number, end: number, mark: boolean, hit: boolean, current: boolean }[]}
 */
export function textRuns(length, marks, hits) {
  const cuts = new Set([0, length]);
  if (marks) { cuts.add(marks[0]); cuts.add(marks[1]); }
  for (const { range } of hits) { cuts.add(range[0]); cuts.add(range[1]); }
  const points = [...cuts].filter(n => n >= 0 && n <= length).sort((a, b) => a - b), runs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i], end = points[i + 1];
    const hit = hits.find(({ range }) => range[0] <= start && end <= range[1]);
    runs.push({ start, end, mark: Boolean(marks && marks[0] <= start && end <= marks[1]), hit: Boolean(hit), current: Boolean(hit?.current) });
  }
  return runs;
}

/** Search state for a view: the query, its options and the active match. */
export class FindState {
  constructor() {
    /** @type {any} */ this.input = null;
    this.open = false; this.caseSensitive = false; this.wholeWord = false; this.regex = false; this.index = 0;
    /** @type {string | null} */ this.error = null;
    /** @type {{ source: any, key: string, matches: any[] } | null} */ this.cache = null;
  }

  get query() { return this.input?.value() || ''; }

  /** @param {'caseSensitive' | 'wholeWord' | 'regex'} option */
  toggle(option) { this[option] = !this[option]; this.index = 0; }

  /**
   * Matches in `source`, cached until the source, query or options change.
   * @template T
   * @param {any} source identity of the searched content
   * @param {(pattern: RegExp) => T[]} collect
   * @returns {T[]}
   */
  matches(source, collect) {
    if (!this.open || !this.query) { this.error = null; return []; }
    const key = JSON.stringify([this.query, this.caseSensitive, this.wholeWord, this.regex]);
    let cache = this.cache;
    if (cache?.source !== source || cache?.key !== key) {
      const { pattern, error } = compileQuery(this.query, this);
      this.error = error;
      cache = this.cache = { source, key, matches: pattern ? collect(pattern) : [] };
      if (this.index >= cache.matches.length) this.index = 0;
    }
    return /** @type {T[]} */ (cache.matches);
  }

  /** @param {number} count @param {number} step */
  move(count, step) { if (count) this.index = (this.index + step + count) % count; }
}
