import { taskTokenId, taskTokenRef, boardStatuses } from './components/tasks-model.js';
export { taskTokenId, taskTokenRef };

export function taskLinkState(link, tasks = [], deleted = {}) {
  const task = tasks.find(task => task.id === link?.id);
  if (task) return { task, label: task.name, state: task.archived ? 'Archived' : task.attention ? 'Action Required' : boardStatuses.find(status => status.key === task.status)?.label || 'Todo' };
  const ref = taskTokenRef(link?.id);
  const removed = ref && deleted[JSON.stringify([ref.machine, ref.folder.replace(/\\/g, '/').replace(/\/+$/, '')])]?.[ref.gid];
  return { label: link?.label || 'Task', state: removed ? 'Deleted task' : 'Unavailable task' };
}

// Due markers are projections of Tasks. They are never saved as Calendar events.
export function calendarEntries(records, tasks = []) {
  const dates = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const date = new Date(value + 'T12:00:00');
    const key = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!Number.isFinite(date.getTime()) || key(date) !== value) return null;
    date.setDate(date.getDate()+1); return key(date);
  };
  return [...records, ...tasks.filter(task => !task.archived && dates(task.dueDate)).map(task => ({
    id: `due:${task.id}`, dueMarker: true, title: `Due · ${task.name}`, notes: '', allDay: true,
    start: task.dueDate, end: dates(task.dueDate), taskLink: { id: task.id, label: task.name },
  }))];
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
