import { folderKey, threadTitle } from './components/session-model.js';

import { boardStatuses } from './components/tasks-model.js';
export { boardStatuses };

export const boardPriorities = [
  { key: 'none', label: 'No priority', icon: 'priority-none' },
  { key: 'urgent', label: 'Urgent', icon: 'priority-urgent' },
  { key: 'high', label: 'High', icon: 'priority-high' },
  { key: 'medium', label: 'Medium', icon: 'priority-medium' },
  { key: 'low', label: 'Low', icon: 'priority-low' },
];
export const boardStatusOptions = t => boardStatuses.map(status => ({ key: status.key, label: status.label,
  color: t.foreground, icon: status.icon, iconColor: status.color }));
export const boardPriorityOptions = t => boardPriorities.map(priority => ({ ...priority,
  color: t.foreground, iconColor: priority.key === 'urgent' ? '#e4a45c' : t.muted }));
export const boardKey = project => JSON.stringify([project.machine || '', folderKey(project.folder)]);
export const threadTaskId = tab => `thread:${tab}`;
export const liveVersion = agents => agents.map(a => `${a.address}:${a.status}:${a.seq}`).sort().join('|');

// Progress belongs to the task. Native terminal turns are never completion evidence.
export function taskStatus(record = {}, agents = [], hasThread = false) {
  return record.status === 'fail' ? 'doing' : boardStatuses.some(item => item.key === record.status) ? record.status : 'todo';
}

export function taskAttention(record, agents = []) {
  if (record.archived) return null;
  if (agents.some(agent => agent.status === 'blocked' || agent.needsInput))
    return { kind: 'native', message: 'Reply or approve in the agent conversation.' };
  if (record.execution?.status === 'fail' || record.status === 'fail') return { kind: 'error', message: record.execution?.summary || 'The last attempt failed. Open the conversation to continue.' };
  return record.execution?.status === 'waiting' ? { kind: 'question', message: record.execution.summary } : null;
}

export function agentsWithTurns(agents, terminals = []) {
  const turns = new Map(terminals.map(terminal => [terminal.address, terminal.turn]));
  return agents.map(agent => ({ ...agent, turn: turns.get(agent.address) ?? agent.turn ?? 0 }));
}

export function reconcileBoardRecords(records, tasks) {
  const next = { ...records };
  for (const task of tasks) {
    if (!task.agents.length && records[task.gid]) continue;
    const previous = records[task.gid] || {};
    const hasInput = task.hasInput === true || task.agents.some(agent => agent.hasInput === true) ? true
      : !task.execution && task.agents.length > 0 && task.agents.every(agent => agent.inputTracked && agent.hasInput === false) ? false : previous.hasInput;
    next[task.gid] = { ...previous, gid: task.gid, name: task.name,
      source: task.source || 'asana', threadId: task.threadId || null,
      status: task.status, ...(task.agents.find(agent => agent.conversation)?.conversation
        ? { conversation: task.agents.find(agent => agent.conversation).conversation } : {}), ...(hasInput !== undefined ? { hasInput } : {}) };
  }
  return next;
}

// Saved is the inbox. Retain launched/manual cards independently when Saved drops them.
export function boardTasks(project, saved = [], records = {}, links = {}, threads = [], agents = [], titleFor = threadTitle) {
  const tasks = new Map(Object.values(records).map(record => [record.gid, { ...record }]));
  for (const task of saved) tasks.set(task.gid, { ...tasks.get(task.gid), ...task });
  for (const [tab, task] of Object.entries(links)) {
    if (folderKey(task.folder) !== folderKey(project.folder)) continue;
    const current = tasks.get(task.gid);
    tasks.set(task.gid, { ...task, ...current });
  }
  for (const thread of threads) {
    if (links[thread.id] || !agents.some(agent => agent.tab === thread.id)) continue;
    const gid = threadTaskId(thread.id), members = agents.filter(agent => agent.tab === thread.id);
    tasks.set(gid, { ...tasks.get(gid), gid, source: 'thread', threadId: thread.id,
      name: titleFor(thread, members.find(agent => agent.focused) || members[0], project) });
  }
  const result = [...tasks.values()].map(task => {
    const tabs = threads.filter(thread => task.threadId === thread.id || (links[thread.id]?.gid === task.gid
      && folderKey(links[thread.id]?.folder) === folderKey(project.folder)));
    const live = agents.filter(agent => tabs.some(tab => tab.id === agent.tab));
    const record = { ...records[task.gid], ...task, source: task.source };
    const execution = task.execution;
    const interrupted = !task.archived && execution && (execution.status === 'stopped'
      || !['done', 'fail'].includes(execution.status) && !live.length && Date.now() - execution.startedAt > 60000);
    return { ...task, tabs, agents: live, status: taskStatus(record, live, tabs.length > 0),
      attention: taskAttention(record, live), interrupted: Boolean(interrupted) };
  // A closed empty launcher is not a durable task. Keep explicit archives and
  // real task history, and never hide an empty thread while its native tab exists.
  }).filter(task => task.source !== 'thread' || task.hasInput !== false || task.tabs.length > 0 || task.archived);
  const byId = new Map(result.map(task => [task.gid, task]));
  return result.map(task => {
    const { parentTask: _snapshot, ...current } = task;
    if (!task.parentId) return current;
    const parent = byId.get(task.parentId);
    return { ...current, parentTask: parent && parent.gid !== task.gid
      ? { gid: parent.gid, name: parent.name, status: parent.status, archived: Boolean(parent.archived) } : null };
  });
}

export const taskChildren = (tasks, gid) => tasks.filter(task => task.parentId === gid && task.gid !== gid);
export const canAddSubtask = task => Boolean(task && !task.archived);

// Every task control uses this policy, including event-time checks. Runtime activity
// wins over manual metadata; assigning a label never grants permission to act on a busy agent.
export function taskActions(task) {
  const archived = Boolean(task?.archived);
  const busy = Boolean(task?.agents?.some(agent => ['working', 'blocked'].includes(agent.status) || agent.needsInput));
  const active = Boolean(task && (busy || task.attention && task.attention.kind !== 'error' || task.execution?.status === 'waiting'
    || task.execution?.status === 'starting' && Date.now() - task.execution.startedAt < 60000));
  const todo = task?.status === 'todo' && !archived && !active;
  return {
    canStart: Boolean(todo && (!task.tabs?.length || task.execution || task.runs?.length)),
    canEdit: Boolean(todo),
    canSetStatus: Boolean(task && !archived && !active),
    canArchive: Boolean(task && !archived),
    canRestore: archived,
    canDelete: Boolean(['local', 'thread'].includes(task?.source) && !active),
    canSchedule: Boolean(task && !archived),
  };
}
export const canStartTask = task => taskActions(task).canStart;
export const taskManualStatusOptions = t => boardStatusOptions(t);
export const taskNeedsArchiveChoice = task => Boolean(task && !task.archived && !taskActions(task).canSetStatus);

export function taskExecutionLabel(task) {
  if (task.agents?.some(agent => agent.status === 'working')) return 'Agent working';
  if (task.attention?.kind === 'native' || task.attention?.kind === 'question') return 'Waiting for you';
  if (task.execution?.status === 'fail' || task.agents?.some(agent => agent.status === 'error')) return 'Attempt failed';
  if (task.execution?.status === 'starting') return 'Starting agent';
  if (task.execution?.status === 'stopped') return 'Agent stopped';
  return null;
}
