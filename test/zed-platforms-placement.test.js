import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtensionRegistry, parseExtensionManifest, extensionMetadata, extensionPopup, extensionServiceLayout, gitActionPopup, resolveProviders,
  launcherAvailable, platformSupported, workspaceRect, workspaceTopAnchor, windowHeightFromSidebar } from '../mods/herdr-zed/extension-model.js';
import { extensionSurfaceLayout, extensionSurfaceNodeId, surfaceEmptyKey, emptyStatusSurfaces } from '../mods/herdr-zed/extension-surfaces.js';
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

test('workspace panels start after the layout divider, preserving its pixels and the measured work width', () => {
  const geometry = { sidebar: { size: { px: 280 } }, workWidth: 1000, windowHeight: 700 };
  const rect = workspaceRect({ ...geometry, dividerWidth: 1 });
  assert.equal(rect.x, 281);
  assert.equal(rect.x + rect.width, 1281, 'the panel fills the work column without covering its left divider');
  assert.equal(workspaceRect({ ...geometry, dividerWidth: 2 }).x, 282);
  assert.equal(workspaceRect({ ...geometry, sidebar: { ...geometry.sidebar, hidden: true }, dividerWidth: 1 }).x, 0);
});

test('the window height is the sidebar column: its measured body plus the fixed brand and history rows, so the panel ends at the status bar', () => {
  // The live layout: brand 32, agents (flexible), history 32 inside a column that spans the window (1032 tall).
  const sidebar = { id: 'sidebar', children: [{ id: 'brand', size: { px: 32 } }, { id: 'agents' }, { id: 'sidebar-history', size: { px: 32 } }] };
  assert.equal(windowHeightFromSidebar(sidebar, 968), 1032);
  assert.equal(windowHeightFromSidebar({ children: [{ id: 'brand', size: { px: 32 } }, { id: 'agents' }, { id: 'h', size: { px: 32 }, hidden: true }] }, 500), 532, 'a hidden row takes no space');
  assert.equal(windowHeightFromSidebar(sidebar, 0), null, 'an unmeasured body');
  assert.equal(windowHeightFromSidebar(sidebar, undefined), null);
  // Header 32 and status bar 32 are subtracted once, by workspaceRect: the panel is 968 tall from y 32 to 1000.
  const rect = workspaceRect({ sidebar: { size: { px: 280 } }, workWidth: 1000, windowHeight: windowHeightFromSidebar(sidebar, 968) });
  assert.deepEqual(rect, { x: 280, y: 32, width: 1000, height: 968 });
  assert.equal(rect.y + rect.height, 1032 - 32, 'it ends where the status bar starts');
});

test('a workspace action declares its size but the shell opens it through openWorkspacePanel: the centered dialog stays the declaration', () => {
  const [work] = parseExtensionManifest('herdr-zed-demo', text({ actions: [action({ placement: 'workspace' })] }));
  const declared = extensionPopup({ ...work, mod: 'herdr-zed-demo', extensionId: 'demo' }, null);
  assert.deepEqual([declared.kind, declared.width, declared.height, declared.modal], ['dialog', 400, 300, false]);
  assert.equal(declared.props.view, 'details');
  const centred = parseExtensionManifest('herdr-zed-demo', text())[0];
  assert.equal(extensionPopup({ ...centred, mod: 'herdr-zed-demo', extensionId: 'demo' }, null).kind, 'dialog');
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
    resolveProviders, launcherAvailable, platformSupported, workspaceRect, extensionSurfaceLayout, extensionSurfaceNodeId, surfaceEmptyKey, emptyStatusSurfaces,
    ToolbarButton() {}, TOOLBAR_GLYPH: 16, glyph() {}, DropdownMenu() {}, h_flex() {},
    ...await evaluateNative('../components/workspace-overlay.js', { shared: key => memory[key], settings: () => ({ zoom: 1 }),
      openOverlay: value => { opened.push(value); return 'overlay'; }, setShared: (key, value) => { memory[key] = structuredClone(value); } },
      'openWorkspacePanel, usableWorkspaceRect, WORKSPACE_RECT_KEY, WORKSPACE_PANEL_OVERLAY, WORKSPACE_PANEL_ACTIVE'),
    windowHeightFromSidebar,
  };
  // extensions.js reads the publisher's own names from the same host; evaluate it once the host is complete.
  return { memory, opened, runs, ...await evaluateNative('../mods/herdr-zed/extensions.js', host,
    'refreshExtensions, openExtension, toggleExtension, extensionCatalog, extensionActive, extensionActions, extensionSurfaceVisible, setExtensionSurfaceVisible, visibleSurfaceCount, WORK_WIDTH_KEY, SIDEBAR_HEIGHT_KEY, recordSize, workspaceRectNow, publishWorkspaceRect, closeWorkspacePanel') };
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

test('opening a workspace action uses the published work area and falls back to the centered dialog while unmeasured', async () => {
  const manifest = JSON.stringify({ ...JSON.parse(text()), actions: [action({ placement: 'workspace' })] });
  const layout = { id: 'root', divider: { width: 1 }, children: [{ id: 'sidebar', type: 'column', size: { px: 280 }, children: [] }] };
  const r = await runtime(manifest, 'linux', layout);
  await r.refreshExtensions();
  r.openExtension('demo.open', null);
  assert.equal(r.opened[0].kind, 'dialog', 'no measured size yet: centered dialog');
  assert.equal(r.memory['herdr-zed.workspace-rect'], undefined, 'nothing is published while unmeasured');
  r.closeWorkspacePanel();
  r.recordSize(r.WORK_WIDTH_KEY, 1000); r.recordSize(r.SIDEBAR_HEIGHT_KEY, 700);
  assert.equal(r.memory[r.WORK_WIDTH_KEY], 1000);
  assert.deepEqual([r.memory['herdr-zed.workspace-rect'].x, r.memory['herdr-zed.workspace-rect'].y, r.memory['herdr-zed.workspace-rect'].width, r.memory['herdr-zed.workspace-rect'].height],
    [281, 32, 1000, 636], 'the shell publishes the work area after its divider');
  r.openExtension('demo.open', null);
  assert.equal(r.opened[1].kind, 'window');
  assert.equal(r.opened[1].key, 'herdr-zed.workspace-panel', 'one window name: opening another replaces it');
  assert.deepEqual([r.opened[1].at, r.opened[1].width, r.opened[1].height], [{ x: 281, y: 32 }, 1000, 636]);
  assert.equal(r.memory['herdr-zed.workspace-panel.overlay'], 'overlay', 'the open panel id is recorded for the shell');
});

test('a workspace panel closes by its recorded id on a project switch or Settings, and the id is forgotten', async () => {
  const manifest = JSON.stringify({ ...JSON.parse(text()), actions: [action({ placement: 'workspace' })] });
  const layout = { id: 'root', children: [{ id: 'sidebar', type: 'column', size: { px: 280 }, children: [] }] };
  const r = await runtime(manifest, 'linux', layout);
  await r.refreshExtensions();
  r.recordSize(r.WORK_WIDTH_KEY, 1000); r.recordSize(r.SIDEBAR_HEIGHT_KEY, 700);
  r.openExtension('demo.open', null);
  assert.equal(r.memory['herdr-zed.workspace-panel.active'].action, 'demo.open');
  r.closeWorkspacePanel();
  assert.deepEqual(r.runs.at(-1), ['overlay.close', { id: 'overlay' }]);
  assert.equal(r.memory['herdr-zed.workspace-panel.overlay'], null);
  assert.equal(r.memory['herdr-zed.workspace-panel.active'], null);
  const count = r.runs.length;
  r.closeWorkspacePanel();
  assert.equal(r.runs.length, count, 'with no open panel there is nothing to close');
});

test('repeated status clicks close the open panel without reopening it; commands preserve the existing instance', async () => {
  const manifest = JSON.stringify({ ...JSON.parse(text()), actions: [action({ placement: 'workspace' })] });
  const r = await runtime(manifest, 'linux');
  await r.refreshExtensions();
  r.toggleExtension('demo.open', null);
  assert.equal(r.opened.length, 1);
  r.openExtension('demo.open', null);
  assert.equal(r.opened.length, 1, 'an open command does not rebuild the panel');
  r.toggleExtension('demo.open', null);
  assert.equal(r.opened.length, 1, 'the second click closes without reopening');
  assert.equal(r.memory['herdr-zed.workspace-panel.active'], null);
  assert.deepEqual(r.runs.at(-1), ['overlay.close', { id: 'overlay' }]);
  r.toggleExtension('demo.open', null);
  assert.equal(r.opened.length, 2, 'a subsequent click opens it again');
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
