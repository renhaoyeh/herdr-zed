import { agentWorkflowFields, launchWorkflowOptions } from '../components/agent-launch-options.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import * as sessions from '../components/session-model.js';
import * as policy from '../mods/herdr-zed-tasks/agent-board-model.js';

function ui() {
  const nodes = new Map(), texts = [], picks = new Map();
  const node = () => {
    const target = { items: [] };
    const proxy = new Proxy(target, { get: (target, key) => key in target ? target[key] : (...args) => {
      if (key === 'id') nodes.set(args[0], proxy);
      if (key === 'child' && typeof args[0] === 'string') texts.push(args[0]);
      if (key === 'child') target.items.push(args[0]);
      if (key === 'children') target.items.push(...args[0]);
      if (key === 'when' && args[0]) args[1](proxy);
      if (key === 'on_click') target.click = args[0];
      return proxy;
    } });
    return proxy;
  };
  const host = { div: node, h_flex: node, v_flex: node, glyph: node,
    Button: id => node().id(id), ToolbarButton: id => node().id(id), SelectState: class {},
    Select: (id, state, value, options, label, change, _theme, style) => {
      picks.set(id, { value, options, change, style }); return node().id(id);
    }, Textarea: { new: node }, Input: { new: node },
    TextareaState: { new: () => { let value = ''; return { set_auto_grow() {}, on() {}, value: () => value, set_value: next => { value = next; } }; } },
    TextView: { markdown: (_id, text) => node().child(text) } };
  return { nodes, texts, picks, host };
}

test('Tasks shares ECC and Workflow choices with New thread and launches only with the main model', async () => {
  const h = ui(), memory = {}, started = [];
  const executor = { providers: ['codex', 'claude'] };
  const { TaskSession } = await evaluateNative('../mods/herdr-zed-tasks/task-session.js', {
    ...sessions, ...h.host, agentWorkflowFields, launchWorkflowOptions, workflowExecutor: () => executor,
    home: () => '/home', shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    continuationPrompt: () => '', withAttachments: text => text,
  }, 'TaskSession');
  const panel = new TaskSession(); panel.init({});
  panel.codexModels.set('/home/.codex', [{ key: 'main', label: 'Main', efforts: ['high'] }]);
  const render = agent => { h.picks.clear(); panel.launchRow({ gid: 'task' }, [agent], (...args) => started.push(args[2]), {}); };
  for (const kind of ['codex', 'claude']) {
    const agent = { key: kind, name: kind, run: [kind] };
    const saved = { workflow: 'supervisor', eccProfile: 'review', model: kind === 'codex' ? 'main' : 'opus', researchModel: 'removed' };
    memory['herdr-zed.profile-sessions'] = { [kind]: saved };
    render(agent);
    for (const field of agentWorkflowFields(agent, saved, { executor })) {
      const pick = h.picks.get(`task-session-${field.id}`);
      assert.equal(pick.value, field.value);
      assert.deepEqual(pick.options.map(({ key, label }) => ({ key, label })), field.options);
    }
    assert.equal(h.picks.has('task-session-researchModel'), false);
    assert.equal(h.picks.has('task-session-reviewModel'), false);
    const secondary = h.nodes.get('task-session-workflow-row');
    assert.ok(secondary.items.includes(h.nodes.get('task-session-eccProfile')));
    assert.ok(secondary.items.includes(h.nodes.get('task-session-workflow')));
    assert.equal(h.nodes.get('task-session-primary-row').items.includes(h.nodes.get('task-session-eccProfile')), false);
    assert.deepEqual(h.nodes.get('task-session-primary-row').items, [h.nodes.get('task-session-controls'), h.nodes.get('task-session-start')],
      'The start arrow is outside the wrapping controls and remains at the right');
    for (const pick of h.picks.values()) {
      assert.equal(pick.style.toolbar, true);
      assert.equal(pick.style.prefix, undefined, 'Toolbar choices have no form labels above them');
    }
    assert.ok(h.nodes.has('task-session-composer'));
    h.picks.get('task-session-eccProfile').change('development');
    h.picks.get('task-session-workflow').change('direct');
    assert.equal(started.length, 0);
    assert.equal(memory['herdr-zed.profile-sessions'][kind].eccProfile, 'development');
    render(agent); h.nodes.get('task-session-start').click();
    const direct = started.pop();
    assert.equal(direct.eccProfile, 'development'); assert.equal(direct.workflow, undefined);
    assert.equal(direct.model, saved.model); assert.equal(direct.researchModel, undefined);
    h.picks.get('task-session-workflow').change('supervisor');
    render(agent); h.nodes.get('task-session-start').click();
    assert.equal(started.pop().workflow, 'supervisor');
    h.picks.get('task-session-eccProfile').change('inherit');
    render(agent); h.nodes.get('task-session-start').click();
    assert.equal(started.pop().eccProfile, undefined, 'Inheritance sends no ECC override');
    panel.machine = 'remote'; render(agent);
    assert.equal(h.picks.has('task-session-workflow'), false); assert.equal(h.picks.has('task-session-eccProfile'), false);
    panel.machine = null;
  }
  render({ key: 'custom', name: 'Custom', run: ['custom'] });
  assert.equal(h.picks.has('task-session-workflow'), false); assert.equal(h.picks.has('task-session-eccProfile'), false);
});

test('execution history shows supervisor stages for current and historical runs, retaining conversation access', async () => {
  const h = ui(), opened = [];
  const { AgentBoard } = await evaluateNative('../mods/herdr-zed-tasks/agent-board.js', {
    ...policy, ...h.host, shared: () => null, taskIdentifier: () => 'LOCAL', launcherLabel: value => value,
  }, 'AgentBoard');
  const board = new AgentBoard();
  board.detail = {}; board.session = { render: () => null };
  const task = { gid: 't', name: 'Task', source: 'local', status: 'review', notes: '', tabs: [{ id: 'tab' }], agents: [],
    runs: [{ id: 'old', status: 'fail', supervisor: { stages: [{ kind: 'research', status: 'done', model: 'small', summary: 'Found the cause' }] } }],
    execution: { id: 'current', status: 'done', supervisor: { stages: [{ kind: 'review', status: 'done', model: 'main', verdict: 'pass', summary: 'Tests passed' }] } } };
  board.preview(task, { name: 'Project' }, [], { thread: id => opened.push(id) }, {}, {});
  assert.ok(h.texts.includes('Research · done · small'));
  assert.ok(h.texts.includes('Found the cause'));
  assert.ok(h.texts.includes('Review · done · main'));
  assert.ok(h.texts.includes('Verdict: pass'));
  assert.ok(h.texts.includes('Tests passed'));
  h.nodes.get('board-thread-tab').click();
  assert.deepEqual(opened, ['tab']);
  h.nodes.clear();
  task.execution.status = 'doing'; task.agents = [];
  board.preview(task, { name: 'Project' }, [], {}, {}, {});
  assert.ok(h.nodes.has('board-stop-session'), 'An unreported or exited stage can still be stopped from ordinary controls');
});
