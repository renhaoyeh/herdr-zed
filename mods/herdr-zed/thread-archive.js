import { div, image } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { agents, spaces, shared, setShared, run, notify, exec, readTextFile, home, terminals, window } from 'herdr';
import { agentCommand, commandKind, archivedAge, folderKey, projectGroups, threadTitle } from './components/session-model.js';
import { RESUME_RECORDS_KEY, recordsWithout, sessionIdentity, resumeCommand, accountEnv, executable, hasCredential } from './thread-identity.js';
import { Button } from './components/button.js';
import { SidebarContent, SidebarGroup, SidebarMenuButton } from './components/sidebar.js';
import { glyph } from './components/icon.js';

const HISTORY_KEY = 'herdr-zed.thread-history';
const history = () => shared(HISTORY_KEY) || [];
const archiving = new Set();
const restoring = new Map();
const timedOutRestores = new Set();

export function historyEligible(thread, live = terminals()) {
  const space = thread.space;
  return !String(space || '').includes('/') && thread.agents.some(agent => {
    const terminal = live.find(item => item.address === agent.address);
    return terminal && !terminal.parent && !String(terminal.address).includes('/') && ['claude-code', 'codex'].includes(agent.app)
      && Boolean(commandKind(terminal.argv));
  });
}

export function historyRestoreCandidate(entry, threads, live = terminals(), projects = [], pending = {}) {
  return threads.some(thread => thread.agents.some(agent => {
    const terminal = live.find(item => item.address === agent.address);
    const command = terminal && agentCommand(terminal.argv);
    const project = projects.find(item => item.id === thread.space);
    return !String(thread.space || '').includes('/') && !String(agent.address || '').includes('/')
      && !project?.machine && terminal && !terminal.parent && command && terminal.foreground?.pid && commandKind(command) === entry.kind
      && !pending.addresses?.has(terminal.address) && (!pending.at || Number(terminal.created_ms) >= pending.at)
      && JSON.stringify(accountEnv(command)) === JSON.stringify(entry.accountEnv)
      && executable(command) === entry.executable
      && folderKey(project?.folder || '') === folderKey(entry.folder || '');
  }));
}

// Archive keeps its own Windows gate; only the Unix lookup is used here (auto-resume has the Windows path).
async function sessionId(kind, command, pid) {
  if (window()?.platform === 'windows') return null;
  return sessionIdentity(kind, command, pid, { exec, readTextFile, home });
}

export const threadArchive = {
  threadBusy(thread, live = terminals()) {
    return ['working', 'blocked'].includes(thread.status) || thread.agents.some(agent =>
      ['working', 'blocked'].includes(agent.status)
      || ['working', 'blocked'].includes(live.find(item => item.address === agent.address)?.status));
  },

  async archiveThread(thread) {
    const live = terminals();
    if (this.threadBusy(thread, live) || !historyEligible(thread, live)) return;
    if (window()?.platform === 'windows') {
      notify({ title: 'History unavailable', body: 'Resumable conversation identity is not available on Windows yet.' }); return;
    }
    const tab = thread.tab.id;
    if (archiving.has(tab)) return;
    archiving.add(tab);
    try {
      if (thread.agents.some(item => ['claude-code', 'codex'].includes(item.app)
          && !live.some(candidate => candidate.address === item.address)))
        throw new Error('A session terminal is unavailable; the thread remains open.');
      const roots = thread.agents.filter(item => {
        const value = live.find(candidate => candidate.address === item.address);
        return value && !value.parent && ['claude-code', 'codex'].includes(item.app) && commandKind(value.argv);
      });
      if (roots.length !== 1) throw new Error('Archive supports one Claude or Codex session per tab; the thread remains open.');
      const agent = roots[0];
      const terminal = live.find(item => item.address === agent.address);
      const command = agentCommand(terminal.argv);
      const kind = commandKind(command);
      if (hasCredential(command)) throw new Error('The launch command contains a literal credential; remove it from the command before archiving.');
      if (!terminal.foreground?.pid) throw new Error('The session process is no longer available; the thread remains open.');
      if (terminal.created_ms == null) throw new Error('The terminal identity is unavailable; the thread remains open.');
      const captured = { created: terminal.created_ms, pid: terminal.foreground.pid };
      const id = await sessionId(kind, command, terminal.foreground?.pid);
      if (!id) throw new Error('No resumable conversation identity was found; the thread remains open.');
      const argv = resumeCommand(command, id);
      if (!argv) throw new Error('This launch includes a positional prompt that cannot be safely resumed; the thread remains open.');
      const current = terminals().find(item => item.address === agent.address);
      if (!current || current.parent || current.created_ms !== captured.created || current.foreground?.pid !== captured.pid
          || JSON.stringify(agentCommand(current.argv)) !== JSON.stringify(command)
          || this.threadBusy(thread) || thread.agents.some(item => ['working', 'blocked'].includes(item.status))) return;
      const project = this.projects().find(item => item.id === thread.space);
      const folder = project?.folder || terminal.cwd;
      const env = accountEnv(command);
      const entry = { id: `${kind}:${id}:${JSON.stringify([executable(command), env])}`, kind, sessionId: id,
        accountEnv: env, executable: executable(command),
        title: thread.title, folder, projectName: project?.name || folder, argv, at: Date.now(),
        icon: agent.program?.icon || null, tint: Boolean(agent.program?.tint) };
      setShared(HISTORY_KEY, [entry, ...history().filter(item => item.id !== entry.id)].slice(0, 200));
      // Archived on purpose: auto-resume must never reopen it after a restart.
      setShared(RESUME_RECORDS_KEY, recordsWithout(shared(RESUME_RECORDS_KEY), tab));
      run('tab.close', { id: tab });
    } catch (error) {
      notify({ title: 'Could not archive thread', body: error.message, level: 'error' });
    } finally { archiving.delete(tab); }
  },

  restoreThread(entry) {
    const current = history().find(item => item.id === entry.id);
    if (!current) return;
    if (!Array.isArray(current.argv) || !current.argv.length) {
      notify({ title: 'Cannot resume conversation', body: 'The saved launch command is unavailable. History was preserved.', level: 'error' }); return;
    }
    if (restoring.has(current.id) && Date.now() - restoring.get(current.id).at < 60000) return;
    if (window()?.platform === 'windows') {
      notify({ title: 'History unavailable', body: 'Conversation identity verification is not available on Windows yet.' }); return;
    }
    timedOutRestores.delete(current.id);
    restoring.set(current.id, { at: Date.now() });
    restoring.get(current.id).addresses = new Set(terminals().map(item => item.address));
    const project = this.projects().find(item => !item.machine && folderKey(item.folder) === folderKey(current.folder));
    const tabName = current.kind === 'codex' ? 'Codex' : 'Claude Code';
    if (project && !project.pending) run('tab.new', { space: project.id, folder: current.folder, name: tabName, argv: current.argv });
    else run('space.new', { name: current.projectName || current.folder.split('/').at(-1), folder: current.folder,
      machine: '', tab: tabName, argv: current.argv });
  },

  startHistoryRestoreTimer(cx) {
    if (!restoring.size || this.historyTimer) return;
    this.historyTimer = cx.timer.every(1000, cx => {
      if (!restoring.size) { this.historyTimer.cancel(); this.historyTimer = null; return; }
      cx.spawn(async cx => {
        try {
          const groups = projectGroups(spaces(), agents(), {}, threadTitle);
          const changed = await this.syncHistoryRestores(groups.flatMap(group => group.threads), terminals());
          if (changed) cx.notify();
        } catch (error) {
          for (const id of restoring.keys()) timedOutRestores.add(id);
          restoring.clear();
          notify({ title: 'Could not verify restored conversation', body: error.message, level: 'error' });
          cx.notify();
        }
        if (!restoring.size) { this.historyTimer?.cancel(); this.historyTimer = null; }
      });
    });
  },

  async syncHistoryRestores(threads, live) {
    if (!restoring.size || this.historySyncing) return false;
    this.historySyncing = true;
    let changed = false;
    try {
      for (const entry of history()) {
        const at = restoring.get(entry.id)?.at;
        if (!at) continue;
        if (Date.now() - at < 2000) continue;
        if (Date.now() - at > 60000) { restoring.delete(entry.id); timedOutRestores.add(entry.id); changed = true; continue; }
        const projects = this.projects();
        const pending = restoring.get(entry.id);
        const candidates = threads.filter(thread => historyRestoreCandidate(entry, [thread], live, projects, pending));
        let observed = false;
        for (const thread of candidates) {
          const agent = thread.agents.find(item => {
            const terminal = live.find(value => value.address === item.address);
            const command = terminal && agentCommand(terminal.argv);
            return command && commandKind(command) === entry.kind;
          });
          const terminal = live.find(item => item.address === agent?.address);
          const command = terminal && agentCommand(terminal.argv);
          try {
            if (terminal?.foreground?.pid && await sessionId(entry.kind, command, terminal.foreground.pid) === entry.sessionId) {
              observed = true; break;
            }
          } catch (error) {
            restoring.delete(entry.id); timedOutRestores.add(entry.id); changed = true;
            notify({ title: 'Could not verify restored conversation', body: error.message, level: 'error' });
            break;
          }
        }
        if (observed) {
          restoring.delete(entry.id);
          setShared(HISTORY_KEY, history().filter(item => item.id !== entry.id));
          changed = true;
        }
      }
    } finally { this.historySyncing = false; }
    if (changed) this.historyRestorePending = false;
    return changed;
  },

  historyList(t) {
    const entries = history();
    const folders = [...new Set(entries.map(entry => folderKey(entry.folder)))];
    return SidebarContent()
      .when(!entries.length, el => el.child(h_flex().h(32).flex_none().px(12).items_center().text_size(12).text_color(t.muted)
        .child(timedOutRestores.size ? 'Resume not found · Retry' : 'No archived threads')))
      .children(folders.map((folder, index) => {
        const items = entries.filter(entry => folderKey(entry.folder) === folder);
        return SidebarGroup(index > 0, t)
          .child(h_flex().h(32).flex_none().px(12).items_center().text_size(12).font_medium().text_color(t.muted)
            .child(div().min_w(0).truncate().child(items[0].projectName)))
          .children(items.map(entry => this.historyRow(entry, t)));
      }));
  },

  historyRow(entry, t) {
    const hovered = this.hoveredHistory === entry.id;
    const pending = restoring.get(entry.id);
    const age = pending ? 'Starting…' : timedOutRestores.has(entry.id) ? 'Retry' : archivedAge(entry.at);
    const icon = entry.icon ? (entry.tint ? glyph('agent', 14).text_color(t.muted) : image(entry.icon).size(14)) : glyph('terminal', 14).text_color(t.muted);
    return SidebarMenuButton(`history-${entry.id}`, false, t).accessibility_label(`Restore ${entry.title}`)
      .on_hover((inside, cx) => { this.hoveredHistory = inside ? entry.id : null; cx.notify(); })
      .on_click((_event, cx) => { this.restoreThread(entry); this.startHistoryRestoreTimer(cx); cx.notify(); })
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(icon))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(entry.title))
      .when(!hovered, el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(age)))
      .when(hovered, el => el.child(Button(`remove-history-${entry.id}`, t, { variant: 'row', size: 'icon-sm' })
        .accessibility_label('Remove from history')
        .on_click((_event, cx) => {
          cx.stop_propagation(); restoring.delete(entry.id); timedOutRestores.delete(entry.id);
          if (!restoring.size) { this.historyTimer?.cancel(); this.historyTimer = null; }
          setShared(HISTORY_KEY, history().filter(item => item.id !== entry.id));
        })
        .child(glyph('close', 12))));
  },
};
