import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { sessionKind } from '../components/session-model.js';
import { validateLaunchTarget } from '../components/extension-contract.js';

async function harness() {
  const memory = {}, writes = [];
  const api = await evaluateNative('../components/agent-workflows.js', {
    sessionKind, validateLaunchTarget, spaces: () => [{ id: 'p' }, { id: 'remote', machine: 'host' }],
    shared: key => memory[key], setShared: (key, value) => { writes.push(key); memory[key] = value; },
  }, 'AGENT_WORKFLOW_EXECUTORS, AGENT_WORKFLOW_REQUESTS, workflowExecutor, registerAgentWorkflow, validateAgentWorkflow, requestAgentWorkflow, takeAgentWorkflows');
  return { ...api, memory, writes };
}

test('workflow executor leases expire and disabled owners disappear without provider-specific shell code', async () => {
  const h = await harness(), now = 100000;
  h.registerAgentWorkflow('supervisor', 'tasks', 'Supervisor', ['codex', 'claude'], now);
  assert.deepEqual(h.workflowExecutor('supervisor', now).providers, ['codex', 'claude']);
  const writes = h.writes.length;
  h.registerAgentWorkflow('supervisor', 'tasks', 'Supervisor', ['codex', 'claude'], now + 1000);
  assert.equal(h.writes.length, writes, 'A healthy lease does not write shared state every timer tick');
  assert.throws(() => h.registerAgentWorkflow('supervisor', 'other', 'Other', ['codex'], now), /already has/);
  assert.equal(h.workflowExecutor('supervisor', now + 16000), null);
  h.memory['herdr-zed.extensions.catalog'] = { ready: true, packages: [{ id: 'tasks', enabled: false }] };
  assert.equal(h.workflowExecutor('supervisor', now), null);
});

test('workflow requests validate scope and options, deduplicate identities and are claimed only by their owner', async () => {
  const h = await harness(), now = 100000;
  h.registerAgentWorkflow('supervisor', 'tasks', 'Supervisor', ['codex', 'claude'], now);
  const target = { space: 'p', folder: '/project', task: 'Fix the form\nKeep attachments.' };
  const options = { workflow: 'supervisor', model: 'main', effort: null };
  const send = (changes = {}) => h.requestAgentWorkflow('supervisor', { key: 'claude' }, target, options, { id: 'intent:one', ...changes }, now);
  assert.equal(send(), 'intent:one'); assert.equal(send(), 'intent:one');
  assert.equal(h.memory[h.AGENT_WORKFLOW_REQUESTS].length, 1);
  assert.deepEqual(h.takeAgentWorkflows('other', now), []);
  const [request] = h.takeAgentWorkflows('tasks', now);
  assert.deepEqual(request.target, { space: 'p', folder: '/project' });
  assert.equal(request.task, target.task); assert.equal(request.agent, 'claude');
  assert.deepEqual(request.options, options); assert.deepEqual(h.takeAgentWorkflows('tasks', now), []);
  for (const bad of [
    { target: { space: 'remote', machine: 'host', folder: '/project' } },
    { target: { space: 'missing', folder: '/project' } },
    { task: ' ' }, { options: { ...options, readOnly: false } }, { expiresAt: now - 1 },
    { options: { ...options, researchModel: 'removed' } }, { terminal: 't-spoof' },
  ]) assert.throws(() => h.validateAgentWorkflow({ ...request, ...bad }, now));
  assert.throws(() => h.requestAgentWorkflow('supervisor', { key: 'custom' }, target, options, {}, now), /unavailable/);
});
