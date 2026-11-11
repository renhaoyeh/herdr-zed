// Raw, read-only REST endpoints. Preserve API envelopes, values and pagination.
// Callers choose filters; no Tasks UI policy, caches or credential storage here.
import { mantisRequest } from './rest.js';

const id = value => encodeURIComponent(String(value));
const query = options => Object.entries(options).filter(([, value]) => value != null)
  .map(([key, value]) => `${id(key)}=${id(value)}`).join('&');

export const getUser = (connection, user = 'me', request = fetch) =>
  mantisRequest(connection, `/users/${id(user)}`, request);
export const listProjects = (connection, request = fetch) =>
  mantisRequest(connection, '/projects', request);
export const getProject = (connection, project, request = fetch) =>
  mantisRequest(connection, `/projects/${id(project)}`, request);
export const getConfig = (connection, option, project, request = fetch) =>
  mantisRequest(connection, `/config?${query({ option, project_id: project })}`, request);
export const listIssues = (connection, options = {}, request = fetch) => {
  const params = query(options);
  return mantisRequest(connection, `/issues${params ? `?${params}` : ''}`, request);
};
export const getIssue = (connection, issue, request = fetch) =>
  mantisRequest(connection, `/issues/${id(issue)}`, request);
