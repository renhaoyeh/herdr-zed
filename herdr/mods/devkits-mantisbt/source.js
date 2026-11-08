import { readMantisConnection, saveMantisConnection } from './connection.js';
import { normalizeUrl, searchProjects, projectTasksPage, myProjectTasks, openSubtasks, taskDetails, taskComments, validateConnection } from './api.js';
export const mantisSource = {
  key: 'mantisbt', name: 'MantisBT', server: true, normalizeUrl,
  tokenHelp: 'Paste an API token from MantisBT → My Account → API Tokens to connect.',
  readConnection: readMantisConnection, saveConnection: saveMantisConnection, validateConnection,
  searchProjects, projectTasksPage, projectWorkspace: async (_connection, project) => project,
  myProjectTasks, openSubtasks, taskDetails, taskComments,
};
