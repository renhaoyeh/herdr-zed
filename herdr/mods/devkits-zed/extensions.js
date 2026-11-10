import { h_flex } from 'gpui-base';
import { shared, setShared, appHome, readTextFile, openOverlay, notify, layout, run } from 'herdr';
import { ToolbarButton } from './components/button.js';
import { glyph } from './components/icon.js';
import { parseExtensionRegistry, parseExtensionManifest, extensionPopup, extensionMetadata, extensionServiceLayout } from './extension-model.js';

const DISABLED = 'devkits-zed.extensions.disabled';
export const extensionEnabled = mod => !(shared(DISABLED) || []).includes(mod);
export function setExtensionEnabled(mod, enabled) {
  const disabled = new Set(shared(DISABLED) || []);
  if (enabled) disabled.delete(mod); else disabled.add(mod);
  setShared(DISABLED, [...disabled]);
  syncExtensionServices();
}

function syncExtensionServices() {
  const next = extensionServiceLayout(layout(), extensionCatalog().packages || [], shared(DISABLED) || []);
  if (next) run('layout.set', { layout: next });
}

const CATALOG = 'devkits-zed.extensions.catalog', REQUEST = 'devkits-zed.extensions.request';
export const extensionCatalog = () => shared(CATALOG) || { ready: false, loading: false, actions: [], packages: [], errors: [] };

export async function refreshExtensions() {
  const request = `${Date.now()}:${Math.random()}`;
  setShared(REQUEST, request);
  setShared(CATALOG, { ...extensionCatalog(), ready: false, loading: true });
  const actions = [], packages = [], errors = [], ids = new Set();
  try {
    const mods = parseExtensionRegistry(await readTextFile(`${appHome()}/data/devkits-zed/extensions.json`));
    for (const mod of mods) {
      try {
        const text = await readTextFile(`${appHome()}/mods/${mod}/extension.json`);
        const entries = parseExtensionManifest(mod, text), metadata = extensionMetadata(mod, text);
        if (entries.some(action => ids.has(action.id))) throw new Error('Duplicate contribution ID.');
        packages.push({ mod, title: metadata.title, services: metadata.services });
        for (const action of entries) { ids.add(action.id); actions.push(action); }
      } catch (error) { packages.push({ mod, title: mod, error: error.message }); errors.push(`${mod}: ${error.message}`); }
    }
  } catch (error) { errors.push(error.message); }
  if (shared(REQUEST) !== request) return;
  setShared(CATALOG, { ready: true, loading: false, actions, packages, errors });
  syncExtensionServices();
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
