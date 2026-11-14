// Optional workflow executors consume Agent Runtime requests; the launcher never imports Work code.
import { shared, setShared, spaces } from 'herdr';
import { sessionKind } from './session-model.js';
import { validateLaunchTarget } from './extension-contract.js';

export const AGENT_WORKFLOW_EXECUTORS = 'herdr-zed.agents.workflow.executors';
export const AGENT_WORKFLOW_REQUESTS = 'herdr-zed.agents.workflow.requests';
const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);

export function workflowExecutor(id, now = Date.now()) {
  const item = shared(AGENT_WORKFLOW_EXECUTORS)?.[id];
  if (!name(id) || !name(item?.owner) || typeof item.label !== 'string' || !item.label.trim()
    || !Array.isArray(item.providers) || !item.providers.length || item.providers.some(kind => !['codex', 'claude'].includes(kind))
    || !Number.isFinite(item.expiresAt) || item.expiresAt <= now || item.expiresAt > now + 30000) return null;
  const catalog = shared('herdr-zed.extensions.catalog');
  if (catalog?.ready && !catalog.packages?.some(pkg => pkg.id === item.owner && pkg.enabled && !pkg.error)) return null;
  return item;
}

export function registerAgentWorkflow(id, owner, label, providers, now = Date.now()) {
  if (!name(id) || !name(owner) || typeof label !== 'string' || !label.trim()
    || !Array.isArray(providers) || !providers.length || providers.some(kind => !['codex', 'claude'].includes(kind)))
    throw Error('Invalid workflow executor.');
  const all = shared(AGENT_WORKFLOW_EXECUTORS) || {}, previous = all[id];
  if (previous && previous.owner !== owner && previous.expiresAt > now) throw Error('This workflow already has an executor.');
  if (previous?.owner === owner && previous.label === label && JSON.stringify(previous.providers) === JSON.stringify(providers)
    && previous.expiresAt > now + 5000) return;
  setShared(AGENT_WORKFLOW_EXECUTORS, { ...all, [id]: { owner, label, providers, expiresAt: now + 15000 } });
}

export function validateAgentWorkflow(request, now = Date.now()) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['id', 'workflow', 'owner', 'agent', 'target', 'task', 'options', 'expiresAt'].includes(key))
    || typeof request.id !== 'string' || !request.id || request.id.length > 200 || !name(request.workflow) || !name(request.owner)
    || typeof request.agent !== 'string' || !request.agent || request.agent.length > 200
    || !Number.isFinite(request.expiresAt) || request.expiresAt <= now || request.expiresAt > now + 30000)
    throw Error('Invalid or expired workflow request.');
  const target = validateLaunchTarget(request.target, spaces());
  if (!target.ok) throw Error(target.error);
  if (request.target.machine) throw Error('Workflows require a local project.');
  if (typeof request.task !== 'string' || !request.task.trim() || request.task.length > 20000)
    throw Error('A workflow needs task text of 1–20000 characters.');
  const options = request.options;
  if (!options || typeof options !== 'object' || Array.isArray(options) || options.workflow !== request.workflow
    || Object.keys(options).some(key => !['workflow', 'model', 'effort', 'serviceTier', 'eccProfile'].includes(key)))
    throw Error('Invalid workflow options.');
  for (const key of ['model', 'effort'])
    if (options[key] != null && (typeof options[key] !== 'string' || !options[key].trim() || options[key].length > 200))
      throw Error(`Invalid workflow ${key}.`);
  if (options.serviceTier != null && options.serviceTier !== 'fast') throw Error('Invalid workflow service tier.');
  if (options.eccProfile != null && !['basic', 'development', 'supervisor', 'review'].includes(options.eccProfile)) throw Error('Invalid workflow ECC profile.');
  return request;
}

export function requestAgentWorkflow(id, agent, target, options, request = {}, now = Date.now()) {
  const executor = workflowExecutor(id, now);
  if (!executor || !executor.providers.includes(sessionKind(agent))) throw Error('This workflow is unavailable for this program.');
  const { task, ...location } = target;
  const item = validateAgentWorkflow({ id: request.id || `workflow:${now}:${Math.random().toString(36).slice(2)}`,
    workflow: id, owner: executor.owner, agent: agent.key, target: location, task, options,
    expiresAt: request.expiresAt ?? now + 30000 }, now);
  const queued = (shared(AGENT_WORKFLOW_REQUESTS) || []).filter(item => item?.expiresAt > now);
  if (!queued.some(entry => entry.id === item.id)) setShared(AGENT_WORKFLOW_REQUESTS, [...queued, item]);
  return item.id;
}

export function takeAgentWorkflows(owner, now = Date.now()) {
  const queued = shared(AGENT_WORKFLOW_REQUESTS) || [];
  const own = queued.filter(item => item?.owner === owner && item.expiresAt > now);
  const remaining = queued.filter(item => item?.owner !== owner && item?.expiresAt > now);
  if (remaining.length !== queued.length) setShared(AGENT_WORKFLOW_REQUESTS, remaining);
  return own;
}
