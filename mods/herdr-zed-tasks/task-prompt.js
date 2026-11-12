const noteLimit = 4000;
const clip = text => text.length > noteLimit ? `${text.slice(0, noteLimit)}…` : text;
const commentLimit = 5, commentLength = 500;

// A task's earlier sessions, oldest first: its finished runs, then the current one.
export const taskAttempts = task => [...(task?.runs || []), ...(task?.execution ? [task.execution] : [])];

// Continue: a task with earlier sessions only names itself. The agent reads its status and earlier results from Tasks
// (list_tasks returns them) and the project's actual state, instead of a copy of old summaries.
export function continuationPrompt(task) {
  if (!taskAttempts(task).length) return null;
  return `This task has earlier sessions (task gid: ${task.gid}). Read its status and their results with the herdr_tasks MCP `
    + 'list_tasks tool, check the project\'s current state (git status and diff), then continue from where it stopped.';
}

// The prompt carries the latest comments, which often hold the decisions the description lacks.
export function taskPrompt(task, reporting = null, instructions = null) {
  const notes = (task.notes || '').trim();
  const source = task.mantisbt || task.asana || task, stories = source.comments || [];
  const name = task.mantisbt || task.source === 'mantisbt' ? 'MantisBT ' : task.asana || !task.source || task.source === 'asana' ? 'Asana ' : '';
  const comments = stories.slice(-commentLimit).map(comment => {
    const text = comment.text.length > commentLength ? `${comment.text.slice(0, commentLength)}…` : comment.text;
    return `- ${comment.author}${comment.at ? ` (${comment.at.slice(0, 10)})` : ''}: ${text.replace(/\s*\n\s*/g, ' ')}`;
  });
  return [`Work on this ${name}task: ${task.name}`, source.url,
    task.parentTask?.name && `Parent task: ${task.parentTask.name}`,
    source.parent && [`It is a subtask of: ${source.parent.name}`, source.parent.url].filter(Boolean).join('\n'),
    notes && `Description:\n${task.source === 'local' ? notes : clip(notes)}`,
    comments.length && `Latest comments${stories.length > comments.length ? ` (${comments.length} of ${stories.length})` : ''}:\n${comments.join('\n')}`,
    task.note?.trim() && `My instructions:\n${task.note.trim()}`,
    // The board shows this part and sends what the person left in it; other callers get the default.
    typeof instructions === 'string' ? instructions.trim() : continuationPrompt(task),
    reporting && `Herdr task attempt: ${reporting.run}\nUse the herdr_tasks MCP report_task tool with run=${JSON.stringify(reporting.run)} for this attempt. Discover the tool's instructions through MCP and follow the reporting policy in the global Agent Guide.`]
    .filter(Boolean).join('\n\n');
}
