const PREFIX = 'zed-extension-surface-';
const nodeId = surface => surface.location === 'dock.right' ? surface.id : `${PREFIX}${surface.mod}-${surface.id}`;
// Sidebar and dock surfaces start hidden the first time they mount; status.right surfaces start visible.
const block = surface => ({ id: nodeId(surface), type: 'block', hidden: surface.location !== 'status.right',
  ...(surface.location === 'dock.right' ? { size: { px: 380 }, min: 300, max: 900 } : {}),
  ...(surface.location === 'sidebar.bottom' ? { size: { px: 260 }, min: 96, max: 420 } : {}),
  ...(surface.location === 'status.right' ? { size: { px: 220 } } : {}),
  content: { mod: surface.mod, props: { view: surface.view } } });
const find = (node, id) => node?.id === id ? node : (node?.children || []).map(child => find(child, id)).find(Boolean) || null;
const copyChildren = (node, children) => JSON.stringify(node.children || []) === JSON.stringify(children) ? node : { ...node, children };
const update = (node, id, change) => node.id === id ? change(node)
  : node.children ? copyChildren(node, node.children.map(child => update(child, id, change))) : node;

// The status row is [status (context), status.right surfaces (live readings)..., status-tools]. Herdr sizes blocks only
// in px or weight, so status-tools is sized to its content (design.md, Status bar and Separators): icon buttons (28px
// each, ToolbarButton), 8px gaps between items, and a 1px divider before each group after the first: readings,
// extension icons, dock toggles, Changes and Files. ExtensionSlot shows at most STATUS_ACTION_LIMIT icons plus one
// overflow button. `readings` counts the visible status.right surfaces the readings divider follows.
export const STATUS_ACTION_LIMIT = 4;
export const ICON_PX = 28, GAP_PX = 8, DIVIDER_PX = 1, PAD_PX = 4;
export function statusToolsWidth({ actions = 0, dock = 0, readings = 0 } = {}) {
  const actionButtons = actions > 0 ? Math.min(actions, STATUS_ACTION_LIMIT) + (actions > STATUS_ACTION_LIMIT ? 1 : 0) : 0;
  const parts = [];
  if (readings > 0) parts.push(DIVIDER_PX);
  if (actionButtons > 0) parts.push(actionButtons * ICON_PX);
  if (actionButtons > 0 && dock > 0) parts.push(DIVIDER_PX);
  if (dock > 0) parts.push(dock * ICON_PX);
  if (actionButtons > 0 || dock > 0) parts.push(DIVIDER_PX);
  parts.push(2 * ICON_PX); // Changes and Files
  return parts.reduce((sum, part) => sum + part, 0) + (parts.length - 1) * GAP_PX + PAD_PX;
}

// Native blocks keep provider contexts and subscriptions owned by their mounted view lifecycle.
// `status` (optional) = { actions, dock }: the counts status-tools is sized for.
export function extensionSurfaceLayout(root, packages, disabled = [], previous = [], status = null) {
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
      continue;
    }
    const mount = block(surface);
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
