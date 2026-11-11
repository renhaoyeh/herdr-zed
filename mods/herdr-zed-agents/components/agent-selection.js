// Shared: edit components/agent-selection.js, then npm run sync:shared.
import { shared, keys, window } from 'herdr';
import { folderKey, launcherChoices, autoLauncherKey, isAccountLauncher, autoAgent, autoUsage, usageProvider } from './session-model.js';
export const agentSelection = {
  defaultThreadAgent(project, agents) { return this.defaultThreadChoice(project, agents).agent; },

  // The remembered launcher for this project, or Auto's current pick when Auto was last used.
  defaultThreadChoice(project, agents) {
    const key = JSON.stringify([project.machine || '', folderKey(project.folder) || project.id]);
    const hidden = shared('herdr-zed.hidden-launchers') || [];
    const available = launcherChoices(agents, shared('herdr-zed.launcher-order') || [])
      .filter(choice => choice.agent && choice.agent.installed !== false && !hidden.includes(choice.key))
      .map(choice => choice.agent);
    for (const remembered of [shared('herdr-zed.last-thread-agents')?.[key], shared('herdr-zed.last-thread-agent')]) {
      const agent = remembered === autoLauncherKey ? this.autoThreadAgent(agents, project.machine)
        : available.find(agent => agent.key === remembered);
      if (agent) return { agent, auto: remembered === autoLauncherKey };
    }
    return { agent: available[0], auto: false };
  },

  // Auto chooses among your added accounts selected in Settings → Usage, by this computer's quota readings.
  autoThreadAgent(agents, machine) {
    if (machine) return null;
    // Accounts hidden from Usage have no readings, so Auto leaves them out too.
    const hidden = shared('herdr-zed.hidden-usage-profiles') || [];
    const members = (shared('herdr-zed.auto-accounts') || []).filter(key => !hidden.includes(key));
    const choices = launcherChoices(agents.filter(agent => isAccountLauncher(agent) && usageProvider(agent) && agent.installed !== false && members.includes(agent.key)),
      shared('herdr-zed.launcher-order') || []).map(choice => choice.agent).filter(Boolean);
    return autoAgent(choices, autoUsage(shared), Date.now(),
      shared('herdr-zed.auto-multipliers') || {});
  },
  newThreadShortcut() {
    const bindings = new Map();
    for (const section of ['global', 'layout:devkits', 'mod:devkits']) {
      for (const binding of keys().filter(binding => binding.section === section)) bindings.set(binding.keys, binding.action);
    }
    const shortcut = [...bindings].find(([, action]) => action === 'devkits.new-thread')?.[0];
    const mac = window()?.platform === 'macos';
    return shortcut?.split('-').map(part => ({ cmd: mac ? '⌘' : 'Super', ctrl: mac ? '⌃' : 'Ctrl',
      alt: mac ? '⌥' : 'Alt', shift: mac ? '⇧' : 'Shift' })[part] || part.toUpperCase()).join(mac ? '' : '+');
  },
};
