// Shell side of ARCHITECTURE §3.3: merge decorator envelopes into per-tab decorations. Only the fields each
// decorator declared are read; the first enabled decorator in catalog order wins a field.
import { validateDecorations } from './components/extension-contract.js';

export const decorationKey = id => `herdr-zed.decorations.${id}`;

/** @returns {Map<string, { badge?: string, subtitle?: string, tone?: string }>} */
export function threadDecorations(decorators, read) {
  const result = new Map();
  for (const decorator of decorators) {
    const threads = validateDecorations(read(decorationKey(decorator.id)));
    for (const [tabId, entry] of Object.entries(threads)) {
      const current = result.get(tabId) || {};
      for (const field of decorator.fields) {
        if (entry[field] !== undefined && current[field] === undefined) current[field] = entry[field];
      }
      if (Object.keys(current).length) result.set(tabId, current);
    }
  }
  return result;
}

// Tones use the shell's status tokens; `muted` is the default for unknown or absent tones.
export const decorationTone = (t, tone) => ({ accent: t.accent, warning: t.blocked, error: t.ansi1 })[tone] || t.muted;
