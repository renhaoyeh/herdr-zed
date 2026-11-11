import { readMantisConnection, saveMantisConnection } from './connection.js';
import { normalizeUrl, searchProjects, projectTasksPage, myProjectTasks, openSubtasks, taskDetails, taskComments, projectFields } from './source-api.js';
export const mantisSource = {
  key: 'mantisbt', name: 'MantisBT', server: true, normalizeUrl,
  tokenHelp: 'Paste an API token from MantisBT → My Account → API Tokens to connect.',
  readConnection: readMantisConnection, saveConnection: saveMantisConnection,
  searchProjects, projectTasksPage, projectWorkspace: async (_connection, project) => project,
  myProjectTasks, openSubtasks, taskDetails, taskComments, projectFields,
  fields: [
    { id: 'priority', name: 'Priority', width: 90, list: true },
    { id: 'gid', name: 'ID', width: 82, list: true },
    { id: 'noteCount', name: 'Notes', width: 55, list: true },
    { id: 'category', name: 'Category', width: 110, list: true },
    { id: 'severity', name: 'Severity', width: 100, list: true },
    { id: 'section', name: 'Status', width: 150, list: true },
    { id: 'updatedAt', name: 'Updated', width: 135, list: true },
    { id: 'projectName', name: 'Project', width: 150 },
    { id: 'assignee', name: 'Assigned To', width: 140 },
    { id: 'reporter', name: 'Reporter', width: 140 },
    { id: 'due', name: 'Due Date', width: 120 },
    { id: 'resolution', name: 'Resolution', width: 130 },
    { id: 'reproducibility', name: 'Reproducibility', width: 140 },
    { id: 'viewStatus', name: 'View Status', width: 120 },
    { id: 'createdAt', name: 'Submitted', width: 135 },
    { id: 'tags', name: 'Tags', width: 150 },
    { id: 'attachmentCount', name: 'Attachments', width: 100 },
  ].map(field => ({ detail: true, ...field })),
};
