import { layout, run, shared, setShared } from 'herdr';

const STORAGE = 'devkits-zed.project-layouts';
const WIDTHS = ['devkits.side-panel-width'];
export const layoutNode = (node, id) => node?.id === id ? node
  : (node?.children ?? []).map(child => layoutNode(child, id)).find(Boolean) ?? null;
const keyFor = project => project ? JSON.stringify([project.machine || '',
  (project.folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || project.id]) : null;
const MAXIMIZED = 'devkits.conversation-maximized';
export const conversationMaximized = project => Boolean(project && shared(MAXIMIZED)?.key === keyFor(project));
// Keep normal panel visibility separate from the temporary maximized layout.
export function maximizeConversation(project, maximized) {
  const previous = shared(MAXIMIZED);
  if (maximized && (!project || conversationMaximized(project))) return;
  if (!maximized) {
    if (!previous) return;
    setShared(MAXIMIZED, null);
    for (const [id, hidden] of Object.entries(previous.hidden))
      if (layoutNode(layout(), id)) run(hidden ? 'layout.hide' : 'layout.show', { id });
    return;
  }
  const hidden = {};
  for (const id of ['editor']) {
    const node = layoutNode(layout(), id);
    if (node) hidden[id] = Boolean(node.hidden);
  }
  setShared(MAXIMIZED, { key: keyFor(project), hidden });
  for (const id of Object.keys(hidden)) run('layout.hide', { id });
}
// Native layout weights round through f32; compare their values rather than JSON decimals.
const restored = (actual, expected) => ['editor', 'workspace-view'].every(id => {
  const a = actual[id], b = expected[id];
  return !a && !b || Boolean(a && b && a.hidden === b.hidden && a.active === b.active
    && ['px', 'weight'].every(unit => a.size?.[unit] === b.size?.[unit]
      || Math.abs(a.size?.[unit] - b.size?.[unit]) < 0.001));
}) && actual.dock === expected.dock && JSON.stringify(actual.widths) === JSON.stringify(expected.widths);

// Only the sidebar owns this controller. Observe layout changes, including native divider drags,
// while retaining the outgoing snapshot when the selected project changes.
export class ProjectLayout {
  sync(project) {
    const key = keyFor(project);
    if (this.key !== key) {
      this.key = key;
      if (!key) return;
      const saved = shared(STORAGE)?.[key];
      // Every project without saved state starts with Files open, including on startup.
      this.restore(saved || {
        editor: { hidden: false, active: 'files', size: { weight: 1.6 } },
        'workspace-view': { size: { weight: 1 } }, dock: 'files', widths: [280, null],
      });
      // Commands may trigger another render; never save the outgoing layout as the new project's.
      return;
    }
    if (!key) return;
    const snapshot = this.snapshot();
    if (this.restoring) {
      if (!restored(snapshot, this.restoring)) return;
      this.restoring = null;
    }
    const all = shared(STORAGE) || {};
    if (JSON.stringify(all[key]) !== JSON.stringify(snapshot)) setShared(STORAGE, { ...all, [key]: snapshot });
  }

  snapshot() {
    const root = layout(), result = {};
    const maximized = shared(MAXIMIZED);
    for (const id of ['editor', 'workspace-view']) {
      const node = layoutNode(root, id);
      if (node) result[id] = { ...(id !== 'workspace-view' ? { hidden: maximized?.hidden[id] ?? Boolean(node.hidden) } : {}),
        ...(id === 'editor' ? { active: shared('devkits.editor-kind') || node.active || 'files' } : {}), size: node.size };
    }
    result.dock = shared('devkits.right-panel') ?? null;
    result.widths = WIDTHS.map(name => shared(name) ?? null);
    return result;
  }

  restore(saved) {
    maximizeConversation(null, false);
    const root = layout(), target = {};
    for (const id of ['editor', 'workspace-view']) {
      const node = layoutNode(root, id);
      if (!node) continue;
      const state = id === 'editor' ? { ...(saved.editor || { size: node.size }), hidden: false, active: saved.editor?.active || 'files' }
        : saved[id] || (id === 'workspace-view' ? { size: { weight: 1 } } : { hidden: node.hidden, size: node.size });
      target[id] = state;
      if (state.size) run('layout.resize', { id, ...state.size });
      if (id === 'editor') setShared('devkits.editor-kind', state.active || 'files');
      if (id !== 'workspace-view') run(state.hidden ? 'layout.hide' : 'layout.show', { id });
    }
    target.dock = saved.dock !== undefined ? saved.dock : 'files';
    setShared('devkits.right-panel', target.dock);
    target.widths = WIDTHS.map((_name, index) => (saved.widths || [280])[index] ?? null);
    this.restoring = target;
    WIDTHS.forEach((name, index) => { if ((shared(name) ?? null) !== target.widths[index]) setShared(name, target.widths[index]); });
  }
}
