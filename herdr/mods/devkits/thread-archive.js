import { div, svg, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { shared, setShared, run, notify, hc, exec, readTextFile, home, terminals, appHome, window } from 'herdr';
import { archivable, agentCommand, commandKind, resumeArgv, codexSessionId, archivedAge, folderKey } from './model.js';
import { taskActions, threadBoardTask, taskLinkForTab, setTaskArchived, boardRecords } from './components/tasks.js';
import { Button } from './components/button.js';
import { SidebarContent, SidebarGroup, SidebarMenuButton } from './components/sidebar.js';
import { glyph } from './components/icon.js';

const archiving = new Set();
const archived = () => shared('devkits.archived-threads') || [];

// The conversation a running Claude or Codex terminal shows, or null before it has one.
async function sessionId(kind, command, pid) {
  if (window()?.platform === 'windows') {
    const prefix = kind === 'codex' ? 'CODEX_HOME=' : 'CLAUDE_CONFIG_DIR=';
    const directory = command.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || `${home()}/.${kind}`;
    const result = await exec('node', [`${appHome()}/mods/devkits/components/agent-session-windows.js`, String(pid), kind, directory]);
    if (result.code) return null;
    const file = JSON.parse(result.stdout).file;
    if (typeof file !== 'string') return null;
    return kind === 'codex' ? codexSessionId(file.replace(/\\/g, '/'))
      : file.match(/(?:^|[/\\])([0-9a-f-]{36})\.jsonl$/i)?.[1] || null;
  }
  if (kind === 'claude') {
    const dir = command.find(arg => arg.startsWith('CLAUDE_CONFIG_DIR='))?.slice(18) || `${home()}/.claude`;
    const id = JSON.parse(await readTextFile(`${dir}/sessions/${pid}.json`) || '{}').sessionId;
    // A session with no messages yet has no transcript to resume.
    const saved = id && (await exec('sh', ['-c', 'ls "$1"/projects/*/"$2".jsonl', 'sh', dir, id])).code === 0;
    return saved ? id : null;
  }
  // Codex keeps its rollout file open, in its own process or a child of a wrapper.
  const result = await exec('sh', ['-c', 'pids=$(pgrep -P "$1" | tr "\\n" ,)$1; lsof -Fn -p "$pids"', 'sh', String(pid)]);
  // shortcut: Codex versions without an open rollout need another reliable session-ID source.
  return codexSessionId(result.stdout);
}

async function threadSession(thread) {
  // The thread's own agent, not a terminal one of its agents started.
  for (const agent of thread.agents) {
    const result = await hc(['get', agent.address, '--json']);
    if (result.code) throw new Error(result.stderr.trim() || 'Herdr could not describe this terminal.');
    const terminal = JSON.parse(result.stdout);
    const command = !terminal.parent && agentCommand(terminal.argv);
    if (!command || !commandKind(command)) continue;
    if (!terminal.foreground?.pid) break;
    const kind = commandKind(command);
    return { terminal, command, kind, id: await sessionId(kind, command, terminal.foreground.pid) };
  }
  throw new Error('Could not find the Claude or Codex session this thread started.');
}

// Archive only inactive conversations. Running/waiting agents expose Stop instead; terminal
// threads retain Close. Claude and Codex conversations can be resumed from the archive. Mixed into the Devkits view.
export const threadArchive = {
  prepareThreadArchive(thread, cx, live = terminals()) {
    if (!cx?.spawn || !archivable(thread, live)) return;
    const tab = thread.tab.id;
    if (this.threadBusy(thread, live)) {
      this.archiveChecks?.delete(tab); this.closeOnlyThreads?.delete(tab);
      return;
    }
    const version = JSON.stringify(thread.agents.map(agent => [agent.address, agent.seq, agent.status,
      live.find(terminal => terminal.address === agent.address)?.foreground?.pid,
      live.find(terminal => terminal.address === agent.address)?.created_ms]));
    this.archiveChecks ||= new Map();
    const previous = this.archiveChecks.get(tab);
    if (previous?.version === version && (previous.pending || !previous.retryAt || previous.retryAt > Date.now())) return;
    const check = { version, pending: true };
    this.archiveChecks.set(tab, check);
    cx.spawn(async cx => {
      let resumable = false;
      try { resumable = Boolean((await threadSession(thread)).id); } catch {}
      if (this.archiveChecks.get(tab) !== check || this.threadBusy(thread)) return;
      check.pending = false;
      if (resumable) this.closeOnlyThreads?.delete(tab);
      else {
        (this.closeOnlyThreads ||= new Set()).add(tab);
        // Core/process metadata and transcript files may arrive after app startup.
        check.retryAt = Date.now() + 5000;
      }
      cx.notify();
    });
  },

  threadBusy(thread, live = terminals()) {
    return ['working', 'blocked'].includes(thread.status) || thread.agents.some(agent =>
      ['working', 'blocked'].includes(live.find(terminal => terminal.address === agent.address)?.status || agent.status));
  },

  async stopThread(thread) {
    if (this.stoppingThreads?.has(thread.tab.id)) return;
    (this.stoppingThreads ||= new Set()).add(thread.tab.id);
    try {
      const active = thread.agents.filter(agent => ['working', 'blocked'].includes(agent.status));
      if (!active.length && thread.agent) active.push(thread.agent);
      for (const agent of active) {
        const result = await hc(['interrupt', agent.address]);
        if (result.code) throw new Error(result.stderr?.trim() || 'Could not stop generation.');
      }
    } catch (error) {
      notify({ title: 'Could not stop generation', body: error.message, level: 'error' });
    } finally { this.stoppingThreads.delete(thread.tab.id); }
  },
  async archiveThread(thread) {
    if (this.threadBusy(thread)) return;
    const taskProject = this.projects().find(project => project.id === thread.space);
    if (taskProject && !taskActions({ ...threadBoardTask(taskProject, thread), agents: thread.agents }).canArchive) return;
    const tab = thread.tab.id;
    if (archiving.has(tab)) return;
    archiving.add(tab);
    try {
      if (archivable(thread, terminals())) {
        const { terminal, command, kind, id } = await threadSession(thread);
        if (this.threadBusy(thread)) return;
        if (kind === 'codex' && !id) {
          (this.closeOnlyThreads ||= new Set()).add(tab);
          notify({ title: 'Archive unavailable', body: 'No resumable Codex conversation was found. Use Close thread to end this session without adding it to the archive.' });
          return;
        }
        if (id) {
          const project = this.projects().find(project => project.id === thread.space);
          const task = taskLinkForTab(tab, project);
          const boardTask = project ? threadBoardTask(project, thread) : null;
          const entry = { id: `${kind}:${id}`, title: thread.title, folder: project?.folder || terminal.cwd,
            projectName: project?.name || terminal.cwd, profile: shared('devkits.thread-profiles')?.[tab] || null,
            argv: resumeArgv(command, id, Boolean(task)), task, boardTask, at: Date.now(),
            icon: thread.agent?.program?.icon || null, tint: Boolean(thread.agent?.program?.tint) };
          setShared('devkits.archived-threads', [entry, ...archived().filter(item => item.id !== entry.id)].slice(0, 200));
          if (project && boardTask) setTaskArchived(project, boardTask, true, entry.id);
        }
      }
      run('tab.close', { id: tab });
    } catch (error) {
      notify({ title: 'Could not archive thread', body: error.message, level: 'error' });
    } finally { archiving.delete(tab); }
  },

  // Reopens the conversation in its project, under its archived title, and leaves the archive.
  restoreThread(entry) {
    const project = this.projects().find(project => !project.machine && folderKey(project.folder) === folderKey(entry.folder));
    if (!project) {
      const saved = shared('devkits.projects') || [];
      if (!saved.some(folder => folderKey(folder) === folderKey(entry.folder))) setShared('devkits.projects', [...saved, entry.folder]);
    }
    setShared('devkits.archived-threads', archived().filter(item => item.id !== entry.id));
    this.archiveOpen = false;
    const boardTask = entry.boardTask || entry.task
      || Object.values(boardRecords({ folder: entry.folder })).find(task => task.archiveId === entry.id);
    if (boardTask) setTaskArchived({ folder: entry.folder }, boardTask, false);
    this.openThread({ space: project && !project.pending ? project.id : null, folder: entry.folder,
      projectName: project?.name || entry.projectName }, entry.title, entry.argv, entry.profile, entry.task || (boardTask ? { gid: boardTask.gid, name: entry.title, folder: entry.folder, source: boardTask.source || 'thread' } : null));
  },

  removeArchived(entry) {
    setShared('devkits.archived-threads', archived().filter(item => item.id !== entry.id));
  },

  archiveList(t) {
    const entries = archived();
    const projects = [...new Set(entries.map(entry => folderKey(entry.folder)))];
    return SidebarContent()
      .when(!entries.length, el => el.child(h_flex().h(32).flex_none().px(12).items_center().text_size(12).text_color(t.muted)
        .child('No archived threads')))
      .children(projects.map((folder, index) => {
        const items = entries.filter(entry => folderKey(entry.folder) === folder);
        return SidebarGroup(index > 0, t)
          .child(h_flex().h(32).flex_none().px(12).items_center().text_size(12).font_medium().text_color(t.muted)
            .child(div().min_w(0).truncate().child(items[0].projectName)))
          .children(items.map(entry => this.archivedRow(entry, t)));
      }));
  },

  archivedRow(entry, t) {
    const icon = entry.icon ? (entry.tint ? svg(entry.icon).size(14).text_color(t.muted) : image(entry.icon).size(14))
      : glyph('terminal', 14).text_color(t.muted);
    const hovered = this.hoveredArchived === entry.id;
    return SidebarMenuButton(`archived-${entry.id}`, false, t).accessibility_label(`Restore ${entry.title}`)
      .on_hover((inside, cx) => {
        if (!inside && this.hoveredArchived !== entry.id) return;
        this.hoveredArchived = inside ? entry.id : null;
        cx.notify();
      })
      .on_click(() => this.restoreThread(entry))
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(entry.title))
      .when(!hovered, el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(archivedAge(entry.at))))
      .when(hovered, el => el.child(Button(`remove-archived-${entry.id}`, t, { variant: 'row', size: 'icon-sm' })
        .accessibility_label('Remove from archive')
        .on_click((_event, cx) => { cx.stop_propagation(); this.removeArchived(entry); })
        .child(glyph('close', 12))));
  },
};
