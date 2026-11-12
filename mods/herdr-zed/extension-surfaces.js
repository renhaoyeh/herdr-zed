const PREFIX = 'zed-extension-surface-';
// A status.right reading's width: four labelled percentages (CPU, RAM, GPU, Disk) fit without clipping.
export const READING_PX = 280;
const nodeId = surface => surface.location === 'dock.right' ? surface.id : `${PREFIX}${surface.mod}-${surface.id}`;
// Sidebar and dock surfaces start hidden the first time they mount; status.right surfaces start visible. A sidebar or
// dock surface the user showed or hid keeps that choice (`shown`, SURFACES_SHOWN_KEY) when its block is mounted again,
// e.g. after the layout is refreshed.
export const SURFACES_SHOWN_KEY = 'herdr-zed.surfaces-shown';
const block = (surface, shown = {}) => ({ id: nodeId(surface), type: 'block',
  hidden: surface.location === 'status.right' ? false : typeof shown[nodeId(surface)] === 'boolean' ? !shown[nodeId(surface)] : true,
  ...(surface.location === 'dock.right' ? { size: { px: 380 }, min: 300, max: 900 } : {}),
  ...(surface.location === 'sidebar.bottom' ? { size: { px: 260 }, min: 96, max: 420 } : {}),
  ...(surface.location === 'status.right' ? { size: { px: READING_PX } } : {}),
  content: { mod: surface.mod, props: { view: surface.view } } });
const find = (node, id) => node?.id === id ? node : (node?.children || []).map(child => find(child, id)).find(Boolean) || null;
const copyChildren = (node, children) => JSON.stringify(node.children || []) === JSON.stringify(children) ? node : { ...node, children };
const update = (node, id, change) => node.id === id ? change(node)
  : node.children ? copyChildren(node, node.children.map(child => update(child, id, change))) : node;

// The status row is [status (context), status.right surfaces (live readings)..., status-tools]. Herdr sizes blocks only
// in px or weight, so status-tools is sized to its content: 28px icon buttons and 8px gaps between groups.
// Every active extension action has its own button, followed by dock toggles, Changes and Files.
export const ICON_PX = 28, GAP_PX = 8, PAD_PX = 4;
export function statusToolsWidth({ actions = 0, dock = 0 } = {}) {
  const actionButtons = actions;
  const parts = [];
  if (actionButtons > 0) parts.push(actionButtons * ICON_PX);
  if (dock > 0) parts.push(dock * ICON_PX);
  parts.push(2 * ICON_PX); // Changes and Files
  return parts.reduce((sum, part) => sum + part, 0) + (parts.length - 1) * GAP_PX + PAD_PX;
}

// Native blocks keep provider contexts and subscriptions owned by their mounted view lifecycle.
// `status` (optional) = { actions, dock }: the counts status-tools is sized for.
// Provider-reported emptiness (ARCHITECTURE §3.8): the shared key a provider sets to true while a status.right reading
// has nothing to show. `read` is the shell's shared-state reader; the result holds the node IDs to hide.
export const surfaceEmptyKey = (extension, surface) => `herdr-zed.surface-empty.${extension}.${surface}`;
export const emptyStatusSurfaces = (packages, read) => new Set(packages.filter(entry => entry.id)
  .flatMap(entry => (entry.surfaces || []).filter(surface => surface.location === 'status.right'
    && read(surfaceEmptyKey(entry.id, surface.id)) === true).map(nodeId)));

export function extensionSurfaceLayout(root, packages, disabled = [], previous = [], status = null, empty = new Set(), shown = {}) {
  if (!root) return null;
  const old = previous.flatMap(entry => entry.surfaces || []);
  const enabled = packages.filter(entry => !entry.error && !disabled.includes(entry.mod)).flatMap(entry => entry.surfaces || []);
  const retained = new Set(enabled.map(nodeId));
  const owners = new Map([...old, ...packages.flatMap(entry => entry.surfaces || [])]
    .map(surface => [nodeId(surface), { mod: surface.mod, view: surface.view }]));
  let changed = false;
  const clean = node => {
    if (!node.children) return node;
    const children = node.children.filter(child => {
      const owner = owners.get(child.id);
      return !owner || owner.mod !== child.content?.mod || owner.view !== child.content?.props?.view || retained.has(child.id);
    }).map(clean);
    if (children.length !== node.children.length) changed = true;
    return copyChildren(node, children);
  };
  let next = clean(root);
  for (const surface of enabled) {
    const id = nodeId(surface), existing = find(next, id);
    if (existing) {
      const owner = owners.get(id);
      if (owner?.mod !== surface.mod || owner?.view !== surface.view || existing.content?.mod !== surface.mod || existing.content?.props?.view !== surface.view)
        throw new Error(`Extension surface layout ID is already in use: ${id}`);
      // A reading mounted at an older width takes the current one.
      if (surface.location === 'status.right' && existing.size?.px !== READING_PX) {
        next = update(next, id, node => ({ ...node, size: { px: READING_PX } }));
        changed = true;
      }
      continue;
    }
    const mount = block(surface, shown);
    const addAt = (node, target, transform) => {
      if (node.id === target) {
        const result = transform(node, mount);
        if (result !== node) changed = true;
        return result;
      }
      return node.children ? copyChildren(node, node.children.map(child => addAt(child, target, transform))) : node;
    };
    if (surface.location === 'sidebar.bottom') {
      // Mounted above the history row, which is always the last row of the sidebar (design.md, Sidebar).
      next = addAt(next, 'sidebar', (node, item) => {
        const at = (node.children || []).findIndex(child => child.id === 'sidebar-history');
        return at < 0 ? node : copyChildren(node, [...node.children.slice(0, at), item, ...node.children.slice(at)]);
      });
    } else if (surface.location === 'status.right') {
      // Mounted in the status row, before the tools block: the surface sits between the status and the action icons.
      next = addAt(next, 'status-content', (node, item) => {
        const at = (node.children || []).findIndex(child => child.id === 'status-tools');
        return at < 0 ? node : copyChildren(node, [...node.children.slice(0, at), item, ...node.children.slice(at)]);
      });
    } else if (surface.location === 'dock.right') {
      if (find(next, 'workspace-row')) next = addAt(next, 'workspace-row', (node, item) => copyChildren(node, [...(node.children || []), item]));
    }
  }
  // A status.right reading is hidden while its provider reports it empty; the status row closes up around it.
  for (const surface of enabled.filter(item => item.location === 'status.right')) {
    const id = nodeId(surface), hidden = empty.has(id), node = find(next, id);
    if (node && Boolean(node.hidden) !== hidden) {
      next = update(next, id, item => ({ ...item, hidden }));
      changed = true;
    }
  }
  if (status) {
    const size = { px: statusToolsWidth(status) };
    next = update(next, 'status-tools', node => {
      if (JSON.stringify(node.size) === JSON.stringify(size)) return node;
      changed = true;
      return { ...node, size };
    });
  }
  return changed ? next : null;
}

export const extensionSurfaceNodeId = nodeId;
