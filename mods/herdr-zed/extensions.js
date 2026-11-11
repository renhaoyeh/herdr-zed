import { h_flex } from 'gpui-base';
import { shared, setShared, appHome, readTextFile, openOverlay, notify, layout, run } from 'herdr';
import { ToolbarButton } from './components/button.js';
import { glyph } from './components/icon.js';
import { parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout, gitActionPopup, resolveProviders, launcherAvailable } from './extension-model.js';
import { extensionSurfaceLayout, extensionSurfaceNodeId } from './extension-surfaces.js';

const DISABLED = 'herdr-zed.extensions.disabled';
export const extensionEnabled = mod => !(shared(DISABLED) || []).includes(mod);
export function setExtensionEnabled(mod, enabled) {
  const disabled = new Set(shared(DISABLED) || []);
  if (enabled) disabled.delete(mod); else disabled.add(mod);
  setShared(DISABLED, [...disabled]);
  if (!enabled) clearExtensionState(mod);
  publishCatalog({});
  syncExtensionServices();
}

// A disabled extension's shared envelopes must not outlive it: decorations and Git credentials are read by the shell.
function clearExtensionState(mod) {
  const id = (extensionCatalog().packages || []).find(entry => entry.mod === mod)?.id;
  if (!id) return;
  setShared(`herdr-zed.decorations.${id}`, null);
  setShared(`herdr-zed.git-credentials.${id}`, null);
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
    const next = extensionSurfaceLayout(services, packages, disabled, previous) || services;
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
  && (extensionCatalog().packages || []).some(entry => entry.mod === mod && !entry.error)
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
        if (entries.some(action => ids.has(action.id))) throw new Error('Duplicate contribution ID.');
        if (metadata.surfaces.some(surface => surfaceIds.has(extensionSurfaceNodeId(surface)))) throw new Error('Duplicate surface ID.');
        packages.push({ mod, id: metadata.id, title: metadata.title, provides: metadata.provides, requires: metadata.requires,
          services: metadata.services, surfaces: metadata.surfaces });
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

export function openExtension(id, project) {
  const catalog = extensionCatalog(), action = catalog.actions.find(action => action.id === id);
  if (!catalog.ready || !action || !extensionActive(action.mod)) return;
  try { return openOverlay(extensionPopup(action, project)); }
  catch (error) { notify({ title: 'Could not open extension', body: error.message, level: 'error' }); }
}

// Actions contributed to a location by active extensions only.
export function extensionActions(location) {
  const catalog = extensionCatalog();
  return (catalog.ready ? catalog.actions : []).filter(action => action.location === location && extensionActive(action.mod));
}

// Git actions open with the selected repository as context, not the workspace project captured by status actions.
export function openGitAction(id, repository) {
  const action = extensionCatalog().actions.find(action => action.id === id);
  if (!action || !extensionActive(action.mod)) return;
  try { return openOverlay(gitActionPopup(action, repository)); }
  catch (error) { notify({ title: 'Could not open extension', body: error.message, level: 'error' }); }
}

export function ExtensionSlot(location, t, project) {
  const entries = extensionActions(location);
  if (!entries.length) return null;
  return h_flex().h_full().flex_none().items_center()
    .children(entries.map(action => ToolbarButton(`extension-${action.id}`, t).accessibility_label(action.title)
      .on_click(() => openExtension(action.id, project))
      .child(glyph(action.icon).text_color(action.iconColor || t.muted)).child(action.title)));
}

export function ExtensionSurfaceSlot(location, t) {
  const entries = (extensionCatalog().packages || []).filter(entry => !entry.error && extensionActive(entry.mod))
    .flatMap(entry => entry.surfaces || []).filter(surface => surface.location === location && location === 'dock.right');
  if (!entries.length) return null;
  return h_flex().h_full().flex_none().items_center()
    .children(entries.map(surface => {
      const visible = extensionSurfaceVisible(surface);
      return ToolbarButton(`extension-surface-${surface.id}`, t, { icon: true, selected: visible })
        .accessibility_label(`${visible ? 'Hide' : 'Show'} ${surface.title} dock`)
        .on_click(() => setExtensionSurfaceVisible(surface, !extensionSurfaceVisible(surface)))
        .child(glyph(surface.icon, 16));
    }));
}
