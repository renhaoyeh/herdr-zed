// Serializable declarations only. Extension implementations stay in their own mods.
const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
const title = value => typeof value === 'string' && value.trim().length > 0;
const dimension = value => Number.isFinite(value) && value > 0 && value <= 2400;
const surfaceLocations = ['sidebar.bottom', 'status.right', 'dock.right'];

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
  validateMetadata(mod, value);
  const ids = new Set();
  const actions = value.actions.map(action => {
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
  const surfaceIds = new Set();
  if (value.surfaces !== undefined && (!Array.isArray(value.surfaces) || value.surfaces.length > 8))
    throw new Error('Invalid extension surfaces.');
  (value.surfaces || []).forEach(surface => {
    if (!surface || !name(surface.id) || surfaceIds.has(surface.id) || !surfaceLocations.includes(surface.location)
      || !name(surface.view) || !title(surface.title) || !name(surface.icon)
      || Object.keys(surface).some(key => !['id', 'location', 'view', 'title', 'icon'].includes(key)))
      throw new Error('Invalid extension surface.');
    surfaceIds.add(surface.id);
  });
  return actions;
}

function validateMetadata(mod, value) {
  const dependencies = value.dependencies ?? [], services = value.services ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 16 || dependencies.some(item => !name(item) || item === mod)
    || new Set(dependencies).size !== dependencies.length) throw new Error('Invalid extension dependencies.');
  if (!Array.isArray(services) || services.length > 8 || services.some(item => !item || !name(item.view)
    || Object.keys(item).some(key => key !== 'view')) || new Set(services.map(item => item.view)).size !== services.length)
    throw new Error('Invalid extension services.');
}

export function extensionMetadata(mod, text) {
  parseExtensionManifest(mod, text);
  const value = JSON.parse(text);
  return { title: value.title, dependencies: value.dependencies || [], services: (value.services || []).map(({ view }) => ({ view })),
    surfaces: (value.surfaces || []).map(surface => ({ ...surface, extensionId: value.id, mod })) };
}

// Only the shell's existing separator owns extension service mounts. Preserve all other layout nodes.
export function extensionServiceLayout(root, packages, disabled = []) {
  if (!root) return null;
  const prefix = 'zed-extension-service-';
  let changed = false;
  const contains = (node, mod, view) => Boolean(node && (!node.id?.startsWith(prefix)
    && node.content?.mod === mod && node.content.props?.view === view
    || node.children?.some(child => contains(child, mod, view))));
  const visit = node => {
    if (node.id === 'status-separator' && node.type === 'row') {
      const unmanaged = (node.children || []).filter(child => !child.id?.startsWith(prefix));
      const owned = packages.filter(entry => !entry.error && !disabled.includes(entry.mod)).flatMap(entry =>
        (entry.services || []).filter(service => !contains(root, entry.mod, service.view)).map(service => ({
          id: `${prefix}${entry.mod}-${service.view}`, type: 'block',
          content: { mod: entry.mod, props: { view: service.view } },
        })));
      const children = [...unmanaged, ...owned];
      if (JSON.stringify(children) === JSON.stringify(node.children || [])) return node;
      changed = true; return { ...node, children };
    }
    return node.children ? { ...node, children: node.children.map(visit) } : node;
  };
  const next = visit(root);
  return changed ? next : null;
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
