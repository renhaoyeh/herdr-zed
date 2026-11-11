import { shared, setShared, spaces } from 'herdr';
import { discoverAgents, loadAccountIdentities } from './discovery.js';
import { prepareSession } from './session-preparation.js';
import { ensureRules } from './global-rules.js';
import { emitLaunch } from './launch.js';
import { publishDecorations } from './decorations.js';

export class AgentsService {
  pending = new Set();
  init(cx) {
    // Native discovery is refreshed once per service lifetime, never per consumer.
    setShared('herdr-zed.agent-cache', {});
    cx.spawn(async cx => { try { await ensureRules(); } catch {} cx.notify(); });
    for (const machine of new Set([null, ...spaces().map(space => space.machine || null)]))
      cx.spawn(async cx => { try { const profiles = await discoverAgents(machine); loadAccountIdentities(cx, profiles, machine); } catch {} cx.notify(); });
    cx.timer.every(100, cx => this.poll(cx));
    cx.timer.every(1000, () => publishDecorations());
  }
  poll(cx) {
    const requests = shared('herdr-zed.agents.requests') || [];
    const active = requests.filter(request => request.expiresAt > Date.now());
    if (active.length !== requests.length) setShared('herdr-zed.agents.requests', active);
    const now = Date.now(), saved = shared('herdr-zed.agents.results') || {};
    const recent = Object.fromEntries(Object.entries(saved).filter(([, result]) => result.expiresAt > now));
    if (Object.keys(recent).length !== Object.keys(saved).length) setShared('herdr-zed.agents.results', recent);
    for (const request of requests) {
      if (request.expiresAt <= now || this.pending.has(request.id)) continue;
      this.pending.add(request.id);
      cx.spawn(async cx => {
        let result;
        try {
          const value = request.action === 'discover' ? await discoverAgents(request.machine, request.refresh)
            : request.action === 'prepare' ? await prepareSession(request.agent, request.target, request.options)
              : request.action === 'launch' ? await emitLaunch(request.agent, request.target, request.options, request.origin)
                : (() => { throw new Error('Unknown Agents request.'); })();
          result = { value: value ?? null };
        } catch (error) { result = { error: error.message }; }
        this.pending.delete(request.id);
        const queued = shared('herdr-zed.agents.requests') || [];
        const alive = queued.some(item => item.id === request.id);
        setShared('herdr-zed.agents.requests', queued.filter(item => item.id !== request.id));
        if (!alive || request.expiresAt <= Date.now()) return;
        const results = shared('herdr-zed.agents.results') || {};
        setShared('herdr-zed.agents.results', { ...results, [request.id]: { ...result, expiresAt: request.expiresAt } });
        cx.notify();
      });
    }
  }
}
