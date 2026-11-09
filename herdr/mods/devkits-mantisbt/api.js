
const authSchemes = new Map();
const configurations = new Map();
const pageSize = 100;
const id = value => encodeURIComponent(String(value));

export function normalizeUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '').replace(/\/api\/rest(?:\/index\.php)?$/i, '');
  if (!/^https?:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/i.test(url))
    throw new Error('Enter the MantisBT server URL, for example https://mantis.example.com.');
  return url;
}

// 2.28 and earlier use a bare token; newer servers also accept Bearer tokens.
// Remember the negotiated scheme only in memory, never in shared UI state.
async function mantisRequest(connection, path, request = fetch) {
  const url = normalizeUrl(connection.url), token = String(connection.token || '').trim();
  if (!token) throw new Error('Enter a personal access token.');
  const key = JSON.stringify([url, token]);
  const send = scheme => request(`${url}/api/rest${path}`, {
    headers: { Authorization: scheme === 'token' ? token : `Bearer ${token}`, Accept: 'application/json' },
  });
  let scheme = authSchemes.get(key) || 'token', response = await send(scheme);
  // Older MantisBT versions also return 403 for invalid token formats.
  if ((response.status === 401 || response.status === 403) && !authSchemes.has(key)) {
    scheme = 'bearer'; response = await send(scheme);
  }
  if (response.status === 401) {
    authSchemes.delete(key);
    throw Object.assign(new Error('MantisBT rejected this token. Enter a new personal access token.'), { unauthorized: true });
  }
  let body;
  try { body = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(new Error(response.status === 403
    ? authSchemes.has(key)
      ? 'This MantisBT account does not have permission to read this resource.'
      : 'MantisBT rejected the API token or denied access. Check the token and account permissions.'
    : body?.message || body?.description || `MantisBT returned ${response.status}.`), { status: response.status });
  if (!body || typeof body !== 'object') throw new Error('The server did not return MantisBT API data. Check the server URL and REST API configuration.');
  authSchemes.set(key, scheme);
  return body;
}

export async function validateConnection(connection, request = fetch) {
  const me = await mantisRequest(connection, '/users/me', request);
  if (!me.id) throw new Error('The server did not return a MantisBT user. Check the server URL.');
  return me;
}

export async function searchProjects(connection, query, request = fetch) {
  const body = await mantisRequest(connection, '/projects', request), projects = [], seen = new Set();
  const visit = (items, parent = '') => {
    for (const project of items || []) {
      const gid = String(project.id);
      if (seen.has(gid)) continue;
      seen.add(gid);
      projects.push({ gid, name: project.name, workspace: parent, workspaceGid: gid, server: normalizeUrl(connection.url) });
      visit(project.subProjects || project.subprojects, project.name);
    }
  };
  if (!Array.isArray(body.projects)) throw new Error('The server did not return MantisBT projects. Check the server URL.');
  visit(body.projects);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return projects.filter(project => words.every(word => `${project.name} ${project.workspace}`.toLowerCase().includes(word)));
}

async function resolvedThreshold(connection, project, request) {
  const key = JSON.stringify([connection.url, connection.token, project]);
  if (!configurations.has(key)) configurations.set(key, mantisRequest(connection,
    `/config?option=bug_resolved_status_threshold&project_id=${id(project)}`, request).then(body => {
    const threshold = Number(body.configs?.find(config => config.option === 'bug_resolved_status_threshold')?.value);
    if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('MantisBT did not return its resolved status setting.');
    return threshold;
  }).catch(error => { configurations.delete(key); throw error; }));
  return configurations.get(key);
}

const relationships = (issue, type) => (issue.relationships || []).filter(relation => relation.type?.name === type);
const issueUrl = (connection, issue) => `${normalizeUrl(connection.url)}/view.php?id=${id(issue)}`;
const normalize = (issue, connection, threshold) => {
  const parent = relationships(issue, 'child-of')[0]?.issue;
  return {
    source: 'mantisbt', gid: String(issue.id), name: issue.summary || `Issue #${issue.id}`,
    url: issueUrl(connection, issue.id), server: normalizeUrl(connection.url),
    due: issue.due_date && !issue.due_date.startsWith('1970-01-01') ? issue.due_date.slice(0, 10) : null,
    assignee: issue.handler?.real_name || issue.handler?.name || null,
    assigneeLogin: issue.handler?.name || '',
    assigneeGid: issue.handler?.id ? String(issue.handler.id) : null,
    section: issue.status?.label || issue.status?.name || 'New',
    statusName: issue.status?.name || '', statusId: issue.status?.id || 0,
    category: issue.category?.name || '', priority: issue.priority?.label || issue.priority?.name || '', priorityId: issue.priority?.id || 0,
    severity: issue.severity?.label || issue.severity?.name || '', resolution: issue.resolution?.label || issue.resolution?.name || '',
    reproducibility: issue.reproducibility?.label || issue.reproducibility?.name || '',
    reporter: issue.reporter?.name || '', viewStatus: issue.view_state?.label || issue.view_state?.name || '',
    projectName: issue.project?.name || '', createdAt: issue.created_at || '', updatedAt: issue.updated_at || '',
    noteCount: issue.notes?.length || 0, attachmentCount: issue.attachments?.length || 0,
    tags: (issue.tags || []).map(tag => tag.name).filter(Boolean),
    subtasks: relationships(issue, 'parent-of').length,
    completed: Number(issue.status?.id) >= threshold,
    parent: parent ? { gid: String(parent.id), name: parent.summary || `Issue #${parent.id}`, url: issueUrl(connection, parent.id) } : null,
  };
};
const listTask = task => ({ ...task, parent: task.parent?.name || null });

async function issuesPage(connection, project, page, filter, request) {
  const [body, threshold] = await Promise.all([
    mantisRequest(connection, `/issues?project_id=${id(project)}&page_size=${pageSize}&page=${page}${filter ? `&filter_id=${filter}` : ''}`, request),
    resolvedThreshold(connection, project, request),
  ]);
  if (!Array.isArray(body.issues)) throw new Error('The server did not return MantisBT issues.');
  return { tasks: body.issues.filter(issue => String(issue.project?.id) === String(project))
    .map(issue => normalize(issue, connection, threshold)).filter(task => !task.completed).map(listTask),
  next: body.issues.length === pageSize ? page + 1 : null };
}

export async function projectTasksPage(connection, project, offset = null, request = fetch) {
  let page = Number(offset) || 1, result;
  // A raw page can contain only resolved issues or issues in subprojects.
  // Advance it so the existing empty state cannot hide the next open page.
  do { result = await issuesPage(connection, project, page, '', request); page = result.next; }
  while (!result.tasks.length && page);
  return result;
}

export async function myProjectTasks(connection, project, _workspace, request = fetch) {
  const tasks = []; let page = 1;
  do {
    const result = await issuesPage(connection, project, page, 'assigned', request);
    tasks.push(...result.tasks); page = result.next;
  } while (page);
  return tasks;
}

async function readIssue(connection, gid, request) {
  const body = await mantisRequest(connection, `/issues/${id(gid)}`, request);
  if (!body.issues?.[0]) throw new Error('The server did not return this MantisBT issue.');
  return body.issues[0];
}

const comments = issue => (issue.notes || []).filter(note => note.text?.trim()).map(note => ({
  gid: String(note.id), author: note.reporter?.real_name || note.reporter?.name || 'Someone',
  authorLogin: note.reporter?.name || '',
  authorGid: note.reporter?.id ? String(note.reporter.id) : null, text: note.text.trim(), at: note.created_at || null,
})).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));

export async function taskDetails(connection, gid, _project, request = fetch) {
  let issue;
  try { issue = await readIssue(connection, gid, request); }
  catch (error) { if (error.status === 404) return null; throw error; }
  const threshold = await resolvedThreshold(connection, issue.project.id, request);
  const notes = [issue.description, issue.steps_to_reproduce && `Steps to reproduce:\n${issue.steps_to_reproduce}`,
    issue.additional_information && `Additional information:\n${issue.additional_information}`].filter(Boolean).join('\n\n');
  return { ...normalize(issue, connection, threshold), notes, projects: [String(issue.project.id)], comments: comments(issue) };
}

export async function taskComments(connection, gid, request = fetch) {
  return comments(await readIssue(connection, gid, request));
}

export async function openSubtasks(connection, gid, request = fetch) {
  const issue = await readIssue(connection, gid, request);
  const children = await Promise.all(relationships(issue, 'parent-of').map(relation => taskDetails(connection, relation.issue.id, null, request)));
  return children.filter(task => task && !task.completed).map(listTask);
}
