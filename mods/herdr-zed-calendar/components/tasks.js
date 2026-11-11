// Shared: edit components/tasks.js, then npm run sync:shared.
import { shared } from 'herdr';
import { openWorkspacePanel } from './workspace-overlay.js';
import { taskProjectKey, taskIndex } from './tasks-model.js';
import { threadTitle, configuredAgents } from './session-model.js';
export { boardStatuses } from './tasks-model.js';
let renderSnapshot = null;
export const tasksSnapshot = () => renderSnapshot || shared('herdr-zed.tasks.snapshot') || { projects: {} };
// Native shared reads deserialize the full projection. Reuse it for one synchronous
// render, then release it so callbacks and later frames always see current state.
export function withTaskSnapshot(render) {
  // A native execution-budget interruption can leave script state behind. Never
  // seed a new frame from the previous frame's retained snapshot.
  renderSnapshot = shared('herdr-zed.tasks.snapshot') || { projects: {} };
  try { return render(); } finally { renderSnapshot = null; }
}
const projectSnapshot = project => tasksSnapshot().projects[taskProjectKey(project)] || {};
export const listTasks = () => taskIndex(tasksSnapshot());
export const projectBoardTasks = project => projectSnapshot(project).tasks || [];
export const boardRecords = project => projectSnapshot(project).records || {};
export function taskLinkForTab(tab, project) {
  const projects = project ? [projectSnapshot(project)] : Object.values(tasksSnapshot().projects);
  return projects.find(value => value.threads?.[tab]?.link)?.threads[tab].link || null;
}
export const threadBoardStatus = (project, thread) => projectSnapshot(project).threads?.[thread.tab.id]?.status ?? null;
export const threadBoardTask = (project, thread) => projectSnapshot(project).threads?.[thread.tab.id]?.task || {
  gid: `thread:${thread.tab.id}`, name: thread.title, source: 'thread', status: 'todo', threadId: thread.tab.id,
};
export const threadTaskArchived = (project, thread) => Boolean(threadBoardTask(project, thread).archived);
export const threadVisibleInSidebar = (project, thread) => !threadTaskArchived(project, thread);
export const taskActions = task => task?.policy || { canStart: false, canEdit: false, canSetStatus: false, canArchive: false, canRestore: false, canDelete: false };
export function sessionThreadTitle(tab, agent, project) {
  const cached = project && projectSnapshot(project).threads?.[tab.id]?.name;
  if (cached) return cached;
  const launchers = configuredAgents(shared('herdr-zed.agent-cache')?.[JSON.stringify(project?.machine || null)] || [], shared('herdr-zed.agent-configs') || []);
  const launcher = launchers.find(item => item.key === shared('herdr-zed.thread-profiles')?.[tab.id]) || launchers.find(item => item.name === tab.name);
  return threadTitle(tab, agent, project, { launcherName: launcher?.name });
}
// Opens the Tasks board popup for a project context ({ id, folder, name, machine }), optionally focusing one task.
export const openTaskBoard = (context, gid = null) => openWorkspacePanel({ mod: 'herdr-zed-tasks', props: { view: 'board', context, focus: gid } });
