import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout } from '../mods/devkits-zed/extension-model.js';
import { extensionSurfaceLayout, extensionSurfaceNodeId } from '../mods/devkits-zed/extension-surfaces.js';
import { installZed } from '../install-zed.js';
import { installZedExtension } from '../install-zed-extension.js';
import { evaluateNative } from './source-harness.js';

const manifestText = await readFile(new URL('../mods/devkits-asana/extension.json', import.meta.url), 'utf8');
const manifest = JSON.parse(manifestText);

test('popup declarations have stable IDs and capture only public originating project fields', () => {
  const [action] = parseExtensionManifest('devkits-asana', manifestText);
  assert.equal(action.id, 'asana.open'); assert.equal(action.location, 'status.right');
  const project = { id: 'project', name: 'Project', folder: '/workspace', machine: 'remote', token: 'private' };
  const popup = extensionPopup(action, project);
  assert.deepEqual(popup, { mod: 'devkits-asana', kind: 'dialog', frame: 'none', modal: false, width: 0.9, height: 0.86,
    props: { view: 'browser', context: { id: 'project', name: 'Project', folder: '/workspace', machine: 'remote' },
      stateKey: 'devkits-zed.extension.asana.["remote","/workspace"]' } });
  project.folder = '/elsewhere'; assert.equal(popup.props.context.folder, '/workspace');
  assert.equal(JSON.stringify(popup).includes('private'), false);
  assert.notEqual(extensionPopup(action, { ...project, folder: '/other' }).props.stateKey, popup.props.stateKey);
  assert.equal(extensionPopup(action, null).props.context, undefined);
});

test('registry and manifest validation reject unsupported versions, paths and contributions', () => {
  assert.deepEqual(parseExtensionRegistry(null), []);
  for (const value of [{ version: 2, extensions: [] }, { version: 1, extensions: ['../escape'] },
    { version: 1, extensions: ['same', 'same'] }, { version: 1, extensions: [], extra: true }])
    assert.throws(() => parseExtensionRegistry(JSON.stringify(value)));
  for (const patch of [{ location: 'right' }, { icon: '../file' }, { popup: { ...manifest.actions[0].popup, width: -1 } }])
    assert.throws(() => parseExtensionManifest('devkits-asana', JSON.stringify({ ...manifest, actions: [{ ...manifest.actions[0], ...patch }] })));
  assert.throws(() => parseExtensionManifest('../escape', manifestText));
  assert.throws(() => parseExtensionManifest('devkits-asana', JSON.stringify({ ...manifest, actions: [manifest.actions[0], manifest.actions[0]] })));
});

const runtime = async (readTextFile, initialLayout = null) => {
  let root = initialLayout;
  const memory = {}, opened = [], notices = [], layoutUpdates = [];
  const host = { shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); },
    appHome: () => '/herdr', readTextFile, layout: () => root, run: (command, args) => { assert.equal(command, 'layout.set'); root = args.layout; layoutUpdates.push(root); }, openOverlay: value => { opened.push(value); return 'overlay'; }, notify: value => notices.push(value),
    parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout,
    extensionSurfaceLayout, extensionSurfaceNodeId };
  return { memory, opened, notices, layoutUpdates, ...await evaluateNative('../mods/devkits-zed/extensions.js', host,
    'refreshExtensions, openExtension, extensionCatalog, extensionEnabled, setExtensionEnabled') };
};

test('discovery reads declarations only; activation alone opens the existing provider popup', async () => {
  const reads = [];
  const r = await runtime(async path => { reads.push(path); return path.endsWith('extensions.json')
    ? '{"version":1,"extensions":["devkits-asana"]}' : manifestText; });
  r.openExtension('asana.open', null); assert.equal(r.opened.length, 0);
  await r.refreshExtensions(); assert.equal(r.opened.length, 0);
  assert.deepEqual(reads, ['/herdr/data/devkits-zed/extensions.json', '/herdr/mods/devkits-asana/extension.json']);
  r.openExtension('asana.open', { id: 'p', folder: '/project', name: 'Project' });
  assert.equal(r.opened.length, 1); assert.equal(r.opened[0].mod, 'devkits-asana');
  assert.equal(r.opened[0].props.channel, undefined, 'No Tasks import channel or service dependency');
  assert.equal(r.notices.length, 0);
});

test('a late discovery cannot restore removed entries; malformed packages leave valid ones available', async () => {
  let resolveOld, calls = 0;
  const r = await runtime(path => {
    if (!path.endsWith('extensions.json')) return Promise.resolve(manifestText);
    if (++calls === 1) return new Promise(resolve => { resolveOld = resolve; });
    return Promise.resolve(null);
  });
  const old = r.refreshExtensions(); await r.refreshExtensions();
  resolveOld('{"version":1,"extensions":["devkits-asana"]}'); await old;
  assert.deepEqual(r.extensionCatalog().actions, []);
  r.openExtension('asana.open', null); assert.equal(r.opened.length, 0);
  const mixed = await runtime(async path => path.endsWith('extensions.json')
    ? '{"version":1,"extensions":["broken","devkits-asana"]}' : path.includes('/broken/') ? 'invalid' : manifestText);
  await mixed.refreshExtensions();
  assert.equal(mixed.extensionCatalog().actions[0].id, 'asana.open');
  assert.equal(mixed.extensionCatalog().errors.length, 1);
});

test('extension install is opt-in, idempotent and preserves provider code, credentials and other registrations', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zed-extension-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await installZed(home);
  await mkdir(join(home, 'data/devkits-zed'), { recursive: true });
  await writeFile(join(home, 'data/devkits-zed/extensions.json'), '{"version":1,"extensions":["other-mod"]}');
  await installZedExtension(home, 'devkits-asana');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'data/devkits-zed/extensions.json'), 'utf8')).extensions, ['other-mod', 'devkits-asana']);
  await assert.rejects(readFile(join(home, 'mods/devkits-mantisbt/main.js')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(home, 'data/devkits/asana.json')), { code: 'ENOENT' });
  const provider = join(home, 'mods/devkits-asana/ui.js'); await writeFile(provider, 'custom provider implementation');
  await mkdir(join(home, 'data/devkits'), { recursive: true });
  await writeFile(join(home, 'data/devkits/asana.json'), 'private credentials');
  await installZedExtension(home, 'devkits-asana');
  assert.equal(await readFile(provider, 'utf8'), 'custom provider implementation');
  assert.equal(await readFile(join(home, 'data/devkits/asana.json'), 'utf8'), 'private credentials');
});


test('disabled extensions retain declarations, block activation and restore without touching provider data', async () => {
  const r = await runtime(async path => path.endsWith('extensions.json')
    ? '{"version":1,"extensions":["devkits-asana"]}' : manifestText);
  await r.refreshExtensions();
  assert.equal(r.extensionCatalog().packages[0].title, 'Asana');
  r.setExtensionEnabled('other-mod', false);
  r.setExtensionEnabled('devkits-asana', false);
  r.openExtension('asana.open', null);
  assert.equal(r.opened.length, 0);
  await r.refreshExtensions();
  assert.equal(r.extensionEnabled('devkits-asana'), false);
  assert.equal(r.extensionCatalog().actions.length, 1);
  r.setExtensionEnabled('devkits-asana', true);
  assert.equal(r.extensionEnabled('other-mod'), false);
  r.openExtension('asana.open', null);
  assert.equal(r.opened.length, 1);
});

test('service mounts follow enable/remove and preserve workspace geometry and unrelated children', () => {
  const marker = { id: 'custom', type: 'row', children: [] };
  const root = { id: 'workspace', children: [{ id: 'editor', size: { weight: 1.6 } },
    { id: 'status-separator', type: 'row', size: { px: 1 }, background: 'border', children: [marker] }] };
  const packages = [{ mod: 'devkits-system', services: [{ view: 'service' }] }];
  const mounted = extensionServiceLayout(root, packages);
  assert.deepEqual(root.children[1].children, [marker], 'Input is immutable');
  assert.deepEqual(mounted.children[0], root.children[0]);
  assert.equal(mounted.children[1].size.px, 1);
  assert.deepEqual(mounted.children[1].children[0], marker);
  assert.equal(mounted.children[1].children[1].content.mod, 'devkits-system');
  assert.equal(extensionServiceLayout(mounted, packages), null, 'Repeated refresh does not remount sampler');
  assert.deepEqual(extensionServiceLayout(mounted, packages, ['devkits-system']), root);
  assert.deepEqual(extensionServiceLayout(mounted, []), root);
  assert.equal(extensionServiceLayout({ children: [] }, packages), null, 'Other layouts remain untouched');
  const existing = { ...root, children: [...root.children, { content: { mod: 'devkits-system', props: { view: 'service' } } }] };
  assert.equal(extensionServiceLayout(existing, packages), null, 'Existing owner is never duplicated');
});

test('service and dependency metadata reject paths, duplicates and arbitrary service props', () => {
  for (const patch of [{ dependencies: ['../escape'] }, { dependencies: ['devkits-asana'] },
    { dependencies: ['same', 'same'] }, { services: [{ view: '../service' }] },
    { services: [{ view: 'service', mod: 'other' }] }, { services: [{ view: 'service' }, { view: 'service' }] }])
    assert.throws(() => parseExtensionManifest('devkits-asana', JSON.stringify({ ...manifest, ...patch })));
});

test('simulator install adds declared frame package without overwriting existing runtime data', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zed-simulator-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await installZed(home);
  await installZedExtension(home, 'devkits-simulator');
  await readFile(join(home, 'mods/devkits-sim-frames/main.js'));
  const frame = join(home, 'mods/devkits-sim-frames/frame-0.jpg');
  await writeFile(frame, 'existing runtime image');
  await installZedExtension(home, 'devkits-simulator');
  assert.equal(await readFile(frame, 'utf8'), 'existing runtime image');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'data/devkits-zed/extensions.json'), 'utf8')).extensions,
    ['devkits-simulator'], 'Supporting package is not registered as another extension');
});

test('incomplete dependency aborts installation without changing registry or existing files', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zed-dependency-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await installZed(home);
  await mkdir(join(home, 'mods/devkits-sim-frames'));
  await writeFile(join(home, 'mods/devkits-sim-frames/user.txt'), 'keep');
  await assert.rejects(installZedExtension(home, 'devkits-simulator'), /Incomplete/);
  assert.equal(await readFile(join(home, 'mods/devkits-sim-frames/user.txt'), 'utf8'), 'keep');
  await assert.rejects(readFile(join(home, 'data/devkits-zed/extensions.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(home, 'mods/devkits-simulator/main.js')), { code: 'ENOENT' });
});


test('runtime refresh mounts one enabled service and disabling removes it without remounting on refresh', async () => {
  const text = await readFile(new URL('../mods/devkits-system/extension.json', import.meta.url), 'utf8');
  const root = { children: [{ id: 'status-separator', type: 'row', children: [], size: { px: 1 } }] };
  const r = await runtime(async path => path.endsWith('extensions.json')
    ? '{"version":1,"extensions":["devkits-system"]}' : text, root);
  await r.refreshExtensions();
  assert.equal(r.layoutUpdates.length, 1);
  assert.equal(r.layoutUpdates[0].children[0].children[0].content.props.view, 'service');
  await r.refreshExtensions();
  assert.equal(r.layoutUpdates.length, 1);
  r.setExtensionEnabled('devkits-system', false);
  assert.deepEqual(r.layoutUpdates.at(-1), root);
  r.openExtension('system.open', null);
  assert.equal(r.opened.length, 0);
  await r.refreshExtensions();
  assert.equal(r.layoutUpdates.length, 2);
  r.setExtensionEnabled('devkits-system', true);
  assert.equal(r.layoutUpdates.length, 3);
});

test('registry removal unmounts old service and surfaces while retaining shell layout blocks', async () => {
  const text = await readFile(new URL('../mods/devkits-system/extension.json', import.meta.url), 'utf8');
  let registry = '{"version":1,"extensions":["devkits-system"]}';
  const root = { id: 'root', children: [
    { id: 'sidebar', type: 'column', children: [{ id: 'agents', type: 'block', content: { mod: 'devkits-zed' } }] },
    { id: 'workspace-row', type: 'row', children: [{ id: 'editor', type: 'block', content: { mod: 'devkits-zed' } }] },
    { id: 'status-separator', type: 'row', children: [] },
    { id: 'status', type: 'column', children: [{ id: 'status-content', type: 'block', content: { mod: 'devkits-zed', props: { view: 'status' } } }] },
  ] };
  const r = await runtime(async path => path.endsWith('extensions.json') ? registry : text, root);
  await r.refreshExtensions();
  assert.ok(r.layoutUpdates.length);
  registry = '{"version":1,"extensions":[]}';
  await r.refreshExtensions();
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'zed-extension-service-devkits-system-service'), null);
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'zed-extension-surface-devkits-system-widgets'), null);
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'zed-extension-surface-devkits-system-inline'), null);
  assert.equal(findLayout(r.layoutUpdates.at(-1), 'status-content').content.props.view, 'status');
});

function findLayout(node, id) {
  return node?.id === id ? node : (node?.children || []).map(child => findLayout(child, id)).find(Boolean) || null;
}
