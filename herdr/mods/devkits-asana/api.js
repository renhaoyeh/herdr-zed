// Raw, read-only REST endpoints. Preserve API envelopes, values and pagination.
// Callers choose fields and filters; no Tasks UI policy or credential storage here.
import { asanaRequest } from './rest.js';

const id = value => encodeURIComponent(String(value));
const query = options => Object.entries(options).filter(([, value]) => value != null)
  .map(([key, value]) => `${id(key)}=${key === 'opt_fields' ? id(value).replace(/%2C/gi, ',') : id(value)}`).join('&');
const get = (token, path, options, request) => {
  const params = query(options);
  return asanaRequest(token, `${path}${params ? `?${params}` : ''}`, request);
};

export const getUser = (token, user = 'me', options = {}, request = fetch) =>
  get(token, `/users/${id(user)}`, options, request);
export const getProject = (token, project, options = {}, request = fetch) =>
  get(token, `/projects/${id(project)}`, options, request);
export const searchWorkspaceProjects = (token, workspace, text, options = {}, request = fetch) =>
  get(token, `/workspaces/${id(workspace)}/typeahead`, { resource_type: 'project', ...options, query: text }, request);
export const listProjectTasks = (token, project, options = {}, request = fetch) =>
  get(token, `/projects/${id(project)}/tasks`, options, request);
export const listTasks = (token, options = {}, request = fetch) =>
  get(token, '/tasks', options, request);
export const listSubtasks = (token, parent, options = {}, request = fetch) =>
  get(token, `/tasks/${id(parent)}/subtasks`, options, request);
export const getTask = (token, task, options = {}, request = fetch) =>
  get(token, `/tasks/${id(task)}`, options, request);
export const listStories = (token, task, options = {}, request = fetch) =>
  get(token, `/tasks/${id(task)}/stories`, options, request);
