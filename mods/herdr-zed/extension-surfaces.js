const PREFIX = 'zed-extension-surface-';
const nodeId = surface => surface.location === 'dock.right' ? surface.id : `${PREFIX}${surface.mod}-${surface.id}`;
const block = surface => ({ id: nodeId(surface), type: 'block', hidden: surface.location === 'dock.right',
  ...(surface.location === 'dock.right' ? { size: { px: 380 }, min: 300, max: 900 } : {}),
  ...(surface.location === 'sidebar.bottom' ? { size: { px: 260 }, min: 96, max: 420 } : {}),
  ...(surface.location === 'status.right' ? { size: { px: 220 } } : {}),
  content: { mod: surface.mod, props: { view: surface.view } } });
const find = (node, id) => node?.id === id ? node : (node?.children || []).map(child => find(child, id)).find(Boolean) || null;
const copyChildren = (node, children) => JSON.stringify(node.children || []) === JSON.stringify(children) ? node : { ...node, children };

// Native blocks keep provider contexts and subscriptions owned by their mounted view lifecycle.
export function extensionSurfaceLayout(root, packages, disabled = [], previous = []) {
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
      if (find(next, 'sidebar')) next = addAt(next, 'sidebar', (node, item) => copyChildren(node, [...(node.children || []), item]));
    } else if (surface.location === 'status.right') {
      next = addAt(next, 'status-content', (node, item) => {
        if (node.type === 'row' && node.id === 'status-content') return copyChildren(node, [...(node.children || []), item]);
        return { id: 'status-content', type: 'row', size: node.size, children: [
          { ...node, id: 'zed-extension-status-content', size: { weight: 1 } }, item,
        ] };
      });
    } else if (surface.location === 'dock.right') {
      if (find(next, 'workspace-row')) next = addAt(next, 'workspace-row', (node, item) => copyChildren(node, [...(node.children || []), item]));
    }
  }
  // Unwrap the status row after its final owned metric view is removed.
  const unwrap = node => {
    if (node.id === 'status-content' && node.type === 'row') {
      const children = node.children || [];
      if (children.length === 1 && children[0].id === 'zed-extension-status-content' && children[0].content?.mod === 'herdr-zed') {
        changed = true;
        return { ...children[0], id: 'status-content', size: node.size };
      }
      return copyChildren(node, children);
    }
    return node.children ? copyChildren(node, node.children.map(unwrap)) : node;
  };
  next = unwrap(next);
  return changed ? next : null;
}

export const extensionSurfaceNodeId = nodeId;
