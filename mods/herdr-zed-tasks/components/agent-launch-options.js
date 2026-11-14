import { sessionKind } from './session-model.js';

export const eccProfiles = [
  { id: 'basic', name: 'Basic', description: 'No optional ECC components. Herdr task progress stays available.', ids: [] },
  { id: 'development', name: 'Development', description: 'Test-driven implementation, failure diagnosis and verification.',
    ids: ['skills:tdd-workflow', 'skills:agent-introspection-debugging', 'skills:verification-loop'] },
  { id: 'supervisor', name: 'Supervisor', description: 'Task decomposition, model tiers, work ownership and result verification.',
    ids: ['skills:agentic-engineering', 'skills:team-agent-orchestration', 'skills:verification-loop', 'agents:planner.md', 'agents:code-reviewer.md'] },
  { id: 'review', name: 'Code review', description: 'Change verification and security review; specialist reviewers on Claude Code.',
    ids: ['skills:verification-loop', 'skills:security-review', 'agents:code-reviewer.md', 'agents:security-reviewer.md'] },
];

// New thread and Tasks use the same invocation choices; full capability management stays in Agents.
export function agentWorkflowFields(agent, saved = {}, { local = true, executor = null } = {}) {
  const kind = sessionKind(agent);
  if (!local || !['codex', 'claude'].includes(kind)) return [];
  return [
    ...(executor?.providers.includes(kind) ? [{ id: 'workflow', label: 'Workflow', type: 'select', row: 'secondary',
      value: saved.workflow === 'supervisor' ? 'supervisor' : 'direct',
      options: [{ key: 'direct', label: 'Single session' }, { key: 'supervisor', label: 'Supervisor' }] }] : []),
    { id: 'eccProfile', label: 'ECC', type: 'select', row: 'secondary',
      value: eccProfiles.some(profile => profile.id === saved.eccProfile) ? saved.eccProfile : 'inherit',
      options: [{ key: 'inherit', label: 'Global/project default' }, ...eccProfiles.map(profile => ({ key: profile.id, label: profile.name }))] },
  ];
}

export function launchWorkflowOptions(values = {}) {
  const eccProfile = [undefined, null, 'inherit', 'default'].includes(values.eccProfile) ? null : values.eccProfile;
  if (eccProfile !== null && !eccProfiles.some(profile => profile.id === eccProfile)) throw Error('Choose an available ECC preset.');
  if (values.workflow != null && !['direct', 'supervisor'].includes(values.workflow)) throw Error('Choose an available workflow.');
  return { ...(eccProfile ? { eccProfile } : {}), ...(values.workflow === 'supervisor' ? { workflow: 'supervisor' } : {}) };
}
