import { spaces, shared, appHome } from 'herdr';
import { configuredAgents, launcherArgv, sessionArgv, sessionKind, settingsKey, rulesArgv } from './components/session-model.js';
import { sessionMcpArgv } from './components/shared-mcp.js';
import { prepareEcc } from './ecc.js';
import { sessionDevkits } from './devkits.js';
import { sessionRules } from './global-rules.js';
import { composeSessionRules } from './global-rules-model.js';

// Resolve a chosen slash entry against this launch's active snapshot, preserving the task suffix.
export function skillCommandTask(task, selected, commands = []) {
  const match = /^\s*\/([^\s]+)(?:\s+|$)/.exec(task || '');
  const command = selected ? commands.find(item => item.id === selected) : match && commands.find(item => item.name === match[1]);
  if (selected && !command) throw Error('The selected skill is no longer available for this project and program. Choose it again.');
  if (!command) return null;
  if (!match || match[1] !== command.name) throw Error('The selected skill command changed. Choose it again.');
  return `Use the skill at \`${command.path.replaceAll('\\', '/')}\` for this task. Read its SKILL.md and resolve supporting files relative to it.\n\n${task.slice(match[0].length)}`;
}

export async function prepareSession(agent, target = {}, options = {}) {
  const space = spaces().find(item => item.id === target.space);
  const machine = target.machine || space?.machine || null;
  const cached = shared('herdr-zed.agent-cache')?.[JSON.stringify(machine)];
  const profiles = cached || [];
  const configs = shared('herdr-zed.agent-configs') || [];
  let config = agent?.profileKey && configs.find(item => item.key === agent.key && item.profileKey === agent.profileKey);
  const available = machine ? profiles : configuredAgents(profiles, configs);
  let current = available.find(item => item.key === agent?.key) || agent;
  if (agent?.profileKey) {
    current = config && (available.find(item => item.key === agent.key && item.profileKey === agent.profileKey) || (!cached && agent));
    if (!current) throw new Error('Agent configuration is unavailable. Choose another agent configuration.');
  }

  const key = settingsKey(current), saved = shared('herdr-zed.profile-sessions')?.[key] || {};
  const session = {
    model: options.model === undefined ? saved.model : options.model,
    effort: options.effort === undefined ? saved.effort : options.effort,
    serviceTier: options.serviceTier === undefined ? saved.serviceTier : options.serviceTier,
    permission: shared('herdr-zed.codex-permissions')?.[key] || 'default',
  };
  const hidden = shared('herdr-zed.session-options')?.[sessionKind(current)] || {};
  if (hidden.models?.includes(session.model)) session.model = null;
  if (hidden.efforts?.includes(session.effort)) session.effort = null;

  const remote = Boolean(machine);
  if (remote && options.command) throw Error('This skill is available only for local sessions.');
  let task = null;
  let argv = current && sessionArgv(current, launcherArgv(current, session.permission), {
    ...session, tasksMcpHome: remote ? null : appHome(),
  });
  if (argv && !remote) {
    let rules = null;
    try { rules = await sessionRules(); } catch {}
    if (config) {
      config = (shared('herdr-zed.agent-configs') || []).find(item => item.key === agent.key && item.profileKey === agent.profileKey);
      if (!config) throw new Error('Agent configuration is unavailable. Choose another agent configuration.');
    }
    const ecc = await prepareEcc(current, argv, { ...target, folder: target.folder || space?.folder });
    argv = await sessionMcpArgv(current, ecc.argv, ecc.mcp);
    const kits = await sessionDevkits(current, { ...target, folder: target.folder || space?.folder }, ecc.mcp, argv);
    task = skillCommandTask(target.task, options.command, kits?.commands);
    if (kits?.argv) argv = kits.argv;
    if (kits || ecc.instructions) {
      const text = composeSessionRules(rules?.text, kits, ecc.instructions);
      rules = text ? { ...rules, composed: true, text } : rules;
    }
    argv = rulesArgv(current, argv, rules, config?.instructions);
  }
  if (agent?.profileKey && !(shared('herdr-zed.agent-configs') || []).some(item => item.key === agent.key && item.profileKey === agent.profileKey))
    throw new Error('Agent configuration is unavailable. Choose another agent configuration.');
  return { argv, session, ...(task ? { task } : {}) };
}
