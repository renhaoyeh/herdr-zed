import { shared, setShared, spaces } from 'herdr';
import { discoverAgents, loadAccountIdentities } from './discovery.js';
import { prepareSession } from './session-preparation.js';
import { ensureRules } from './global-rules.js';

export class AgentsService {
  pending = new Set();
  init(cx) {
    // Native discovery is refreshed once per service lifetime, never per consumer.
    setShared('devkits.agent-cache', {});
    cx.spawn(async cx => { try { await ensureRules(); } catch {} cx.notify(); });
    for (const machine of new Set([null, ...spaces().map(space => space.machine || null)]))
      cx.spawn(async cx => { try { const profiles = await discoverAgents(machine); loadAccountIdentities(cx, profiles, machine); } catch {} cx.notify(); });
    cx.timer.every(100, cx => this.poll(cx));
  }
  poll(cx) {
    const requests = shared('devkits.agents.requests') || [];
    const active = requests.filter(request => request.expiresAt > Date.now());
    if (active.length !== requests.length) setShared('devkits.agents.requests', active);
    const now = Date.now(), saved = shared('devkits.agents.results') || {};
    const recent = Object.fromEntries(Object.entries(saved).filter(([, result]) => result.expiresAt > now));
    if (Object.keys(recent).length !== Object.keys(saved).length) setShared('devkits.agents.results', recent);
    for (const request of requests) {
      if (request.expiresAt <= now || this.pending.has(request.id)) continue;
      this.pending.add(request.id);
      cx.spawn(async cx => {
        let result;
        try {
          const value = request.action === 'discover' ? await discoverAgents(request.machine, request.refresh)
            : request.action === 'prepare' ? await prepareSession(request.agent, request.target, request.options)
              : (() => { throw new Error('Unknown Agents request.'); })();
          result = { value: value ?? null };
        } catch (error) { result = { error: error.message }; }
        this.pending.delete(request.id);
        const queued = shared('devkits.agents.requests') || [];
        const alive = queued.some(item => item.id === request.id);
        setShared('devkits.agents.requests', queued.filter(item => item.id !== request.id));
        if (!alive || request.expiresAt <= Date.now()) return;
        const results = shared('devkits.agents.results') || {};
        setShared('devkits.agents.results', { ...results, [request.id]: { ...result, expiresAt: request.expiresAt } });
        cx.notify();
      });
    }
  }
}
