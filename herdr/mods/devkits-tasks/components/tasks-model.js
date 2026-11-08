// Shared: edit mods/devkits/components/tasks-model.js, then npm run sync:shared.
export const boardStatuses = [
  { key: 'todo', label: 'Todo', icon: 'circle', color: '#96969f' },
  { key: 'doing', label: 'Doing', icon: 'circle-half', color: '#e5b454' },
  { key: 'waiting', label: 'Needs your input', icon: 'clock', color: '#b39af5' },
  { key: 'done', label: 'Done', icon: 'circle-check', color: '#6b80ef' },
  { key: 'fail', label: 'Fail', icon: 'circle-alert', color: '#e57878' },
];
export const taskFolderKey = folder => (folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
export const taskProjectKey = project => JSON.stringify([project.machine || '', taskFolderKey(project.folder)]);
export const taskTokenId = (project, gid) => JSON.stringify(['task', project.machine || '', taskFolderKey(project.folder), gid]);
export function taskTokenRef(id) {
  try {
    const [kind, machine, folder, gid] = JSON.parse(id);
    return kind === 'task' && [machine, folder, gid].every(value => typeof value === 'string') && folder && gid ? { machine, folder, gid } : null;
  } catch { return null; }
}
export function taskIndex(snapshot) {
  return Object.values(snapshot?.projects || {}).flatMap(({ project, tasks }) => project.machine ? [] : tasks.map(task => ({ ...task, project, id: taskTokenId(project, task.gid) })));
}
