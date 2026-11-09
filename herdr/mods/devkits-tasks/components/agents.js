// Shared: edit mods/devkits/components/agents.js, then npm run sync:shared.
import { shared, setShared, layout, openOverlay, appHome } from 'herdr';
import { launcherOption, accountAddresses, noAccountLabel } from './session-model.js';

const REQUESTS = 'devkits.agents.requests', RESULTS = 'devkits.agents.results';
export const rulesPath = () => `${appHome()}/data/devkits/AGENTS.md`;
export const noAccount = noAccountLabel;
export const openAgentSettings = (space = null, page = 'accounts') => openOverlay({ mod: 'devkits-agents', kind: 'dialog', frame: 'none', modal: false,
  width: 1040, height: 0.86, props: { view: 'manage-launchers', space, page } });
export const openAgentLauncher = (target, at) => openOverlay({ mod: 'devkits-agents', kind: 'popup', frame: 'none', width: 280, at,
  props: { ...target, view: 'launcher' } });
export const openSharedMcp = agent => openOverlay({ mod: 'devkits-agents', kind: 'dialog', frame: 'none', modal: true, width: 720, height: 0.8,
  props: { view: 'shared-mcp', agent } });
export const agentAccountName = (agent, label) => label === 'Default account' && agent && !agent.profileKey
  ? launcherOption(agent, accountAddresses(shared)).label : label;
const mounted = node => node?.content?.mod === 'devkits-agents' && node.content.props?.view === 'service'
  || (node?.children || []).some(mounted);

// Requests belong to the caller's view. Closing it cancels its pending work; no
// native context is retained, and only pending requests read shared results.
export class AgentClient {
  constructor() { this.pending = new Map(); }
  init(cx, onStart = null, host = false) {
    if (this.started) return;
    this.started = true;
    cx.timer.every(100, cx => {
      if (this.pending.size) this.poll();
      if (host) {
        const events = shared('devkits.agents.navigation') || [];
        if (events.length) {
          setShared('devkits.agents.navigation', []);
          for (const event of events) if (event.expiresAt > Date.now()) onStart?.(event, cx);
        }
      }
    });
  }
  request(action, args) {
    if (!this.started || !mounted(layout())) return Promise.reject(new Error('Agents service is unavailable in this layout.'));
    const id = `agents:${Date.now()}:${Math.random().toString(36).slice(2)}`, expiresAt = Date.now() + 90000;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, expiresAt });
      setShared(REQUESTS, [...(shared(REQUESTS) || []), { id, action, ...args, expiresAt }]);
    });
  }
  discover(machine = null, refresh = false) { return this.request('discover', { machine, refresh }); }
  prepare(agent, target = {}, options = {}) { return this.request('prepare', { agent, target, options }); }
  poll() {
    const results = { ...(shared(RESULTS) || {}) };
    let changed = false; const completed = new Set();
    for (const [id, pending] of this.pending) {
      const result = results[id];
      if (!result && pending.expiresAt > Date.now()) continue;
      this.pending.delete(id); completed.add(id);
      delete results[id]; changed = true;
      if (!result || result.error) pending.reject(new Error(result?.error || 'Agents request timed out. Please retry.'));
      else pending.resolve(result.value);
    }
    if (changed) {
      setShared(RESULTS, results);
      setShared(REQUESTS, (shared(REQUESTS) || []).filter(item => !completed.has(item.id)));
    }
  }
  close() {
    this.started = false;
    const ids = new Set(this.pending.keys());
    if (!ids.size) return;
    setShared(REQUESTS, (shared(REQUESTS) || []).filter(item => !ids.has(item.id)));
    const results = { ...(shared(RESULTS) || {}) };
    for (const [id, pending] of this.pending) { delete results[id]; pending.reject(new Error('Agent request cancelled.')); }
    this.pending.clear(); setShared(RESULTS, results);
  }
}
