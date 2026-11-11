import { h_flex } from 'gpui-base';
import { shared, setShared, appHome, readTextFile, openOverlay, notify, layout, run, window } from 'herdr';
import { ToolbarButton, TOOLBAR_GLYPH } from './components/button.js';
import { glyph } from './components/icon.js';
import { DropdownMenu } from './components/dropdown-menu.js';
import { parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout, gitActionPopup, resolveProviders, launcherAvailable, platformSupported, workspaceRect, windowHeightFromSidebar } from './extension-model.js';
import { extensionSurfaceLayout, extensionSurfaceNodeId, STATUS_ACTION_LIMIT, surfaceEmptyKey, emptyStatusSurfaces, statusReadings } from './extension-surfaces.js';
import { openWorkspacePanel, WORKSPACE_RECT_KEY, WORKSPACE_PANEL_OVERLAY, usableWorkspaceRect } from './components/workspace-overlay.js';

const DISABLED = 'herdr-zed.extensions.disabled';
// Measured by the shell's views (on_size_change, logical px): the work column width and the sidebar's flexible body
// height (windowHeightFromSidebar adds the fixed rows around it).
export const WORK_WIDTH_KEY = 'herdr-zed.work-width', SIDEBAR_HEIGHT_KEY = 'herdr-zed.sidebar-height';
export const recordSize = (key, value) => { if (value > 0 && shared(key) !== value) { setShared(key, value); publishWorkspaceRect(); } };

// The work area for `workspace` panels now, or null while its size is unknown (ARCHITECTURE §2.1).
export const workspaceRectNow = () => {
  const sidebar = layoutNode(layout(), 'sidebar');
  return workspaceRect({ sidebar, workWidth: shared(WORK_WIDTH_KEY), windowHeight: windowHeightFromSidebar(sidebar, shared(SIDEBAR_HEIGHT_KEY)) });
};

// A workspace panel shows the selected project's work: it closes on a project switch and when Settings opens.
export function closeWorkspacePanel() {
  const id = shared(WORKSPACE_PANEL_OVERLAY);
  if (!id) return;
  setShared(WORKSPACE_PANEL_OVERLAY, null);
  run('overlay.close', { id });
}

// ARCHITECTURE §3.7: the shell publishes the work area (logical px) whenever it changes, null while unmeasured. Providers
// open their workspace panels over it through components/workspace-overlay.js. Written only when it differs.
export function publishWorkspaceRect() {
  const rect = workspaceRectNow(), current = usableWorkspaceRect(shared(WORKSPACE_RECT_KEY));
  if (!rect ? !shared(WORKSPACE_RECT_KEY) : current && ['x', 'y', 'width', 'height'].every(key => current[key] === rect[key])) return;
  setShared(WORKSPACE_RECT_KEY, rect ? { ...rect, updatedAt: Date.now() } : null);
}
export const extensionEnabled = mod => !(shared(DISABLED) || []).includes(mod);
export function setExtensionEnabled(mod, enabled) {
  const disabled = new Set(shared(DISABLED) || []);
  if (enabled) disabled.delete(mod); else disabled.add(mod);
  setShared(DISABLED, [...disabled]);
  if (!enabled) clearExtensionState(mod);
  publishCatalog({});
  syncExtensionServices();
}

// A disabled extension's shared envelopes must not outlive it: decorations, Git credentials and surface emptiness are read by the shell.
function clearExtensionState(mod) {
  const entry = (extensionCatalog().packages || []).find(item => item.mod === mod), id = entry?.id;
  if (!id) return;
  setShared(`herdr-zed.decorations.${id}`, null);
  setShared(`herdr-zed.git-credentials.${id}`, null);
  for (const surface of entry.surfaces || []) if (surface.location === 'status.right') setShared(surfaceEmptyKey(id, surface.id), null);
}

// Mods whose services and surfaces must not mount: disabled, or unavailable because a required extension is not active.
function inactiveMods() {
  return [...(shared(DISABLED) || []), ...(extensionCatalog().resolved?.unavailable || []).map(entry => entry.mod)];
}

function syncExtensionServices() {
  const root = layout(), packages = extensionCatalog().packages || [];
  applyExtensionLayout(root, packages, inactiveMods(), packages);
}

function applyExtensionLayout(root, packages, disabled, previous) {
  try {
    const services = extensionServiceLayout(root, packages, disabled) || root;
    // Providers report status.right readings with nothing to show (ARCHITECTURE §3.8); those mount hidden and take no width.
    const empty = emptyStatusSurfaces(packages, shared);
    const status = { actions: extensionActions('status.right').length, dock: activeSurfaces('dock.right').length,
      readings: statusReadings(packages, disabled, empty) };
    const next = extensionSurfaceLayout(services, packages, disabled, previous, status, empty) || services;
    if (next !== root) run('layout.set', { layout: next });
  } catch (error) {
    notify({ title: 'Could not mount extension surfaces', body: error.message, level: 'error' });
  }
}

const CATALOG = 'herdr-zed.extensions.catalog', REQUEST = 'herdr-zed.extensions.request';
export const extensionCatalog = () => shared(CATALOG) || { ready: false, loading: false, actions: [], packages: [], errors: [], resolved: resolveProviders([]) };
const layoutNode = (node, id) => node?.id === id ? node : (node?.children || []).map(child => layoutNode(child, id)).find(Boolean) || null;

// A package contributes only when it is enabled, parsed, and every extension it requires is active.
export const extensionActive = mod => extensionEnabled(mod)
  && (extensionCatalog().packages || []).some(entry => entry.mod === mod && !entry.error && !entry.unsupported)
  && !(extensionCatalog().resolved?.unavailable || []).some(entry => entry.mod === mod);

// Publishes the catalog with the enabled flags and provider resolution derived from the current disabled list.
function publishCatalog(patch) {
  const current = extensionCatalog(), disabled = shared(DISABLED) || [];
  const packages = (patch.packages || current.packages || []).map(entry => ({ ...entry, enabled: !disabled.includes(entry.mod) }));
  setShared(CATALOG, { ...current, ...patch, packages, resolved: resolveProviders(packages, disabled) });
}

// The launcher the + button and the provider's launch intake use: the resolved one, only while its service is mounted.
// Otherwise the shell uses its native picker (ARCHITECTURE §2.2.1, §3.6).
export const activeLauncher = () => {
  const catalog = extensionCatalog(), launcher = catalog.resolved?.launcher;
  return launcherAvailable(launcher, catalog.packages, layout()) ? launcher : null;
};

export const extensionSurfaceVisible = surface => {
  const node = layoutNode(layout(), extensionSurfaceNodeId(surface));
  return Boolean(node && !node.hidden);
};
export const setExtensionSurfaceVisible = (surface, visible) => {
  const id = extensionSurfaceNodeId(surface), node = layoutNode(layout(), id);
  if (!node || Boolean(node.hidden) === !visible) return;
  run(visible ? 'layout.show' : 'layout.hide', { id });
};

// Re-sizes status-tools to what is shown now. Called from the status-tools view, which renders after a change, so it
// never acts on a stale layout between a show/hide command and its effect.
export function syncExtensionLayout() { syncExtensionServices(); }

export async function refreshExtensions() {
  const previousPackages = extensionCatalog().packages || [];
  const request = `${Date.now()}:${Math.random()}`;
  setShared(REQUEST, request);
  setShared(CATALOG, { ...extensionCatalog(), ready: false, loading: true });
  const actions = [], packages = [], errors = [], ids = new Set(), surfaceIds = new Set();
  try {
    const mods = parseExtensionRegistry(await readTextFile(`${appHome()}/data/herdr-zed/extensions.json`));
    for (const mod of mods) {
      try {
        const text = await readTextFile(`${appHome()}/mods/${mod}/extension.json`);
        const entries = parseExtensionManifest(mod, text), metadata = extensionMetadata(mod, text);
        // ARCHITECTURE §2.1 platforms: a package for another platform contributes nothing and shows as unavailable.
        if (!platformSupported(metadata.platforms, window()?.platform)) {
          packages.push({ mod, id: metadata.id, title: metadata.title, provides: {}, requires: [], platforms: metadata.platforms,
            unsupported: true, services: [], surfaces: [] });
          continue;
        }
        if (entries.some(action => ids.has(action.id))) throw new Error('Duplicate contribution ID.');
        if (metadata.surfaces.some(surface => surfaceIds.has(extensionSurfaceNodeId(surface)))) throw new Error('Duplicate surface ID.');
        packages.push({ mod, id: metadata.id, title: metadata.title, provides: metadata.provides, requires: metadata.requires,
          settings: metadata.settings, services: metadata.services, surfaces: metadata.surfaces });
        for (const action of entries) { ids.add(action.id); actions.push(action); }
        for (const surface of metadata.surfaces) surfaceIds.add(extensionSurfaceNodeId(surface));
      } catch (error) { packages.push({ mod, title: mod, provides: {}, requires: [], error: error.message }); errors.push(`${mod}: ${error.message}`); }
    }
  } catch (error) { errors.push(error.message); }
  if (shared(REQUEST) !== request) return;
  publishCatalog({ ready: true, loading: false, actions, packages, errors });
  applyExtensionLayout(layout(), packages, inactiveMods(), previousPackages);
  if (errors.length) notify({ title: 'Could not load extensions', body: errors.join('\n'), level: 'error' });
}

// Workspace placement opens its window over the work area (openWorkspacePanel). Without a known size the declared centered
// dialog opens.
export function openExtension(id, project) {
  const catalog = extensionCatalog(), action = catalog.actions.find(action => action.id === id);
  if (!catalog.ready || !action || !extensionActive(action.mod)) return;
  try {
    const popup = extensionPopup(action, project);
    return action.popup.placement === 'workspace'
      ? openWorkspacePanel({ mod: popup.mod, props: popup.props, width: popup.width, height: popup.height, modal: popup.modal })
      : openOverlay(popup);
  }
  catch (error) { notify({ title: 'Could not open extension', body: error.message, level: 'error' }); }
}

// Actions contributed to a location by active extensions only.
export function extensionActions(location) {
  const catalog = extensionCatalog();
  return (catalog.ready ? catalog.actions : []).filter(action => action.location === location && extensionActive(action.mod));
}

// Surfaces declared at a location by active extensions only.
const activeSurfaces = location => (extensionCatalog().packages || []).filter(entry => !entry.error && extensionActive(entry.mod))
  .flatMap(entry => entry.surfaces || []).filter(surface => surface.location === location);
// How many surfaces at a location are active and shown: dividers and widths follow what is actually visible.
export const visibleSurfaceCount = location => activeSurfaces(location).filter(surface => extensionSurfaceVisible(surface)).length;

// Git actions open with the selected repository as context, not the workspace project captured by status actions.
export function openGitAction(id, repository) {
  const action = extensionCatalog().actions.find(action => action.id === id);
  if (!action || !extensionActive(action.mod)) return;
  try { return openOverlay(gitActionPopup(action, repository)); }
  catch (error) { notify({ title: 'Could not open extension', body: error.message, level: 'error' }); }
}

// Status bar actions are icon-only (title is the tooltip and label). The first STATUS_ACTION_LIMIT show as buttons;
// the rest sit in one overflow menu with icon and title rows. `menu` is the overflow DropdownMenuState.
export function ExtensionSlot(location, t, project, menu) {
  const entries = extensionActions(location);
  if (!entries.length) return null;
  const shown = entries.slice(0, STATUS_ACTION_LIMIT), overflow = entries.slice(STATUS_ACTION_LIMIT);
  const choose = id => openExtension(id, project);
  return h_flex().h_full().flex_none().items_center()
    .children(shown.map(action => ToolbarButton(`extension-${action.id}`, t, { icon: true })
      .accessibility_label(action.title).tooltip(action.title)
      .on_click(() => choose(action.id))
      .child(glyph(action.icon, TOOLBAR_GLYPH).text_color(action.iconColor || t.muted))))
    .when(overflow.length > 0, el => el.child(DropdownMenu('extension-overflow', menu,
      ToolbarButton('extension-overflow', t, { icon: true }).accessibility_label('More extensions').tooltip('More extensions')
        .child(glyph('ellipsis', TOOLBAR_GLYPH)),
      overflow.map(action => ({ key: action.id, label: action.title, icon: action.icon })),
      id => choose(id), t, { align: 'end', offset: { x: 0, y: 8 } })));
}

export function ExtensionSurfaceSlot(location, t) {
  const entries = activeSurfaces(location).filter(surface => location === 'dock.right');
  if (!entries.length) return null;
  return h_flex().h_full().flex_none().items_center()
    .children(entries.map(surface => {
      const visible = extensionSurfaceVisible(surface);
      return ToolbarButton(`extension-surface-${surface.id}`, t, { icon: true, selected: visible })
        .accessibility_label(`${visible ? 'Hide' : 'Show'} ${surface.title} dock`)
        .on_click(() => setExtensionSurfaceVisible(surface, !extensionSurfaceVisible(surface)))
        .child(glyph(surface.icon, TOOLBAR_GLYPH));
    }));
}
