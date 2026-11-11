import { exec, knownAgents, readTextFile, appHome, shared, setShared } from 'herdr';
import { sessionKind, isAccountLauncher, configuredAgents } from './components/session-model.js';
const agentDiscoveryLoads = new Map();
export function availableAgents(profiles, machine) {
    if (machine) return profiles;
    return configuredAgents(profiles, shared('herdr-zed.agent-configs') || []);
  }
export async function discoverAgents(machine, refresh = false) {
    if (refresh) {
      const next = { ...(shared('herdr-zed.agent-cache') || {}) }; delete next[JSON.stringify(machine || null)];
      setShared('herdr-zed.agent-cache', next);
    }
    const key = JSON.stringify(machine || null);
    const cached = shared('herdr-zed.agent-cache')?.[key];
    if (cached) return availableAgents(cached, machine);
    if (agentDiscoveryLoads.has(key)) return availableAgents(await agentDiscoveryLoads.get(key), machine);
    const pending = (async () => {
      let agents = (await knownAgents({ on: machine }))
        .filter(agent => agent.installed && (!machine || !isAccountLauncher(agent)));
      // Native discovery can lag programs.json after a rename or removal.
      if (!machine) {
        const source = await readTextFile(`${appHome()}/programs.json`);
        const programs = source === null ? {} : JSON.parse(source).programs || {};
        // A just-saved account may precede the native programs watcher. Its
        // provider was already discovered; use the saved launcher immediately.
        for (const [key, entry] of Object.entries(programs)) {
          if (!isAccountLauncher({ key }) || agents.some(agent => agent.key === key) || !Array.isArray(entry?.run)) continue;
          const base = agents.find(agent => agent.key === sessionKind({ key }));
          if (base) agents.push({ ...base, ...entry, key, installed: true });
        }
        agents = agents.filter(agent => !isAccountLauncher(agent) || Object.hasOwn(programs, agent.key))
          .map(agent => typeof programs[agent.key]?.name === 'string'
          ? { ...agent, name: programs[agent.key].name } : agent);
      }
      setShared('herdr-zed.agent-cache', { ...(shared('herdr-zed.agent-cache') || {}), [key]: agents });
      return agents;
    })();
    agentDiscoveryLoads.set(key, pending);
    try { return availableAgents(await pending, machine); } finally { agentDiscoveryLoads.delete(key); }
  }


const identityReads = new Set();
export function loadAccountIdentities(cx, agents, machine = null) {
    if (machine) return;
    const usage = shared('herdr-zed.usage.snapshot')?.contexts?.[JSON.stringify(null)]?.usage || [];
    const missing = (agents || []).filter(agent => !agent.profileKey && ['claude', 'codex'].includes(sessionKind(agent))
      && !usage.find(item => item.key === agent.key)?.email && !identityReads.has(agent.key));
    if (!missing.length) return;
    for (const agent of missing) identityReads.add(agent.key);
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [`${appHome()}/mods/herdr-zed-agents/usage/usage-reader.js`,
          JSON.stringify(missing.map(agent => ({ key: agent.key, name: agent.name, run: agent.run, provider: sessionKind(agent) })))]);
        if (result.code === 0) {
          const saved = { ...(shared('herdr-zed.account-identities') || {}) };
          for (const entry of JSON.parse(result.stdout)) saved[entry.key] = { email: entry.email || null, plan: entry.plan || null };
          setShared('herdr-zed.account-identities', saved);
        }
      } catch {}
      cx.notify();
    });
  }
