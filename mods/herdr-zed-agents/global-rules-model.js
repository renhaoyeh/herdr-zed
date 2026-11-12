// An empty Guide adds no custom global instructions.
export const defaultRules = '';

/** Shifts Markdown headings down by `levels`, leaving fenced code untouched. */
export function demoteHeadings(text, levels = 1) {
  let fence = false;
  return (text || '').split(/\r?\n/).map(line => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    return !fence && /^#{1,6}\s/.test(line) ? '#'.repeat(levels) + line : line;
  }).join('\n');
}

/**
 * One "# Global rules" document: enabled Devkits capabilities first (summary list, then their
 * sections), selected ECC guidance next, and the user's own Guide last as "## Custom rules".
 * @param {{ summary?: string, sections?: string } | null} kits
 */
export function composeSessionRules(guide, kits, ecc = '') {
  const custom = (guide || '').replace(/^\s*# Global rules[^\n]*\n/, '').trim();
  const parts = [
    kits?.summary?.trim(), kits?.sections?.trim(),
    ecc?.trim() && '## ECC selected guidance\n\n' + demoteHeadings(ecc.trim(), 2),
    custom && '## Custom rules\n\n' + demoteHeadings(custom, 1),
  ].filter(Boolean);
  return parts.length ? '# Global rules\n\n' + parts.join('\n\n') + '\n' : '';
}
