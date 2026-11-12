// Shared: edit components/session-model.js, then npm run sync:shared.
import { unwrapTerminalArgv } from './session-shell.js';

export function quotaElapsedPercent(window, now = Date.now()) {
  const duration = window.minutes * 60000;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(window.resetsAt) || window.resetsAt <= 0) return null;
  const remaining = window.resetsAt * 1000 - now;
  // An expired or inconsistent reset belongs to stale data, not a new window.
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > duration) return null;
  return (1 - remaining / duration) * 100;
}

export function quotaResetLabel(window, now = Date.now()) {
  if (!Number.isFinite(window.resetsAt) || window.resetsAt <= 0) return 'Reset time unavailable';
  const minutes = Math.ceil((window.resetsAt * 1000 - now) / 60000);
  if (minutes <= 0) return 'Reset due · awaiting refresh';
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `Resets in ${hours ? `${hours}h ` : ''}${minutes % 60}m`;
}

// Auto starts the member with the most room: its plan multiplier times quota left per time left,
// in its tightest window (1 = on pace). Members at a limit go last, soonest reset first;
// members without readings count as on pace.
export const autoLauncherKey = 'auto';
// Quota readings and account identity share the same plan. A hidden or not-yet-loaded
// Usage surface must not turn a known plan back into the default x1.
export function autoUsage(read) {
  const readings = read('herdr-zed.usage.snapshot')?.contexts?.[JSON.stringify(null)]?.usage || [];
  const identities = read('herdr-zed.account-identities') || {};
  const keys = new Set([...Object.keys(identities), ...readings.map(account => account.key)]);
  return [...keys].map(key => {
    const reading = readings.find(account => account.key === key);
    return { ...reading, key, plan: reading?.plan || identities[key]?.plan || null };
  });
}
export const autoMultipliers = [1, 5, 20];
// Plan size by price tier: Plus/Business and Claude Pro x1, Pro $100 (prolite) and Max 5x x5, Pro $200 and Max 20x x20.
const planSizes = { pro: 20, prolite: 5, claude_max: 5, claude_max_20x: 20, claude_max_5x: 5 };
const planNames = { plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', go: 'Go', free: 'Free',
  prolite: 'Pro Lite', pro: 'Pro', claude_pro: 'Pro', claude_max: 'Max', claude_max_5x: 'Max 5x', claude_max_20x: 'Max 20x' };
export const planMultiplier = plan => planSizes[plan] || 1;
export const planLabel = plan => !plan ? null : planNames[plan] || plan;
export const autoMultiplier = (key, account, saved = {}) => saved[key] || planMultiplier(account?.plan);
export function autoRank(account, multiplier = 1, now = Date.now()) {
  const windows = (account?.windows || [])
    .filter(window => Number.isFinite(window.usedPercent) && !(window.resetsAt > 0 && window.resetsAt * 1000 <= now));
  const full = windows.filter(window => window.usedPercent >= 100);
  if (full.length) return { full: true, resetsAt: Math.max(...full.map(window => window.resetsAt > 0 ? window.resetsAt : Infinity)) };
  const rates = windows.map(window => (100 - window.usedPercent) / Math.max(1, 100 - (quotaElapsedPercent(window, now) ?? 0)));
  return { full: false, known: windows.length > 0, room: multiplier * (rates.length ? Math.min(...rates) : 1) };
}
export function autoAgent(members, usage = [], now = Date.now(), multipliers = {}) {
  const ranked = members.map((agent, index) => [agent,
    autoRank(usage.find(account => account.key === agent.key),
      autoMultiplier(agent.key, usage.find(account => account.key === agent.key), multipliers), now), index]);
  ranked.sort(([, a, i], [, b, j]) => a.full - b.full || (a.full ? a.resetsAt - b.resetsAt : b.room - a.room) || i - j);
  return ranked[0]?.[0] || null;
}

export const codexPermissionModes = [
  { key: 'default', label: 'Default', description: 'Use this launcher’s existing Codex settings.', args: [] },
  { key: 'read-only', label: 'Read only', description: 'Read files. Request approval when additional access is needed.',
    args: ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'] },
  { key: 'workspace-write', label: 'Workspace', description: 'Write in the workspace. Request approval for additional access.',
    args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] },
  { key: 'danger-full-access', label: 'Full access', description: 'Write outside the workspace and run commands without sandboxing or approval.',
    args: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'] },
];

export const claudePermissionModes = [
  { key: 'default', label: 'Default', description: 'Use this launcher’s existing Claude Code settings.', args: [] },
  { key: 'plan', label: 'Plan', description: 'Read files and plan. Ask before editing files or running commands.',
    args: ['--permission-mode', 'plan'] },
  { key: 'acceptEdits', label: 'Accept edits', description: 'Edit files without asking. Ask before running commands.',
    args: ['--permission-mode', 'acceptEdits'] },
  { key: 'bypassPermissions', label: 'Full access', description: 'Edit files and run commands without permission prompts.',
    args: ['--permission-mode', 'bypassPermissions'] },
];

// Native programs.json is global to Herdr. A launcher referencing another product's
// data directory is not part of this shell; ordinary system programs remain available.
export function programInScope(agent, root) {
  const data = `${String(root).replaceAll('\\', '/')}/data/`;
  return (agent?.run || []).every(arg => {
    const text = String(arg).replaceAll('\\', '/');
    const offset = text.indexOf(data);
    return offset < 0 || text.slice(offset + data.length).startsWith('herdr-zed/');
  });
}

export const isAccountLauncher = agent => /^herdr-zed-(?:codex|claude)-/.test(agent?.key || '');
export const isCodexLauncher = agent => (agent?.profileKey || agent?.key) === 'codex' || Boolean((agent?.profileKey || agent?.key)?.startsWith('herdr-zed-codex-'));
export const isClaudeLauncher = agent => (agent?.profileKey || agent?.key) === 'claude' || Boolean((agent?.profileKey || agent?.key)?.startsWith('herdr-zed-claude-'));
export const permissionModes = agent => isCodexLauncher(agent) ? codexPermissionModes
  : isClaudeLauncher(agent) ? claudePermissionModes : null;

const permissionFlags = {
  codex: { name: 'Codex', executable: /(?:^|[/\\])codex(?:\.exe|\.cmd)?$/i, valued: ['--sandbox', '-s', '--ask-for-approval', '-a'],
    drop: arg => /^--(?:sandbox|ask-for-approval)=|^-[sa]=|^-[sa](?:read-only|workspace-write|danger-full-access|never|on-request)$/.test(arg) ||
      ['--full-auto', '--approve-for-me', '--not-so-yolo', '--yolo', '--dangerously-bypass-approvals-and-sandbox'].includes(arg) },
  claude: { name: 'Claude', executable: /(?:^|[/\\])claude(?:\.exe|\.cmd)?$/i, valued: ['--permission-mode'],
    drop: arg => arg.startsWith('--permission-mode=') || arg === '--dangerously-skip-permissions' },
};

export function launcherArgv(agent, permission) {
  const mode = permissionModes(agent)?.find(mode => mode.key === permission);
  if (!mode?.args.length) return agent?.run;
  const flags = permissionFlags[isCodexLauncher(agent) ? 'codex' : 'claude'];
  const executable = agent.run.findIndex(arg => !arg.includes('=') && flags.executable.test(arg));
  if (executable < 0) throw new Error(`Could not find ${flags.name} in this launcher. Choose Default to keep its existing command.`);
  const rest = [];
  for (let i = executable + 1; i < agent.run.length; i++) {
    const arg = agent.run[i];
    if (arg === '--') { rest.push(...agent.run.slice(i)); break; }
    if (flags.valued.includes(arg)) { i++; continue; }
    if (flags.drop(arg)) continue;
    rest.push(arg);
  }
  return [...agent.run.slice(0, executable + 1), ...mode.args, ...rest];
}

// Per-session model and effort for Claude and Codex launchers; Default leaves the command as it is.
export const claudeModels = [['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
  .map(([key, label]) => ({ key, label }));
export const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
export const codexHome = (agent, home) => agent?.run?.find(arg => arg.startsWith('CODEX_HOME='))?.slice(11) || `${home}/.codex`;

// Codex lists its models, and each model's reasoning efforts, in models_cache.json.
export function codexModels(source) {
  let models;
  try { models = JSON.parse(source)?.models; } catch { return []; }
  return (Array.isArray(models) ? models : []).filter(model => model?.slug && model.visibility === 'list')
    .map(model => ({ key: model.slug, label: model.display_name || model.slug,
      efforts: (model.supported_reasoning_levels || []).map(level => level?.effort || level).filter(effort => typeof effort === 'string') }));
}

export const sessionKind = agent => isClaudeLauncher(agent) ? 'claude' : isCodexLauncher(agent) ? 'codex' : null;
// The readers support Codex commands and Claude profiles with a managed recorder.
// Derived agent configurations share their parent account's quota.
export function usageProvider(agent) {
  if (!Array.isArray(agent?.run) || agent.profileKey || agent.installed === false) return null;
  if (agent.run.some(arg => !arg.includes('=') && /(?:^|[/\\])codex(?:\.exe)?$/i.test(arg))) return 'codex';
  return agent.key === 'claude' || (agent.key?.startsWith('herdr-zed-claude-')
    && agent.run.some(arg => arg.startsWith('CLAUDE_CONFIG_DIR='))) ? 'claude' : null;
}


// Each profile's default agent and each named agent configuration have independent settings.
export const settingsKey = agent => agent?.key;

// Program icons identify the provider; account and agent labels carry only their useful names.
const providerLabel = /^(?:codex(?: cli)?|claude(?: code)?)$/i;
export const launcherLabel = name => {
  const label = (name || '').trim().replace(/^(?:codex(?: cli)?|claude(?: code)?)\s*(?:·|\/)\s*/i, '').trim();
  return providerLabel.test(label) ? 'Default account' : label;
};

// All account and agent selects share their label, provider icon and tint policy.
export const noAccountLabel = 'No account';

// Known signed-in addresses, read from shared state: Usage's readings, then addresses read for accounts Usage hides.
export function accountAddresses(read) {
  const usage = read('herdr-zed.usage.snapshot')?.contexts?.[JSON.stringify(null)]?.usage || [];
  const saved = read('herdr-zed.account-identities') || {};
  return key => usage.find(item => item.key === key)?.email || saved[key]?.email || null;
}

// The program a Default account runs, as the New thread picker names it.
export const programName = agent => sessionKind(agent) === 'claude' ? 'Claude Code' : 'Codex CLI';

// With `address`, a Default account is named like the New thread picker: "Program · address" when its signed-in address is
// known, else the program name. Named accounts keep their own name. Every account list uses this one rule.
export function launcherOption(agent, address = null) {
  const kind = sessionKind(agent);
  let label = launcherLabel(agent.name || kind || 'Unnamed agent');
  if (address && label === 'Default account' && !agent.profileKey && kind) {
    const email = address(agent.key);
    label = email ? `${programName(agent)} · ${email}` : programName(agent);
  }
  return { key: agent.key, label,
    icon: agent.icon || (kind ? `icons/${kind}.svg` : 'agent'), iconTint: agent.icon ? Boolean(agent.tint) : !kind };
}

// Configurations reuse the profile's executable and credentials, with their own stable launcher identity.
export function configuredAgents(profiles = [], configs = []) {
  const originals = profiles.filter(agent => !agent.profileKey);
  const known = new Set(originals.map(agent => agent.key));
  return [...originals, ...configs.flatMap(config => {
    const profile = originals.find(agent => agent.key === config.profileKey);
    if (!profile || !sessionKind(profile) || !config.key?.startsWith('herdr-zed-preset-') || known.has(config.key)) return [];
    known.add(config.key);
    const defaultProfile = profile.key === sessionKind(profile) && (!profile.name || providerLabel.test(profile.name.trim()));
    return [{ ...profile, key: config.key, profileKey: profile.key, configName: config.name,
      name: defaultProfile ? config.name : `${config.name} - ${launcherLabel(profile.name || profile.key)}` }];
  })];
}

// Every Codex profile shares one choice of models, so their caches are merged by model.
export function mergeModels(lists) {
  const models = new Map();
  for (const model of lists.flat()) {
    const known = models.get(model.key);
    models.set(model.key, known ? { ...known, efforts: [...new Set([...known.efforts, ...model.efforts])] } : model);
  }
  return [...models.values()];
}

// Manage hides models and efforts by key, so ones Codex adds later still appear.
export const shownOptions = (items, hidden = []) => items.filter(item => !hidden.includes(typeof item === 'string' ? item : item.key));

export const effortLabel = effort => effort === 'xhigh' ? 'XHigh' : effort[0].toUpperCase() + effort.slice(1);

// The models and efforts a provider offers after Manage's order and switches; efforts narrow to the chosen model's for Codex.
export function sessionChoices(kind, codexList, settings = {}, model = null) {
  const models = shownOptions(orderedOptions(kind === 'claude' ? claudeModels : codexList || [], settings.order), settings.models);
  const levels = kind === 'claude' ? claudeEfforts
    : [...new Set((model ? models.filter(item => item.key === model) : models).flatMap(item => item.efforts))];
  return { models, efforts: shownOptions(levels, settings.efforts) };
}

// Models follow the order dragged in Manage; ones it has not seen keep their own order after them.
export function orderedOptions(items, order = []) {
  const ranks = new Map(order.map((key, index) => [key, index]));
  return items.map((item, index) => [item, ranks.get(item.key) ?? order.length + index])
    .sort((a, b) => a[1] - b[1]).map(([item]) => item);
}

// Moves `key` to where `target` is, within the full list of keys.
export function moveOption(keys, key, target) {
  const from = keys.indexOf(key), to = keys.indexOf(target);
  if (from < 0 || to < 0 || from === to) return keys;
  const next = [...keys];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

export function tasksMcpServer(directory, kind = 'codex') {
  return { command: 'node', args: [`${directory.replace(/\\/g, '/')}/mods/herdr-zed-tasks/mcp-server.cjs`], env: { HERDR_APP_HOME: directory },
    // Codex filters stdio server environments; forward each launch's live identity.
    ...(kind === 'codex' ? { env_vars: ['HC_TERMINAL_ID'] } : {}) };
}

export function sessionArgv(agent, argv, { model, effort, serviceTier, tasksMcpHome } = {}) {
  const kind = isCodexLauncher(agent) ? 'codex' : isClaudeLauncher(agent) ? 'claude' : null;
  const fast = kind === 'codex' && serviceTier === 'fast';
  if (!kind || (!model && !effort && !fast && !tasksMcpHome)) return argv;
  const executable = argv.findIndex(arg => !arg.includes('=') && permissionFlags[kind].executable.test(arg));
  if (executable < 0) throw new Error(`Could not find ${permissionFlags[kind].name} in this launcher. Choose Default for session settings.`);
  const flags = kind === 'claude'
    ? [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])]
    : [...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      ...(fast ? ['-c', 'service_tier="fast"'] : [])];
  if (tasksMcpHome) {
    const server = tasksMcpServer(tasksMcpHome, kind);
    if (kind === 'claude') flags.push('--mcp-config', JSON.stringify({ mcpServers: { herdr_tasks: server } }));
    else flags.push('-c', `mcp_servers.herdr_tasks={command="node",args=${JSON.stringify(server.args)},env={HERDR_APP_HOME=${JSON.stringify(tasksMcpHome)}},env_vars=${JSON.stringify(server.env_vars)}}`);
  }
  const rest = [];
  const overridesConfig = value => (model && /^model\s*=/.test(value)) || (effort && /^model_reasoning_effort\s*=/.test(value)) ||
    (fast && /^service_tier\s*=/.test(value));
  for (let i = executable + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { rest.push(...argv.slice(i)); break; }
    if ((model && (arg === '--model' || (kind === 'codex' && arg === '-m'))) ||
        (effort && kind === 'claude' && arg === '--effort')) { i++; continue; }
    if ((model && (/^--model=/.test(arg) || (kind === 'codex' && /^-m.+/.test(arg)))) ||
        (effort && kind === 'claude' && /^--effort=/.test(arg))) continue;
    if (kind === 'codex') {
      if ((arg === '-c' || arg === '--config') && overridesConfig(argv[i + 1] || '')) { i++; continue; }
      if (/^(?:-c|--config=)/.test(arg) && overridesConfig(arg.replace(/^(?:--config=|-c=?)/, ''))) continue;
    }
    rest.push(arg);
  }
  return [...argv.slice(0, executable + 1), ...flags, ...rest];
}

// Profile instructions follow global rules, without replacing the provider's base system prompt.
export function rulesArgv(agent, argv, rules, additional = '') {
  const kind = sessionKind(agent);
  const executable = argv.findIndex(arg => !arg.includes('=') && /(?:^|[/\\])(?:claude|codex)(?:\.exe|\.cmd)?$/i.test(arg));
  const extra = additional.trim();
  if ((!rules && !extra) || !kind || executable < 0) return argv;
  const text = extra ? [rules?.text?.trim(), `# Agent profile instructions\n\n${extra}`].filter(part => part?.trim()).join('\n\n') : rules.text;
  const flags = kind === 'claude' ? extra || rules?.composed ? ['--append-system-prompt', text] : ['--append-system-prompt-file', rules.file]
    // A JSON string is also a valid TOML basic string.
    : ['-c', `developer_instructions=${JSON.stringify(text)}`];
  return [...argv.slice(0, executable + 1), ...flags, ...argv.slice(executable + 1)];
}

export function launcherChoices(agents, order = []) {
  const choices = [{ key: 'terminal', name: 'Terminal', group: 0 },
    ...agents.map(agent => ({ key: `agent:${agent.key}`, name: launcherLabel(agent.name), agent,
      group: agent.profileKey ? 3 : isAccountLauncher(agent) ? 2 : 1 }))];
  const ranks = new Map(order.map((key, index) => [key, index]));
  return choices.sort((a, b) => a.group - b.group || (ranks.get(a.key) ?? order.length) - (ranks.get(b.key) ?? order.length));
}

export function threadTitle(tab, agent, space, { launcherName, taskName } = {}) {
  if (taskName?.trim()) return taskName.trim();
  const providers = agent ? ['Codex', 'Claude', agent.program?.name, agent.app].filter(Boolean) : [];
  const folders = [agent?.space_name, space?.name, space?.folder,
    space?.folder?.split(/[\\/]/).filter(Boolean).at(-1)].filter(Boolean);
  // Codex appends its repository to the terminal title ("Task | repo"); the project is already shown.
  const codex = agent?.app === 'codex' || isCodexLauncher(agent?.program);
  let fallback;
  for (const value of [tab.named ? tab.name : '', agent?.title, agent?.tab_name, tab.name]) {
    let title = (value || '').replace(/^[\u2800-\u28ff✳✻✽✶✢✦✴✹✺]\s*/u, '').trim();
    if (codex && value === agent.title) title = title.replace(/\s+\|\s+[^|]+$/, '');
    if (!title || (/^\d+$/.test(title) && !(tab.named && value === tab.name))) continue;
    // Launchers set a native tab name too; that automatic label is only a fallback.
    if (launcherName && title === launcherName && !providerLabel.test(title)) { fallback ||= launcherLabel(launcherName); continue; }
    for (const provider of providers) {
      if (title.toLowerCase() === provider.toLowerCase()) { title = ''; break; }
      if (title.toLowerCase().startsWith(`${provider.toLowerCase()} · `)) {
        fallback ||= title.slice(provider.length + 3).trim(); title = ''; break;
      }
    }
    const named = tab.named && value === tab.name;
    if (!named && (folders.includes(title) || /^(?:[~/\\]|[A-Za-z]:[\\/])/.test(title))) continue;
    if (title) return title;
  }
  return fallback || (agent ? 'New thread' : 'Terminal');
}

// A started session is the first tab that appears in its project afterwards; remember which profile ran it.
// A session started from an Asana task also links its tab to that task.
export function resolveThreadProfiles(spaces, pending = [], profiles = {}, now = Date.now(), tasks = {}) {
  const next = { ...profiles }, links = { ...tasks }, restored = [];
  const waiting = pending.filter(entry => {
    const space = spaces.find(space => entry.space ? space.id === entry.space
      : !space.machine && folderKey(space.folder) === folderKey(entry.folder));
    const tab = space?.tabs.find(tab => !entry.before.includes(tab.id) && !next[tab.id]);
    if (tab) next[tab.id] = entry.key;
    if (tab && entry.task) links[tab.id] = entry.task;
    if (tab && entry.restoreArchiveId) restored.push({ id: entry.restoreArchiveId, folder: entry.folder, task: entry.task, tab: tab.id, at: now });
    return !tab && now - entry.at < 60000;
  });
  return { pending: waiting, profiles: Object.fromEntries(Object.entries(next).slice(-200)),
    tasks: Object.fromEntries(Object.entries(links).slice(-200)), ...(restored.length ? { restored } : {}) };
}

// Threads started before profiles were recorded are still named after their launcher.
export function threadProfile(tab, launchers = [], profiles = {}) {
  const profile = launchers.find(agent => agent.key === profiles[tab.id])
    || (tab.named ? launchers.find(agent => agent.name === tab.name) : null);
  return profile ? launcherLabel(profile.name) || null : null;
}

// Live terminals an agent started with hc run (and theirs, one level deeper each), in start order.
export function childTerminals(terminals = [], parents = [], depth = 1, maxDepth = 3, seen = new Set(parents)) {
  return parents.flatMap(parent => terminals.filter(terminal => terminal.parent === parent && terminal.state === 'live')
    .flatMap(terminal => {
      if (seen.has(terminal.address)) return [];
      seen.add(terminal.address);
      return [{ terminal, depth, label: terminalLabel(terminal) },
        ...(depth < maxDepth ? childTerminals(terminals, [terminal.address], depth + 1, maxDepth, seen) : [])];
    }));
}

// Its name, else the command a shell runs for it (sh -c "…"), else the program.
export function terminalLabel(terminal) {
  if (terminal.name) return terminal.name;
  const argv = terminal.argv || [];
  const shell = /(?:^|\/)(?:sh|bash|zsh)$/.test(argv[0] || '') && argv[1] === '-c';
  return (shell ? argv[2] : argv.join(' ')) || terminal.agent || terminal.address;
}

// A live shell is usually waiting for input; a foreground command is running.
// Agent reports take precedence: an idle/blocked agent still owns a foreground process.
// design.md / review L12: the spinner shows only what an agent reports as working. A plain terminal running a foreground
// process (npm run dev) keeps its terminal icon; terminalWorking is for the terminal's own state, not for the spinner.
export function agentReportedWorking(terminal, status = terminal?.status) {
  return status === 'working' && Boolean(terminal?.program?.agent || terminal?.agent);
}

export function terminalWorking(terminal) {
  if (!terminal || (terminal.state && terminal.state !== 'live')) return false;
  if (terminal.status) return terminal.status === 'working';
  if (terminal.program?.agent) return false;
  const foreground = terminal.foreground;
  if (!foreground?.pid) return false;
  const argv = foreground.argv || [];
  const name = (foreground.name || argv[0] || '').split(/[/\\]/).pop().replace(/^-|\.exe$/gi, '').toLowerCase();
  if (!name) return false;
  const shell = /^(?:sh|bash|dash|ash|zsh|ksh|mksh|fish|nu|pwsh|powershell|cmd|elvish|xonsh|tcsh|csh)$/.test(name)
    || (terminal.program?.shell && terminal.program.name?.toLowerCase() === name);
  if (!shell) return true;
  // A shell executing a script/command (including Herdr's Run wrapper) is busy.
  return argv.slice(1).some(arg => /^-[a-z]*c(?:$|=)/i.test(arg) || /^(?:--command(?:=|$)|\/c$|-command$|-file$)/i.test(arg))
    || Boolean(argv[1] && !argv[1].startsWith('-') && !/^\/[ck]$/i.test(argv[1]));
}

// Claude and Codex threads on this machine can be archived and resumed later; remote ids carry a machine/ prefix.
export const archivable = (thread, terminals = []) => (thread.agents || []).some(agent => {
  const terminal = terminals.find(terminal => terminal.address === agent.address);
  return ['claude-code', 'codex'].includes(agent.app) && (!terminal || Boolean(commandKind(terminal.argv)));
})
  && !String(thread.space || '').includes('/');

// An agent run inside an existing shell keeps the terminal's identity.
export function threadProgram(thread, terminals, fallback = thread?.agent?.program) {
  const agent = thread?.agent;
  const terminal = terminals.find(terminal => terminal.address === agent?.address);
  return terminal && ['claude-code', 'codex'].includes(agent?.app) && !commandKind(terminal.argv) ? null : fallback;
}

// The agent command inside a terminal's argv, without the login shell Herdr wraps it in.
export function agentCommand(argv = []) {
  argv = unwrapTerminalArgv(argv);
  const start = argv.findIndex(arg => arg === 'env' || commandKind([arg]));
  return start < 0 ? null : argv.slice(start);
}

export function commandKind(command = []) {
  command = unwrapTerminalArgv(command);
  const executable = command.find(arg => !arg.includes('=') && /(?:^|[/\\])(?:claude|codex)(?:\.exe|\.cmd)?$/i.test(arg));
  return executable ? (/codex(?:\.exe|\.cmd)?$/i.test(executable) ? 'codex' : 'claude') : null;
}

// The same command, account and flags, reopening `id` instead of starting over; a task prompt is not sent again.
export function resumeArgv(command, id, prompt = false) {
  const kind = commandKind(command);
  const executable = command.findIndex(arg => !arg.includes('=') && commandKind([arg]));
  const rest = command.slice(executable + 1, prompt && command.at(-1) !== id ? -1 : undefined);
  // Re-archiving a resumed thread must not nest Resume or retain its old ID.
  if (kind === 'codex' && rest[0] === 'resume') {
    rest.shift();
    if (rest.at(-1) === id) rest.pop();
  } else if (kind === 'claude') {
    const resume = rest.indexOf('--resume');
    if (resume >= 0) rest.splice(resume, rest[resume + 1] === id ? 2 : 1);
  }
  return kind === 'codex' ? [...command.slice(0, executable + 1), 'resume', ...rest, id]
    : [...command.slice(0, executable + 1), ...rest, '--resume', id];
}

// Codex keeps each open conversation in sessions/…/rollout-<time>-<id>.jsonl; its sub-agents run in the same
// process with their own, later rollouts, so the thread's own conversation is the earliest one.
export function codexSessionId(lsof) {
  const rollouts = [...(lsof || '').matchAll(/rollout-([^/\n]*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/gim)];
  return rollouts.sort((a, b) => a[1].localeCompare(b[1]))[0]?.[2] || null;
}

export function archivedAge(at, now = Date.now()) {
  const minutes = Math.floor((now - at) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

// shortcut: compare path spellings; resolve aliases if symlinked project roots need deduplication.
export const folderKey = folder => (folder || '').replace(/\\/g, '/').replace(/\/+$/, '');

export function projectCatalog(spaces, saved = [], roots = {}, selected, order = []) {
  const projects = spaces.map(space => ({ ...space, folder: roots[space.id] || space.folder }));
  for (const folder of saved) {
    if (projects.some(p => !p.machine && folderKey(p.folder) === folderKey(folder))) continue;
    projects.push({ id: `project:${folder}`, name: folder.split(/[\\/]/).filter(Boolean).at(-1) || folder,
      folder, machine: null, tabs: [], pending: true });
  }
  const chosen = projects.find(p => p.id === selected) || projects.find(p => p.active) || projects[0];
  const ranks = new Map(order.map((key, index) => [key, index]));
  projects.sort((a, b) => (ranks.get(JSON.stringify([a.machine || '', folderKey(a.folder) || a.id])) ?? order.length)
    - (ranks.get(JSON.stringify([b.machine || '', folderKey(b.folder) || b.id])) ?? order.length));
  return projects.map(project => ({ ...project, active: project.id === chosen?.id }));
}

export function projectGroups(spaces, agents, defaults = {}, titleFor = threadTitle) {
  return spaces.map(space => ({ space, threads: space.tabs.filter(tab => tab.id !== defaults[space.id]
    || agents.some(agent => agent.space === space.id && agent.tab === tab.id)).map(tab => {
    const members = agents.filter(a => a.space === space.id && a.tab === tab.id);
    const agent = members.find(a => a.focused) || members[0];
    return { space: space.id, tab, agents: members, agent,
      title: titleFor(tab, agent, space),
      status: tab.status || agent?.status || 'idle',
      active: space.active && tab.active };
  }).sort((a, b) => Number(b.agents.some(agent => agent.status === 'working') || b.status === 'working')
    - Number(a.agents.some(agent => agent.status === 'working') || a.status === 'working')) }));
}
