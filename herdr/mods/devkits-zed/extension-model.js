// Serializable declarations only. Extension implementations stay in their own mods.
const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
const title = value => typeof value === 'string' && value.trim().length > 0;
const dimension = value => Number.isFinite(value) && value > 0 && value <= 2400;

export function parseExtensionRegistry(text) {
  if (text === null) return [];
  const value = JSON.parse(text);
  if (!value || value.version !== 1 || !Array.isArray(value.extensions)
    || Object.keys(value).some(key => !['version', 'extensions'].includes(key))
    || value.extensions.some(mod => !name(mod)) || new Set(value.extensions).size !== value.extensions.length)
    throw new Error('Invalid extension registry. Expected version 1 and unique mod names.');
  return value.extensions;
}

export function parseExtensionManifest(mod, text) {
  if (!name(mod)) throw new Error('Invalid extension mod name.');
  if (text === null) throw new Error('Extension manifest is missing.');
  const value = JSON.parse(text);
  if (!value || value.version !== 1 || !name(value.id) || !title(value.title) || !Array.isArray(value.actions))
    throw new Error('Invalid extension manifest.');
  const ids = new Set();
  return value.actions.map(action => {
    if (!action || !name(action.id) || ids.has(action.id) || !title(action.title)
      || action.location !== 'status.right'
      || !name(action.icon) || (action.iconColor && !/^#[0-9a-f]{6}$/i.test(action.iconColor))
      || !action.popup || !name(action.popup.view) || !dimension(action.popup.width) || !dimension(action.popup.height)
      || typeof action.popup.modal !== 'boolean') throw new Error('Invalid extension action.');
    ids.add(action.id);
    return { id: `${value.id}.${action.id}`, extensionId: value.id, extensionTitle: value.title, mod,
      title: action.title, icon: action.icon, iconColor: action.iconColor || null,
      location: action.location,
      popup: { view: action.popup.view, width: action.popup.width, height: action.popup.height, modal: action.popup.modal } };
  });
}

export function extensionPopup(action, project) {
  // Capture the originating project. Later workspace switches don't retarget an open dialog.
  const context = project ? { id: project.id, folder: project.folder, name: project.name, machine: project.machine || null } : null;
  const scope = JSON.stringify([context?.machine || '', context?.folder || '']);
  return { mod: action.mod, kind: 'dialog', frame: 'none', modal: action.popup.modal,
    width: action.popup.width, height: action.popup.height,
    props: { view: action.popup.view, ...(context ? { context } : {}),
      stateKey: `devkits-zed.extension.${action.extensionId}.${scope}` } };
}
