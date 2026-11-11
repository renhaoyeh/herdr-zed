import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtensionRegistry, parseExtensionManifest, extensionMetadata, extensionPopup, extensionServiceLayout, gitActionPopup, resolveProviders,
  launcherAvailable, platformSupported, workspaceRect, workspaceTopAnchor } from '../mods/herdr-zed/extension-model.js';
import { extensionSurfaceLayout, extensionSurfaceNodeId, STATUS_ACTION_LIMIT } from '../mods/herdr-zed/extension-surfaces.js';
import { evaluateNative } from './source-harness.js';

const action = (popup = {}) => ({ id: 'open', title: 'Open', icon: 'globe', location: 'status.right',
  popup: { view: 'details', width: 400, height: 300, modal: false, ...popup } });
const text = extra => JSON.stringify({ version: 1, id: 'demo', title: 'Demo', actions: [action()], ...extra });

test('platforms: optional, non-empty, unique, from macos, windows and linux; absent means every platform', () => {
  assert.equal(extensionMetadata('herdr-zed-demo', text()).platforms, null);
  assert.deepEqual(extensionMetadata('herdr-zed-demo', text({ platforms: ['macos', 'windows'] })).platforms, ['macos', 'windows']);
  for (const bad of [[], ['macos', 'macos'], ['beos'], 'macos', ['macos', 'windows', 'linux', 'macos']])
    assert.throws(() => parseExtensionManifest('herdr-zed-demo', text({ platforms: bad })), /Invalid extension platforms/, JSON.stringify(bad));
  assert.equal(platformSupported(undefined, 'windows'), true, 'no platforms key: every platform');
  assert.equal(platformSupported(['macos'], 'windows'), false);
  assert.equal(platformSupported(['windows', 'linux'], 'linux'), true);
});

test('popup.placement: center by default, workspace when declared, anything else is rejected', () => {
  assert.equal(parseExtensionManifest('herdr-zed-demo', text())[0].popup.placement, 'center');
  const [work] = parseExtensionManifest('herdr-zed-demo', text({ actions: [action({ placement: 'workspace' })] }));
  assert.equal(work.popup.placement, 'workspace');
  assert.throws(() => parseExtensionManifest('herdr-zed-demo', text({ actions: [action({ placement: 'top' })] })), /Invalid extension action/);
});

test('the workspace rectangle: x is the sidebar width (0 when hidden), y the header, width the window minus x, height minus header and status bar', () => {
  assert.deepEqual(workspaceRect({ sidebar: { size: { px: 280 } }, workWidth: 1000, windowHeight: 700 }), { x: 280, y: 32, width: 1000, height: 636 });
  assert.deepEqual(workspaceRect({ sidebar: { hidden: true, size: { px: 280 } }, workWidth: 1200, windowHeight: 700 }),
    { x: 0, y: 32, width: 1200, height: 636 });
  assert.equal(workspaceRect({ sidebar: { size: {} }, workWidth: 1000, windowHeight: 700 }), null, 'an unknown sidebar size is not guessed');
  assert.equal(workspaceRect({ sidebar: { size: { px: 280 } }, workWidth: 0, windowHeight: 700 }), null, 'an unmeasured work area');
  assert.equal(workspaceRect({ sidebar: { size: { px: 280 } }, workWidth: 1000 }), null, 'an unmeasured window height');
  assert.equal(workspaceRect({ sidebar: { size: { px: 300 } }, workWidth: 100, windowHeight: 60 }), null, 'no room left');
});

test('a workspace popup opens over the work area; without a known area it is the declared centered dialog', () => {
  const [work] = parseExtensionManifest('herdr-zed-demo', text({ actions: [action({ placement: 'workspace' })] }));
  const rect = { x: 280, y: 32, width: 1000, height: 636 };
  const popup = extensionPopup({ ...work, mod: 'herdr-zed-demo', extensionId: 'demo' }, null, rect);
  assert.equal(popup.kind, 'popup'); assert.equal(popup.frame, 'none');
  assert.deepEqual([popup.at, popup.width, popup.height], [{ x: 280, y: 32 }, 1000, 636]);
  assert.equal(popup.modal, undefined, 'a popup closes on an outside click, so it carries no modal flag');
  assert.equal(popup.props.view, 'details');
  const fallback = extensionPopup({ ...work, mod: 'herdr-zed-demo', extensionId: 'demo' }, null, null);
  assert.deepEqual([fallback.kind, fallback.width, fallback.height, fallback.modal], ['dialog', 400, 300, false]);
  const centred = parseExtensionManifest('herdr-zed-demo', text())[0];
  assert.equal(extensionPopup({ ...centred, mod: 'herdr-zed-demo', extensionId: 'demo' }, null, rect).kind, 'dialog',
    'a center placement ignores the work area');
});

test('a keyboard-opened picker centres at the top of the work area; without a work area it uses the pointer', () => {
  assert.deepEqual(workspaceTopAnchor({ x: 280, y: 32, width: 1000, height: 636 }, 280, 1), { x: 640, y: 40 });
  assert.deepEqual(workspaceTopAnchor({ x: 280, y: 32, width: 1000, height: 636 }, 280, 2), { x: 1280, y: 80 }, 'device px at zoom 2');
  assert.deepEqual(workspaceTopAnchor({ x: 0, y: 32, width: 200, height: 300 }, 280, 1), { x: 0, y: 40 }, 'a narrow area never goes negative');
  assert.equal(workspaceTopAnchor(null, 280, 1), 'pointer');
});

test('gitActionPopup, service layout and launcher helpers still take the same declarations', () => {
  const [action] = parseExtensionManifest('herdr-zed-demo', text());
  assert.equal(gitActionPopup({ ...action, mod: 'herdr-zed-demo' }, { machine: null, folder: '/w' }).kind, 'dialog');
  assert.equal(extensionServiceLayout({ children: [] }, []), null);
  assert.equal(launcherAvailable(null, [], null), false);
  assert.ok(STATUS_ACTION_LIMIT > 0);
  assert.equal(typeof extensionSurfaceNodeId, 'function');
  assert.equal(typeof extensionSurfaceLayout, 'function');
  assert.deepEqual(parseExtensionRegistry('{"version":1,"extensions":["herdr-zed-demo"]}'), ['herdr-zed-demo']);
  assert.equal(resolveProviders([]).launcher, null);
});

// ---- Refresh with a platform: a package for another platform contributes nothing ----

const runtime = async (manifest, platform, layout = null) => {
  const memory = {}, opened = [], runs = [];
  let root = layout;
  const host = {
    shared: key => memory[key], setShared: (key, value) => { memory[key] = structuredClone(value); }, appHome: () => '/herdr',
    readTextFile: async path => path.endsWith('extensions.json') ? '{"version":1,"extensions":["herdr-zed-demo"]}' : manifest,
    window: () => ({ platform }), settings: () => ({ zoom: 1 }), layout: () => root,
    run: (command, args) => { runs.push([command, args]); if (command === 'layout.set') root = args.layout; },
    openOverlay: value => { opened.push(value); return 'overlay'; }, notify() {},
    parseExtensionRegistry, parseExtensionManifest, extensionMetadata, extensionPopup, extensionServiceLayout, gitActionPopup,
    resolveProviders, launcherAvailable, platformSupported, workspaceRect, extensionSurfaceLayout, extensionSurfaceNodeId,
    STATUS_ACTION_LIMIT, ToolbarButton() {}, TOOLBAR_GLYPH: 16, glyph() {}, DropdownMenu() {}, h_flex() {},
  };
  return { memory, opened, runs, ...await evaluateNative('../mods/herdr-zed/extensions.js', host,
    'refreshExtensions, openExtension, extensionCatalog, extensionActive, extensionActions, extensionSurfaceVisible, setExtensionSurfaceVisible, visibleSurfaceCount, WORK_WIDTH_KEY, WINDOW_HEIGHT_KEY, recordSize, workspaceRectNow') };
};

const platformManifest = JSON.parse(text({ platforms: ['macos'], settings: { view: 'settings', title: 'Demo' },
  surfaces: [{ id: 'widgets', location: 'sidebar.bottom', view: 'widgets', title: 'Widgets', icon: 'globe' }] }));

test('a package for another platform contributes no actions, surfaces, services or settings and is not active', async () => {
  const r = await runtime(JSON.stringify(platformManifest), 'windows');
  await r.refreshExtensions();
  const [entry] = r.extensionCatalog().packages;
  assert.equal(entry.unsupported, true);
  assert.deepEqual(entry.surfaces, []); assert.deepEqual(entry.services, []);
  assert.equal(entry.settings, undefined, 'no Settings page'); assert.deepEqual(entry.provides, {});
  assert.equal(r.extensionCatalog().actions.length, 0);
  assert.equal(r.extensionActive('herdr-zed-demo'), false);
  assert.equal(r.extensionCatalog().resolved.settings.length, 0);
  assert.equal(r.extensionCatalog().resolved.unavailable.length, 0, 'an unsupported package is not reported as unavailable either');
  r.openExtension('open', null);
  assert.equal(r.opened.length, 0);
  assert.equal(r.runs.length, 0, 'it mounts no surface');
});

test('the same package is fully active on its platform', async () => {
  const r = await runtime(JSON.stringify(platformManifest), 'macos', { id: 'root', children: [
    { id: 'sidebar', type: 'column', children: [{ id: 'agents', type: 'block', content: { mod: 'herdr-zed' } },
      { id: 'sidebar-history', type: 'block', content: { mod: 'herdr-zed' } }] }] });
  await r.refreshExtensions();
  assert.equal(r.extensionActive('herdr-zed-demo'), true);
  assert.equal(r.extensionCatalog().actions[0].id, 'demo.open');
  assert.equal(r.runs.length, 1, 'the sidebar surface mounts above the history row');
});

test('opening a workspace action uses the measured work area and falls back to the centered dialog while unmeasured', async () => {
  const manifest = JSON.stringify({ ...JSON.parse(text()), actions: [action({ placement: 'workspace' })] });
  const layout = { id: 'root', children: [{ id: 'sidebar', type: 'column', size: { px: 280 }, children: [] }] };
  const r = await runtime(manifest, 'linux', layout);
  await r.refreshExtensions();
  r.openExtension('demo.open', null);
  assert.equal(r.opened[0].kind, 'dialog', 'no measured size yet: centered dialog');
  r.recordSize(r.WORK_WIDTH_KEY, 1000); r.recordSize(r.WINDOW_HEIGHT_KEY, 700);
  assert.equal(r.memory[r.WORK_WIDTH_KEY], 1000);
  r.openExtension('demo.open', null);
  assert.equal(r.opened[1].kind, 'popup');
  assert.deepEqual([r.opened[1].at, r.opened[1].width, r.opened[1].height], [{ x: 280, y: 32 }, 1000, 636]);
});

test('surface visibility and the status counts follow what is shown', async () => {
  const system = { ...JSON.parse(text()), surfaces: [
    { id: 'inline', location: 'status.right', view: 'inline', title: 'Inline', icon: 'globe' },
    { id: 'widgets', location: 'sidebar.bottom', view: 'widgets', title: 'Widgets', icon: 'globe' }] };
  const root = { id: 'root', children: [
    { id: 'sidebar', type: 'column', children: [{ id: 'agents', type: 'block' }, { id: 'sidebar-history', type: 'block' }] },
    { id: 'status', type: 'column', children: [{ id: 'status-content', type: 'row', children: [
      { id: 'status-main', type: 'block' }, { id: 'status-tools', type: 'block', size: { px: 68 } }] }] }] };
  const r = await runtime(JSON.stringify(system), 'linux', root);
  await r.refreshExtensions();
  assert.equal(r.runs.length, 1, 'mounted once');
  assert.equal(r.visibleSurfaceCount('status.right'), 1, 'a status.right surface is visible by default');
  assert.equal(r.visibleSurfaceCount('sidebar.bottom'), 0, 'a sidebar surface starts hidden');
});
