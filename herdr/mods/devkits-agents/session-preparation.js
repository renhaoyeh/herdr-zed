import { spaces, shared, appHome } from 'herdr';
import { configuredAgents, launcherArgv, sessionArgv, sessionKind, settingsKey, rulesArgv } from './components/session-model.js';
import { sessionMcpArgv } from './components/shared-mcp.js';
import { prepareEcc } from './ecc.js';
import { sessionRules } from './global-rules.js';

export async function prepareSession(agent, target = {}, options = {}) {
  const space = spaces().find(item => item.id === target.space);
  const machine = target.machine || space?.machine || null;
  const cached = shared('devkits.agent-cache')?.[JSON.stringify(machine)];
  const profiles = cached || [];
  const configs = shared('devkits.agent-configs') || [];
  let config = agent?.profileKey && configs.find(item => item.key === agent.key && item.profileKey === agent.profileKey);
  const available = machine ? profiles : configuredAgents(profiles, configs);
  let current = available.find(item => item.key === agent?.key) || agent;
  if (agent?.profileKey) {
    current = config && (available.find(item => item.key === agent.key && item.profileKey === agent.profileKey) || (!cached && agent));
    if (!current) throw new Error('Agent configuration is unavailable. Choose another agent configuration.');
  }

  const key = settingsKey(current), saved = shared('devkits.profile-sessions')?.[key] || {};
  const session = {
    model: options.model === undefined ? saved.model : options.model,
    effort: options.effort === undefined ? saved.effort : options.effort,
    serviceTier: saved.serviceTier,
    permission: shared('devkits.codex-permissions')?.[key] || 'default',
  };
  const hidden = shared('devkits.session-options')?.[sessionKind(current)] || {};
  if (hidden.models?.includes(session.model)) session.model = null;
  if (hidden.efforts?.includes(session.effort)) session.effort = null;

  const remote = Boolean(machine);
  let argv = current && sessionArgv(current, launcherArgv(current, session.permission), {
    ...session, tasksMcpHome: remote ? null : appHome(),
  });
  if (argv && !remote) {
    let rules = null;
    try { rules = await sessionRules(); } catch {}
    if (config) {
      config = (shared('devkits.agent-configs') || []).find(item => item.key === agent.key && item.profileKey === agent.profileKey);
      if (!config) throw new Error('Agent configuration is unavailable. Choose another agent configuration.');
    }
    argv = await sessionMcpArgv(current, argv);
    const ecc = await prepareEcc(current, argv);
    argv = ecc.argv;
    if (ecc.instructions) rules = { ...rules, composed: true, text: [rules?.text, '# ECC selected guidance\n\n' + ecc.instructions].filter(Boolean).join('\n\n') };
    argv = rulesArgv(current, argv, rules, config?.instructions);
  }
  if (agent?.profileKey && !(shared('devkits.agent-configs') || []).some(item => item.key === agent.key && item.profileKey === agent.profileKey))
    throw new Error('Agent configuration is unavailable. Choose another agent configuration.');
  return { argv, session };
}
