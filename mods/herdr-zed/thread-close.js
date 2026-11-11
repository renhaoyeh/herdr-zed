import { spaces, panes, run } from 'herdr';

export const EMPTY_PROJECT_TAB = '__herdr_zed_empty_project__';
export const isProjectPlaceholder = tab => [EMPTY_PROJECT_TAB, '__herdr_zed_default_terminal__'].includes(tab?.name);

// Native Herdr closes the space with its last tab. Keep an empty mod tab so
// closing a thread never doubles as closing a project or starting another shell.
export function closeThreadTab(id) {
  const space = spaces().find(space => space.tabs.some(tab => tab.id === id));
  if (!space) return;
  if (space.tabs.length === 1) run('tab.new', { space: space.id, name: EMPTY_PROJECT_TAB,
    mod: 'herdr-zed', props: { view: 'project-empty' } });
  run('tab.close', { id });
}

export function closeThreadPane(id) {
  const all = panes(), pane = all.find(pane => pane.pane === id);
  if (!pane) return;
  if (all.filter(item => item.tab === pane.tab).length === 1) closeThreadTab(pane.tab);
  else run('pane.close', { pane: id });
}
