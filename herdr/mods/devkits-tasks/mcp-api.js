// Runs inside the Tasks owner; callers never write shared.json themselves.
export function tasksMcpCall(runtime, name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  const snapshot = runtime.snapshot();
  const projects = Object.entries(snapshot.projects).map(([key, value]) => ({ key, ...value.project }));
  if (name === 'list_projects') return { projects };
  if (name === 'report_task') {
    const task = runtime.reportTask(null, args);
    return { task: { gid: task.gid, status: task.status, run: task.execution.id, message: task.execution.summary } };
  }
  const project = projects.find(project => project.key === args.project);
  if (!project) throw new Error('Unknown project. Use list_projects and pass its key.');
  if (name === 'list_tasks') return { tasks: snapshot.projects[project.key].tasks };
  if (name !== 'create_task') throw new Error('Unknown tool.');
  for (const key of Object.keys(args)) if (!['project', 'name', 'notes', 'priority', 'parentId'].includes(key)) throw new Error(`Unknown field: ${key}`);
  if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 1000) throw new Error('name must contain 1–1000 characters.');
  if (args.notes !== undefined && (typeof args.notes !== 'string' || args.notes.length > 20000)) throw new Error('notes must be a string of at most 20000 characters.');
  if (args.parentId !== undefined && (typeof args.parentId !== 'string' || !args.parentId)) throw new Error('parentId must be a nonempty task gid.');
  if (args.priority !== undefined && !['none', 'low', 'medium', 'high', 'urgent'].includes(args.priority)) throw new Error('Invalid priority.');
  return { task: runtime.createTask(project, args) };
}
