import { exec, knownAgents, readTextFile, appHome, shared, setShared } from 'herdr';
import { sessionKind, isAccountLauncher, configuredAgents, profileSettings } from './components/session-model.js';
const agentDiscoveryLoads = new Map();
export function availableAgents(profiles, machine) {
    if (machine) return profiles;
    // Discard legacy profile visibility flags once; afterwards profiles hide like any other launcher.
    if (!shared('devkits.profile-visibility')) {
      const hiddenLaunchers = shared('devkits.hidden-launchers') || [];
      const nativeHidden = hiddenLaunchers.filter(key => !key.startsWith('agent:devkits-preset-'));
      if (nativeHidden.length !== hiddenLaunchers.length) setShared('devkits.hidden-launchers', nativeHidden);
      setShared('devkits.profile-visibility', true);
    }
    if (profiles.length && shared('devkits.hidden-usage-profiles') === undefined) {
      const hidden = shared('devkits.hidden-launchers') || [];
      setShared('devkits.hidden-usage-profiles', profiles.filter(agent => !agent.profileKey && hidden.includes(`agent:${agent.key}`)).map(agent => agent.key));
    }
    if (profiles.length && !shared('devkits.independent-agent-defaults')) {
      for (const key of ['devkits.codex-permissions', 'devkits.profile-sessions']) {
        const saved = shared(key) || {}, next = profileSettings(saved, profiles.filter(agent => !agent.profileKey));
        if (next !== saved) setShared(key, next);
      }
      setShared('devkits.independent-agent-defaults', true);
    }
    return configuredAgents(profiles, shared('devkits.agent-configs') || []);
  }
export async function discoverAgents(machine, refresh = false) {
    if (refresh) {
      const next = { ...(shared('devkits.agent-cache') || {}) }; delete next[JSON.stringify(machine || null)];
      setShared('devkits.agent-cache', next);
    }
    const key = JSON.stringify(machine || null);
    const cached = shared('devkits.agent-cache')?.[key];
    if (cached) return availableAgents(cached, machine);
    if (agentDiscoveryLoads.has(key)) return availableAgents(await agentDiscoveryLoads.get(key), machine);
    const pending = (async () => {
      let agents = (await knownAgents({ on: machine }))
        .filter(agent => agent.installed && (!machine || !isAccountLauncher(agent)));
      // Native discovery can lag programs.json after a rename or removal.
      if (!machine) {
        const source = await readTextFile(`${appHome()}/programs.json`);
        const programs = source === null ? {} : JSON.parse(source).programs || {};
        agents = agents.filter(agent => !isAccountLauncher(agent) || Object.hasOwn(programs, agent.key))
          .map(agent => typeof programs[agent.key]?.name === 'string'
          ? { ...agent, name: programs[agent.key].name } : agent);
      }
      setShared('devkits.agent-cache', { ...(shared('devkits.agent-cache') || {}), [key]: agents });
      return agents;
    })();
    agentDiscoveryLoads.set(key, pending);
    try { return availableAgents(await pending, machine); } finally { agentDiscoveryLoads.delete(key); }
  }


const identityReads = new Set();
export function loadAccountIdentities(cx, agents, machine = null) {
    if (spaces().find(space => space.id === props()?.space)?.machine) return;
    const usage = shared('devkits.usage.snapshot')?.contexts?.[JSON.stringify(null)]?.usage || [];
    const missing = (agents || []).filter(agent => !agent.profileKey && ['claude', 'codex'].includes(sessionKind(agent))
      && !usage.find(item => item.key === agent.key)?.email && !identityReads.has(agent.key));
    if (!missing.length) return;
    for (const agent of missing) identityReads.add(agent.key);
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [`${appHome()}/mods/devkits-usage/usage-reader.js`,
          JSON.stringify(missing.map(agent => ({ key: agent.key, name: agent.name, run: agent.run, provider: sessionKind(agent) })))]);
        if (result.code === 0) {
          const saved = { ...(shared('devkits.account-identities') || {}) };
          for (const entry of JSON.parse(result.stdout)) saved[entry.key] = { email: entry.email || null, plan: entry.plan || null };
          setShared('devkits.account-identities', saved);
        }
      } catch {}
      cx.notify();
    });
  }
