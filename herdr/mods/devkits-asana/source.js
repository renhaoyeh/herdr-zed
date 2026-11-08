import { readAsanaToken, saveAsanaToken } from './connection.js';
import { searchProjects, projectTasksPage, projectWorkspace, myProjectTasks, openSubtasks, taskDetails, taskComments } from './api.js';
export const asanaSource = {
  key: 'asana', name: 'Asana',
  tokenHelp: 'No token is saved. Paste a personal access token from the Asana developer console to connect.',
  readConnection: async () => ({ token: await readAsanaToken() }),
  saveConnection: connection => saveAsanaToken(connection.token),
  searchProjects, projectTasksPage, projectWorkspace, myProjectTasks, openSubtasks, taskDetails, taskComments,
};
