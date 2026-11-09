
const api = 'https://app.asana.com/api/1.0';
const taskFields = 'name,due_on,assignee.name,assignee.gid,num_subtasks,permalink_url,memberships.project.gid,memberships.section.name,custom_fields.gid,custom_fields.name,custom_fields.resource_subtype,custom_fields.display_value,custom_fields.number_value,custom_fields.text_value,custom_fields.enum_value,custom_fields.multi_enum_values,custom_fields.date_value,custom_fields.people_value.name';
const customField = field => ({ gid: String(field.gid), name: field.name || 'Custom field', type: field.resource_subtype || field.type || 'text',
  value: field.number_value ?? field.text_value ?? field.enum_value ?? field.multi_enum_values ?? field.date_value ?? field.people_value ?? null,
  displayValue: field.display_value ?? field.enum_value?.name ?? field.multi_enum_values?.map(value => value.name).join(', ') ?? field.text_value ?? (field.number_value == null ? '' : String(field.number_value)),
});

export async function projectFields(token, project, request = fetch) {
  const body = await asanaRequest(token, `/projects/${encodeURIComponent(project)}?opt_fields=custom_field_settings.custom_field.gid,custom_field_settings.custom_field.name,custom_field_settings.custom_field.resource_subtype`, request);
  return (body.data?.custom_field_settings || []).map(setting => customField(setting.custom_field));
}

async function asanaRequest(token, path, request = fetch) {
  const response = await request(`${api}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  let body = null;
  try { body = await response.json(); } catch {}
  if (response.status === 401) throw Object.assign(new Error('Asana rejected this token. Enter a new personal access token.'), { unauthorized: true });
  if (!response.ok) throw Object.assign(new Error(body?.errors?.[0]?.message || `Asana returned ${response.status}.`), { status: response.status });
  return body || {};
}

async function asanaList(token, path, request) {
  const items = [];
  let offset = null;
  do {
    const page = await asanaRequest(token, `${path}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`, request);
    items.push(...(page.data || []));
    offset = page.next_page?.offset || null;
  } while (offset);
  return items;
}

const normalize = (task, project) => ({
  gid: task.gid, name: task.name || 'Untitled task', url: task.permalink_url || '', due: task.due_on || null,
  assignee: task.assignee?.name || null, assigneeGid: task.assignee?.gid || null, subtasks: task.num_subtasks || 0,
  section: task.memberships?.find(item => item.project?.gid === project)?.section?.name || null,
  customFields: (task.custom_fields || []).map(customField),
});

// Asana stays the source of truth: Devkits only reads it and never writes back.
export async function searchProjects(token, query, request = fetch) {
  const me = (await asanaRequest(token, '/users/me?opt_fields=workspaces.name', request)).data || {};
  const lists = await Promise.all((me.workspaces || []).map(workspace => asanaRequest(token,
    `/workspaces/${workspace.gid}/typeahead?resource_type=project&count=20&opt_fields=name&query=${encodeURIComponent(query)}`, request)
    .then(page => (page.data || []).map(project => ({ gid: project.gid, name: project.name, workspace: workspace.name, workspaceGid: workspace.gid })))));
  return lists.flat();
}

// All: one page of the project's open tasks at a time; `next` continues it.
export async function projectTasksPage(token, project, offset = null, request = fetch) {
  const more = offset ? `&offset=${encodeURIComponent(offset)}` : '';
  const page = await asanaRequest(token, `/projects/${project}/tasks?completed_since=now&limit=100&opt_fields=${taskFields}${more}`, request);
  return { tasks: (page.data || []).map(task => normalize(task, project)), next: page.next_page?.offset || null };
}

export async function projectWorkspace(token, project, request = fetch) {
  return (await asanaRequest(token, `/projects/${project}?opt_fields=workspace.gid`, request)).data?.workspace?.gid || null;
}

// Mine: Asana returns only the tasks assigned to the token owner; those in this project are kept.
export async function myProjectTasks(token, project, workspace, request = fetch) {
  return (await asanaList(token, `/tasks?assignee=me&workspace=${workspace}&completed_since=now&limit=100&opt_fields=${taskFields}`, request))
    .filter(task => task.memberships?.some(item => item.project?.gid === project)).map(task => normalize(task, project));
}

export async function openSubtasks(token, parent, request = fetch) {
  return (await asanaList(token, `/tasks/${parent}/subtasks?limit=100&opt_fields=completed,${taskFields}`, request))
    .filter(task => !task.completed).map(task => normalize(task));
}

// Resolves null when the task was deleted.
export async function taskDetails(token, gid, project, request = fetch) {
  try {
    const task = (await asanaRequest(token, `/tasks/${gid}?opt_fields=notes,completed,projects.gid,parent.name,parent.permalink_url,${taskFields}`, request)).data;
    return { ...normalize({ ...task, gid }, project), notes: task.notes || '', completed: Boolean(task.completed),
      projects: (task.projects || []).map(item => item.gid),
      parent: task.parent ? { gid: task.parent.gid, name: task.parent.name || 'Untitled task', url: task.parent.permalink_url || '' } : null };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

// Comments are the task's stories of the comment kind, oldest first, as Asana shows them.
export async function taskComments(token, gid, request = fetch) {
  return (await asanaList(token, `/tasks/${gid}/stories?limit=100&opt_fields=resource_subtype,text,created_at,created_by.name,created_by.gid`, request))
    .filter(story => story.resource_subtype === 'comment_added' && story.text?.trim())
    .map(story => ({ gid: story.gid, author: story.created_by?.name || 'Someone', authorGid: story.created_by?.gid || null,
      text: story.text.trim(), at: story.created_at || null }));
}
