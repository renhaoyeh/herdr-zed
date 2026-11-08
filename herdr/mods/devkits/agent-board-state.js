import { shared, setShared, terminals } from 'herdr';
import { folderKey, threadTitle, configuredAgents } from './model.js';
import { withTaskInputEvidence } from './agent-task-evidence.js';
import { boardKey, boardTasks, taskStatus, threadTaskId, agentsWithTurns, reconcileBoardRecords, taskActions } from './agent-board-model.js';

export const boardRecords = project => shared('devkits.agent-board')?.[boardKey(project)] || {};

// Resolve every conversation title against the same saved task and launcher metadata.
export function sessionThreadTitle(tab, agent, project) {
  const launchers = configuredAgents(shared('devkits.agent-cache')?.[JSON.stringify(project?.machine || null)] || [], shared('devkits.agent-configs') || []);
  const launcher = launchers.find(item => item.key === shared('devkits.thread-profiles')?.[tab.id])
    || launchers.find(item => item.name === tab.name);
  const link = shared('devkits.thread-tasks')?.[tab.id];
  const task = link && (!project || folderKey(link.folder) === folderKey(project.folder)) ? link : null;
  return threadTitle(tab, agent, project, { launcherName: launcher?.name,
    taskName: task && (project && boardRecords(project)[task.gid]?.name || task.name) });
}
export function rememberBoardTask(project, task, change = {}) {
  const key = boardKey(project), all = shared('devkits.agent-board') || {};
  const records = all[key] || {};
  setShared('devkits.agent-board', { ...all, [key]: { ...records,
    [task.gid]: { ...records[task.gid], gid: task.gid, name: task.name, source: task.source || 'asana', threadId: task.threadId || null, notes: task.notes || records[task.gid]?.notes || '', parent: task.parent?.name || task.parent || null, ...change } } });
}
export function projectBoardTasks(project, agents = []) {
  const records = boardRecords(project);
  const tasks = boardTasks(project, [], records, shared('devkits.thread-tasks') || {}, project.tabs || [], withTaskInputEvidence(agentsWithTurns(agents, terminals()), terminals()), sessionThreadTitle);
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


export function createLocalTask(project, name, notes = '', options = {}, agents = []) {
  const title = name.trim();
  if (!title) return null;
  const parentId = options.parentId || null;
  if (parentId) {
    const parent = projectBoardTasks(project, agents).find(task => task.gid === parentId);
    if (!parent || parent.archived) throw new Error('The parent task is unavailable or archived.');
  }
  const task = { gid: `local:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`, name: title,
    notes: notes.trim(), source: 'local', status: 'todo', ...(parentId ? { parentId } : {}) };
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
  // Removing a parent keeps every child, its progress and its conversation.
  const detach = value => value?.parentId === gid ? { ...value, parentId: null } : value;
  for (const [id, record] of Object.entries(records)) records[id] = detach(record);
  setShared('devkits.agent-board', { ...all, [boardKey(project)]: records });
  const links = shared('devkits.thread-tasks') || {};
  const nextLinks = Object.fromEntries(Object.entries(links).filter(([_tab, link]) => !matches(link))
    .map(([tab, link]) => [tab, folderKey(link.folder) === folderKey(project.folder) ? detach(link) : link]));
  if (JSON.stringify(nextLinks) !== JSON.stringify(links)) setShared('devkits.thread-tasks', nextLinks);
  const archived = shared('devkits.archived-threads') || [];
  const attached = entry => folderKey(entry.folder) === folderKey(project.folder) && (entry.task?.gid === gid || entry.boardTask?.gid === gid);
  const nextArchived = archived.map(entry => attached(entry) ? { ...entry, task: null, boardTask: null }
    : folderKey(entry.folder) === folderKey(project.folder) ? { ...entry, task: detach(entry.task), boardTask: detach(entry.boardTask) } : entry);
  if (JSON.stringify(nextArchived) !== JSON.stringify(archived)) setShared('devkits.archived-threads', nextArchived);
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
