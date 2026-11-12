// Auto-resume: remembers each agent tab's resumable conversation and reopens it after a reboot or crash.
//
// Herdr gives a lost terminal (core crash, reboot, logout) a shell in its last folder with the same address, and
// never runs its original command again. Herdr has no command that runs a program in an existing terminal (only
// new terminals, text paste and `hc send`, which types into a shell and needs shell quoting), so a lost
// conversation opens in a new tab with the same space, folder and title. The stale shell tab closes only after
// the new tab shows the same session.
//
// Lost-terminal heuristic (all must hold): the record's tab still exists, no agent runs in it, the terminal at the
// record's address is a plain shell (program is a shell or the foreground is one, no agent report, no command
// running), and the terminal was created after the record was last written (created_ms > updatedAt).
// A plain shell created before the record was written means the person left the agent in that shell. The record
// is dropped only when this session saw that agent running there (`observed`); otherwise it is kept, because a
// replacement terminal may keep its original creation time and a reboot must not erase the record.
import { shared, setShared, run, notify, exec, readTextFile, home, appHome, window, machines, spaces, agents, terminals, panes } from 'herdr';
import { commandKind, agentCommand, threadTitle, terminalWorking } from './components/session-model.js';
import { RESUME_RECORDS_KEY, AUTO_RESUME_KEY, sessionIdentity, windowsSessionIdentity, resumeCommand, hasCredential } from './thread-identity.js';

export const RESUME_TICK_MS = 2000;
export const RESUME_REFRESH_MS = 10000;
export const RESUME_TIMEOUT_MS = 60000;
const MAX_RECORDS = 200;
const SHELLS = /^(?:sh|bash|dash|ash|zsh|ksh|mksh|fish|nu|pwsh|powershell|cmd|elvish|xonsh|tcsh|csh)$/;

// On unless the person turned it off in shared state.
export const autoResumeEnabled = value => value !== false;

// An interactive shell with nothing running in it and no agent reporting.
export function isPlainShell(terminal) {
  if (!terminal || (terminal.state && terminal.state !== 'live') || terminal.report || terminal.program?.agent) return false;
  const name = String(terminal.foreground?.name || terminal.foreground?.argv?.[0] || '').split(/[\\/]/).pop().replace(/^-|\.exe$/gi, '').toLowerCase();
  return Boolean(terminal.foreground?.pid) && (terminal.program?.shell === true || SHELLS.test(name)) && !terminalWorking(terminal);
}

const tabIndex = list => new Map(list.flatMap(space => space.tabs.map(tab => [tab.id, { space, tab }])));

// Which recorded threads to forget, resume, or report. Pure: reads only the given lists.
export function planRecords(records, { spaces, agents, terminals, observed = new Set() }) {
  const tabs = tabIndex(spaces);
  const plan = { forget: [], resume: [], blocked: [] };
  for (const record of Object.values(records || {})) {
    if (!tabs.has(record.tabId)) { plan.forget.push(record.tabId); continue; }
    if (agents.some(agent => agent.tab === record.tabId)) continue;
    const terminal = terminals.find(item => item.address === record.address);
    if (!terminal || terminal.parent || !isPlainShell(terminal) || typeof terminal.created_ms !== 'number') continue;
    if (terminal.created_ms <= record.updatedAt) { if (observed.has(record.tabId)) plan.forget.push(record.tabId); continue; }
    if (!record.sessionId) plan.blocked.push({ record, reason: 'session not identified' });
    else if (!Array.isArray(record.command) || !resumeCommand(record.command, record.sessionId)) plan.blocked.push({ record, reason: 'started with a prompt' });
    else plan.resume.push({ record, terminal });
  }
  return plan;
}

// Identity lookups for tabs with one Claude or Codex agent on this machine. Returns only the changed records.
// A record is written only when its identity changes (shared-state writes re-render every mod).
export async function refreshRecords(records, api, now) {
  const upsert = {}, windows = api.window()?.platform === 'windows';
  const roots = api.shared('herdr-zed.project-roots') || {};
  const liveAgents = api.agents(), live = api.terminals();
  for (const { space, tab } of tabIndex(api.spaces()).values()) {
    if (space.machine) continue;
    const candidates = liveAgents.filter(agent => agent.space === space.id && agent.tab === tab.id
      && !String(agent.address).includes('/') && ['claude-code', 'codex'].includes(agent.app))
      .flatMap(agent => {
        const terminal = live.find(item => item.address === agent.address);
        return terminal && !terminal.parent && commandKind(terminal.argv) && terminal.foreground?.pid && terminal.created_ms != null
          ? [{ agent, terminal }] : [];
      });
    if (candidates.length !== 1) continue;
    const [{ agent, terminal }] = candidates;
    const command = agentCommand(terminal.argv), kind = command && commandKind(command);
    if (!command || !kind || hasCredential(command)) continue;
    const pid = terminal.foreground.pid, previous = records[tab.id];
    let sessionId = null;
    try {
      sessionId = windows ? await windowsSessionIdentity(kind, command, pid, api) : await sessionIdentity(kind, command, pid, api);
    } catch { sessionId = null; }
    // A failed lookup keeps what this same process already had.
    if (!sessionId && previous?.pid === pid && previous.address === agent.address) sessionId = previous.sessionId || null;
    const folder = roots[space.id] || space.folder;
    const same = previous && previous.space === space.id && previous.folder === folder && previous.kind === kind
      && previous.sessionId === sessionId && previous.pid === pid && previous.address === agent.address
      && JSON.stringify(previous.command) === JSON.stringify(command);
    if (same) continue;
    upsert[tab.id] = { tabId: tab.id, space: space.id, folder, machine: null, kind, sessionId, command,
      title: previous && previous.sessionId === sessionId && previous.pid === pid ? previous.title : threadTitle(tab, agent, space),
      updatedAt: now, address: agent.address, pid };
  }
  return upsert;
}

// Herdr is ready when this machine's layout has loaded and has spaces; before that, tabs look missing.
const ready = api => {
  const local = api.machines().find(item => item.name === null);
  return (!local || local.layout === 'ready') && api.spaces().length > 0;
};

// The shell's resume loop. `api` carries the Herdr functions (see `herdrApi`); tests pass fakes.
export function createThreadResume(api) {
  // observed: tabs whose recorded agent this session saw running (in memory only, so a restart observes afresh).
  const state = { busy: false, refreshedAt: -Infinity, pending: new Map(), attempted: new Set(), warned: new Set(), observed: new Set(),
    done: [], failed: [] };

  async function tick(now = Date.now()) {
    if (state.busy || !ready(api)) return;
    state.busy = true;
    try {
      const snapshot = api.shared(RESUME_RECORDS_KEY) || {};
      const enabled = autoResumeEnabled(api.shared(AUTO_RESUME_KEY));
      const upsert = {}, remove = new Set();
      if (now - state.refreshedAt >= RESUME_REFRESH_MS) {
        state.refreshedAt = now;
        Object.assign(upsert, await refreshRecords(snapshot, api, now));
      }
      const view = { ...snapshot, ...upsert }, spaceList = api.spaces(), liveAgents = api.agents();
      for (const agent of liveAgents) if (view[agent.tab]?.address === agent.address) state.observed.add(agent.tab);
      const plan = planRecords(view, { spaces: spaceList, agents: liveAgents, terminals: api.terminals(), observed: state.observed });
      plan.forget.forEach(id => remove.add(id));

      if (enabled) {
        for (const { record } of plan.resume) {
          if (state.attempted.has(record.tabId)) continue;
          state.attempted.add(record.tabId);
          const argv = resumeCommand(record.command, record.sessionId);
          const before = (spaceList.find(space => space.id === record.space)?.tabs || []).map(tab => tab.id);
          state.pending.set(record.tabId, { record, before, startedAt: now });
          api.run('tab.new', { space: record.space, folder: record.folder, name: record.title, argv });
        }
      }

      // Close each stale tab once its new tab shows the same session; give up after a timeout (the stale tab stays).
      for (const [tabId, job] of [...state.pending]) {
        const space = spaceList.find(item => item.id === job.record.space);
        const fresh = space?.tabs.find(tab => !job.before.includes(tab.id));
        const liveNow = api.terminals(), paneList = api.panes();
        const shown = Boolean(fresh) && paneList.some(pane => pane.tab === fresh.id && pane.terminal
          && liveNow.some(item => item.address === pane.terminal && commandKind(item.argv) === job.record.kind
            && JSON.stringify(item.argv).includes(job.record.sessionId)));
        if (shown) {
          // §3.1: the fresh tab continues the stale one, so providers move what they linked to it (a task) across.
          const threads = api.shared('herdr-zed.threads') || {};
          api.setShared('herdr-zed.threads', { ...threads,
            [fresh.id]: { profile: null, source: 'herdr-zed', ...threads[tabId], ...threads[fresh.id], replaces: tabId } });
          const stale = spaceList.flatMap(item => item.tabs).find(tab => tab.id === tabId);
          if (stale?.panes > 1) {
            const pane = paneList.find(item => item.terminal === job.record.address)?.pane;
            if (pane) api.run('pane.close', { pane });
          } else if (stale) api.run('tab.close', { id: tabId });
          state.pending.delete(tabId); remove.add(tabId); state.done.push(job.record.title);
        } else if (now - job.startedAt > RESUME_TIMEOUT_MS) {
          state.pending.delete(tabId); state.failed.push(job.record.title);
        }
      }
      if (!state.pending.size && (state.done.length || state.failed.length)) {
        const { done, failed } = state;
        state.done = []; state.failed = [];
        const body = [done.length ? `Resumed: ${done.join(', ')}` : '', failed.length ? `Not resumed: ${failed.join(', ')}` : '']
          .filter(Boolean).join('\n');
        api.notify({ title: done.length ? `Resumed ${done.length === 1 ? '1 conversation' : `${done.length} conversations`}` : 'Could not resume conversations',
          body, level: failed.length ? 'warning' : 'success' });
      }

      const blocked = enabled ? plan.blocked.filter(item => !state.warned.has(item.record.tabId)) : [];
      blocked.forEach(item => state.warned.add(item.record.tabId));
      if (blocked.length) {
        api.notify({ title: 'Conversations not resumed', level: 'warning',
          body: blocked.map(item => `${item.record.title}: ${item.reason}`).join('\n') });
      }

      // Merge into the latest shared value: archive may have removed a record while this tick awaited.
      const latest = api.shared(RESUME_RECORDS_KEY) || {};
      const next = { ...latest, ...upsert };
      remove.forEach(id => delete next[id]);
      const pruned = Object.fromEntries(Object.entries(next).slice(-MAX_RECORDS));
      if (JSON.stringify(pruned) !== JSON.stringify(latest)) api.setShared(RESUME_RECORDS_KEY, pruned);
    } catch (error) {
      api.notify({ title: 'Conversation resume failed', body: error.message, level: 'error' });
    } finally { state.busy = false; }
  }
  return { tick, state };
}

const herdrApi = { shared, setShared, run, notify, exec, readTextFile, home, appHome, window, machines, spaces, agents, terminals, panes };

// Starts the loop with the long-lived shell view: one pass now (after a reboot this resumes lost conversations), then
// every RESUME_TICK_MS. Identity lookups themselves run at most every RESUME_REFRESH_MS.
export function startThreadResume(cx) {
  const resume = createThreadResume(herdrApi);
  const kick = () => cx.spawn(async () => { await resume.tick(Date.now()); });
  kick();
  cx.timer.every(RESUME_TICK_MS, kick);
  return resume;
}
