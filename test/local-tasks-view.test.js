import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import * as policy from '../mods/herdr-zed-tasks/agent-board-model.js';

test('local list and board retain selection and search, showing reported results independently of task stage', async () => {
  const nodes = new Map(), memory = {};
  const node = () => {
    const value = { items: [] };
    const proxy = new Proxy(value, { get(target, method) {
      if (method in target) return target[method];
      return (...args) => {
        if (method === 'id') { target.id = args[0]; nodes.set(args[0], proxy); }
        if (method === 'child') target.items.push(args[0]);
        if (method === 'children') target.items.push(...args[0]);
        if (method === 'when' && args[0]) args[1](proxy);
        if (method === 'on_click') target.click = args[0];
        return proxy;
      };
    } });
    return proxy;
  };
  const task = { gid: 'local:one', name: 'Fix issue', source: 'local', status: 'review', notes: '', agents: [], tabs: [],
    execution: { id: 'run:one', status: 'done', summary: 'Login tests passed' } };
  let query = '';
  const search = { value: () => query, set_value: value => { query = value; } };
  const { AgentBoard } = await evaluateNative('../mods/herdr-zed-tasks/agent-board.js', {
    ...policy, div: node, h_flex: node, v_flex: node, glyph: node,
    Button: id => node().id(id), Input: { new: node },
    boardTheme: () => ({}), props: () => ({ sourceHub: 'fixture' }),
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    boardRecords: () => ({}), projectBoardTasks: () => [task], installedSources: () => [],
    taskIdentifier: () => 'LOCAL', launcherLabel: value => value,
    SidePanelLayout: (_id, _state, content, detail) => node().child(content).child(detail),
  }, 'AgentBoard');
  const board = new AgentBoard();
  Object.assign(board, { viewMode: 'list', search, handle: {}, detailPanel: { end() {} },
    detail: {}, cardMenu: {}, title: { set_value() {} }, description: { set_value() {} }, dueDate: { set_value() {} } });
  board.preview = () => node().id('fixture-detail');
  const project = { id: 'p', folder: '/p' }, cx = { notify() {}, stop_propagation() {} };
  board.render(project, [], [], {}, cx);
  assert.ok(nodes.has('agent-task-list'));
  memory['herdr-zed.board-focus'] = { project: '["","/other"]', gid: task.gid };
  board.render(project, [], [], {}, cx);
  assert.equal(memory['herdr-zed.board-focus'].gid, task.gid, 'A different project cannot consume a task link');
  assert.equal(board.selected, null);
  memory['herdr-zed.board-focus'] = { project: policy.boardKey(project), gid: task.gid };
  board.render(project, [], [], {}, cx);
  assert.equal(memory['herdr-zed.board-focus'], null);
  nodes.get('task-row-local:one').click({}, cx);
  assert.equal(board.selected, task.gid);
  nodes.get('tasks-view-board').click({}, cx);
  nodes.clear(); board.render(project, [], [], {}, cx);
  assert.equal(board.selected, task.gid); assert.ok(nodes.has('fixture-detail'));
  assert.ok(nodes.has('board-card-local:one')); assert.equal(memory['herdr-zed.tasks.view'], 'board');
  query = 'tests passed';
  nodes.get('tasks-view-list').click({}, cx);
  nodes.clear(); board.render(project, [], [], {}, cx);
  assert.equal(query, 'tests passed'); assert.ok(nodes.has('task-row-local:one'));
  assert.equal(board.selected, task.gid); assert.equal(task.status, 'review');
  assert.equal(policy.taskExecutionLabel(task), 'Agent finished');
});
