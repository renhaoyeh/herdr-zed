import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import * as asana from '../mods/devkits-asana/api.js';
import * as mantis from '../mods/devkits-mantisbt/api.js';

const reply = data => ({ ok: true, status: 200, json: async () => data });
const cx = { notify() {} };
async function controller(provider = 'asana') {
  const values = {}, nodes = new Map();
  const element = id => {
    const node = { children: [] };
    const proxy = new Proxy(node, { get: (target, key) => key === 'when' ? (condition, render) => {
      if (condition) render(proxy); return proxy;
    } : (...args) => {
      if (key === 'child') target.children.push(args[0]);
      if (key === 'children') target.children.push(...args[0]);
      if (key.startsWith('on_')) target[key] = args[0];
      return proxy;
    } });
    if (typeof id === 'string') nodes.set(id, node);
    return proxy;
  };
  const api = provider === 'asana' ? asana : mantis;
  const sourceHost = { ...api, readAsanaToken() {}, saveAsanaToken() {}, readMantisConnection() {}, saveMantisConnection() {} };
  const key = provider === 'asana' ? 'asanaSource' : 'mantisSource';
  const source = (await evaluateNative(`../mods/devkits-${provider}/source.js`, sourceHost, key))[key];
  const { TaskSourceController } = await evaluateNative('../mods/devkits/components/task-source.js', {
    div: element, h_flex: element, v_flex: element, Checkbox: element, Button: element,
  }, 'TaskSourceController');
  let binding = { gid: 'one', name: 'One', server: 'https://one.test' };
  const panel = new TaskSourceController({ source, getBinding: () => binding,
    state: { get: key => values[key], set: (key, value) => { values[key] = structuredClone(value); } },
  });
  panel.server = 'https://one.test'; panel.all = { tasks: [] }; panel.needsToken = false; panel.token = 'secret';
  return { panel, values, nodes, element, bind: value => { binding = value; } };
}

test('Asana reads project definitions and preserves numeric zero, enum identity and date values in lists and details', async () => {
  const fields = [
    { gid: 'effort', name: 'Estimate', resource_subtype: 'number', number_value: 0, display_value: '0.00' },
    { gid: 'priority', name: 'Priority', resource_subtype: 'enum', enum_value: { gid: 'high', name: 'High', color: 'red' }, display_value: 'High' },
    { gid: 'date', name: 'Review', resource_subtype: 'date', date_value: { date: '2026-11-09' }, display_value: 'Nov 9' },
  ];
  const request = async url => {
    assert.ok(url.includes('custom_field'));
    return reply(url.includes('/tasks') ? { data: url.includes('/tasks/t') ? { gid: 't', custom_fields: fields } : [{ gid: 't', custom_fields: fields }] }
      : { data: { custom_field_settings: fields.map(custom_field => ({ custom_field })) } });
  };
  assert.deepEqual((await asana.projectFields('token', 'p', request)).map(field => field.name), ['Estimate', 'Priority', 'Review']);
  const page = await asana.projectTasksPage('token', 'p', null, request);
  const detail = await asana.taskDetails('token', 't', 'p', request);
  assert.deepEqual(page.tasks[0].customFields, detail.customFields);
  assert.equal(detail.customFields[0].value, 0);
  assert.equal(detail.customFields[1].value.gid, 'high');
  assert.deepEqual(detail.customFields[2].value, { date: '2026-11-09' });
});

test('MantisBT reads project field definitions and retains multiline values and zero in issues', async () => {
  const request = async url => reply(url.includes('/projects/') ? { projects: [{ id: 42, custom_fields: [{ id: 9, name: 'RD Note', type: { name: 'textarea' } }] }] }
    : url.includes('/config?') ? { configs: [{ option: 'bug_resolved_status_threshold', value: 80 }] }
      : { issues: [{ id: 7, project: { id: 42 }, status: { id: 10 }, custom_fields: [
        { field: { id: 9, name: 'RD Note' }, value: 'First\nSecond' }, { field: { id: 10, name: 'Hours' }, value: 0 },
      ] }] });
  const connection = { url: 'https://custom.test', token: 'token' };
  const definitions = await mantis.projectFields(connection, 42, request);
  assert.equal(definitions[0].type, 'textarea');
  const page = await mantis.projectTasksPage(connection, 42, null, request);
  const detail = await mantis.taskDetails(connection, 7, 42, request);
  assert.deepEqual(detail.customFields, page.tasks[0].customFields);
  assert.equal(detail.customFields[0].displayValue, 'First\nSecond');
  assert.equal(detail.customFields[1].displayValue, '0');
});

for (const provider of ['asana', 'mantisbt']) test(`${provider} remembers visibility and order independently by source project and surface`, async () => {
  const h = await controller(provider), p = h.panel;
  p.all.tasks = [{ customFields: [{ gid: 'custom', name: 'Priority', displayValue: 'High' }] }];
  assert.ok(p.displayFields('detail').some(field => field.id === 'custom:custom'));
  assert.ok(!p.displayFields('list').some(field => field.id === 'custom:custom'));
  p.changeField('list', 'custom:custom', 0, cx);
  p.changeField('list', 'custom:custom', -1, cx);
  const order = p.displayFields('list').map(field => field.id);
  assert.ok(order.includes('custom:custom'));
  p.changeField('detail', 'custom:custom', 0, cx);
  assert.ok(!p.displayFields('detail').some(field => field.id === 'custom:custom'));
  h.bind({ gid: 'two', server: p.server });
  assert.ok(!p.displayFields('list').some(field => field.id === 'custom:custom'));
  h.bind({ gid: 'one', server: p.server });
  assert.deepEqual(p.displayFields('list').map(field => field.id), order);
  if (provider === 'mantisbt') {
    p.server = 'https://two.test'; h.bind({ gid: 'one', server: p.server });
    assert.ok(!p.displayFields('list').some(field => field.id === 'custom:custom'));
  }
});

test('field choices keep unavailable fields and newly discovered fields', async () => {
  const h = await controller(), p = h.panel;
  p.all.tasks = [{ customFields: [{ gid: 'a', name: 'Estimate', displayValue: '0' }] }];
  p.changeField('list', 'custom:a', 0, cx);
  assert.equal(p.fieldValue(p.all.tasks[0], { id: 'custom:a' }), '0');
  p.all.tasks = []; p.changeField('list', 'due', 0, cx);
  p.all.tasks = [{ customFields: [{ gid: 'a', name: 'Renamed' }, { gid: 'b', name: 'New field' }] }];
  assert.ok(p.displayFields('list').some(field => field.id === 'custom:a' && field.name === 'Renamed'));
  assert.ok(!p.displayFields('list').some(field => field.id === 'custom:b'));
  assert.ok(p.displayFields('detail').some(field => field.id === 'custom:b'));
});

test('late field definitions cannot replace another project or a closed view; failures keep task fields usable and can retry', async () => {
  const h = await controller(), p = h.panel, pending = [];
  const asyncCx = { ...cx, spawn: work => pending.push(work(asyncCx)) };
  let finish;
  p.source = { ...p.source, projectFields: () => new Promise(resolve => { finish = resolve; }) };
  p.syncFields(asyncCx); h.bind({ gid: 'two' }); finish([{ gid: 'old', name: 'Old' }]); await pending.shift();
  assert.ok(!p.fieldCatalog().some(field => field.id === 'custom:old'));
  p.source.projectFields = async () => { throw new Error('Offline'); };
  p.all.tasks = [{ customFields: [{ gid: 'loaded', name: 'Loaded' }] }];
  p.syncFields(asyncCx); await pending.shift();
  assert.equal(p.fieldSchema.error, 'Offline');
  assert.ok(p.fieldCatalog().some(field => field.id === 'custom:loaded'));
  p.source.projectFields = () => new Promise(resolve => { finish = resolve; });
  p.syncFields(asyncCx, true); p.dispose(); finish([{ gid: 'late', name: 'Late' }]); await pending.shift();
  assert.equal(p.fieldSchema, null);
});


test('MantisBT resolves field types by ID and formats dates without replacing raw values or separator text', async () => {
  const stamp = String(Math.floor(new Date(2026, 10, 5).getTime() / 1000));
  const separator = '='.repeat(152);
  const request = async url => reply(url.includes('/projects/') ? { projects: [{ id: 43, custom_fields: [
    { id: 83, name: 'Fix Date', type: { name: 'date' } },
    { id: 299, name: 'For PM', type: { name: 'string' } },
  ] }] } : url.includes('/config?') ? { configs: [{ option: 'bug_resolved_status_threshold', value: 80 }] }
    : { issues: [{ id: 8, project: { id: 43 }, status: { id: 10 }, custom_fields: [
      { field: { id: 299, name: 'For PM' }, value: separator },
      { field: { id: 83, name: 'Fix Date' }, value: stamp },
    ] }] });
  const connection = { url: 'https://typed.test', token: 'token' };
  const page = await mantis.projectTasksPage(connection, 43, null, request);
  const detail = await mantis.taskDetails(connection, 8, 43, request);
  assert.deepEqual(page.tasks[0].customFields, detail.customFields);
  assert.deepEqual(detail.customFields[1], { gid: '83', name: 'Fix Date', type: 'date', value: stamp, displayValue: '2026-11-05' });
  assert.equal(detail.customFields[0].value, separator);
  assert.equal(detail.customFields[0].displayValue, separator);
});


for (const provider of ['asana', 'mantisbt']) test(`${provider} field settings bind native visibility and order controls to the selected surface`, async () => {
  const h = await controller(provider), p = h.panel, name = provider === 'asana' ? 'AsanaPanel' : 'MantisPanel';
  const host = { TaskSourceController: p.constructor, TaskSourceProjectPicker: class {},
    asanaSource: p.source, mantisSource: p.source, div: h.element, svg: h.element,
    h_flex: h.element, v_flex: h.element, Button: h.element, Checkbox: h.element };
  const Panel = (await evaluateNative(`../mods/devkits-${provider}/ui.js`, host, name))[name];
  Object.setPrototypeOf(p, Panel.prototype);
  p.all.tasks = [{ customFields: [{ gid: 'a', name: 'Estimate', displayValue: '0' }] }];
  p.fieldSettings({});
  h.nodes.get('source-field-visible-list-custom:a').on_change(true, cx);
  assert.ok(p.displayFields('list').some(field => field.id === 'custom:a'));
  h.nodes.get('source-fields-detail').on_click({}, cx);
  p.fieldSettings({});
  h.nodes.get('source-field-visible-detail-custom:a').on_change(false, cx);
  assert.ok(!p.displayFields('detail').some(field => field.id === 'custom:a'));
  assert.ok(p.displayFields('list').some(field => field.id === 'custom:a'));
  h.nodes.get('source-field-drag-detail-custom:a').on_key_down({ key: 'up', modifiers: { alt: true } }, { ...cx, stop_propagation() {} });
  const order = p.fieldOptions('detail').map(field => field.id);
  assert.notEqual(order.at(-1), 'custom:a');
});


for (const provider of ['asana', 'mantisbt']) test(`${provider} field dragging saves on drop and cancels outside its project and surface`, async () => {
  const h = await controller(provider), p = h.panel;
  p.all.tasks = [{ customFields: [{ gid: 'a', name: 'Custom A' }, { gid: 'b', name: 'Custom B' }] }];
  const before = p.fieldOptions('detail').map(field => field.id);
  p.startFieldDrag('detail', 'custom:b', cx);
  p.hoverField('detail', 'custom:a', cx);
  assert.deepEqual(p.fieldOptions('detail').map(field => field.id), before);
  p.dropField('detail', 'custom:a', cx);
  const after = p.fieldOptions('detail').map(field => field.id);
  assert.equal(after.indexOf('custom:b') + 1, after.indexOf('custom:a'));
  assert.ok(!p.displayFields('list').some(field => field.id === 'custom:b'));
  p.startFieldDrag('detail', 'custom:a', cx); p.cancelFieldDrag(cx); p.dropField('detail', 'custom:b', cx);
  assert.deepEqual(p.fieldOptions('detail').map(field => field.id), after);
  p.startFieldDrag('detail', 'custom:a', cx); p.dropField('list', 'custom:b', cx);
  assert.deepEqual(p.fieldOptions('detail').map(field => field.id), after);
  p.startFieldDrag('detail', 'custom:a', cx); h.bind({ gid: 'two', server: p.server }); p.dropField('detail', 'custom:b', cx);
  h.bind({ gid: 'one', server: p.server });
  assert.deepEqual(p.fieldOptions('detail').map(field => field.id), after);
});
