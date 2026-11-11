// Shared: edit mods/devkits/components/task-source-model.js, then npm run sync:shared.
export const filterTasks = (tasks, query) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter(task => words.every(word => [task.name, task.section, task.assignee, task.parent]
    .filter(Boolean).join(' ').toLowerCase().includes(word)));
};

// The import boundary contains domain data only, never connection or UI state.
export function sourceTaskSnapshot(source, task, server = '') {
  if (!source?.key || task?.gid == null || String(task.gid) === '') throw new Error('Select a source task to import.');
  const pick = (record, keys) => Object.fromEntries(keys.filter(key => record[key] != null)
    .map(key => [key, String(record[key])]));
  const fieldValue = value => value == null || ['string', 'number', 'boolean'].includes(typeof value) ? value
    : Array.isArray(value) ? value.map(fieldValue) : pick(value, ['gid', 'name', 'color', 'start', 'end', 'date', 'date_time']);
  const fields = Object.fromEntries(['section', 'assignee', 'assigneeGid', 'due', 'subtasks', 'completed', 'priority', 'severity',
    'category', 'resolution', 'reproducibility', 'reporter', 'viewStatus', 'projectName', 'createdAt', 'updatedAt', 'noteCount', 'attachmentCount', 'tags',
    'statusName', 'statusId', 'priorityId', 'assigneeLogin']
    .filter(key => task[key] != null).map(key => [key, fieldValue(task[key])]));
  return {
    source: source.key, gid: String(task.gid), name: String(task.name || 'Untitled task'),
    notes: String(task.notes || ''), url: String(task.url || ''),
    parent: task.parent && typeof task.parent === 'object' ? pick(task.parent, ['gid', 'name', 'url']) : null,
    comments: (Array.isArray(task.comments) ? task.comments : []).map(comment =>
      pick(comment, ['gid', 'author', 'authorGid', 'authorLogin', 'text', 'at'])),
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(Array.isArray(task.customFields) ? { customFields: task.customFields.map(field => ({
      ...pick(field, ['gid', 'name', 'type', 'displayValue']), value: fieldValue(field.value),
    })) } : {}),
    ...(source.server ? { server: source.normalizeUrl(task.server || server) } : {}),
  };
}

export function relativeTime(at, now = Date.now()) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
  const date = new Date(time), year = new Date(now).getFullYear();
  return `${months[date.getMonth()]} ${date.getDate()}${date.getFullYear() === year ? '' : `, ${date.getFullYear()}`}`;
}

// Bounds and positions are in zoomed pixels; the list and the preview each keep at least 320px.
export const previewWidthAt = (bounds, x, zoom) =>
  Math.round(Math.max(320, Math.min(bounds.width / zoom - 320, (bounds.x + bounds.width - x) / zoom)));
// Asana sections are free text; infer a status for task properties.
export const statusKind = section => /done|complete|closed|shipped|released|resolved/i.test(section || '') ? 'done'
  : /progress|doing|review|testing|qa|active|started|wip/i.test(section || '') ? 'started'
    : /backlog|later|icebox|someday|idea|triage/i.test(section || '') ? 'backlog' : 'todo';
// Linear gives each person a steady color; white initials stay readable on all of these in both themes.
const avatarColors = ['#e5484d', '#f76b15', '#c27c0e', '#30a46c', '#12a594', '#0090ff', '#6e56cf', '#d6409f'];
export const avatarColor = key => avatarColors[[...(key || '')].reduce((hash, char) => (hash * 31 + char.codePointAt(0)) >>> 0, 0) % avatarColors.length];
export const initials = name => name.split(/\s+/).filter(Boolean).map(word => [...word][0]).join('').slice(0, 2).toUpperCase();
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Asana due dates are calendar days; compare them with today's local date.
export function dueLabel(due, now = new Date()) {
  if (!due) return { text: '', overdue: false };
  const [year, month, day] = due.split('-').map(Number);
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return { text: `${months[month - 1]} ${day}${year === now.getFullYear() ? '' : `, ${year}`}`, overdue: due < today };
}


export const sourcePathKey = folder => (folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
