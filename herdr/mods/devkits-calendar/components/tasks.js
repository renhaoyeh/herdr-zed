// Shared: edit mods/devkits/components/tasks.js, then npm run sync:shared.
import { shared, setShared, openOverlay } from 'herdr';
import { taskProjectKey, taskIndex } from './tasks-model.js';
import { threadTitle, configuredAgents } from './session-model.js';
export { boardStatuses } from './tasks-model.js';
const copy = value => JSON.parse(JSON.stringify(value));
export const tasksSnapshot = () => shared('devkits.tasks.snapshot') || { projects: {} };
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
  const launchers = configuredAgents(shared('devkits.agent-cache')?.[JSON.stringify(project?.machine || null)] || [], shared('devkits.agent-configs') || []);
  const launcher = launchers.find(item => item.key === shared('devkits.thread-profiles')?.[tab.id]) || launchers.find(item => item.name === tab.name);
  return threadTitle(tab, agent, project, { launcherName: launcher?.name });
}
export function taskRequest(action, options) {
  const request = copy({ id: `${Date.now()}:${Math.random()}`, action, ...options });
  setShared('devkits.tasks.requests', [...(shared('devkits.tasks.requests') || []), request]);
  return request.id;
}
export const requestTaskSource = (project, source) => taskRequest('source', { project, source });
export const requestTaskOpen = (project, gid = null, options = {}) => taskRequest('open', { project, gid, ...options });
export function taskRequestResult(id) {
  const results = shared('devkits.tasks.results') || {}, result = results[id];
  if (!result) return null;
  const next = { ...results }; delete next[id]; setShared('devkits.tasks.results', next); return result;
}
export function cancelTaskRequest(id) {
  const requests = shared('devkits.tasks.requests') || [];
  if (requests.some(request => request.id === id)) setShared('devkits.tasks.requests', requests.filter(request => request.id !== id));
  taskRequestResult(id);
}
export const setTaskArchived = (project, task, archived, archiveId = null) => taskRequest('archive', { project, gid: task.gid, archived, archiveId });
export const requestTaskStart = (agent, target, options = {}) => taskRequest('start', {
  project: { folder: target.folder, machine: target.machine || null }, gid: target.task?.gid, agent, target, options,
});
export const openTaskComposer = (project, task = null, status = 'todo', importTask = null, parent = null) => openOverlay({
  mod: 'devkits-tasks', kind: 'dialog', modal: true, frame: 'none', width: 760, height: 400,
  props: { view: 'task-composer', project, task, status, importTask, parent },
});
export function publishTaskNavigation(event) {
  setShared('devkits.tasks.navigation', [...(shared('devkits.tasks.navigation') || []),
    copy({ ...event, receiver: shared('devkits.tasks.host')?.receiver || 'devkits' })]);
}
export class TaskHost {
  constructor(onNavigate, receiver = 'devkits') { this.onNavigate = onNavigate; this.receiver = receiver; }
  init(cx) {
    setShared('devkits.tasks.host', { receiver: this.receiver }); this.poll(cx);
    cx.timer.every(200, cx => this.poll(cx));
  }
  poll(cx) {
    const events = shared('devkits.tasks.navigation') || [], mine = events.filter(event => event.receiver === this.receiver);
    if (!mine.length) return;
    setShared('devkits.tasks.navigation', events.filter(event => event.receiver !== this.receiver));
    for (const event of mine) this.onNavigate(event, cx);
  }
}
