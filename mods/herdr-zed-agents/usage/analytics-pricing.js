// USD / million tokens, standard processing / short context. Checked 2026-11-06.
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-5.4
// https://developers.openai.com/api/docs/models/gpt-5.2
// https://developers.openai.com/api/docs/models/gpt-5.2-codex
// https://developers.openai.com/api/docs/models/gpt-5.1-codex
// https://platform.claude.com/docs/en/about-claude/pricing
export const pricingDate = '2026-11-06';
// Input, output, cache read, short cache write, long cache write.
const rates = {
  'gpt-6-astra': [10, 50, 1, 12.5, 25],
  'gpt-6.1-sol': [2, 10, 0.1, 2.5, 5],
  'gpt-6.1-terra': [1, 5, 0.05, 1.25, 2.5],
  'gpt-6-luna': [0.1, 0.5, 0.01, 0.125, 0.25],
  'gpt-6-sol': [2, 10, 0.2, 2.5],
  'gpt-5.4': [2.5, 15, 0.25],
  'gpt-5.3-codex': [1.75, 14, 0.175],
  'gpt-5.2-codex': [1.75, 14, 0.175],
  'gpt-5.2': [1.75, 14, 0.175],
  'gpt-5.1-codex': [1.25, 10, 0.125],
  'claude-fable-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-mythos-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-opus-5-5': [4, 20, 0.2, 5, 8],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5, 4],
  'claude-opus-5': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-8': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-7': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-6': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-5': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-1': [15, 75, 1.5, 18.75, 30],
  'claude-opus-4': [15, 75, 1.5, 18.75, 30],
  'claude-sonnet-5': [2, 10, 0.2, 2.5, 4],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75, 6],
  'claude-sonnet-4-5': [3, 15, 0.3, 3.75, 6],
  'claude-sonnet-4': [3, 15, 0.3, 3.75, 6],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25, 2],
};

export function estimateCost(event) {
  // Only explicit IDs or dated snapshots; never guess aliases or future versions.
  const model = (event.model || '').replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  const rate = Object.hasOwn(rates, model) ? rates[model] : null;
  if (!rate || (event.cacheWrite && rate[3] == null)) return null;
  const long = Math.min(event.cacheWrite || 0, event.cacheWrite1h || 0);
  return ((event.input || 0) * rate[0] + (event.output || 0) * rate[1]
    + (event.cacheRead || 0) * rate[2] + ((event.cacheWrite || 0) - long) * (rate[3] || 0)
    + long * (rate[4] || rate[3] || 0)) / 1e6;
}

export function costLabel(cost) {
  if (!cost || (!cost.pricedTokens && cost.unpricedTokens)) return '';
  const usd = cost.usd > 0 && cost.usd < 0.01 ? '<$0.01' : `$${cost.usd.toFixed(2)}`;
  return usd;
}
