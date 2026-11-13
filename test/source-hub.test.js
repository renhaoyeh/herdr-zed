import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { projectCatalog } from '../components/session-model.js';

const tabs = [
  { id: 'asana', title: 'Asana', mod: 'herdr-zed-asana', props: { view: 'browser' }, hosted: true },
  { id: 'mantisbt', title: 'MantisBT', mod: 'herdr-zed-mantisbt', props: { view: 'browser' }, hosted: true },
];
const hub = { title: 'Tasks', hostMod: 'herdr-zed-tasks', stack: 'queue-stack', tabs, selected: 'asana', bindingsKey: 'herdr-zed.tasks-v2.bindings', stateKey: 'herdr-zed.tasks-v2.native', workspaceAction: 'tasks.open' };
const projectKey = folder => JSON.stringify(['', folder]);

test('original source host follows the live outer project and switches original modules within the same workspace action', async () => {
  const memory = {}, opened = [], closed = [], commands = [], current = [{ id: 'a', folder: '/a', name: 'A', active: true }, { id: 'b', folder: '/b', name: 'B' }];
  let followed = 0;
  const { SourceHub } = await evaluateNative('../components/source-hub.js', {
    projectCatalog, spaces: () => current, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; }, followWorkspaceProject: () => { followed++; },
    openWorkspacePanel: spec => { opened.push(spec); return 'next'; }, closeOverlay: id => closed.push(id),
    run: (name, args) => commands.push({ name, args }),
  }, 'SourceHub');
  const target = { overlay: 'previous', sourceHub: hub }, host = new SourceHub(target);
  host.init(); host.sync(); assert.equal(target.context.folder, '/a'); assert.equal(followed, 1);
  memory['herdr-zed.selected-project'] = 'b'; host.sync(); assert.equal(target.context.folder, '/b');
  host.open(tabs[0]); assert.equal(opened.length, 0); assert.deepEqual(closed, []);
  host.toggleScope();
  assert.equal(memory[`${hub.stateKey}.all-projects.asana`], true);
  host.open(tabs[1]);
  assert.equal(memory[`${hub.stateKey}.selected`], 'mantisbt');
  assert.deepEqual(commands[0], { name: 'layout.select', args: { stack: hub.stack, child: `${hub.stack}-mantisbt` } });
  assert.equal(opened.length, 0); assert.deepEqual(closed, []);
  assert.equal(memory[`${hub.stateKey}.all-projects.mantisbt`], undefined);
  host.toggleScope(); assert.equal(memory[`${hub.stateKey}.all-projects.mantisbt`], true);
  assert.equal(commands.length, 1, 'scope changes never select another source or replace a view');
  host.open(tabs[0]);
  assert.equal(memory[`${hub.stateKey}.selected`], 'asana');
  assert.equal(memory[`${hub.stateKey}.all-projects.asana`], true);
  assert.equal(commands[1].args.child, `${hub.stack}-asana`);
});

test('native source host places original modules in retained stack children with isolated v2 props', async () => {
  const { sourceHubLayout, resolveSourceHub } = await evaluateNative('../components/source-hub.js', { shared: () => hub }, 'sourceHubLayout, resolveSourceHub');
  const layout = sourceHubLayout(hub, { folder: '/a' });
  assert.equal(layout.children[0].content.props.view, 'source-hub');
  const stack = layout.children[1];
  assert.equal(stack.active, 'queue-stack-asana');
  assert.deepEqual(stack.children.map(child => child.content.mod), tabs.map(tab => tab.mod));
  for (const child of stack.children) {
    assert.equal(child.content.props.sourceHub, hub.stateKey);
    assert.equal(resolveSourceHub(child.content.props).sourceHub.bindingsKey, hub.bindingsKey);
    assert.equal(child.content.props.channel, undefined);
    assert.equal(child.content.props.context.folder, '/a');
  }
});

test('original source controls use only v2 bindings and preferences, including after the active folder changes', async () => {
  const memory = { 'herdr-zed.asana-project': { gid: 'old' }, 'herdr-zed.asana-field-display': { old: true },
    'herdr-zed.tasks-v2.bindings': { [projectKey('/a')]: { asana: { gid: 'a1' } } } }, opened = [];
  const { sourceModuleOptions } = await evaluateNative('../components/source-channel.js', {
    shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    openOverlay: spec => opened.push(spec), closeOverlay() {},
  }, 'sourceModuleOptions');
  const target = { sourceHub: hub, context: { folder: '/a' }, stateKey: 'herdr-zed.tasks-v2.native.asana' };
  const options = sourceModuleOptions({ key: 'asana' }, target);
  assert.equal(options.getBinding().gid, 'a1'); assert.equal(options.onImport, undefined);
  options.state.set('field-display', { own: true });
  assert.deepEqual(memory['herdr-zed.asana-field-display'], { old: true });
  assert.deepEqual(memory['herdr-zed.tasks-v2.native.asana-field-display'], { own: true });
  target.context = { folder: '/b' }; assert.equal(options.getBinding(), null);
  options.setBinding('/b', { gid: 'b1' }); assert.equal(memory[hub.bindingsKey][projectKey('/b')].asana.gid, 'b1');
  assert.equal(memory['herdr-zed.asana-project'].gid, 'old');
  options.openProjectPicker('/b', {});
  assert.equal(opened[0].props.view, 'projects'); assert.equal(opened[0].props.context.folder, '/b');
  assert.deepEqual(opened[0].props.sourceHub, hub);
});

for (const [source, picker] of [['asana', 'AsanaProjectPicker'], ['mantisbt', 'MantisProjectPicker']]) {
  test(`${source} hosted entry retains its original panel and offers the catalog importer`, async () => {
    const panel = { init() { this.handle = { focus() {} }; }, render(context) { this.context = context; return {}; } };
    const node = () => new Proxy({}, { get: () => () => node() });
    const { SourceMod } = await evaluateNative(`../mods/herdr-zed-${source}/main.js`, {
      View: class {}, div: node, v_flex: node, workspacePanel: value => value,
      props: () => ({ sourceHub: { ...hub, selected: source }, context: { folder: '/a' } }),
      SourceHub: class { constructor(target) { this.target = target; } init() {} sync() { this.target.context = { folder: '/active' }; } render() { return {}; } },
      SourcePanel: class { constructor(options) { Object.assign(panel, options); return panel; } },
      SourceScope: class { options(options) { return options; } banner() { return null; } context(current) { return current; } },
      [picker]: class {}, [source === 'asana' ? 'asanaSource' : 'mantisSource']: {},
      sourceModuleOptions: () => ({ getBinding: () => null }),
      resolveSourceHub: target => target,
      importTarget: () => ({ mod: 'herdr-zed-tasks', title: 'Tasks', view: 'import-draft' }), shared: () => null,
    }, 'SourceMod');
    const view = new SourceMod(); view.init({}, { timer: { every() {} } }); view.render({});
    assert.equal(panel.context.folder, '/active'); assert.equal(typeof panel.onImport, 'function');
  });
}
