import { shared, setShared, terminals } from 'herdr';
import { folderKey } from './model.js';
import { withTaskInputEvidence } from './agent-task-evidence.js';
import { boardKey, boardTasks, taskStatus, threadTaskId, agentsWithTurns, reconcileBoardRecords, taskActions } from './agent-board-model.js';

export const boardRecords = project => shared('devkits.agent-board')?.[boardKey(project)] || {};
export function rememberBoardTask(project, task, change = {}) {
  const key = boardKey(project), all = shared('devkits.agent-board') || {};
  const records = all[key] || {};
  setShared('devkits.agent-board', { ...all, [key]: { ...records,
    [task.gid]: { ...records[task.gid], gid: task.gid, name: task.name, source: task.source || 'asana', threadId: task.threadId || null, notes: task.notes || records[task.gid]?.notes || '', parent: task.parent?.name || task.parent || null, ...change } } });
}
export function projectBoardTasks(project, agents = []) {
  const records = boardRecords(project);
  const tasks = boardTasks(project, [], records, shared('devkits.thread-tasks') || {}, project.tabs || [], withTaskInputEvidence(agentsWithTurns(agents, terminals()), terminals()));
  const next = reconcileBoardRecords(records, tasks);
  if (JSON.stringify(next) !== JSON.stringify(records))
    setShared('devkits.agent-board', { ...(shared('devkits.agent-board') || {}), [boardKey(project)]: next });
  return tasks;
}
export function threadBoardStatus(project, thread) {
  const task = shared('devkits.thread-tasks')?.[thread.tab.id];
  const record = boardRecords(project)[task?.gid || threadTaskId(thread.tab.id)];
  if (!task && !thread.agents.length && !record) return null;
  return taskStatus({ ...record, source: record?.source || (task ? task.source || 'asana' : 'thread') }, withTaskInputEvidence(agentsWithTurns(thread.agents, terminals()), terminals()), true);
}


export function createLocalTask(project, name, notes = '', options = {}) {
  const title = name.trim();
  if (!title) return null;
  const task = { gid: `local:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`, name: title,
    notes: notes.trim(), source: 'local', status: 'todo' };
  rememberBoardTask(project, task, { status: 'todo', manual: false, ...options });
  return task;
}

export function setTaskArchived(project, task, archived, archiveId = null) {
  rememberBoardTask(project, task, { archived, status: boardRecords(project)[task.gid]?.status || task.status || 'todo', ...(archiveId ? { archiveId } : {}) });
}

// Delete only local task metadata. Native conversations and their archive entries stay resumable.
export function deleteLocalTask(project, gid, agents = []) {
  const task = projectBoardTasks(project, agents).find(task => task.gid === gid);
  if (!taskActions(task).canDelete) return false;
  const matches = link => link?.gid === gid && folderKey(link.folder) === folderKey(project.folder);
  if ((shared('devkits.pending-profiles') || []).some(entry => matches(entry.task) && Date.now() - entry.at < 60000)) return false;
  const all = shared('devkits.agent-board') || {}, records = { ...boardRecords(project) };
  delete records[gid];
  setShared('devkits.agent-board', { ...all, [boardKey(project)]: records });
  const links = shared('devkits.thread-tasks') || {};
  if (Object.values(links).some(matches))
    setShared('devkits.thread-tasks', Object.fromEntries(Object.entries(links).filter(([_tab, link]) => !matches(link))));
  const archived = shared('devkits.archived-threads') || [];
  const attached = entry => folderKey(entry.folder) === folderKey(project.folder) && (entry.task?.gid === gid || entry.boardTask?.gid === gid);
  if (archived.some(attached))
    setShared('devkits.archived-threads', archived.map(entry => attached(entry) ? { ...entry, task: null, boardTask: null } : entry));
  return true;
}
export function threadBoardTask(project, thread) {
  const link = shared('devkits.thread-tasks')?.[thread.tab.id];
  const gid = link?.gid || threadTaskId(thread.tab.id);
  return { ...boardRecords(project)[gid], status: threadBoardStatus(project, thread) || 'todo', gid, name: link?.name || thread.title,
    source: link?.source || (link ? 'asana' : 'thread'), threadId: link ? null : thread.tab.id };
}
export const threadTaskArchived = (project, thread) => Boolean(threadBoardTask(project, thread).archived);

// Finishing a run never hides an open conversation. Only explicit archive removes it.
export const threadVisibleInSidebar = (project, thread) => !threadTaskArchived(project, thread);
