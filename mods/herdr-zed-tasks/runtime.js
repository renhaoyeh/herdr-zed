import { agents, spaces, terminals, shared, setShared, notify, props, run, hc } from 'herdr';
import { projectCatalog, projectGroups, folderKey, launcherChoices, launcherLabel, isAccountLauncher, configuredAgents, resolveThreadProfiles } from './components/session-model.js';
import { boardKey, taskActions, canStartTask, taskNeedsArchiveChoice } from './agent-board-model.js';
import { projectBoardTasks, rememberBoardTask, setTaskArchived, threadBoardTask, threadBoardStatus, sessionThreadTitle, boardRecords, createLocalTask } from './agent-board-state.js';
import { observeTaskInput } from './agent-task-evidence.js';
import { openArchiveTask } from './archive-task.js';
import { taskPrompt } from './task-prompt.js';
import { TaskSources, resolveTaskImport } from './task-sources.js';
import { openTaskComposer } from './task-composer.js';
import { AgentClient } from './components/agents.js';
const startingThreads = new Set();
const clip = (text, length = 40) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
const toneFor = (thread, task) => task.execution?.status === 'fail' ? 'error' : task.attention ? 'warning' : thread.status === 'fail' ? 'error' : thread.status === 'doing' ? 'accent' : 'muted';

export class TaskRuntime {
  agentClient = new AgentClient();

  constructor() { this.taskSources = new TaskSources((context, snapshot) => this.importDraft(context, snapshot)); }
  // Replaced by the board's host view: closes the popup or dialog this runtime is shown in.
  close() {}
  projects() { return projectCatalog(spaces(), shared('herdr-zed.projects') || [], shared('herdr-zed.project-roots') || {}, shared('herdr-zed.selected-project'), shared('herdr-zed.project-order') || []); }
  availableAgents(available, machine) { return machine ? available : configuredAgents(available, shared('herdr-zed.agent-configs') || []); }
  resolveImport(request) { return resolveTaskImport(request, this.projects()); }
  // A snapshot from an integration is revalidated here, then opens the composer draft. Only its Create button makes a Todo.
  importDraft(context, snapshot) {
    const resolved = this.resolveImport({ source: snapshot?.source, context, snapshot });
    if (resolved.error) { notify({ title: 'Could not import task', body: resolved.error, level: 'error' }); return null; }
    return openTaskComposer(resolved.project, null, 'todo', resolved.snapshot);
  }
  createTask(project, args) { return createLocalTask(project, args.name, args.notes || '', { priority: args.priority || 'none', ...(args.parentId ? { parentId: args.parentId } : {}) }, agents()); }
  // Native focus: the conversation's space and tab are selected in Herdr itself.
  focusThread(tab) {
    const space = spaces().find(item => item.tabs.some(item => item.id === tab));
    if (space) run('space.select', { id: space.id });
    run('tab.select', { id: tab });
  }
  reportTask(project, args) {
    if (!['doing', 'waiting', 'done', 'fail'].includes(args.status)) throw new Error('Invalid progress state.');
    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 4000)
      throw new Error('Provide a progress message of 1–4000 characters.');
    if (!args.run) {
      if (typeof args.terminal !== 'string' || !args.terminal) throw new Error('A task run ID or your live HC terminal is required.');
      const all = agents(), sender = all.find(agent => agent.address === args.terminal);
      project = sender && this.projects().find(item => !item.machine && item.tabs?.some(tab => tab.id === sender.tab));
      const task = project && projectBoardTasks(project, all).find(task => task.agents.some(agent => agent.address === sender.address));
      if (!task || task.archived && !task.archivedBackground) throw new Error('This terminal has no active Herdr task.');
      const current = boardRecords(project)[task.gid];
      if (!current.execution || ['done', 'fail', 'stopped'].includes(current.execution.status) && args.status === 'doing') {
        if (args.status !== 'doing') throw new Error('Report doing to begin a task attempt before reporting an outcome.');
        const profile = shared('herdr-zed.thread-profiles')?.[sender.tab] || current.agentKey || null;
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
    if (!task || task.archived && !task.archivedBackground || !task.execution || task.execution.id !== args.run)
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
      status: args.status === 'done' ? 'review' : 'doing', manual: false });
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
        threads[thread.tab.id] = { link: shared('herdr-zed.thread-tasks')?.[thread.tab.id] || null, name: sessionThreadTitle(thread.tab, thread.agent, project), status: threadBoardStatus(project, thread),
          task: { ...task, attention: current?.attention || null, interrupted: Boolean(current?.interrupted), policy: taskActions(current || { ...task, agents: thread.agents }) } };
      }
      projects[boardKey(project)] = { project: { id: project.id, folder: project.folder, name: project.name, machine: project.machine || null, pending: Boolean(project.pending) },
        tasks: tasks.map(task => { const { agents, tabs, ...data } = task; return { ...data, tabs: tabs.map(tab => ({ id: tab.id })), policy: taskActions(task) }; }),
        records: boardRecords(project), threads };
    }
    return { projects, deleted: shared('herdr-zed.deleted-tasks') || {} };
  }
  // Conversations launched by Tasks carry origin { extension: 'tasks', ref: <task gid> } in the shell's thread read model.
  bindLaunchedThreads() {
    const threads = shared('herdr-zed.threads') || {};
    const links = { ...(shared('herdr-zed.thread-tasks') || {}) }, profiles = { ...(shared('herdr-zed.thread-profiles') || {}) };
    let changed = false;
    for (const [tabId, thread] of Object.entries(threads)) {
      const origin = thread?.origin;
      if (origin?.extension !== 'tasks' || typeof origin.ref !== 'string' || links[tabId]) continue;
      const project = this.projects().find(item => item.tabs?.some(tab => tab.id === tabId));
      const record = project && boardRecords(project)[origin.ref];
      if (!record) continue;
      links[tabId] = { gid: record.gid, name: record.name, folder: project.folder, source: record.source || 'local' };
      if (thread.profile) profiles[tabId] = thread.profile;
      changed = true;
    }
    if (changed) { setShared('herdr-zed.thread-tasks', links); setShared('herdr-zed.thread-profiles', profiles); }
  }
  resolveSessions() {
    this.bindLaunchedThreads();
    if (shared('herdr-zed.pending-profiles')?.length) {
      const resolved = resolveThreadProfiles(spaces(), shared('herdr-zed.pending-profiles'), shared('herdr-zed.thread-profiles') || {},
        Date.now(), shared('herdr-zed.thread-tasks') || {});
      if (resolved.pending.length !== shared('herdr-zed.pending-profiles').length) {
        setShared('herdr-zed.thread-profiles', resolved.profiles);
        setShared('herdr-zed.thread-tasks', resolved.tasks);
        setShared('herdr-zed.pending-profiles', resolved.pending);
        if (resolved.restored?.length) setShared('herdr-zed.pending-resumes', [...(shared('herdr-zed.pending-resumes') || []), ...resolved.restored]);
      }
    }
    const confirming = shared('herdr-zed.pending-resumes') || [];
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
          setShared('herdr-zed.archived-threads', (shared('herdr-zed.archived-threads') || []).filter(entry => entry.id !== resumed.id));
        } else if (exists && Date.now() - resumed.at < 60000) remaining.push(resumed);
      }
      if (remaining.length !== confirming.length) setShared('herdr-zed.pending-resumes', remaining);
    }
  }
  // Decorations are published only when the linked-thread projection changes.
  publishDecorations(snapshot) {
    const threads = {};
    for (const project of Object.values(snapshot.projects))
      for (const [tabId, thread] of Object.entries(project.threads)) {
        if (!thread.link) continue;
        const name = thread.task?.name || thread.name || '';
        threads[tabId] = { ...(name ? { subtitle: clip(name) } : {}), tone: toneFor(thread, thread.task || {}) };
      }
    const signature = JSON.stringify(threads);
    if (signature === this.decorationSignature) return;
    this.decorationSignature = signature;
    setShared('herdr-zed.decorations.tasks', { updatedAt: Date.now(), threads });
  }
  refresh(cx) {
    this.resolveSessions();
    observeTaskInput(agents(), terminals(), cx);
    const snapshot = this.snapshot(), next = JSON.stringify(snapshot);
    if (next !== this.snapshotSignature) { this.snapshotSignature = next; setShared('herdr-zed.tasks.snapshot', snapshot); }
    this.publishDecorations(snapshot);
  }
  init(cx) {
    this.agentClient.init(cx);
    this.taskSources.init(cx); this.refresh(cx);
    cx.timer.every(1500, cx => this.refresh(cx));
  }

  async startThread(agent, target = props(), options = {}) {
    const key = JSON.stringify([target.space || folderKey(target.folder || ''), agent?.key || agent?.run,
      target.task?.gid || null]);
    if (startingThreads.has(key)) return;
    startingThreads.add(key);
    try { await this.launchThread(agent, target, options); }
    finally { startingThreads.delete(key); }
  }

  // Tasks validates policy and records the run, then Agents prepares and opens the tab. Failures are thrown to the board.
  async launchThread(agent, target, options) {
    const task = target.task;
    if (!task || !agent) throw new Error('Choose an agent for this task.');
    const project = this.projects().find(item => item.id === target.space || (!item.machine && folderKey(item.folder) === folderKey(target.folder))) || { folder: target.folder, tabs: [] };
    const current = projectBoardTasks(project, agents()).find(item => item.gid === task.gid);
    if (!current) throw new Error('This task is no longer available.');
    if (!taskActions(current).canStart) throw new Error('Move this task to Todo before starting a new session.');
    const reporting = !target.machine && !spaces().find(space => space.id === target.space)?.machine
      ? { run: `run:${Date.now()}:${Math.random().toString(36).slice(2)}` } : null;
    const prompt = taskPrompt(task, reporting);
    const before = boardRecords(project)[task.gid] || {};
    rememberBoardTask(project, task, { status: 'doing', manual: false, seenWorking: false, agentKey: agent.key, agentName: agent.name,
      ...(reporting ? { execution: { id: reporting.run, status: 'starting', profile: agent.key, profileName: agent.name,
        model: options.model ?? null, effort: options.effort ?? null, startedAt: Date.now(), summary: 'Starting session' },
        runs: [...(before.runs || []), ...(before.execution ? [before.execution] : [])].slice(-30) } : {}) });
    let launched;
    try {
      launched = await this.agentClient.launch(agent, target, { ...options, prompt, origin: { extension: 'tasks', ref: task.gid } });
    } catch (error) {
      // The run never started: restore the task as it was before this attempt.
      rememberBoardTask(project, task, { status: before.status || 'todo', manual: before.manual ?? false,
        agentKey: before.agentKey ?? null, agentName: before.agentName ?? null,
        execution: before.execution ?? null, runs: before.runs ?? [] });
      throw error;
    }
    // Agents resolves with what prepare decided (model, effort, profile); record it on the run.
    const live = boardRecords(project)[task.gid];
    if (reporting && live?.execution?.id === reporting.run) {
      const meta = launched && typeof launched === 'object' ? launched : {};
      rememberBoardTask(project, task, { execution: { ...live.execution, model: meta.model ?? live.execution.model ?? null,
        effort: meta.effort ?? live.execution.effort ?? null, profile: meta.profile ?? live.execution.profile } });
    }
    this.close();
    if (agent.key) {
      const space = spaces().find(item => item.id === target.space);
      const key = JSON.stringify([space?.machine || '', folderKey(target.folder) || target.space]);
      setShared('herdr-zed.last-thread-agent', agent.key);
      setShared('herdr-zed.last-thread-agents', { ...(shared('herdr-zed.last-thread-agents') || {}), [key]: agent.key });
    }
  }

  taskAssignees(project) {
    const available = this.availableAgents(shared('herdr-zed.agent-cache')?.[JSON.stringify(project?.machine || null)] || [], project?.machine);
    const hidden = shared('herdr-zed.hidden-launchers') || [];
    return launcherChoices(available, shared('herdr-zed.launcher-order') || [])
      .filter(choice => choice.agent && choice.agent.installed !== false && !hidden.includes(choice.key))
      .map(choice => ({ ...choice.agent, name: isAccountLauncher(choice.agent) ? launcherLabel(choice.name) : choice.name }));
  }

  async archiveTask(project, gid, mode) {
    const currentProject = this.projects().find(item => item.id === project.id) || project;
    const current = projectBoardTasks(currentProject, agents()).find(item => item.gid === gid);
    if (!taskActions(current).canArchive) throw Error('This task is no longer available.');
    if (!['background', 'stop'].includes(mode)) throw Error('Choose how to handle the running agent.');
    if (mode === 'stop') {
      if (current.execution?.status === 'starting' && !current.agents.length) throw Error('The agent is still starting. Wait for it to appear before stopping.');
      const live = current.agents.filter(agent => ['working', 'blocked'].includes(agent.status) || agent.needsInput);
      for (const agent of live) {
        const result = await hc(['interrupt', agent.address]);
        if (result.code) throw Error(result.stderr?.trim() || 'Could not stop the agent. The task remains on the board.');
        const stopped = await hc(['wait', agent.address, '--timeout', '20']);
        if (stopped.code) throw Error('Could not confirm the agent stopped. The task remains on the board.');
        const state = JSON.parse(stopped.stdout || '{}');
        if (state.reason !== 'exit' && !['idle', 'done', 'error'].includes(state.status))
          throw Error('The agent is still active. The task remains on the board.');
      }
    }
    const latest = boardRecords(currentProject)[gid];
    if (!latest || latest.archived) throw Error('This task changed while confirming. Reopen it to try again.');
    if (mode === 'stop' && latest.execution && !['done', 'fail', 'stopped'].includes(latest.execution.status))
      rememberBoardTask(currentProject, latest, { execution: { ...latest.execution, status: 'stopped', summary: 'Stopped by user', finishedAt: Date.now() } });
    rememberBoardTask(currentProject, latest, { archivedBackground: mode === 'background' });
    setTaskArchived(currentProject, latest, true);
  }

  boardPanel(project, cx) {
    const launchers = this.taskAssignees(project);
    return this.agentBoard.render(project, agents(), launchers, {
      archive: (task, eventCx) => {
        const currentProject = this.projects().find(item => item.id === project.id) || project;
        const current = projectBoardTasks(currentProject, agents()).find(item => item.gid === task.gid);
        if (!taskActions(current).canArchive) return;
        if (taskNeedsArchiveChoice(current)) openArchiveTask(project, current);
        else setTaskArchived(project, current, true);
      },
      restore: task => {
        const current = projectBoardTasks(project, agents()).find(item => item.gid === task.gid);
        if (current?.archived) setTaskArchived(project, current, false);
      },
      // Restoring a saved conversation needs a resume contract that Tasks does not have yet (see report).
      resume: task => this.agentBoard.setTaskError(task.gid, 'Restore conversation is not available from Tasks yet. Use the thread history.'),
      stop: task => {
        const current = projectBoardTasks(project, agents()).find(item => item.gid === task.gid);
        if (!current) return;
        if (current.execution && !['done', 'fail', 'stopped'].includes(current.execution.status))
          rememberBoardTask(project, current, { execution: { ...current.execution, status: 'stopped', summary: 'Stopped by user', finishedAt: Date.now() } });
        const live = agents().filter(agent => current.tabs.some(tab => tab.id === agent.tab) && ['working', 'blocked'].includes(agent.status));
        for (const agent of live) hc(['interrupt', agent.address]).then(result => {
          if (result.code) throw new Error(result.stderr?.trim() || 'Could not stop generation.');
        }).catch(error => notify({ title: 'Could not stop generation', body: error.message, level: 'error' }));
      },
      close: () => this.close(),
      importSource: source => this.taskSources.open(project, source),
      thread: id => { this.focusThread(id); this.close(); },
      start: (agent, task, options, eventCx) => eventCx.spawn(async cx => {
        const currentProject = this.projects().find(item => item.id === project.id) || project;
        if (!canStartTask(projectBoardTasks(currentProject, agents()).find(item => item.gid === task.gid))) return;
        this.agentBoard.clearTaskError(task.gid);
        try { await this.startThread(agent, { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name, task }, options); }
        catch (error) { this.agentBoard.setTaskError(task.gid, error.message); }
        cx.notify();
      }),
    }, cx);
  }
}
