// Serializable declarations only. Extension implementations stay in their own mods.
// @ts-check
const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
const title = value => typeof value === 'string' && value.trim().length > 0;
const dimension = value => Number.isFinite(value) && value > 0 && value <= 2400;
const surfaceLocations = ['sidebar.bottom', 'status.right', 'dock.right'];
const actionLocations = ['status.right', 'git.actions'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const providerKeys = ['launcher', 'threadDecorator', 'importer', 'gitCredentials'];
const decorationFields = ['badge', 'subtitle', 'tone'];
const platformNames = ['macos', 'windows', 'linux'];
const placements = ['center', 'workspace'];
// ARCHITECTURE §2.1 popup.placement "workspace": the work area between the header and the status bar.
export const WORKSPACE_HEADER = 32, WORKSPACE_STATUS = 32;

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
      || !actionLocations.includes(action.location)
      || !name(action.icon) || (action.iconColor && !/^#[0-9a-f]{6}$/i.test(action.iconColor))
      || !action.popup || !name(action.popup.view) || !dimension(action.popup.width) || !dimension(action.popup.height)
      || typeof action.popup.modal !== 'boolean' || (action.popup.placement !== undefined && !placements.includes(action.popup.placement)))
      throw new Error('Invalid extension action.');
    ids.add(action.id);
    return { id: `${value.id}.${action.id}`, extensionId: value.id, extensionTitle: value.title, mod,
      title: action.title, icon: action.icon, iconColor: action.iconColor || null,
      location: action.location,
      popup: { view: action.popup.view, width: action.popup.width, height: action.popup.height, modal: action.popup.modal,
        placement: action.popup.placement || 'center' } };
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
  validateRequires(value.id, value.requires);
  validateProvides(value.provides);
  validateSettings(value.settings);
  validatePlatforms(value.platforms);
  if (value.dataReset !== undefined && value.dataReset !== null
    && (!hasExactKeys(value.dataReset, ['helper']) || typeof value.dataReset.helper !== 'string' || !/^[a-z][a-z0-9-]*\.js$/.test(value.dataReset.helper)))
    throw new Error('Invalid extension data reset helper.');
}

// ARCHITECTURE §2.1: optional `platforms` (non-empty, unique). Absent means every platform.
function validatePlatforms(list) {
  if (list !== undefined && (!Array.isArray(list) || list.length === 0 || list.length > platformNames.length
    || list.some(item => !platformNames.includes(item)) || new Set(list).size !== list.length))
    throw new Error('Invalid extension platforms.');
}

// The platform rule (ARCHITECTURE §2.1): a package whose platforms do not include the window's platform contributes nothing.
export const platformSupported = (platforms, platform) => !platforms || platforms.includes(platform);

// ARCHITECTURE §2.1: the Settings dialog hosts `view` embedded, listed under `title`. `pages` (optional, 1-12) are
// sub-items under the entry, each { id, title }. Keys are exactly these.
function validateSettings(settings) {
  if (settings === undefined) return;
  if (!plain(settings) || Object.keys(settings).some(key => !['view', 'title', 'pages'].includes(key))
    || !name(settings.view) || !title(settings.title)) throw new Error('Invalid extension settings.');
  const pages = settings.pages;
  if (pages === undefined) return;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 12
    || pages.some(page => !hasExactKeys(page, ['id', 'title']) || !name(page.id) || !title(page.title))
    || new Set(pages.map(page => page.id)).size !== pages.length) throw new Error('Invalid extension settings.');
}

function validateRequires(id, requires) {
  if (requires === undefined) return;
  if (!Array.isArray(requires) || requires.length > 16 || requires.some(item => !name(item) || item === id)
    || new Set(requires).size !== requires.length) throw new Error('Invalid extension requires.');
}

function validateProvides(provides) {
  if (provides === undefined) return;
  if (!plain(provides) || Object.keys(provides).some(key => !providerKeys.includes(key))) throw new Error('Invalid extension provides.');
  const { launcher, threadDecorator, importer, gitCredentials } = provides;
  if (launcher !== undefined && !validLauncher(launcher)) throw new Error('Invalid extension launcher provider.');
  if (threadDecorator !== undefined && !validThreadDecorator(threadDecorator)) throw new Error('Invalid extension thread decorator provider.');
  if (importer !== undefined && !validImporter(importer)) throw new Error('Invalid extension importer provider.');
  if (gitCredentials !== undefined && !(plain(gitCredentials) && Object.keys(gitCredentials).length === 0))
    throw new Error('Invalid extension git credentials provider.');
}

// ARCHITECTURE §2.2.1: the launcher provides its picker only; its settings page is the manifest `settings` key (§2.1).
const validLauncher = launcher => hasExactKeys(launcher, ['picker'])
  && hasExactKeys(launcher.picker, ['view', 'width']) && name(launcher.picker.view) && dimension(launcher.picker.width);

const validThreadDecorator = decorator => hasExactKeys(decorator, ['fields'])
  && Array.isArray(decorator.fields) && decorator.fields.length > 0 && decorator.fields.length <= decorationFields.length
  && decorator.fields.every(field => decorationFields.includes(field)) && new Set(decorator.fields).size === decorator.fields.length;

const validImporter = importer => hasExactKeys(importer, ['accepts', 'view'])
  && Array.isArray(importer.accepts) && importer.accepts.length > 0 && importer.accepts.every(kind => kind === 'task-snapshot')
  && new Set(importer.accepts).size === importer.accepts.length && name(importer.view);

// Only declared, enabled, error-free packages whose requirements are themselves available contribute.
export function resolveProviders(packages = [], disabledMods = []) {
  const disabled = new Set(disabledMods);
  // An unsupported package (another platform) is never available: it is neither a provider nor a conflict.
  const usable = entry => entry && !entry.error && !entry.unsupported && !disabled.has(entry.mod);
  let available = packages.filter(usable);
  for (;;) {
    const ids = new Set(available.map(entry => entry.id));
    const next = available.filter(entry => (entry.requires || []).every(id => ids.has(id)));
    if (next.length === available.length) break;
    available = next;
  }
  const availableIds = new Set(available.map(entry => entry.id));
  const unavailable = packages
    .filter(entry => usable(entry) && !available.includes(entry))
    .map(entry => ({ mod: entry.mod, id: entry.id, missing: (entry.requires || []).filter(id => !availableIds.has(id)) }));
  const conflicts = [];
  const unique = (provider, entries) => {
    if (entries.length <= 1) return entries[0] ?? null;
    conflicts.push({ provider, mods: entries.map(entry => entry.mod), ids: entries.map(entry => entry.id) });
    return null;
  };
  const launcher = unique('launcher', available.filter(entry => entry.provides?.launcher)
    .map(entry => ({ mod: entry.mod, id: entry.id, ...entry.provides.launcher })));
  const gitCredentials = unique('gitCredentials', available.filter(entry => entry.provides?.gitCredentials)
    .map(entry => ({ mod: entry.mod, id: entry.id })));
  const importers = available.filter(entry => entry.provides?.importer)
    .map(entry => ({ mod: entry.mod, id: entry.id, ...entry.provides.importer }));
  const decorators = available.filter(entry => entry.provides?.threadDecorator)
    .map(entry => ({ mod: entry.mod, id: entry.id, fields: [...entry.provides.threadDecorator.fields] }));
  // Settings pages: enabled, error-free, available packages that declare `settings`, in catalog order.
  const settings = available.filter(entry => entry.settings)
    .map(entry => ({ mod: entry.mod, id: entry.id, view: entry.settings.view, title: entry.settings.title,
      pages: entry.settings.pages || [] }));
  return { launcher, gitCredentials, importers, decorators, settings, conflicts, unavailable };
}

function settingsMetadata(settings) {
  if (!settings) return null;
  return { view: settings.view, title: settings.title, pages: (settings.pages || []).map(({ id, title }) => ({ id, title })) };
}

export function extensionMetadata(mod, text) {
  parseExtensionManifest(mod, text);
  const value = JSON.parse(text);
  return { id: value.id, title: value.title, dependencies: value.dependencies || [], requires: value.requires || [],
    dataReset: value.dataReset || null, provides: value.provides || {}, platforms: value.platforms || null, settings: settingsMetadata(value.settings),
    services: (value.services || []).map(({ view }) => ({ view })),
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

// ARCHITECTURE §3.6: a launcher counts as available only while every service its package declares is mounted in the
// layout (a block whose content is that mod's service view). Otherwise the shell uses its native picker.
const mountedView = (node, mod, view) => Boolean(node && (node.content?.mod === mod && node.content.props?.view === view
  || (node.children || []).some(child => mountedView(child, mod, view))));
export function launcherAvailable(launcher, packages = [], root = null) {
  if (!launcher || !root) return false;
  const entry = packages.find(item => item && item.mod === launcher.mod);
  if (!entry) return false;
  return (entry.services || []).every(service => mountedView(root, launcher.mod, service.view));
}

// The declared popup of an action, centered. A `workspace` placement is opened by the shell through openWorkspacePanel
// (components/workspace-overlay.js), which falls back to this same declaration's size while the work area is unknown.
/** @param {any} action @param {any} project */
export function extensionPopup(action, project) {
  // Capture the originating project. Later workspace switches don't retarget an open dialog.
  const context = project ? { id: project.id, folder: project.folder, name: project.name, machine: project.machine || null } : null;
  const scope = JSON.stringify([context?.machine || '', context?.folder || '']);
  const props = { view: action.popup.view, ...(context ? { context } : {}),
    stateKey: `herdr-zed.extension.${action.extensionId}.${scope}` };
  return { mod: action.mod, kind: 'dialog', frame: 'none', modal: action.popup.modal,
    width: action.popup.width, height: action.popup.height, props };
}

// A picker opened without a pointer (keyboard or the new-thread command) is centred at the top of the work area, never in
// the window's top-right corner (review L10). Device px, as the dropdown menus' anchors. Without a known work area it
// falls back to the pointer.
export function workspaceTopAnchor(rect, width, zoom = 1) {
  if (!rect) return 'pointer';
  return { x: (rect.x + Math.max(0, (rect.width - width) / 2)) * zoom, y: (rect.y + 8) * zoom };
}

// The work area for `workspace` popups: x = sidebar width plus its layout divider (0 when hidden), y = header height,
// width = the measured work column, height = window height minus header and status bar. `sidebar` is the layout node 'sidebar'; `workWidth`
// (the work column, which is the window minus the sidebar) and `windowHeight` are measured by the shell's views.
// Null when a size is unknown: the caller then uses the centered dialog.
export function workspaceRect({ sidebar, dividerWidth = 0, workWidth, windowHeight }) {
  if (!(workWidth > 0) || !(windowHeight > 0)) return null;
  let x = 0;
  if (sidebar && !sidebar.hidden) {
    if (!Number.isFinite(sidebar.size?.px)) return null;
    x = sidebar.size.px + dividerWidth;
  }
  const height = windowHeight - WORKSPACE_HEADER - WORKSPACE_STATUS;
  if (workWidth <= 0 || height <= 0) return null;
  return { x, y: WORKSPACE_HEADER, width: workWidth, height };
}

// The window's height, from the sidebar column's measured body. The column spans the whole window, and its flexible
// block (the agents list) is the only one without a fixed px size: the fixed rows around it (brand, history) are added
// back. Measuring the body alone (or the column) and then subtracting the header and status bar again was 64px short.
// Null while the body is unmeasured.
export function windowHeightFromSidebar(sidebar, bodyHeight) {
  if (!(bodyHeight > 0)) return null;
  const fixed = (sidebar?.children || []).reduce((sum, child) =>
    sum + (!child.hidden && Number.isFinite(child.size?.px) ? child.size.px : 0), 0);
  return bodyHeight + fixed;
}

// Git actions open with the selected repository (ARCHITECTURE §2.1), not the workspace project.
export function gitActionPopup(action, { machine, folder }) {
  return { mod: action.mod, kind: 'dialog', frame: 'none', modal: action.popup.modal,
    width: action.popup.width, height: action.popup.height,
    props: { view: action.popup.view, context: { machine: machine || null, folder } } };
}
