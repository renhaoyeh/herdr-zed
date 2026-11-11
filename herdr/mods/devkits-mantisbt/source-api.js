// Tasks source projection: caches, open-issue policy and display data.
import * as mantisApi from './api.js';
import { normalizeUrl } from './rest.js';
export { normalizeUrl } from './rest.js';

const configurations = new Map();
const projectLists = new Map();
const fieldDefinitions = new Map();
const pageSize = 20;
const id = value => encodeURIComponent(String(value));

export async function validateConnection(connection, request = fetch) {
  const me = await mantisApi.getUser(connection, 'me', request);
  if (!me.id) throw new Error('The server did not return a MantisBT user. Check the server URL.');
  return me;
}

export async function searchProjects(connection, query, request = fetch) {
  const key = JSON.stringify([normalizeUrl(connection.url), String(connection.token || '').trim()]);
  let cached = projectLists.get(key);
  if (!cached || cached.expires <= Date.now()) {
    cached = { expires: Date.now() + 300_000 };
    cached.pending = mantisApi.listProjects(connection, request).then(body => {
      if (!Array.isArray(body.projects)) throw new Error('The server did not return MantisBT projects. Check the server URL.');
      return compactProjects(connection, body.projects);
    }).catch(error => { if (projectLists.get(key) === cached) projectLists.delete(key); throw error; });
    projectLists.set(key, cached);
  }
  return filterProjects(await cached.pending, query);
}

export function filterProjects(projects, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return projects.filter(project => words.every(word => `${project.name} ${project.workspace}`.toLowerCase().includes(word)));
}

function compactProjects(connection, items) {
  const projects = [], seen = new Set(), server = normalizeUrl(connection.url);
  const visit = (items, parent = '') => {
    for (const project of items || []) {
      const gid = String(project.id);
      if (seen.has(gid)) continue;
      seen.add(gid);
      projects.push({ gid, name: project.name, workspace: parent, workspaceGid: gid, server });
      visit(project.subProjects || project.subprojects, project.name);
    }
  };
  visit(items);
  return projects;
}

async function resolvedThreshold(connection, project, request) {
  const key = JSON.stringify([connection.url, connection.token, project]);
  if (!configurations.has(key)) configurations.set(key, mantisApi.getConfig(connection, 'bug_resolved_status_threshold', project, request).then(body => {
    const threshold = Number(body.configs?.find(config => config.option === 'bug_resolved_status_threshold')?.value);
    if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('MantisBT did not return its resolved status setting.');
    return threshold;
  }).catch(error => { configurations.delete(key); throw error; }));
  return configurations.get(key);
}

const relationships = (issue, type) => (issue.relationships || []).filter(relation => relation.type?.name === type);
const issueUrl = (connection, issue) => `${normalizeUrl(connection.url)}/view.php?id=${id(issue)}`;
const customField = entry => ({ gid: String(entry.field?.id ?? entry.id), name: entry.field?.name || entry.name || 'Custom field',
  type: String(entry.type?.name || entry.type || 'text'), value: entry.value ?? null,
  displayValue: Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value ?? ''),
});
export async function projectFields(connection, project, request = fetch) {
  const body = await mantisApi.getProject(connection, project, request);
  const record = body.projects?.find(item => String(item.id) === String(project)) || body.project;
  if (!record) throw new Error('The server did not return this MantisBT project.');
  return (record.custom_fields || []).map(customField);
}

async function typedCustomFields(issue, connection, request) {
  const values = (issue.custom_fields || []).map(customField);
  if (!values.length) return values;
  const key = JSON.stringify([normalizeUrl(connection.url), connection.token, String(issue.project?.id)]);
  if (!fieldDefinitions.has(key)) fieldDefinitions.set(key, projectFields(connection, issue.project.id, request)
    .catch(error => { fieldDefinitions.delete(key); throw error; }));
  let definitions;
  try { definitions = await fieldDefinitions.get(key); } catch { return values; }
  return values.map(field => {
    const definition = definitions.find(item => item.gid === field.gid);
    const type = definition?.type || field.type;
    let displayValue = field.displayValue;
    if (type === 'date' && /^\d+$/.test(displayValue)) {
      const date = new Date(Number(displayValue) * 1000);
      if (Number.isFinite(date.getTime())) displayValue = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    }
    return { ...field, type, displayValue };
  });
}
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
    statusName: issue.status?.name || '', statusId: issue.status?.id || 0, statusColor: issue.status?.color || '',
    category: issue.category?.name || '', priority: issue.priority?.label || issue.priority?.name || '', priorityId: issue.priority?.id || 0,
    severity: issue.severity?.label || issue.severity?.name || '', resolution: issue.resolution?.label || issue.resolution?.name || '',
    reproducibility: issue.reproducibility?.label || issue.reproducibility?.name || '',
    reporter: issue.reporter?.name || '', viewStatus: issue.view_state?.label || issue.view_state?.name || '',
    projectName: issue.project?.name || '', createdAt: issue.created_at || '', updatedAt: issue.updated_at || '',
    noteCount: issue.notes?.length || 0, attachmentCount: issue.attachments?.length || 0,
    tags: (issue.tags || []).map(tag => tag.name).filter(Boolean),
    customFields: (issue.custom_fields || []).map(customField),
    subtasks: relationships(issue, 'parent-of').length,
    completed: Number(issue.status?.id) >= threshold,
    parent: parent ? { gid: String(parent.id), name: parent.summary || `Issue #${parent.id}`, url: issueUrl(connection, parent.id) } : null,
  };
};
const listTask = task => ({ ...task, parent: task.parent?.name || null });

async function issuesPage(connection, project, page, filter, request) {
  const [body, threshold] = await Promise.all([
    mantisApi.listIssues(connection, { project_id: project, page_size: pageSize, page, filter_id: filter || null }, request),
    resolvedThreshold(connection, project, request),
  ]);
  if (!Array.isArray(body.issues)) throw new Error('The server did not return MantisBT issues.');
  const tasks = await Promise.all(body.issues.filter(issue => String(issue.project?.id) === String(project)).map(async issue =>
    ({ ...normalize(issue, connection, threshold), customFields: await typedCustomFields(issue, connection, request) })));
  return { tasks: tasks.filter(task => !task.completed).map(listTask),
  next: body.issues.length === pageSize ? page + 1 : null };
}

export async function projectTasksPage(connection, project, offset = null, request = fetch) {
  return issuesPage(connection, project, Number(offset) || 1, '', request);
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
  const body = await mantisApi.getIssue(connection, gid, request);
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
  return { ...normalize(issue, connection, threshold), customFields: await typedCustomFields(issue, connection, request), notes, projects: [String(issue.project.id)], comments: comments(issue) };
}

export async function taskComments(connection, gid, request = fetch) {
  return comments(await readIssue(connection, gid, request));
}

export async function openSubtasks(connection, gid, request = fetch) {
  const issue = await readIssue(connection, gid, request);
  const children = await Promise.all(relationships(issue, 'parent-of').map(relation => taskDetails(connection, relation.issue.id, null, request)));
  return children.filter(task => task && !task.completed).map(listTask);
}
