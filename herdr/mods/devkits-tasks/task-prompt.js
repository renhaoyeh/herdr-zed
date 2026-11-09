const noteLimit = 4000;
const clip = text => text.length > noteLimit ? `${text.slice(0, noteLimit)}…` : text;
const commentLimit = 5, commentLength = 500;

// The prompt carries the latest comments, which often hold the decisions the description lacks.
export function taskPrompt(task, reporting = null) {
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
    reporting && `Herdr task progress reporting:\nRead the local reporting manual first: node ${JSON.stringify(reporting.cli)} --skill\nFor this task use:\nnode ${JSON.stringify(reporting.cli)} report --run ${JSON.stringify(reporting.run)} --status doing --message "Starting work"\nReport waiting when you need a user answer, doing after the answer, and done or fail with the final result. Do not treat an intermediate reply as completion. Keep this run ID unchanged.`]
    .filter(Boolean).join('\n\n');
}
