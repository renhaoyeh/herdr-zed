import { agents, spaces, terminals, shared, setShared, readTextFile, appHome, notify, props } from 'herdr';
import { projectCatalog, projectGroups, folderKey, launcherChoices, launcherLabel, isAccountLauncher, launcherArgv, sessionArgv, sessionKind, rulesArgv, settingsKey, configuredAgents, resolveThreadProfiles } from './components/session-model.js';
import { boardKey, taskActions, canStartTask } from './agent-board-model.js';
import { projectBoardTasks, rememberBoardTask, setTaskArchived, threadBoardTask, threadBoardStatus, sessionThreadTitle, boardRecords } from './agent-board-state.js';
import { observeTaskInput } from './agent-task-evidence.js';
import { taskPrompt } from './task-prompt.js';
import { TaskSources } from './task-sources.js';
import { openTaskComposer } from './task-composer.js';
import { publishTaskNavigation } from './components/tasks.js';
const startingThreads = new Set();
const sessionRules = async () => { const file = `${appHome()}/data/devkits/AGENTS.md`, text = await readTextFile(file); return text?.trim() ? { file, text } : null; };

export class TaskRuntime {

  constructor() { this.taskSources = new TaskSources((project, snapshot) => openTaskComposer(project, null, 'todo', snapshot)); }
  projects() { return projectCatalog(spaces(), shared('devkits.projects') || [], shared('devkits.project-roots') || {}, shared('devkits.selected-project'), shared('devkits.project-order') || []); }
  availableAgents(available, machine) { return machine ? available : configuredAgents(available, shared('devkits.agent-configs') || []); }
  navigate(event) { publishTaskNavigation(event); }
  closeBoard() { this.navigate({ type: 'close' }); }
  selectProject(project) { this.navigate({ type: 'project', project }); }
  showConversation(_shown, project) { this.navigate({ type: 'thread', project, tab: project.tabs?.find(tab => tab.active)?.id }); }
  openThread(target, name, argv, profile, task) { this.navigate({ type: 'launch', target, name, argv, profile, task }); }
  archiveThread(thread) { this.navigate({ type: 'archive-thread', thread }); }
  restoreThread(entry) { this.navigate({ type: 'restore-thread', entry }); }
  snapshot() {
    const all = agents(), projects = {};
    for (const project of this.projects()) {
      if (!project.folder) continue;
      const tasks = projectBoardTasks(project, all);
      const threads = {};
      for (const thread of projectGroups([project], all, {}, sessionThreadTitle).flatMap(group => group.threads)) {
        const task = threadBoardTask(project, thread), current = tasks.find(item => item.gid === task.gid);
        threads[thread.tab.id] = { link: shared('devkits.thread-tasks')?.[thread.tab.id] || null, name: sessionThreadTitle(thread.tab, thread.agent, project), status: threadBoardStatus(project, thread),
          task: { ...task, policy: taskActions(current || { ...task, agents: thread.agents }) } };
      }
      projects[boardKey(project)] = { project: { id: project.id, folder: project.folder, name: project.name, machine: project.machine || null, pending: Boolean(project.pending) },
        tasks: tasks.map(task => { const { agents, tabs, ...data } = task; return { ...data, tabs: tabs.map(tab => ({ id: tab.id })), policy: taskActions(task) }; }),
        records: boardRecords(project), threads };
    }
    return { projects };
  }
  resolveSessions() {
    if (shared('devkits.pending-profiles')?.length) {
      const resolved = resolveThreadProfiles(spaces(), shared('devkits.pending-profiles'), shared('devkits.thread-profiles') || {},
        Date.now(), shared('devkits.thread-tasks') || {});
      if (resolved.pending.length !== shared('devkits.pending-profiles').length) {
        setShared('devkits.thread-profiles', resolved.profiles);
        setShared('devkits.thread-tasks', resolved.tasks);
        setShared('devkits.pending-profiles', resolved.pending);
      }
    }
  }
  refresh(cx) {
    this.resolveSessions();
    observeTaskInput(agents(), terminals(), cx);
    const snapshot = this.snapshot(), next = JSON.stringify(snapshot);
    if (next !== this.snapshotSignature) { this.snapshotSignature = next; setShared('devkits.tasks.snapshot', snapshot); }
  }
  init(cx) {
    this.taskSources.init(cx); this.refresh(cx);
    cx.timer.every(1500, cx => this.refresh(cx));
    cx.timer.every(200, cx => this.poll(cx));
  }
  poll(cx) {
    const requests = shared('devkits.tasks.requests') || [];
    if (!requests.length) return;
    setShared('devkits.tasks.requests', []);
    for (const request of requests) {
      const project = this.projects().find(project => boardKey(project) === boardKey(request.project || {}));
      if (request.action === 'open') {
        const task = project && request.gid && projectBoardTasks(project, agents()).find(task => task.gid === request.gid);
        const ok = Boolean(project && (!request.gid || task));
        if (request.reply) setShared('devkits.tasks.results', { ...(shared('devkits.tasks.results') || {}), [request.id]: { ok } });
        if (ok) this.navigate({ type: 'task', project, gid: task?.gid || null });
      } else if (project && request.action === 'source') {
        this.taskSources.open(project, request.source);
      } else if (project && request.action === 'archive') {
        const task = projectBoardTasks(project, agents()).find(task => task.gid === request.gid);
        if (request.archived ? taskActions(task).canArchive : taskActions(task).canRestore) setTaskArchived(project, task, request.archived, request.archiveId);
      } else if (project && request.action === 'start') {
        if (!canStartTask(projectBoardTasks(project, agents()).find(task => task.gid === request.gid))) continue;
        cx.spawn(async cx => { try { await this.startThread(request.agent, { ...request.target, task: projectBoardTasks(project, agents()).find(task => task.gid === request.gid) }, request.options || {}); }
          catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); } cx.notify(); });
      }
    }
    this.refresh(cx);
  }

  async startThread(agent, target = props(), options = {}) {
    const key = JSON.stringify([target.space || folderKey(target.folder || ''), agent?.key || agent?.run,
      target.task?.gid || null]);
    if (startingThreads.has(key)) return;
    startingThreads.add(key);
    try { await this.launchThread(agent, target, options); }
    finally { startingThreads.delete(key); }
  }

  async launchThread(agent, target, options) {
    const config = agent?.profileKey && (shared('devkits.agent-configs') || []).find(item => item.key === agent.key && item.profileKey === agent.profileKey);
    if (agent?.profileKey && !config) {
      notify({ title: 'Agent configuration is unavailable', body: 'Choose another agent configuration.' });
      return;
    }
    const task = target.task;
    if (task) {
      const project = this.projects().find(item => item.id === target.space || (!item.machine && folderKey(item.folder) === folderKey(target.folder))) || { folder: target.folder, tabs: [] };
      const current = projectBoardTasks(project, agents()).find(item => item.gid === task.gid);
      if (current && !taskActions(current).canStart) {
        notify({ title: 'Task is not ready to start', body: 'Move this task to Todo before starting a new session.' });
        return;
      }
    }
    let argv;
    // A choice made for this session wins; otherwise the profile's own default model and effort apply.
    const profile = shared('devkits.profile-sessions')?.[settingsKey(agent)] || {};
    const session = { model: options.model === undefined ? profile.model : options.model,
      effort: options.effort === undefined ? profile.effort : options.effort,
      serviceTier: profile.serviceTier };
    const allowed = shared('devkits.session-options')?.[sessionKind(agent)] || {};
    if (allowed.models?.includes(session.model)) session.model = null;
    if (allowed.efforts?.includes(session.effort)) session.effort = null;
    try { argv = agent && sessionArgv(agent, launcherArgv(agent, shared('devkits.codex-permissions')?.[settingsKey(agent)]), session); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); return; }
    // Global rules live on this computer, so only local sessions get them.
    if (argv && !spaces().find(space => space.id === target.space)?.machine) {
      let rules = null;
      try { rules = await sessionRules(); } catch {}
      argv = rulesArgv(agent, argv, rules, config?.instructions);
    }
    // A local task may be deleted while its launch rules are being read.
    if (task?.source === 'local') {
      const project = this.projects().find(item => item.id === target.space || (!item.machine && folderKey(item.folder) === folderKey(target.folder)));
      if (!project || !canStartTask(projectBoardTasks(project, agents()).find(item => item.gid === task.gid))) return;
    }
    if (task) argv = [...argv, taskPrompt(task)];
    // Closing the launcher destroys its async context; finish reading rules first.
    if (target.overlay) this.navigate({ type: 'close-overlay', overlay: target.overlay });
    if (task) {
      rememberBoardTask({ folder: target.folder }, task, { status: 'todo', manual: false, seenWorking: false, agentKey: agent.key, agentName: agent.name });
    }
    this.closeBoard();
    this.openThread(target, task?.name || agent?.name, argv, agent?.key, task ? { gid: task.gid, name: task.name, folder: target.folder, ...(task.source ? { source: task.source } : {}) } : null);
    if (agent?.key) {
      const project = spaces().find(space => space.id === target.space);
      const key = JSON.stringify([project?.machine || '', folderKey(target.folder) || target.space]);
      setShared('devkits.last-thread-agent', agent.key);
      setShared('devkits.last-thread-agents', { ...(shared('devkits.last-thread-agents') || {}), [key]: agent.key });
    }
  }

  taskAssignees(project) {
    const available = this.availableAgents(shared('devkits.agent-cache')?.[JSON.stringify(project?.machine || null)] || [], project?.machine);
    const hidden = shared('devkits.hidden-launchers') || [];
    return launcherChoices(available, shared('devkits.launcher-order') || [])
      .filter(choice => choice.agent && choice.agent.installed !== false && !hidden.includes(choice.key))
      .map(choice => ({ ...choice.agent, name: isAccountLauncher(choice.agent) ? launcherLabel(choice.name) : choice.name }));
  }

  boardPanel(project, cx) {
    const launchers = this.taskAssignees(project);
    return this.agentBoard.render(project, agents(), launchers, {
      asana: () => this.taskSources.open(project),
      mantisbt: () => this.taskSources.open(project, 'mantisbt'),
      archive: (task, eventCx) => {
        const currentProject = this.projects().find(item => item.id === project.id) || project;
        const current = projectBoardTasks(currentProject, agents()).find(item => item.gid === task.gid);
        if (!taskActions(current).canArchive) return;
        task = current;
        if (!task.tabs.length) { setTaskArchived(project, task, true); return; }
        const thread = projectGroups([project], agents(), {}, sessionThreadTitle).flatMap(group => group.threads).find(thread => task.tabs.some(tab => tab.id === thread.tab.id));
        if (thread) eventCx.spawn(async cx => { await this.archiveThread(thread); cx.notify(); });
      },
      restore: task => {
        const entry = (shared('devkits.archived-threads') || []).find(entry => entry.id === task.archiveId);
        if (entry) this.restoreThread(entry);
        else setTaskArchived(project, task, false);
      },
      close: () => this.closeBoard(),
      thread: id => {
        this.navigate({ type: 'thread', project, tab: id });
      },
      start: (agent, task, options, eventCx) => eventCx.spawn(async cx => {
        const currentProject = this.projects().find(item => item.id === project.id) || project;
        if (!canStartTask(projectBoardTasks(currentProject, agents()).find(item => item.gid === task.gid))) return;
        try { await this.startThread(agent, { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name, task }, options); }
        catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); }
        cx.notify();
      }),
    }, cx);
  }
}
