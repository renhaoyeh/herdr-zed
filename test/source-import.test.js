// Standalone import: each integration finds an importer in the shell catalog and hands it a snapshot dialog.
// Integrations never name the importer's code; the catalog is the only source of truth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateNative } from './source-harness.js';
import { parseExtensionManifest, extensionMetadata } from '../mods/herdr-zed/extension-model.js';
import { sourceTaskSnapshot } from '../mods/herdr-zed-asana/components/task-source-model.js';
import * as asanaImport from '../mods/herdr-zed-asana/import-target.js';
import * as mantisImport from '../mods/herdr-zed-mantisbt/import-target.js';

const providers = [
  { id: 'asana', mod: 'herdr-zed-asana', source: 'asanaSource', picker: 'AsanaProjectPicker', lib: asanaImport },
  { id: 'mantisbt', mod: 'herdr-zed-mantisbt', source: 'mantisSource', picker: 'MantisProjectPicker', lib: mantisImport },
];
const importer = (overrides = {}) => ({ mod: 'herdr-zed-tasks', id: 'tasks', title: 'Tasks', enabled: true,
  provides: { importer: { accepts: ['task-snapshot'], view: 'import-draft' } }, ...overrides });
const context = { id: 7, folder: '/project', name: 'Project', machine: null };
const hasCallable = value => typeof value === 'function' || (value !== null && typeof value === 'object' && Object.values(value).some(hasCallable));

for (const { id, lib } of providers) test(`${id} finds an importer only among enabled, error-free packages that accept task snapshots`, () => {
  assert.deepEqual(lib.importTarget({ packages: [{ mod: 'herdr-zed-system', id: 'system', enabled: true }, importer()] }),
    { mod: 'herdr-zed-tasks', title: 'Tasks', view: 'import-draft' });
  assert.equal(lib.importTarget({ packages: [importer({ enabled: undefined })] }).mod, 'herdr-zed-tasks');
  assert.equal(lib.importTarget({ packages: [importer({ enabled: false })] }), null, 'a disabled importer is absent');
  assert.equal(lib.importTarget({ packages: [importer({ error: 'Invalid extension manifest.' })] }), null, 'an errored importer is absent');
  assert.equal(lib.importTarget({ packages: [importer({ provides: { importer: { accepts: ['other'], view: 'x' } } })] }), null);
  assert.equal(lib.importTarget({ packages: [importer({ provides: { launcher: { picker: {}, settings: {} } } })] }), null);
  assert.equal(lib.importTarget({ packages: [importer({ enabled: false }), importer({ mod: 'herdr-zed-other', title: 'Other' })] }).mod, 'herdr-zed-other');
  assert.equal(lib.importTarget({ packages: [] }), null);
  assert.equal(lib.importTarget(null), null);
  assert.equal(lib.importTarget({}), null);
});

for (const { id, lib } of providers) test(`${id} hands the importer a snapshot-only dialog with no credentials or callbacks`, () => {
  const target = lib.importTarget({ packages: [importer()] });
  const snapshot = sourceTaskSnapshot({ key: id }, { gid: '42', name: 'Issue', url: 'https://tracker.test/42', notes: 'Body',
    comments: [{ gid: 'c', author: 'Amy', text: 'Context', at: '2026-11-08' }], token: 'secret-token', onImport() {} }, '');
  const request = lib.importRequest(target, { source: id, context, snapshot });
  assert.deepEqual(request, { mod: 'herdr-zed-tasks', kind: 'dialog', frame: 'none', modal: true, width: 760, height: 400,
    props: { view: 'import-draft', kind: 'task-snapshot', source: id, context, snapshot } });
  assert.deepEqual(Object.keys(snapshot).sort(), ['comments', 'gid', 'name', 'notes', 'parent', 'source', 'url']);
  assert.ok(!hasCallable(request), 'props must be serializable');
  assert.ok(!JSON.stringify(request).includes('secret-token'));
});

for (const provider of providers) {
  // Mounts the real browser entry with a fake panel; the catalog and channel are the only inputs that vary.
  async function mount({ catalog = null, channel = null } = {}) {
    const state = { catalog }, opened = [], ticks = [], notified = [];
    const panel = { importLabel: 'Import', onImport: undefined, init() { this.handle = { focus() {} }; }, render() {}, dispose() {} };
    const host = { View: class {}, props: () => ({ context, ...(channel ? { channel } : {}) }),
      shared: key => (key === 'herdr-zed.extensions.catalog' ? state.catalog : null),
      openOverlay: request => { opened.push(request); },
      importTarget: provider.lib.importTarget, importRequest: provider.lib.importRequest,
      [provider.source]: {}, [provider.picker]: class {}, SourcePanel: class { constructor(options) { Object.assign(panel, options); return panel; } },
      sourceModuleOptions: () => ({ getBinding: () => null, importLabel: 'Import', onImport: channel ? () => 'channel' : undefined }),
      publishSourceEvent() {} };
    const { SourceMod } = await evaluateNative(`../mods/${provider.mod}/main.js`, host, 'SourceMod');
    const cx = { notify: () => notified.push(true), timer: { every: (_ms, fn) => ticks.push(fn) } };
    new SourceMod().init({}, cx);
    return { panel, opened, state, notified, tick: () => ticks.forEach(fn => fn(cx)) };
  }

  test(`${provider.id} standalone browser imports through the catalog importer and opens its dialog`, async () => {
    const { panel, opened } = await mount({ catalog: { packages: [importer()] } });
    assert.equal(panel.importLabel, 'Import into Tasks'); assert.equal(typeof panel.onImport, 'function');
    panel.onImport({ source: provider.id, gid: '42' });
    assert.deepEqual(opened, [{ mod: 'herdr-zed-tasks', kind: 'dialog', frame: 'none', modal: true, width: 760, height: 400,
      props: { view: 'import-draft', kind: 'task-snapshot', source: provider.id, context, snapshot: { source: provider.id, gid: '42' } } }]);
  });

  test(`${provider.id} standalone browser hides the import action without an enabled importer`, async () => {
    for (const catalog of [null, { packages: [] }, { packages: [importer({ enabled: false })] }, { packages: [importer({ error: 'Bad manifest.' })] }]) {
      const { panel, opened } = await mount({ catalog });
      assert.equal(panel.onImport, undefined); assert.equal(panel.importLabel, 'Import'); assert.equal(opened.length, 0);
    }
  });

  test(`${provider.id} standalone browser follows the catalog when an importer appears or is disabled`, async () => {
    const { panel, state, tick, notified } = await mount({ catalog: null });
    tick(); // the first tick records the binding signature and may redraw once
    const base = notified.length;
    assert.equal(panel.onImport, undefined);
    state.catalog = { packages: [importer()] }; tick();
    assert.equal(panel.importLabel, 'Import into Tasks'); assert.equal(notified.length, base + 1);
    tick(); assert.equal(notified.length, base + 1, 'an unchanged catalog does not redraw');
    state.catalog = { packages: [importer({ enabled: false })] }; tick();
    assert.equal(panel.onImport, undefined); assert.equal(panel.importLabel, 'Import'); assert.equal(notified.length, base + 2);
  });

  test(`${provider.id} browser opened by a receiver keeps the channel import and never opens the catalog importer`, async () => {
    const { panel, opened } = await mount({ catalog: { packages: [importer()] }, channel: 'source:1' });
    assert.equal(panel.importLabel, 'Import'); assert.equal(panel.onImport(), 'channel');
    assert.equal(opened.length, 0);
  });

  test(`${provider.id} manifest parses with its existing action, no requirements and no provider contracts`, async () => {
    const text = await readFile(new URL(`../mods/${provider.mod}/extension.json`, import.meta.url), 'utf8');
    const actions = parseExtensionManifest(provider.mod, text);
    assert.deepEqual(actions.map(action => action.id), [`${provider.id}.open`]);
    const metadata = extensionMetadata(provider.mod, text);
    assert.equal(metadata.id, provider.id);
    assert.deepEqual(metadata.requires, []); assert.deepEqual(metadata.provides, {});
  });
}
