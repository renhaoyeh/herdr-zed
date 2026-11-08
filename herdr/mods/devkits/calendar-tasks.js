import { folderKey } from './model.js';
import { boardKey, boardTasks } from './agent-board-model.js';

export const taskTokenId = (project, gid) => JSON.stringify(['task', project.machine || '', folderKey(project.folder), gid]);

// Read the same task inventory as Tasks without reconciling or writing board state.
export function calendarTasks(projects, records, links, agents, titleFor) {
  return projects.filter(project => !project.machine && project.folder).flatMap(project =>
    boardTasks(project, [], records[boardKey(project)] || {}, links, project.tabs || [], agents, titleFor)
      .map(task => ({ ...task, project, id: taskTokenId(project, task.gid) })));
}

export function taskTokenRef(id) {
  try {
    const [kind, machine, folder, gid] = JSON.parse(id);
    return kind === 'task' && [machine, folder, gid].every(value => typeof value === 'string') && folder && gid
      ? { machine, folder, gid } : null;
  } catch { return null; }
}

// Retain only intact native tokens and shift their UTF-16 offsets when trimming.
export function calendarContent(content) {
  const value = String(content?.text || ''), text = value.trim(), offset = value.length - value.trimStart().length;
  const tokens = (content?.tokens || []).filter(({ range, token }) =>
    Number.isInteger(range?.start) && Number.isInteger(range?.end) && range.start >= offset && range.end <= offset + text.length
    && range.end > range.start && taskTokenRef(token?.id) && value.slice(range.start, range.end) === token.text)
    .map(({ range, token }) => ({ range: { start: range.start - offset, end: range.end - offset }, token: { id: token.id, text: token.text, label: token.label || token.text } }));
  return { text, tokens };
}

// A newly typed/pasted @ opens a searchable picker, even in the middle of text.
// Comparing snapshots avoids assuming an unavailable native caret getter.
export function mentionTrigger(previous, next, tokens = []) {
  let start = 0, end = next.length, oldEnd = previous.length;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  while (end > start && oldEnd > start && next[end - 1] === previous[oldEnd - 1]) { end--; oldEnd--; }
  const inserted = next.slice(start, end), match = /(?:^|\s)@([^@\n]*)$/.exec(inserted);
  if (!match) return null;
  const from = start + match.index + match[0].indexOf('@');
  if (from && !/[\s([{]/.test(next[from - 1])) return null;
  if (tokens.some(({ range }) => range.start < end && range.end > from)) return null;
  return { range: { start: from, end }, query: match[1] };
}
