import { folderKey, threadTitle } from './model.js';

export const boardStatuses = [
  { key: 'todo', label: 'Todo', icon: 'circle', color: '#96969f' },
  { key: 'doing', label: 'Doing', icon: 'circle-half', color: '#e5b454' },
  { key: 'waiting', label: 'Needs your input', icon: 'clock', color: '#b39af5' },
  { key: 'done', label: 'Done', icon: 'circle-check', color: '#6b80ef' },
  { key: 'fail', label: 'Fail', icon: 'circle-alert', color: '#e57878' },
];
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

// Core increments turn whenever an agent leaves working. Its unread done becomes idle
// after viewing; the turn and our observed history keep that finished thread in Done.
export function taskStatus(record = {}, agents = [], hasThread = false) {
  if (agents.some(agent => agent.status === 'blocked' || agent.needsInput)) return 'waiting';
  const noInput = record.source === 'thread' && agents.length > 0
    && agents.every(agent => agent.inputTracked && agent.hasInput !== true)
    && (agents.some(agent => agent.hasInput === false) || record.hasInput !== true);
  if (noInput) return record.manual && ['todo', 'done', 'fail'].includes(record.status) ? record.status : 'todo';
  const working = agents.some(a => a.status === 'working');
  if (working) return 'doing';
  if (record.manual && ['todo', 'done', 'fail'].includes(record.status)) return record.status;
  if (agents.some(a => a.status === 'done')) return 'done';
  if (agents.some(a => a.status === 'idle'))
    return record.seenWorking || record.status === 'done' || agents.some(a => a.turn > 0) ? 'done' : 'todo';
  if (['doing', 'waiting'].includes(record.status)) return record.seenWorking ? 'done' : 'todo';
  return record.status || 'todo';
}

export function agentsWithTurns(agents, terminals = []) {
  const turns = new Map(terminals.map(terminal => [terminal.address, terminal.turn]));
  return agents.map(agent => ({ ...agent, turn: turns.get(agent.address) ?? agent.turn ?? 0 }));
}

export function reconcileBoardRecords(records, tasks) {
  const next = { ...records };
  for (const task of tasks) {
    if (!task.agents.length) continue;
    const previous = records[task.gid] || {};
    const hasInput = task.agents.some(agent => agent.hasInput === true) ? true
      : task.agents.every(agent => agent.inputTracked) ? (task.agents.some(agent => agent.hasInput === false) ? false : previous.hasInput ?? false) : previous.hasInput;
    const manual = Boolean(previous.manual && ['todo', 'done', 'fail'].includes(previous.status)
      && !task.agents.some(agent => ['working', 'blocked'].includes(agent.status) || agent.needsInput));
    next[task.gid] = { ...previous, gid: task.gid, name: task.name,
      source: task.source || 'asana', threadId: task.threadId || null,
      status: task.status, manual,
      ...(hasInput !== undefined ? { hasInput } : {}),
      seenWorking: hasInput === false ? false : Boolean(previous.seenWorking || task.agents.some(agent => agent.status === 'working' || agent.turn > 0)) };
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
  return [...tasks.values()].map(task => {
    const tabs = threads.filter(thread => task.threadId === thread.id || (links[thread.id]?.gid === task.gid
      && folderKey(links[thread.id]?.folder) === folderKey(project.folder)));
    const live = agents.filter(agent => tabs.some(tab => tab.id === agent.tab));
    return { ...task, tabs, agents: live, status: taskStatus({ ...records[task.gid], source: task.source }, live, tabs.length > 0) };
  // A closed empty launcher is not a durable task. Keep explicit archives and
  // real task history, and never hide an empty thread while its native tab exists.
  }).filter(task => task.source !== 'thread' || task.hasInput !== false || task.tabs.length > 0 || task.archived);
}

// Every task control uses this policy, including event-time checks. Runtime activity
// wins over manual metadata; assigning a label never grants permission to act on a busy agent.
export function taskActions(task) {
  const archived = Boolean(task?.archived);
  const active = Boolean(task && (['doing', 'waiting'].includes(task.status)
    || task.agents?.some(agent => ['working', 'blocked'].includes(agent.status) || agent.needsInput)));
  const todo = task?.status === 'todo' && !archived && !active;
  return {
    canStart: Boolean(todo && !task.tabs?.length),
    canEdit: Boolean(todo),
    canSetStatus: Boolean(task && !archived && !active),
    canArchive: Boolean(task && !archived && !active && ['todo', 'done', 'fail'].includes(task.status)),
    canRestore: archived,
    canDelete: Boolean(task?.source === 'local' && !active && ['todo', 'done', 'fail'].includes(task.status)),
  };
}
export const canStartTask = task => taskActions(task).canStart;
export const taskManualStatusOptions = t => boardStatusOptions(t).filter(option => ['todo', 'done', 'fail'].includes(option.key));
