import { h_flex } from 'gpui-base';
import { shared, setShared, appHome, readTextFile, openOverlay, notify, layout, run } from 'herdr';
import { ToolbarButton } from './components/button.js';
import { glyph } from './components/icon.js';
import { parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout } from './extension-model.js';
import { extensionSurfaceLayout, extensionSurfaceNodeId } from './extension-surfaces.js';

const DISABLED = 'herdr-zed.extensions.disabled';
export const extensionEnabled = mod => !(shared(DISABLED) || []).includes(mod);
export function setExtensionEnabled(mod, enabled) {
  const disabled = new Set(shared(DISABLED) || []);
  if (enabled) disabled.delete(mod); else disabled.add(mod);
  setShared(DISABLED, [...disabled]);
  syncExtensionServices();
}

function syncExtensionServices() {
  const root = layout(), packages = extensionCatalog().packages || [], disabled = shared(DISABLED) || [];
  applyExtensionLayout(root, packages, disabled, packages);
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
export const extensionCatalog = () => shared(CATALOG) || { ready: false, loading: false, actions: [], packages: [], errors: [] };
const layoutNode = (node, id) => node?.id === id ? node : (node?.children || []).map(child => layoutNode(child, id)).find(Boolean) || null;
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
        packages.push({ mod, title: metadata.title, services: metadata.services, surfaces: metadata.surfaces });
        for (const action of entries) { ids.add(action.id); actions.push(action); }
        for (const surface of metadata.surfaces) surfaceIds.add(extensionSurfaceNodeId(surface));
      } catch (error) { packages.push({ mod, title: mod, error: error.message }); errors.push(`${mod}: ${error.message}`); }
    }
  } catch (error) { errors.push(error.message); }
  if (shared(REQUEST) !== request) return;
  setShared(CATALOG, { ready: true, loading: false, actions, packages, errors });
  applyExtensionLayout(layout(), packages, shared(DISABLED) || [], previousPackages);
  if (errors.length) notify({ title: 'Could not load extensions', body: errors.join('\n'), level: 'error' });
}

export function openExtension(id, project) {
  const catalog = extensionCatalog(), action = catalog.actions.find(action => action.id === id);
  if (!catalog.ready || !action || !extensionEnabled(action.mod)) return;
  try { return openOverlay(extensionPopup(action, project)); }
  catch (error) { notify({ title: 'Could not open extension', body: error.message, level: 'error' }); }
}

export function ExtensionSlot(location, t, project) {
  const catalog = extensionCatalog();
  const entries = (catalog.ready ? catalog.actions : []).filter(action => action.location === location && extensionEnabled(action.mod));
  if (!entries.length) return null;
  return h_flex().h_full().flex_none().items_center()
    .children(entries.map(action => ToolbarButton(`extension-${action.id}`, t).accessibility_label(action.title)
      .on_click(() => openExtension(action.id, project))
      .child(glyph(action.icon).text_color(action.iconColor || t.muted)).child(action.title)));
}

export function ExtensionSurfaceSlot(location, t) {
  const entries = (extensionCatalog().packages || []).filter(entry => !entry.error && extensionEnabled(entry.mod))
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
