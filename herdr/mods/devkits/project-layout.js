import { layout, run, shared, setShared } from 'herdr';

const STORAGE = 'devkits.project-layouts';
const WIDTHS = ['devkits.side-panel-width', 'devkits.asana-preview-width'];
export const layoutNode = (node, id) => node?.id === id ? node
  : (node?.children ?? []).map(child => layoutNode(child, id)).find(Boolean) ?? null;
const keyFor = project => project ? JSON.stringify([project.machine || '',
  (project.folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || project.id]) : null;
// Native layout weights round through f32; compare their values rather than JSON decimals.
const restored = (actual, expected) => ['editor', 'simulator'].every(id => {
  const a = actual[id], b = expected[id];
  return !a && !b || Boolean(a && b && a.hidden === b.hidden && a.active === b.active
    && ['px', 'weight'].every(unit => a.size?.[unit] === b.size?.[unit]
      || Math.abs(a.size?.[unit] - b.size?.[unit]) < 0.001));
}) && JSON.stringify(actual.widths) === JSON.stringify(expected.widths);

// Only the sidebar owns this controller. Observe layout changes, including native divider drags,
// while retaining the outgoing snapshot when the selected project changes.
export class ProjectLayout {
  sync(project) {
    const key = keyFor(project);
    if (this.key !== key) {
      this.key = key;
      if (!key) return;
      const saved = shared(STORAGE)?.[key];
      // Every project without saved state starts with Files open and Simulator closed, including on startup.
      this.restore(saved || {
        editor: { hidden: false, active: 'files', size: { weight: 1.6 } },
        simulator: { hidden: true, size: { px: 380 } }, widths: [280, null],
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
    for (const id of ['editor', 'simulator']) {
      const node = layoutNode(root, id);
      if (node) result[id] = { hidden: Boolean(node.hidden), ...(id === 'editor' ? { active: node.active } : {}), size: node.size };
    }
    result.widths = WIDTHS.map(name => shared(name) ?? null);
    return result;
  }

  restore(saved) {
    const root = layout(), target = {};
    for (const id of ['editor', 'simulator']) {
      const node = layoutNode(root, id), state = saved[id];
      if (!node || !state) continue;
      target[id] = state;
      if (state.size) run('layout.resize', { id, ...state.size });
      if (id === 'editor' && state.active) run('layout.select', { stack: id, child: state.active });
      run(state.hidden ? 'layout.hide' : 'layout.show', { id });
    }
    target.widths = saved.widths || [280, null];
    this.restoring = target;
    WIDTHS.forEach((name, index) => { if ((shared(name) ?? null) !== target.widths[index]) setShared(name, target.widths[index]); });
  }
}
