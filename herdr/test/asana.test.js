import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { claudeModels, claudeEfforts, codexHome, codexModels, isClaudeLauncher, isCodexLauncher, sessionArgv, sessionKind, shownOptions, mergeModels, orderedOptions, moveOption, effortLabel, sessionChoices, settingsKey, launcherOption } from '../mods/devkits/model.js';

const names = ['asanaTheme', 'AsanaPanel', 'AsanaProjectPicker', 'previewWidthAt', 'avatarColor', 'statusKind', 'initials', 'dueLabel', 'searchProjects', 'projectTasksPage', 'myProjectTasks', 'projectWorkspace', 'openSubtasks', 'taskDetails', 'taskComments', 'relativeTime',
  'filterTasks', 'taskPrompt', 'readAsanaToken', 'saveAsanaToken'];
async function load(host = {}) {
  const source = await readFile(new URL('../mods/devkits/asana.js', import.meta.url), 'utf8');
  host = { fetch: () => assert.fail('unexpected request'), Button: () => {}, claudeModels, claudeEfforts, codexHome, codexModels, isClaudeLauncher, isCodexLauncher, sessionKind, shownOptions, orderedOptions, effortLabel, settingsKey, launcherOption,
    home: () => '/home', Select: () => element(), SelectState: class {}, ...host };
  return new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '')
    .replace('export default class', 'class').replace(/^export /gm, '')
    + `\nreturn { ${names.join(', ')} };`)(...Object.values(host));
}
const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });

test('project search covers every workspace through typeahead with the typed query', async () => {
  const urls = [];
  const { searchProjects } = await load();
  const projects = await searchProjects('secret', 'web app', async (url, options) => {
    urls.push(url); assert.equal(options.headers.Authorization, 'Bearer secret');
    if (url.includes('/users/me')) return reply(200, { data: { workspaces: [{ gid: '1', name: 'Team' }, { gid: '2', name: 'Lab' }] } });
    return reply(200, { data: [{ gid: url.includes('/workspaces/1/') ? 'p1' : 'p2', name: 'Web' }] });
  });
  assert.deepEqual(projects, [{ gid: 'p1', name: 'Web', workspace: 'Team', workspaceGid: '1' }, { gid: 'p2', name: 'Web', workspace: 'Lab', workspaceGid: '2' }]);
  assert.ok(urls.slice(1).every(url => url.includes('resource_type=project') && url.includes('query=web%20app')));
});

test('All reads one page at a time and Mine asks Asana only for my tasks, keeping this project’s', async () => {
  const urls = [];
  const { projectTasksPage, myProjectTasks, projectWorkspace } = await load();
  const request = async url => {
    urls.push(url);
    if (url.includes('opt_fields=workspace.gid')) return reply(200, { data: { workspace: { gid: 'w' } } });
    if (url.includes('assignee=me')) return url.includes('offset=') ? reply(200, { data: [{ gid: 'm2', memberships: [{ project: { gid: 'p1' } }] }] })
      : reply(200, { data: [{ gid: 'm1', memberships: [{ project: { gid: 'p1' }, section: { name: 'Doing' } }] }, { gid: 'x', memberships: [{ project: { gid: 'other' } }] }],
        next_page: { offset: 'mine 2' } });
    return reply(200, { data: [{ gid: 'a', name: 'First', num_subtasks: 2, assignee: { name: 'Amy' },
      memberships: [{ project: { gid: 'other' }, section: { name: 'Elsewhere' } }, { project: { gid: 'p1' }, section: { name: 'To do' } }] }],
      next_page: { offset: 'next token' } });
  };
  const first = await projectTasksPage('secret', 'p1', null, request);
  assert.deepEqual(first.tasks.map(task => [task.gid, task.section, task.assignee, task.subtasks]), [['a', 'To do', 'Amy', 2]]);
  assert.equal(first.next, 'next token');
  await projectTasksPage('secret', 'p1', first.next, request);
  assert.ok(urls[1].includes('/projects/p1/tasks') && urls[1].endsWith('&offset=next%20token'));
  assert.equal(await projectWorkspace('secret', 'p1', request), 'w');
  urls.length = 0;
  const mine = await myProjectTasks('secret', 'p1', 'w', request);
  assert.deepEqual(mine.map(task => [task.gid, task.section]), [['m1', 'Doing'], ['m2', null]]);
  assert.ok(urls.every(url => url.includes('/tasks?assignee=me&workspace=w') && url.includes('completed_since=now')));
});

test('subtasks hide completed ones; deleted tasks read as null; a rejected token asks for a new one', async () => {
  const { openSubtasks, taskDetails } = await load();
  const subs = await openSubtasks('secret', 'a', async () => reply(200, { data: [{ gid: 's1', name: 'Open' }, { gid: 's2', name: 'Done', completed: true }] }));
  assert.deepEqual(subs.map(task => task.gid), ['s1']);
  assert.equal(await taskDetails('secret', 'gone', 'p1', async () => reply(404, {})), null);
  await assert.rejects(taskDetails('bad', 'a', 'p1', async () => reply(401, {})), error => error.unauthorized === true);
  await assert.rejects(taskDetails('ok', 'a', 'p1', async () => reply(500, { errors: [{ message: 'Server down' }] })), /Server down/);
  const detail = await taskDetails('ok', 'a', 'p1', async () => reply(200, { data: { name: 'Child', notes: 'n', projects: [],
    parent: { gid: 'p', name: 'Parent', permalink_url: 'https://p' } } }));
  assert.deepEqual(detail.parent, { gid: 'p', name: 'Parent', url: 'https://p' });
});

test('search matches every word across name, section, assignee and parent; prompt carries the parent and trimmed notes', async () => {
  const { filterTasks, taskPrompt } = await load();
  const tasks = [{ name: 'Fix login', section: 'Doing', assignee: 'Amy' }, { name: 'Add test', parent: 'Fix login' }];
  assert.deepEqual(filterTasks(tasks, 'fix amy').map(task => task.name), ['Fix login']);
  assert.deepEqual(filterTasks(tasks, 'add login').map(task => task.name), ['Add test']);
  assert.equal(filterTasks(tasks, '  ').length, 2);
  assert.equal(taskPrompt({ name: 'Add test', url: 'https://x', notes: '  Steps  ', parent: { name: 'Fix login', url: 'https://p' } }),
    'Work on this Asana task: Add test\n\nhttps://x\n\nIt is a subtask of: Fix login\nhttps://p\n\nDescription:\nSteps');
  assert.equal(taskPrompt({ name: 'Short', url: '', notes: '', parent: null }), 'Work on this Asana task: Short');
  assert.ok(taskPrompt({ name: 'Long', url: '', notes: 'x'.repeat(5000), parent: null }).length < 4100);
});

test('the token is stored locally and only replaced against the file it was read from', async () => {
  const files = {}, writes = [];
  const { readAsanaToken, saveAsanaToken } = await load({ appHome: () => '/herdr',
    readTextFile: async path => files[path] ?? null,
    writeTextFile: async (path, text, expected) => { writes.push(expected); files[path] = text; } });
  assert.equal(await readAsanaToken(), null);
  await saveAsanaToken('one'); await saveAsanaToken('two');
  assert.equal(await readAsanaToken(), 'two');
  assert.deepEqual(writes, [null, '{\n  "token": "one"\n}\n']);
});

const element = () => new Proxy(() => {}, { get: (_target, key) => key === 'when'
  ? (condition, render) => condition ? render(element()) : element() : () => element() });
const ui = { div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
  TextView: { markdown: element }, theme: () => ({}), openOverlay() {}, DropdownMenuContent: element, DropdownMenuItem: element, DropdownMenuLabel: element,
  InputState: { new: () => ({ on() {}, value: () => '', set_value() {}, set_masked() {}, focus() {} }) },
  Textarea: { new: element }, TextareaState: { new: () => { let value = '', change; return { on: (name, handler) => { if (name === 'change') change = handler; },
    value: () => value, set_value: next => { value = next; }, type: next => { value = next; change?.(); }, set_auto_grow() {} }; } },
  Button: element, DialogTitle: element, DialogDescription: element, DropdownMenuTrigger: element,
  };

// A small Asana: project tasks are paged two at a time; Mine is every task assigned to "me" in the workspace.
const asana = (tasks, urls = []) => async url => {
  urls.push(url);
  const member = task => task.projects.map(gid => ({ project: { gid }, section: { name: task.section || 'To do' } }));
  const shape = task => ({ gid: task.gid, name: task.name, num_subtasks: task.subs?.length || 0,
    assignee: task.me ? { gid: 'me', name: 'Rick' } : null, memberships: member(task) });
  if (url.includes('/users/me')) return reply(200, { data: { gid: 'me', workspaces: [{ gid: 'w', name: 'Team' }] } });
  if (url.includes('typeahead')) return reply(200, { data: [{ gid: 'p9', name: 'Web' }] });
  if (url.includes('opt_fields=workspace.gid')) return reply(200, { data: { workspace: { gid: 'w' } } });
  if (url.includes('assignee=me')) return reply(200, { data: tasks.filter(task => task.me).map(shape) });
  const page = url.match(/\/projects\/(\w+)\/tasks/);
  if (page) {
    const all = tasks.filter(task => task.projects.includes(page[1]));
    const start = Number(url.match(/offset=(\d+)/)?.[1] || 0);
    return reply(200, { data: all.slice(start, start + 2).map(shape), next_page: start + 2 < all.length ? { offset: String(start + 2) } : null });
  }
  const stories = url.match(/\/tasks\/(\w+)\/stories/);
  if (stories) return reply(200, { data: [{ gid: 'c0', resource_subtype: 'assigned', text: 'assigned' },
    { gid: 'c1', resource_subtype: 'comment_added', text: `Looks good ${stories[1]}`, created_at: '2026-11-05T10:00:00Z', created_by: { gid: 'amy', name: 'Amy' } }] });
  const subs = url.match(/\/tasks\/(\w+)\/subtasks/);
  if (subs) return reply(200, { data: (tasks.find(task => task.gid === subs[1])?.subs || []).map(gid => ({ gid, name: gid })) });
  const one = tasks.find(task => url.includes(`/tasks/${task.gid}?`));
  return one ? reply(200, { data: { name: one.name, notes: `notes ${one.gid}`, num_subtasks: one.subs?.length || 0, projects: one.projects.map(gid => ({ gid })) } })
    : reply(404, {});
};
const harness = () => {
  const pending = [];
  const cx = { notify() {}, focus_handle: () => ({ focus() {} }), spawn: task => { pending.push(task(cx)); } };
  return { cx, settle: async () => { while (pending.length) await pending.shift(); } };
};

test('Mine loads only my tasks; All loads a page when shown and more on request; previews read fresh', async () => {
  const memory = { 'devkits.asana-projects': { '["","/Code/api"]': { gid: 'p1', name: 'API' } } }, urls = [];
  const tasks = [{ gid: 't1', name: 'Fix login', me: true, projects: ['p1'], subs: ['s1'] }, { gid: 't2', name: 'Other', projects: ['p1'] },
    { gid: 't3', name: 'Nobody', projects: ['p1'] }, { gid: 't4', name: 'Elsewhere', me: true, projects: ['p2'] }];
  const { AsanaPanel } = await load({ ...ui, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    folderKey: path => path.replace(/\/+$/, ''), appHome: () => '/herdr', readTextFile: async () => '{"token":"secret"}', fetch: asana(tasks, urls) });
  const { cx, settle } = harness();
  const panel = new AsanaPanel(); panel.init(cx);
  const render = async () => { panel.render({ folder: '/Code/api/' }, () => assert.fail('nothing starts on preview'), () => {}, cx); await settle(); };
  await render(); await render();
  assert.equal(panel.tab, 'mine');
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['t1']);
  assert.equal(memory['devkits.asana-projects']['["","/Code/api"]'].workspace, 'w');
  assert.ok(!urls.some(url => url.includes('/projects/p1/tasks')));
  panel.tab = 'all'; await render();
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['t1', 't2']);
  assert.deepEqual(panel.listItems().map(item => item.key), ['section:To do', 'task:t1', 'task:t2', 'more']);
  panel.more(cx); await settle();
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['t1', 't2', 't3']);
  assert.equal(panel.all.next, null);
  panel.tab = 'mine';
  panel.show(panel.mine[0], cx); await settle();
  assert.equal(panel.detail.notes, 'notes t1');
  assert.deepEqual(panel.detail.comments.map(comment => [comment.author, comment.text]), [['Amy', 'Looks good t1']]);
  assert.deepEqual(panel.subtasks.get('t1').map(sub => sub.gid), ['s1']);
  panel.toggleExpanded(panel.mine[0], cx);
  assert.deepEqual(panel.rows().map(row => [row.task.gid, row.depth]), [['t1', 0], ['s1', 1]]);
  memory['devkits.asana-view'] = 'board'; await render();
  assert.deepEqual(panel.groups().map(group => group.name), ['To do']);
});

test('an unbound project loads nothing until a project is chosen from the dropdown, which remembers it and its workspace', async () => {
  const memory = {}, closed = [], urls = [];
  const { AsanaPanel, AsanaProjectPicker } = await load({ ...ui, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    folderKey: path => path, appHome: () => '/herdr', readTextFile: async () => '{"token":"secret"}', closeOverlay: id => closed.push(id),
    fetch: asana([{ gid: 'w1', name: 'Mine', me: true, projects: ['p9'] }], urls) });
  const { cx, settle } = harness();
  const panel = new AsanaPanel(); panel.init(cx);
  panel.render({ folder: '/Code/web' }, () => {}, () => {}, cx); await settle();
  panel.render({ folder: '/Code/web' }, () => {}, () => {}, cx); await settle();
  assert.deepEqual(panel.rows(), []);
  assert.equal(urls.length, 0);
  const picker = new AsanaProjectPicker(); picker.init({ folder: '/Code/web', overlay: 'menu' }, cx); await settle();
  assert.deepEqual(picker.projects.map(project => project.gid), ['p9']);
  picker.choose(picker.projects[0]);
  assert.deepEqual(memory['devkits.asana-projects'], { '["","/Code/web"]': { gid: 'p9', name: 'Web', workspace: 'w' } });
  assert.deepEqual(closed, ['menu']);
  panel.render({ folder: '/Code/web' }, () => {}, () => {}, cx); await settle();
  assert.equal(panel.loadedGid, 'p9');
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['w1']);
  assert.ok(!urls.some(url => url.includes('opt_fields=workspace.gid')));
});

test('dragging the divider sizes the preview from the right edge, at any zoom, keeping both sides usable', async () => {
  const { previewWidthAt } = await load();
  const bounds = { x: 100, width: 1200 };
  assert.equal(previewWidthAt(bounds, 800, 1), 500);
  assert.equal(previewWidthAt({ x: 200, width: 2400 }, 1600, 2), 500);
  assert.equal(previewWidthAt(bounds, 1250, 1), 320);
  assert.equal(previewWidthAt(bounds, 120, 1), 880);
});

test('sections map to Linear status kinds; assignees show initials; due dates are short and flag overdue days', async () => {
  const { statusKind, initials, dueLabel } = await load();
  assert.deepEqual(['Done', 'In Progress', 'Code review', 'Backlog', 'To do', null].map(statusKind),
    ['done', 'started', 'started', 'backlog', 'todo', 'todo']);
  assert.equal(initials('amy  yeh'), 'AY');
  assert.equal(initials('葉仁豪'), '葉');
  const now = new Date(2026, 10, 6);
  assert.deepEqual(dueLabel('2026-11-10', now), { text: 'Nov 10', overdue: false });
  assert.deepEqual(dueLabel('2026-11-06', now), { text: 'Nov 6', overdue: false });
  assert.deepEqual(dueLabel('2026-11-05', now), { text: 'Nov 5', overdue: true });
  assert.deepEqual(dueLabel('2027-01-02', now), { text: 'Jan 2, 2027', overdue: false });
  assert.deepEqual(dueLabel(null, now), { text: '', overdue: false });
});

test('each assignee keeps one avatar color', async () => {
  const { avatarColor } = await load();
  assert.equal(avatarColor('123'), avatarColor('123'));
  assert.notEqual(new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(avatarColor)).size, 1);
});

test('switching Devkits projects keeps each project’s tasks, selection and preview without reloading', async () => {
  const memory = { 'devkits.asana-projects': { '["","/a"]': { gid: 'pa', name: 'A', workspace: 'w' }, '["","/b"]': { gid: 'pb', name: 'B', workspace: 'w' } } }, urls = [];
  const { AsanaPanel } = await load({ ...ui, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    folderKey: path => path, appHome: () => '/herdr', readTextFile: async () => '{"token":"secret"}',
    fetch: asana([{ gid: 'a1', name: 'A task', me: true, projects: ['pa'] }, { gid: 'b1', name: 'B task', me: true, projects: ['pb'] }], urls) });
  const { cx, settle } = harness();
  const panel = new AsanaPanel(); panel.init(cx);
  const show = async folder => { panel.render({ folder }, () => {}, () => {}, cx); await settle(); panel.render({ folder }, () => {}, () => {}, cx); await settle(); };
  await show('/a');
  panel.show(panel.mine[0], cx); await settle();
  await show('/b');
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['b1']);
  assert.equal(panel.selected, null);
  const before = urls.length;
  await show('/a');
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['a1']);
  assert.equal(panel.selected, 'a1');
  assert.equal(panel.detail.notes, 'notes a1');
  assert.equal(urls.length, before);
});

test('comments keep only comment stories; times read relatively; the prompt carries the latest five, shortened', async () => {
  const { taskComments, relativeTime, taskPrompt } = await load();
  const comments = await taskComments('secret', 't1', async url => {
    assert.ok(url.includes('/tasks/t1/stories'));
    return reply(200, { data: [{ gid: 's', resource_subtype: 'section_changed', text: 'moved' }, { gid: 'e', resource_subtype: 'comment_added', text: '  ' },
      { gid: 'c', resource_subtype: 'comment_added', text: ' Ship it ', created_at: '2026-11-06T09:00:00Z', created_by: { gid: 'u', name: 'Amy' } }] });
  });
  assert.deepEqual(comments, [{ gid: 'c', author: 'Amy', authorGid: 'u', text: 'Ship it', at: '2026-11-06T09:00:00Z' }]);
  const now = Date.parse('2026-11-06T12:00:00Z');
  assert.equal(relativeTime('2026-11-06T11:59:40Z', now), 'just now');
  assert.equal(relativeTime('2026-11-06T11:15:00Z', now), '45m ago');
  assert.equal(relativeTime('2026-11-06T09:00:00Z', now), '3h ago');
  assert.equal(relativeTime('2026-11-03T12:00:00Z', now), '3d ago');
  assert.match(relativeTime('2026-10-01T12:00:00Z', now), /^Oct 1$/);
  assert.equal(relativeTime(null, now), '');
  const many = Array.from({ length: 7 }, (_, index) => ({ author: `P${index}`, text: index === 6 ? `line one
line two ${'x'.repeat(600)}` : `c${index}`, at: '2026-11-0' + (index + 1) + 'T00:00:00Z' }));
  const prompt = taskPrompt({ name: 'Fix', url: '', notes: '', parent: null, comments: many });
  assert.ok(prompt.includes('Latest comments (5 of 7):'));
  assert.ok(!prompt.includes('- P1 ') && prompt.includes('- P2 (2026-11-03): c2'));
  assert.ok(prompt.includes('line one line two') && prompt.includes('x…'));
  assert.ok(!taskPrompt({ name: 'Fix', url: '', notes: '', parent: null, comments: [] }).includes('comments'));
  assert.ok(taskPrompt({ name: 'Fix', url: '', notes: 'Desc', parent: null, comments: many, note: '  Only touch the API  ' })
    .endsWith('My instructions:\nOnly touch the API'));
  assert.ok(!taskPrompt({ name: 'Fix', url: '', notes: '', parent: null, note: '   ' }).includes('instructions'));
});

test('model and effort flags go right after the Claude or Codex executable; Default leaves the command alone', () => {
  const claude = { key: 'devkits-claude-work', run: ['env', 'CLAUDE_CONFIG_DIR=/c', 'claude', '--permission-mode', 'plan'] };
  assert.deepEqual(sessionArgv(claude, claude.run, { model: 'sonnet', effort: 'high' }),
    ['env', 'CLAUDE_CONFIG_DIR=/c', 'claude', '--model', 'sonnet', '--effort', 'high', '--permission-mode', 'plan']);
  const codex = { key: 'codex', run: ['codex', '--no-daemon'] };
  assert.deepEqual(sessionArgv(codex, codex.run, { model: 'gpt-6-luna', effort: 'xhigh' }),
    ['codex', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="xhigh"', '--no-daemon']);
  assert.deepEqual(sessionArgv(codex, codex.run, { effort: 'low' }), ['codex', '-c', 'model_reasoning_effort="low"', '--no-daemon']);
  assert.equal(sessionArgv(claude, claude.run, {}), claude.run);
  const other = { key: 'aider', run: ['aider'] };
  assert.equal(sessionArgv(other, other.run, { model: 'x' }), other.run);
  assert.throws(() => sessionArgv({ key: 'codex', run: ['wrapper'] }, ['wrapper'], { model: 'x' }), /Could not find Codex/);
});

test('Codex models come from its cache, listed ones only, with their efforts; the home follows CODEX_HOME', () => {
  const cache = JSON.stringify({ models: [
    { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    { slug: 'hidden', visibility: 'hide', supported_reasoning_levels: [] }] });
  assert.deepEqual(codexModels(cache), [{ key: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'high'] }]);
  assert.deepEqual(codexModels('not json'), []);
  assert.equal(codexHome({ run: ['env', 'CODEX_HOME=/x/acct', 'codex'] }, '/home'), '/x/acct');
  assert.equal(codexHome({ run: ['codex'] }, '/home'), '/home/.codex');
});

test('model and effort overrides replace conflicting launcher flags and preserve unrelated config and literal arguments', () => {
  const codex = { key: 'codex' };
  const argv = ['env', 'CODEX_HOME=/work', 'codex', '--model=old', '-molder', '--config', 'model="old"',
    '-cmodel_reasoning_effort="low"', '--config=model_reasoning_effort="medium"', '-c', 'other=true', '--', '--model=literal'];
  assert.deepEqual(sessionArgv(codex, argv, { model: 'new', effort: 'high' }),
    ['env', 'CODEX_HOME=/work', 'codex', '-m', 'new', '-c', 'model_reasoning_effort="high"', '-c', 'other=true', '--', '--model=literal']);
  const claude = { key: 'claude' }, command = ['claude', '--model', 'opus', '--effort=low', '--permission-mode', 'plan'];
  assert.deepEqual(sessionArgv(claude, command, { model: 'sonnet' }), ['claude', '--model', 'sonnet', '--effort=low', '--permission-mode', 'plan']);
  assert.deepEqual(sessionArgv(claude, command, { effort: 'high' }), ['claude', '--effort', 'high', '--model', 'opus', '--permission-mode', 'plan']);
});

test('Asana names and applies profile defaults, narrows efforts to the effective model and drops incompatible inherited effort', async () => {
  const memory = { 'devkits.profile-sessions': { codex: { model: 'a', effort: 'high' } } };
  const picks = new Map(); let click, started;
  const button = new Proxy({}, { get: (_target, key) => (...args) => { if (key === 'on_click') click = args[0]; return button; } });
  const { AsanaPanel } = await load({ ...ui, shared: key => memory[key],
    Select: (id, state, value, options) => { picks.set(id, { value, options }); return element(); }, Button: () => button });
  const panel = new AsanaPanel(); panel.init({ focus_handle: () => ({ focus() {} }) });
  panel.codexModels.set('/home/.codex', [{ key: 'a', label: 'A', efforts: ['low', 'high'] }, { key: 'b', label: 'B', efforts: ['low'] }]);
  const agents = [{ key: 'codex', name: 'Codex', run: ['codex'], icon: 'icons/codex.svg', tint: false }];
  const render = () => panel.launchRow({ gid: 'task' }, agents, (_agent, _task, options) => { started = options; }, {});
  render();
  assert.deepEqual(panel.session(agents).efforts, ['low', 'high']);
  assert.equal(picks.get('asana-agent').options[0].label, 'Default account');
  assert.equal(picks.get('asana-agent').options[0].icon, 'icons/codex.svg');
  assert.equal(picks.get('asana-agent').options[0].iconTint, false);
  assert.equal(picks.get('asana-model').options[0].label, 'Default (A)');
  assert.equal(picks.get('asana-effort').options[0].label, 'Default (High)');
  click(); assert.deepEqual(started, { model: 'a', effort: 'high' });
  memory['devkits.asana-session'] = { agent: 'codex', model: 'b' };
  render(); click(); assert.deepEqual(started, { model: 'b', effort: null });
  assert.equal(picks.get('asana-effort').options[0].label, 'Default');
  memory['devkits.asana-session'] = {};
  memory['devkits.session-options'] = { codex: { models: ['a'], efforts: ['high'] } };
  render(); click(); assert.deepEqual(started, { model: null, effort: null });
  assert.equal(picks.get('asana-model').options[0].label, 'Default');
  assert.deepEqual(panel.session(agents).efforts, ['low']);
});

test('the composer remembers the agent and drops a model or effort the new agent lacks', async () => {
  const memory = { 'devkits.asana-session': { agent: 'codex', model: 'opus', effort: 'max' } };
  const { AsanaPanel } = await load({ ...ui, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    readTextFile: async () => JSON.stringify({ models: [{ slug: 'gpt-6-luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }] }) });
  const panel = new AsanaPanel(); panel.init({ focus_handle: () => ({ focus() {} }) });
  const agents = [{ key: 'claude', name: 'Claude', run: ['claude'] }, { key: 'codex', name: 'Codex', run: ['codex'] }];
  const pending = [];
  panel.cx = { notify() {}, spawn: task => { pending.push(task(panel.cx)); } };
  panel.session(agents); await Promise.all(pending);
  const codex = panel.session(agents);
  assert.equal(codex.agent.key, 'codex');
  assert.equal(codex.model, null);
  assert.equal(codex.effort, null);
  assert.deepEqual(codex.models.map(model => model.key), ['gpt-6-luna']);
  memory['devkits.asana-session'] = { agent: 'claude', model: 'opus', effort: 'max' };
  assert.deepEqual([panel.session(agents).model, panel.session(agents).effort], ['opus', 'max']);
  memory['devkits.asana-session'] = { agent: 'gone' };
  assert.equal(panel.session(agents).agent.key, 'claude');
});

test('a thread’s Asana link opens its task in the preview once, for the matching project only', async () => {
  const memory = { 'devkits.asana-projects': { '["","/a"]': { gid: 'pa', name: 'A', workspace: 'w' } },
    'devkits.asana-focus': { folder: '/a/', gid: 'a2' } };
  const { AsanaPanel } = await load({ ...ui, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    folderKey: path => path.replace(/\/+$/, ''), appHome: () => '/herdr', readTextFile: async () => '{"token":"secret"}',
    fetch: asana([{ gid: 'a1', name: 'One', me: true, projects: ['pa'] }, { gid: 'a2', name: 'Two', projects: ['pa'] }]) });
  const { cx, settle } = harness();
  const panel = new AsanaPanel(); panel.init(cx);
  panel.render({ folder: '/b' }, () => {}, () => {}, cx); await settle();
  panel.render({ folder: '/b' }, () => {}, () => {}, cx); await settle();
  assert.ok(memory['devkits.asana-focus']);
  panel.render({ folder: '/a' }, () => {}, () => {}, cx); await settle();
  panel.render({ folder: '/a' }, () => {}, () => {}, cx); await settle();
  assert.equal(memory['devkits.asana-focus'], null);
  assert.equal(panel.selected, 'a2');
  assert.equal(panel.detail.name, 'Two');
});

test('hidden models and efforts leave the composer, while new Codex models still appear; caches merge by model', async () => {
  assert.deepEqual(mergeModels([[{ key: 'a', label: 'A', efforts: ['low'] }], [{ key: 'a', label: 'A', efforts: ['high'] }, { key: 'b', label: 'B', efforts: [] }]]),
    [{ key: 'a', label: 'A', efforts: ['low', 'high'] }, { key: 'b', label: 'B', efforts: [] }]);
  assert.deepEqual(shownOptions(['low', 'high'], ['low']), ['high']);
  const memory = { 'devkits.session-options': { claude: { models: ['haiku'], efforts: ['low', 'max'] }, codex: { models: ['old'] } },
    'devkits.asana-session': { agent: 'claude', model: 'haiku', effort: 'max' } };
  const { AsanaPanel } = await load({ ...ui, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    readTextFile: async () => JSON.stringify({ models: [{ slug: 'old', visibility: 'list' }, { slug: 'new', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }] }) });
  const panel = new AsanaPanel(); panel.init({ focus_handle: () => ({ focus() {} }) });
  const agents = [{ key: 'claude', name: 'Claude', run: ['claude'] }, { key: 'codex', name: 'Codex', run: ['codex'] }];
  const claude = panel.session(agents);
  assert.deepEqual(claude.models.map(model => model.key), ['fable', 'opus', 'sonnet']);
  assert.deepEqual(claude.efforts, ['medium', 'high', 'xhigh']);
  assert.equal(claude.model, null);
  assert.equal(claude.effort, null);
  const pending = [];
  panel.cx = { notify() {}, spawn: task => { pending.push(task(panel.cx)); } };
  memory['devkits.asana-session'] = { agent: 'codex' };
  panel.session(agents); await Promise.all(pending);
  assert.deepEqual(panel.session(agents).models.map(model => model.key), ['new']);
});

test('models follow the dragged order, new ones keep theirs after it, and the composer lists them that way', async () => {
  const items = ['a', 'b', 'c', 'd'].map(key => ({ key }));
  assert.deepEqual(orderedOptions(items, ['c', 'a']).map(item => item.key), ['c', 'a', 'b', 'd']);
  assert.deepEqual(orderedOptions(items).map(item => item.key), ['a', 'b', 'c', 'd']);
  assert.deepEqual(moveOption(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveOption(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(moveOption(['a', 'b'], 'x', 'a'), ['a', 'b']);
  const memory = { 'devkits.session-options': { claude: { order: ['haiku', 'opus'], models: ['sonnet'] } } };
  const { AsanaPanel } = await load({ ...ui, shared: key => memory[key], setShared: (key, value) => { memory[key] = value; } });
  const panel = new AsanaPanel(); panel.init({ focus_handle: () => ({ focus() {} }) });
  assert.deepEqual(panel.session([{ key: 'claude', name: 'Claude', run: ['claude'] }]).models.map(model => model.key), ['haiku', 'opus', 'fable']);
});

test('a provider’s choices follow Manage, and Codex efforts narrow to the chosen model', () => {
  const codex = [{ key: 'a', label: 'A', efforts: ['low', 'high'] }, { key: 'b', label: 'B', efforts: ['max'] }];
  assert.deepEqual(sessionChoices('codex', codex, { order: ['b'], efforts: ['low'] }), { models: [codex[1], codex[0]], efforts: ['max', 'high'] });
  assert.deepEqual(sessionChoices('codex', codex, {}, 'a').efforts, ['low', 'high']);
  assert.deepEqual(sessionChoices('claude', [], { models: ['haiku'] }).models.map(model => model.key), ['fable', 'opus', 'sonnet']);
  assert.equal(effortLabel('xhigh'), 'XHigh');
});


test('Asana owns its colors in both modes regardless of the host accent and surfaces', async () => {
  const { asanaTheme } = await load();
  const dark = asanaTheme({ background: '#101010', foreground: '#ff0000', solid: '#00ff00' });
  assert.equal(dark.background, '#1e1f21');
  assert.equal(dark.popover, '#1e1f21');
  assert.equal(dark.foreground, '#f5f4f3');
  assert.equal(dark.solid, '#4573d2');
  assert.deepEqual(dark, asanaTheme({ background: '#222', solid: '#ff00ff' }));
  const light = asanaTheme({ background: '#ffffff', solid: '#00ff00' });
  assert.equal(light.background, '#ffffff');
  assert.equal(light.border, '#edeae9');
  assert.equal(light.foreground, '#1e1f21');
  assert.equal(light.solid, dark.solid);
});

test('token settings replaces credentials, clears caches and disconnects without losing bindings or bookmarks', async () => {
  let file = '{"token":"old"}', draft = 'new';
  const memory = { 'devkits.asana-projects': { project: 'p1' }, 'devkits.asana-saved': { project: ['t1'] } };
  const { AsanaPanel, readAsanaToken } = await load({ ...ui, appHome: () => '/herdr',
    shared: key => memory[key], readTextFile: async () => file,
    writeTextFile: async (_path, text) => { file = text; } });
  const { cx, settle } = harness();
  const panel = new AsanaPanel(); panel.init(cx);
  panel.tokenInput = { value: () => draft, set_value: value => { draft = value; } };
  panel.token = 'old'; panel.needsToken = false; panel.settingsOpen = true;
  panel.states = new Map([['/a', { mine: ['stale'] }]]);
  panel.saveToken(cx); await settle();
  assert.equal(await readAsanaToken(), 'new');
  assert.equal(panel.token, 'new');
  assert.equal(panel.settingsOpen, false);
  assert.equal(draft, '');
  assert.equal(panel.states.size, 0);
  panel.mine = [{ gid: 'private' }]; panel.selected = 'private';
  panel.clearToken(cx); await settle();
  assert.equal(await readAsanaToken(), null);
  assert.equal(panel.token, null);
  assert.equal(panel.needsToken, true);
  assert.equal(panel.settingsOpen, true);
  assert.equal(panel.selected, null);
  assert.equal(panel.mine, null);
  assert.deepEqual(memory, { 'devkits.asana-projects': { project: 'p1' }, 'devkits.asana-saved': { project: ['t1'] } });
});

test('failed token updates keep the current connection and allow retrying', async () => {
  const { AsanaPanel } = await load({ ...ui, appHome: () => '/herdr', shared: () => null,
    readTextFile: async () => '{"token":"old"}', writeTextFile: async () => { throw new Error('Cannot save'); } });
  const { cx, settle } = harness();
  const panel = new AsanaPanel(); panel.init(cx);
  panel.tokenInput = { value: () => 'replacement' };
  panel.token = 'old'; panel.needsToken = false; panel.settingsOpen = true;
  panel.saveToken(cx); await settle();
  assert.equal(panel.token, 'old'); assert.equal(panel.tokenBusy, false);
  assert.equal(panel.settingsOpen, true); assert.equal(panel.error, 'Cannot save');
  panel.clearToken(cx); await settle();
  assert.equal(panel.token, 'old'); assert.equal(panel.needsToken, false);
  assert.equal(panel.tokenBusy, false); assert.equal(panel.error, 'Cannot save');
});

test('settings populates the saved token in a masked input and unchanged Save keeps the connection', async () => {
  let draft = '', masked = false;
  const { AsanaPanel } = await load({ ...ui, shared: () => null,
    InputState: { new: () => ({ on() {}, value: () => draft, set_value: value => { draft = value; },
      set_masked: value => { masked = value; } }) },
    writeTextFile: () => assert.fail('unchanged token must not be written') });
  const { cx } = harness();
  const panel = new AsanaPanel(); panel.init(cx);
  panel.token = 'saved-secret'; panel.needsToken = false;
  const tasks = [{ gid: 't1' }]; panel.mine = tasks;
  panel.openSettings(cx);
  assert.equal(masked, true);
  assert.equal(draft, 'saved-secret');
  assert.equal(panel.settingsOpen, true);
  panel.saveToken(cx);
  assert.equal(panel.settingsOpen, false);
  assert.equal(panel.token, 'saved-secret');
  assert.equal(panel.mine, tasks);
  assert.equal(draft, '');
});

test('Copy copies the current token value while empty fields leave the clipboard alone', async () => {
  const { AsanaPanel } = await load({ ...ui, shared: () => null });
  const { cx } = harness();
  const panel = new AsanaPanel(); panel.init(cx);
  let value = 'actual-secret'; const copied = [];
  panel.tokenInput = { value: () => value };
  cx.write_to_clipboard = text => copied.push(text);
  panel.copyToken(cx);
  assert.deepEqual(copied, ['actual-secret']);
  assert.equal(panel.tokenCopied, true);
  value = '';
  panel.copyToken(cx);
  assert.equal(copied.length, 1);
});

test('local task prompts carry instructions without claiming an Asana source', async () => {
  const { taskPrompt } = await load();
  assert.equal(taskPrompt({ name: 'Fix login', notes: 'Add validation', source: 'local', comments: [] }),
    'Work on this task: Fix login\n\nDescription:\nAdd validation');
});

test('Asana preview only imports source content and has no agent, model, effort or execution controls', async () => {
  const nodes = new Map(), clicks = new Map();
  const node = id => {
    const proxy = new Proxy({}, { get: (_target, key) => {
      if (key === 'when') return (condition, render) => { if (condition) render(proxy); return proxy; };
      return (...args) => { if (key === 'id') nodes.set(args[0], proxy); if (key === 'on_click' && typeof id === 'string') clicks.set(id, args[0]); return proxy; };
    } });
    if (typeof id === 'string') nodes.set(id, proxy);
    return proxy;
  };
  const imported = [];
  const { AsanaPanel } = await load({ ...ui, div: node, v_flex: node, h_flex: node, svg: node, Button: node,
    shared: () => null, folderKey: path => path });
  const panel = new AsanaPanel(); panel.init({ focus_handle: () => ({}) });
  panel.folder = '/project'; panel.selected = 'a1';
  panel.detail = { gid: 'a1', name: 'Source', notes: 'Description', comments: [{ author: 'Amy', text: 'Context' }] };
  panel.session = () => assert.fail('source preview must not read model or agent settings');
  panel.preview({}, task => imported.push(task));
  assert.ok(nodes.has('asana-import'));
  for (const id of ['asana-start', 'asana-agent', 'asana-model', 'asana-effort', 'asana-note', 'asana-save', 'asana-tab-saved']) assert.ok(!nodes.has(id));
  clicks.get('asana-import')();
  assert.deepEqual(imported, [panel.detail]);
});

test('imported local prompts keep source links and comments plus all edited instructions', async () => {
  const { taskPrompt } = await load();
  const prompt = taskPrompt({ source: 'local', name: 'My task', notes: 'x'.repeat(4500) + '\nExtra requirement at the end',
    asana: { gid: 'a1', url: 'https://app.asana.com/0/p/a1', parent: { name: 'Parent', url: 'https://parent' },
      comments: [{ author: 'Amy', text: 'Use v2' }] } });
  assert.match(prompt, /Work on this Asana task: My task/);
  assert.match(prompt, /https:\/\/app.asana.com\/0\/p\/a1/); assert.match(prompt, /It is a subtask of: Parent/);
  assert.match(prompt, /Extra requirement at the end/); assert.match(prompt, /Amy: Use v2/);
});

test('legacy Saved selection falls back to Mine without reading or changing bookmarks or existing Tasks', async () => {
  const memory = { 'devkits.asana-tab': 'saved', 'devkits.asana-projects': { '["","/project"]': { gid: 'p1', workspace: 'w' } },
    'devkits.asana-saved': { '["","/project"]': [{ gid: 'legacy' }] },
    'devkits.agent-board': { '["","/project"]': { existing: { gid: 'existing', source: 'local', status: 'todo' } } } };
  const originalBookmarks = structuredClone(memory['devkits.asana-saved']), originalTasks = structuredClone(memory['devkits.agent-board']);
  const reads = [], urls = [];
  const { AsanaPanel } = await load({ ...ui, folderKey: path => path, appHome: () => '/herdr',
    shared: key => { reads.push(key); return memory[key]; }, setShared: (key, value) => { memory[key] = value; },
    readTextFile: async () => '{"token":"secret"}', fetch: asana([{ gid: 'a1', name: 'Mine', me: true, projects: ['p1'] }], urls) });
  const panel = new AsanaPanel(), { cx, settle } = harness(); panel.init(cx);
  assert.equal(panel.tab, 'mine');
  panel.render({ folder: '/project' }, () => {}, () => {}, cx); await settle();
  panel.render({ folder: '/project' }, () => {}, () => {}, cx); await settle();
  assert.deepEqual(panel.rows().map(row => row.task.gid), ['a1']);
  assert.ok(!reads.includes('devkits.asana-saved')); assert.ok(!urls.some(url => url.includes('/tasks/legacy')));
  assert.deepEqual(memory['devkits.asana-saved'], originalBookmarks); assert.deepEqual(memory['devkits.agent-board'], originalTasks);
});

test('reselecting an Asana issue reuses its pending read and loaded details and comments', async () => {
  const urls = []; let release;
  const { AsanaPanel } = await load({ ...ui, folderKey: path => path, shared: () => null,
    fetch: async url => {
      urls.push(url);
      if (url.includes('/stories?')) return reply(200, { data: [] });
      if (url.includes('/tasks/a?')) await new Promise(resolve => { release = resolve; });
      return reply(200, { data: { name: url.includes('/tasks/a?') ? 'A' : 'B', notes: 'Description' } });
    } });
  const { cx, settle } = harness(), panel = new AsanaPanel(); panel.init(cx); panel.folder = '/a'; panel.token = 'secret';
  panel.show({ gid: 'a' }, cx); const pending = panel.detailRequest;
  panel.show({ gid: 'a' }, cx); panel.show({ gid: 'a' }, cx);
  assert.equal(urls.length, 1); assert.equal(panel.detailRequest, pending);
  release(); await settle();
  const detail = panel.detail, count = urls.length;
  panel.show({ gid: 'a' }, cx); await settle();
  assert.equal(panel.detail, detail); assert.equal(urls.length, count);
  panel.show({ gid: 'b' }, cx); await settle();
  assert.equal(panel.detail.name, 'B'); assert.equal(urls.length, count + 2);
});

test('failed Asana reads can be retried and obsolete responses cannot replace a newer selection', async () => {
  let fail = true; const pending = [];
  const { AsanaPanel } = await load({ ...ui, folderKey: path => path, shared: () => null,
    fetch: async url => {
      if (url.includes('/stories?')) return reply(200, { data: [] });
      if (fail) { fail = false; return reply(500, { errors: [{ message: 'Offline' }] }); }
      return new Promise(resolve => pending.push(resolve));
    } });
  const { cx, settle } = harness(), panel = new AsanaPanel(); panel.init(cx); panel.folder = '/a'; panel.token = 'secret';
  panel.show({ gid: 'same' }, cx); await settle();
  assert.equal(panel.detailError, 'Offline'); assert.equal(panel.detailRequest, null);
  panel.show({ gid: 'same' }, cx);
  panel.show({ gid: 'other' }, cx);
  panel.show({ gid: 'same' }, cx);
  assert.equal(pending.length, 3);
  pending[2](reply(200, { data: { name: 'Newest', notes: 'Keep this' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.detail.name, 'Newest');
  pending[0](reply(200, { data: { name: 'Obsolete same issue' } }));
  pending[1](reply(200, { data: { name: 'Obsolete other issue' } }));
  await settle(); assert.equal(panel.detail.name, 'Newest');
});

test('local subtask execution prompts resolve the local parent separately from imported source context', async () => {
  const { taskPrompt } = await load();
  const prompt = taskPrompt({ source: 'local', name: 'Add tests', notes: 'Test instructions',
    parentTask: { gid: 'parent', name: 'Ship release' }, asana: { parent: { name: 'External parent' }, comments: [] } });
  assert.match(prompt, /Parent task: Ship release/); assert.match(prompt, /It is a subtask of: External parent/);
  assert.match(prompt, /Description:\nTest instructions/);
});
