import { agents, spaces, terminals, shared, setShared, readTextFile, appHome, notify, props } from 'herdr';
import { projectCatalog, projectGroups, folderKey, launcherChoices, launcherLabel, isAccountLauncher, launcherArgv, sessionArgv, sessionKind, rulesArgv, settingsKey, configuredAgents, resolveThreadProfiles } from './components/session-model.js';
import { boardKey, taskActions, canStartTask } from './agent-board-model.js';
import { projectBoardTasks, rememberBoardTask, setTaskArchived, threadBoardTask, threadBoardStatus, sessionThreadTitle, boardRecords, createLocalTask } from './agent-board-state.js';
import { observeTaskInput } from './agent-task-evidence.js';
import { taskPrompt } from './task-prompt.js';
import { TaskSources } from './task-sources.js';
import { openTaskComposer } from './task-composer.js';
import { sessionMcpArgv } from './components/shared-mcp.js';
import { publishTaskNavigation } from './components/tasks.js';
const startingThreads = new Set();
const sessionRules = async () => { const file = `${appHome()}/data/devkits/AGENTS.md`, text = await readTextFile(file); return text?.trim() ? { file, text } : null; };

export class TaskRuntime {

  constructor() { this.taskSources = new TaskSources((project, snapshot) => openTaskComposer(project, null, 'todo', snapshot)); }
  projects() { return projectCatalog(spaces(), shared('devkits.projects') || [], shared('devkits.project-roots') || {}, shared('devkits.selected-project'), shared('devkits.project-order') || []); }
  availableAgents(available, machine) { return machine ? available : configuredAgents(available, shared('devkits.agent-configs') || []); }
  navigate(event) { publishTaskNavigation(event); }
  closeBoard() { this.navigate({ type: 'close' }); }
  createTask(project, args) { return createLocalTask(project, args.name, args.notes || '', { priority: args.priority || 'none', ...(args.parentId ? { parentId: args.parentId } : {}) }, agents()); }
  selectProject(project) { this.navigate({ type: 'project', project }); }
  showConversation(_shown, project) { this.navigate({ type: 'thread', project, tab: project.tabs?.find(tab => tab.active)?.id }); }
  openThread(target, name, argv, profile, task) { this.navigate({ type: 'launch', target, name, argv, profile, task }); }
  archiveThread(thread) { this.navigate({ type: 'archive-thread', thread }); }
  restoreThread(entry) { this.navigate({ type: 'restore-thread', entry }); }
  reportTask(project, args) {
    if (!['doing', 'waiting', 'done', 'fail'].includes(args.status)) throw new Error('Invalid progress state.');
    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 4000)
      throw new Error('Provide a progress message of 1–4000 characters.');
    if (!args.run) {
      if (typeof args.terminal !== 'string' || !args.terminal) throw new Error('A task run ID or your live HC terminal is required.');
      const all = agents(), sender = all.find(agent => agent.address === args.terminal);
      project = sender && this.projects().find(item => !item.machine && item.tabs?.some(tab => tab.id === sender.tab));
      const task = project && projectBoardTasks(project, all).find(task => task.agents.some(agent => agent.address === sender.address));
      if (!task || task.archived) throw new Error('This terminal has no active Herdr task.');
      const current = boardRecords(project)[task.gid];
      if (!current.execution || ['done', 'fail', 'stopped'].includes(current.execution.status) && args.status === 'doing') {
        if (args.status !== 'doing') throw new Error('Report doing to begin a task attempt before reporting an outcome.');
        const profile = shared('devkits.thread-profiles')?.[sender.tab] || current.agentKey || null;
        const launcher = this.taskAssignees(project).find(agent => agent.key === profile);
        rememberBoardTask(project, current, { status: 'doing', manual: false, hasInput: true,
          execution: { id: `run:${Date.now()}:${Math.random().toString(36).slice(2)}`, status: 'doing',
            profile, profileName: launcher?.name || current.agentName || sender.program?.name || 'Agent', model: null, effort: null,
            startedAt: Date.now(), summary: '' },
          runs: [...(current.runs || []), ...(current.execution ? [current.execution] : [])].slice(-30) });
      }
      args = { ...args, task: current.gid, run: boardRecords(project)[current.gid].execution.id };
    }
    if (typeof args.run !== 'string' || !args.run) throw new Error('A task run ID is required.');
    project ||= this.projects().find(item => Object.values(boardRecords(item)).some(task => task.execution?.id === args.run));
    if (!project) throw new Error('This task run is no longer active.');
    if (project.machine) throw new Error('Progress reporting currently supports local tasks.');
    const task = args.task ? boardRecords(project)[args.task] : Object.values(boardRecords(project)).find(task => task.execution?.id === args.run);
    if (!task || task.archived || !task.execution || task.execution.id !== args.run)
      throw new Error('This task run is no longer active. Refresh the task before reporting.');
    const execution = task.execution;
    if (args.status === execution.status && args.message.trim() === execution.summary) return task;
    if (['done', 'fail', 'stopped'].includes(execution.status)) {
      if (args.status === execution.status && args.message.trim() === execution.summary) return task;
      throw new Error('This run has already finished. Start a new attempt to report more work.');
    }
    const at = Date.now(), summary = args.message.trim();
    const next = { ...execution, status: args.status, summary, updatedAt: at,
      ...(['done', 'fail'].includes(args.status) ? { finishedAt: at } : {}) };
    const activity = [...(task.activity || []), { run: execution.id, status: args.status, message: summary, at }].slice(-100);
    rememberBoardTask(project, task, { execution: next, activity,
      status: args.status === 'waiting' ? 'doing' : args.status, manual: false });
    return boardRecords(project)[task.gid];
  }
  snapshot() {
    const all = agents(), projects = {};
    for (const project of this.projects()) {
      if (!project.folder) continue;
      const tasks = projectBoardTasks(project, all);
      const threads = {};
      for (const thread of projectGroups([project], all, {}, sessionThreadTitle).flatMap(group => group.threads)) {
        const task = threadBoardTask(project, thread), current = tasks.find(item => item.gid === task.gid);
        threads[thread.tab.id] = { link: shared('devkits.thread-tasks')?.[thread.tab.id] || null, name: sessionThreadTitle(thread.tab, thread.agent, project), status: threadBoardStatus(project, thread),
          task: { ...task, attention: current?.attention || null, interrupted: Boolean(current?.interrupted), policy: taskActions(current || { ...task, agents: thread.agents }) } };
      }
      projects[boardKey(project)] = { project: { id: project.id, folder: project.folder, name: project.name, machine: project.machine || null, pending: Boolean(project.pending) },
        tasks: tasks.map(task => { const { agents, tabs, ...data } = task; return { ...data, tabs: tabs.map(tab => ({ id: tab.id })), policy: taskActions(task) }; }),
        records: boardRecords(project), threads };
    }
    return { projects, deleted: shared('devkits.deleted-tasks') || {} };
  }
  resolveSessions() {
    if (shared('devkits.pending-profiles')?.length) {
      const resolved = resolveThreadProfiles(spaces(), shared('devkits.pending-profiles'), shared('devkits.thread-profiles') || {},
        Date.now(), shared('devkits.thread-tasks') || {});
      if (resolved.pending.length !== shared('devkits.pending-profiles').length) {
        setShared('devkits.thread-profiles', resolved.profiles);
        setShared('devkits.thread-tasks', resolved.tasks);
        setShared('devkits.pending-profiles', resolved.pending);
        if (resolved.restored?.length) setShared('devkits.pending-resumes', [...(shared('devkits.pending-resumes') || []), ...resolved.restored]);
      }
    }
    const confirming = shared('devkits.pending-resumes') || [];
    if (confirming.length) {
      const currentSpaces = spaces(), currentAgents = agents(), remaining = [];
      for (const resumed of confirming) {
        const exists = currentSpaces.some(space => space.tabs.some(tab => tab.id === resumed.tab));
        // A tab may be created before its CLI fails. Require an agent that stays alive through startup.
        if (exists && Date.now() - resumed.at >= 2000 && currentAgents.some(agent => agent.tab === resumed.tab && ['idle', 'working', 'done', 'blocked'].includes(agent.status))) {
          if (resumed.task) {
            const project = { folder: resumed.folder }, current = boardRecords(project)[resumed.task.gid];
            if (current) setTaskArchived(project, current, false);
          }
          setShared('devkits.archived-threads', (shared('devkits.archived-threads') || []).filter(entry => entry.id !== resumed.id));
        } else if (exists && Date.now() - resumed.at < 60000) remaining.push(resumed);
      }
      if (remaining.length !== confirming.length) setShared('devkits.pending-resumes', remaining);
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
    try { argv = agent && sessionArgv(agent, launcherArgv(agent, shared('devkits.codex-permissions')?.[settingsKey(agent)]), { ...session,
      tasksMcpHome: !target.machine && !spaces().find(space => space.id === target.space)?.machine ? appHome() : null }); }
    catch (error) { notify({ title: 'Could not start session', body: error.message, level: 'error' }); return; }
    // Global rules live on this computer, so only local sessions get them.
    if (argv && !spaces().find(space => space.id === target.space)?.machine) {
      let rules = null;
      try { rules = await sessionRules(); } catch {}
      argv = rulesArgv(agent, argv, rules, config?.instructions);
      if (!target.machine) {
        try { argv = await sessionMcpArgv(agent, argv); }
        catch (error) { notify({ title: 'Could not load shared MCP settings', body: error.message, level: 'error' }); return; }
      }
    }
    // A local task may be deleted while its launch rules are being read.
    if (task?.source === 'local') {
      const project = this.projects().find(item => item.id === target.space || (!item.machine && folderKey(item.folder) === folderKey(target.folder)));
      if (!project || !canStartTask(projectBoardTasks(project, agents()).find(item => item.gid === task.gid))) return;
    }
    const reporting = task && !target.machine && !spaces().find(space => space.id === target.space)?.machine
      ? { cli: `${appHome()}/mods/devkits-tasks/tasks-cli.cjs`, project: boardKey({ folder: target.folder }), run: `run:${Date.now()}:${Math.random().toString(36).slice(2)}` } : null;
    if (task) argv = [...argv, taskPrompt(task, reporting)];
    // Closing the launcher destroys its async context; finish reading rules first.
    if (target.overlay) this.navigate({ type: 'close-overlay', overlay: target.overlay });
    if (task) {
      const previous = boardRecords({ folder: target.folder })[task.gid] || {};
      rememberBoardTask({ folder: target.folder }, task, { status: 'todo', manual: false, seenWorking: false, agentKey: agent.key, agentName: agent.name,
        ...(reporting ? { execution: { id: reporting.run, status: 'starting', profile: agent.key, profileName: agent.name,
          model: session.model || null, effort: session.effort || null, startedAt: Date.now(), summary: 'Starting session' },
          runs: [...(previous.runs || []), ...(previous.execution ? [previous.execution] : [])].slice(-30) } : {}) });
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
      archive: (task, eventCx) => {
        const currentProject = this.projects().find(item => item.id === project.id) || project;
        const current = projectBoardTasks(currentProject, agents()).find(item => item.gid === task.gid);
        if (!taskActions(current).canArchive) return;
        task = current;
        setTaskArchived(project, task, true);
      },
      restore: task => {
        const current = projectBoardTasks(project, agents()).find(item => item.gid === task.gid);
        if (current?.archived) setTaskArchived(project, current, false);
      },
      resume: task => {
        const entry = (shared('devkits.archived-threads') || []).find(entry => entry.id === task.archiveId);
        if (entry) this.restoreThread(entry);
      },
      stop: task => {
        const current = projectBoardTasks(project, agents()).find(item => item.gid === task.gid);
        if (!current) return;
        if (current.execution && !['done', 'fail', 'stopped'].includes(current.execution.status))
          rememberBoardTask(project, current, { execution: { ...current.execution, status: 'stopped', summary: 'Stopped by user', finishedAt: Date.now() } });
        for (const thread of projectGroups([project], agents(), {}, sessionThreadTitle).flatMap(group => group.threads)
          .filter(thread => current.tabs.some(tab => tab.id === thread.tab.id))) this.navigate({ type: 'stop-thread', thread });
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
