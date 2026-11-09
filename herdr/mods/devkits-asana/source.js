import { readAsanaToken, saveAsanaToken } from './connection.js';
import { searchProjects, projectTasksPage, projectWorkspace, myProjectTasks, openSubtasks, taskDetails, taskComments, projectFields } from './api.js';
export const asanaSource = {
  key: 'asana', name: 'Asana',
  tokenHelp: 'No token is saved. Paste a personal access token from the Asana developer console to connect.',
  readConnection: async () => ({ token: await readAsanaToken() }),
  saveConnection: connection => saveAsanaToken(connection.token),
  searchProjects, projectTasksPage, projectWorkspace, myProjectTasks, openSubtasks, taskDetails, taskComments, projectFields,
  fields: [
    { id: 'section', name: 'Section', width: 150, detail: true },
    { id: 'assignee', name: 'Assignee', width: 120, list: true, card: true, detail: true },
    { id: 'due', name: 'Due date', width: 120, list: true, card: true, detail: true },
    { id: 'subtasks', name: 'Subtasks', width: 85 },
  ],
};
