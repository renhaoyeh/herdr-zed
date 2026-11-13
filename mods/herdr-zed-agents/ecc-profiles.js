import { eccItemEnabled } from './ecc-model.js';

export const eccCostSkill = 'skills:cost-aware-llm-pipeline';
export const eccProfiles = [
  { id: 'basic', name: 'Basic', description: 'No optional ECC components. Herdr task progress stays available.', ids: [] },
  { id: 'development', name: 'Development', description: 'Test-driven implementation, failure diagnosis and verification.',
    ids: ['skills:tdd-workflow', 'skills:agent-introspection-debugging', 'skills:verification-loop'] },
  { id: 'supervisor', name: 'Supervisor', description: 'Task decomposition, model tiers, work ownership and result verification.',
    ids: ['skills:agentic-engineering', 'skills:team-agent-orchestration', 'skills:verification-loop', 'agents:planner.md', 'agents:code-reviewer.md'] },
  { id: 'review', name: 'Code review', description: 'Change verification and security review; specialist reviewers on Claude Code.',
    ids: ['skills:verification-loop', 'skills:security-review', 'agents:code-reviewer.md', 'agents:security-reviewer.md'] },
];

export function eccProfilePlan(items, provider, id, cost = false) {
  const profile = eccProfiles.find(profile => profile.id === id);
  if (!profile || !['claude', 'codex'].includes(provider)) throw Error('Choose a supported ECC profile and provider.');
  const ids = [...profile.ids, ...(cost ? [eccCostSkill] : [])].filter(id => provider === 'claude' || !id.startsWith('agents:'));
  const selected = ids.map(id => items.find(item => item.id === id && item.providers.includes(provider)));
  const missing = ids.filter((id, index) => !selected[index] || selected[index].unavailable);
  return { profile, ids, items: selected.filter(Boolean), missing };
}

export function eccProfileName(config, provider, items) {
  const selected = new Set(Object.entries(config.selection?.[provider] || {}).filter(([, on]) => on).map(([id]) => id));
  for (const item of items) if (eccItemEnabled(config, provider, item)) selected.add(item.id);
  const cost = selected.delete(eccCostSkill);
  for (const profile of eccProfiles) {
    const plan = eccProfilePlan(items, provider, profile.id);
    if (!plan.missing.length && plan.ids.length === selected.size && plan.ids.every(id => selected.has(id)))
      return `${profile.name}${cost ? ' + Cost conscious' : ''}`;
  }
  return 'Custom';
}

export function applyEccProfile(config, provider, items, id, cost) {
  const plan = eccProfilePlan(items, provider, id, cost);
  if (plan.missing.length) throw Error(`Profile components unavailable: ${plan.missing.join(', ')}`);
  config.selection = { ...config.selection, [provider]: Object.fromEntries(plan.ids.map(id => [id, true])) };
  return plan;
}
