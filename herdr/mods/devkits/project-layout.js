import { layout, run, shared, setShared } from 'herdr';

const STORAGE = 'devkits.project-layouts';
const WIDTHS = ['devkits.side-panel-width', 'devkits.asana-preview-width'];
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
  for (const id of ['editor', 'simulator']) {
    const node = layoutNode(layout(), id);
    if (node) hidden[id] = Boolean(node.hidden);
  }
  setShared(MAXIMIZED, { key: keyFor(project), hidden });
  for (const id of Object.keys(hidden)) run('layout.hide', { id });
}
// Tasks temporarily owns the workspace without changing its underlying panel layout.
const TASK_LAYOUT = 'devkits.board-layout';
export const taskMode = () => shared('devkits.tasks-open') ?? Boolean(shared('devkits.board-project'));
export function enforceTaskBoard() {
  for (const id of ['workspace-view', 'simulator', 'editor']) {
    const node = layoutNode(layout(), id), hidden = id !== 'editor';
    if (node && Boolean(node.hidden) !== hidden) run(hidden ? 'layout.hide' : 'layout.show', { id });
  }
}
export function openTaskBoard(project) {
  const previous = shared(TASK_LAYOUT);
  if (shared(TASK_LAYOUT)?.project !== project.id) {
    const hidden = {};
    for (const id of ['workspace-view', 'simulator', 'editor']) {
      const node = layoutNode(layout(), id);
      if (node) hidden[id] = Boolean(node.hidden);
    }
    if (taskMode()) {
      // The cover is already up: read the destination's normal visibility without
      // ever applying it to the screen during a Tasks-to-Tasks switch.
      const saved = shared(STORAGE)?.[keyFor(project)];
      if (hidden.editor !== undefined) hidden.editor = Boolean(saved?.editor?.hidden);
      if (hidden.simulator !== undefined) hidden.simulator = saved?.simulator?.hidden ?? true;
      if (hidden['workspace-view'] !== undefined) hidden['workspace-view'] = !shared('devkits.conversation-visible')?.[keyFor(project)];
    }
    setShared(TASK_LAYOUT, { project: project.id, hidden });
  }
  if (shared('devkits.tasks-open') !== true) setShared('devkits.tasks-open', true);
  if (shared('devkits.board-project') !== project.id) setShared('devkits.board-project', project.id);
  enforceTaskBoard();
}
export function closeTaskBoard(keepMode = false) {
  if (keepMode) return; // Project selection must not reveal or resize the workspace.
  const previous = shared(TASK_LAYOUT);
  setShared('devkits.tasks-open', Boolean(keepMode));
  setShared('devkits.board-project', null);
  if (!previous) return;
  setShared(TASK_LAYOUT, null);
  for (const [id, hidden] of Object.entries(previous.hidden))
    if (layoutNode(layout(), id)) run(hidden ? 'layout.hide' : 'layout.show', { id });
}

// Native layout weights round through f32; compare their values rather than JSON decimals.
const restored = (actual, expected) => ['editor', 'simulator', 'workspace-view'].every(id => {
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
    if (taskMode()) {
      this.tasks = true;
      this.key = key;
      this.restoring = null;
      if (project) openTaskBoard(project);
      return;
    }
    // Restore the destination layout once, only when leaving the global Tasks mode.
    if (this.tasks) { this.tasks = false; this.key = null; }
    if (this.key !== key) {
      this.key = key;
      if (!key) return;
      const saved = shared(STORAGE)?.[key];
      // Every project without saved state starts with Files open and Simulator closed, including on startup.
      this.restore(saved || {
        editor: { hidden: false, active: 'files', size: { weight: 1.6 } },
        simulator: { hidden: true, size: { px: 380 } },
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
    const maximized = shared(MAXIMIZED), board = shared(TASK_LAYOUT);
    for (const id of ['editor', 'simulator', 'workspace-view']) {
      const node = layoutNode(root, id);
      if (node) result[id] = { ...(id !== 'workspace-view' ? { hidden: board?.hidden[id] ?? maximized?.hidden[id] ?? Boolean(node.hidden) } : {}),
        ...(id === 'editor' ? { active: shared('devkits.editor-kind') || node.active || 'files' } : {}), size: node.size };
    }
    result.dock = shared('devkits.right-panel') ?? null;
    result.widths = WIDTHS.map(name => shared(name) ?? null);
    return result;
  }

  restore(saved) {
    maximizeConversation(null, false);
    const root = layout(), target = {};
    for (const id of ['editor', 'simulator', 'workspace-view']) {
      const node = layoutNode(root, id);
      if (!node) continue;
      const state = id === 'editor' ? { ...(saved.editor || { size: node.size }), hidden: false, active: saved.editor?.active || 'files' }
        : saved[id] || (id === 'workspace-view' ? { size: { weight: 1 } } : { hidden: node.hidden, size: node.size });
      target[id] = state;
      if (state.size) run('layout.resize', { id, ...state.size });
      if (id === 'editor') setShared('devkits.editor-kind', state.active || 'files');
      if (id !== 'workspace-view') run(state.hidden ? 'layout.hide' : 'layout.show', { id });
    }
    target.dock = saved.dock !== undefined ? saved.dock : saved.editor?.hidden ? null : saved.editor?.active || 'files';
    setShared('devkits.right-panel', target.dock);
    target.widths = saved.widths || [280, null];
    this.restoring = target;
    WIDTHS.forEach((name, index) => { if ((shared(name) ?? null) !== target.widths[index]) setShared(name, target.widths[index]); });
  }
}
