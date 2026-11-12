import { AgentClient } from '../components/agents.js';
import { shared, setShared, exec, appHome, home } from 'herdr';
import { launcherChoices, isAccountLauncher, configuredAgents, usageProvider } from '../components/session-model.js';
import { ensureClaudeStatusLine } from '../components/claude-usage-hook.js';
import { UsageClient } from '../components/usage.js';
const usageCacheMs = 5 * 60000;
const claudeDirectory = agent => agent.run.find(arg => arg.startsWith('CLAUDE_CONFIG_DIR='))?.slice(18) || `${home()}/.claude`;

export class UsageMonitor extends UsageClient {
  constructor({ machine = null, active = () => true } = {}) { super({ context: () => ({ machine }), active }); this.machine = machine; }
  projects() { return [{ active: true, machine: this.machine }]; }
  agentClient = new AgentClient();
  cachedAgents(machine, refresh = false) {
    const cached = shared('herdr-zed.agent-cache')?.[JSON.stringify(machine || null)];
    if (!refresh && cached) return Promise.resolve(machine ? cached.filter(agent => !isAccountLauncher(agent)) : configuredAgents(cached, shared('herdr-zed.agent-configs') || []));
    return this.agentClient.discover(machine, refresh);
  }
  snapshot() {
    const machine = this.projects().find(project => project.active)?.machine || null;
    const choices = launcherChoices(this.usageMachine === machine ? this.usageAgents || [] : [], shared('herdr-zed.launcher-order') || [])
      .filter(choice => choice.agent && usageProvider(choice.agent) && !(shared('herdr-zed.hidden-usage-profiles') || []).includes(choice.agent.key))
      .map(choice => ({ key: choice.key, name: choice.name,
        agent: { key: choice.agent.key, name: choice.agent.name, icon: choice.agent.icon, tint: choice.agent.tint },
        provider: machine ? null : usageProvider(choice.agent) }));
    const selected = new Set(choices.map(choice => choice.agent.key));
    const usage = (this.usage || []).filter(entry => selected.has(entry.key)).map(entry => ({ key: entry.key,
      checkedAt: entry.checkedAt, fetchedAt: entry.fetchedAt, error: entry.error, plan: entry.plan || null, email: entry.email || null,
      windows: entry.windows?.map(window => ({ bucket: window.bucket, name: window.name, slot: window.slot, minutes: window.minutes, usedPercent: window.usedPercent, resetsAt: window.resetsAt })) }));
    return { machine, choices, usage, loading: Boolean(this.usageLoading), error: this.usageError || null };
  }
  publish() {
    const snapshot = this.snapshot(), signature = JSON.stringify(snapshot);
    if (signature === this.published) return; this.published = signature;
    const cached = shared('herdr-zed.usage.snapshot') || {};
    setShared('herdr-zed.usage.snapshot', { contexts: { ...cached.contexts, [JSON.stringify(snapshot.machine)]: snapshot } });
  }
  refreshUsage(cx, force = true, manual = false) {
    if (!this.active()) { this.usageScope = null; return; }
    const machine = this.projects().find(project => project.active)?.machine || null;
    const hidden = shared('herdr-zed.hidden-usage-profiles') || [];
    const order = shared('herdr-zed.launcher-order') || [];
    const scope = JSON.stringify([machine, hidden, order, shared('herdr-zed.profile-revision') || 0]);
    if (this.usageLoading || (!force && this.usageScope === scope)) return;
    this.usageScope = scope;
    this.usageLoading = true; this.publish();
    cx.spawn(async cx => {
      try {
        this.agentClient.init(cx);
        const agents = await this.cachedAgents(machine, manual);
        if (!this.active() || (this.projects().find(project => project.active)?.machine || null) !== machine) return;
        this.usageAgents = agents.filter(agent => !agent.profileKey);
        if (this.usageMachine !== machine) this.usage = [];
        this.usageMachine = machine;
        this.usageError = null;
        this.publish(); cx.notify();
        const accounts = launcherChoices(this.usageAgents, order)
          .filter(choice => choice.agent && !(shared('herdr-zed.hidden-usage-profiles') || []).includes(choice.agent.key) && !machine && usageProvider(choice.agent)).map(choice => choice.agent);
        // Cached results survive reloads and restarts so providers are queried at most once per interval.
        const cached = () => shared('herdr-zed.usage-cache') || {};
        const now = Date.now();
        // Set up the status line once per app session; the built-in profile chains any status line it already has.
        this.statusLines ||= new Set();
        for (const account of accounts.filter(account => usageProvider(account) === 'claude' && !this.statusLines.has(account.key))) {
          if (!this.active()) return;
          this.statusLines.add(account.key);
          const directory = claudeDirectory(account);
          try { await ensureClaudeStatusLine(directory, { chain: account.key === 'claude', owned: directory.startsWith(`${appHome()}/data/herdr-zed/`) }); } catch {}
        }
        // Claude usage is a local file, so only provider queries are rate-limited by the cache.
        const stale = accounts.filter(account => manual || usageProvider(account) === 'claude'
          || !(now - (cached()[account.key]?.checkedAt || 0) < usageCacheMs)
          // Readings cached before plans or addresses were recorded are read again once.
          || (!cached()[account.key]?.error && !['plan', 'email'].every(field => Object.hasOwn(cached()[account.key] || {}, field))));
        this.usage = accounts.map(account => cached()[account.key]).filter(Boolean);
        if (stale.length) {
          if (!this.active()) return;
          this.publish(); cx.notify();
          const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/usage/usage-reader.js`,
            JSON.stringify(stale.map(account => ({ ...account, provider: usageProvider(account) })))]);
          if (result.code !== 0) throw new Error('Could not read usage');
          // Only current accounts are kept, so readings of removed or Devkits accounts are dropped.
          const known = new Set(accounts.map(account => account.key));
          const next = Object.fromEntries(Object.entries(cached()).filter(([key]) => known.has(key)));
          for (const entry of JSON.parse(result.stdout)) {
            const previous = next[entry.key];
            // Keep the last good windows when a later request fails.
            next[entry.key] = entry.error && previous?.windows
              ? { ...previous, error: entry.error, ...(entry.plan ? { plan: entry.plan } : {}), ...(entry.email ? { email: entry.email } : {}), checkedAt: Date.now() } : { ...entry, checkedAt: Date.now() };
          }
          setShared('herdr-zed.usage-cache', next);
          this.usage = accounts.map(account => next[account.key]).filter(Boolean);
        }
      } catch { this.usageError = 'Could not read usage'; }
      finally { this.usageLoading = false; this.publish(); cx.notify(); }
    });
  }
}
