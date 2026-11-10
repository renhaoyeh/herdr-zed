export const eccGroups = [
  { id: 'rules', label: 'Rules · Guardrails', description: 'Standards your agent follows for coding, testing and security. Selected rules guide each new conversation.', example: 'For example: code style, test requirements and language conventions.', providers: ['claude', 'codex'] },
  { id: 'agents', label: 'Agents · Specialists', description: 'Specialist roles Claude can call for planning, review and troubleshooting.', example: 'For example: planner breaks down a feature; code-reviewer checks a change.', providers: ['claude'] },
  { id: 'skills', label: 'Skills · Playbooks', description: 'Reusable knowledge and working steps, loaded when the agent handles a matching task.', example: 'For example: TDD, code review, database design and frontend development.', providers: ['claude', 'codex'] },
  { id: 'commands', label: 'Commands · Shortcuts', description: 'Slash commands that start a predefined workflow in Claude. Disabled commands are removed from the managed plugin.', example: 'For example: /ecc:plan and /ecc:code-review. Codex uses Skills instead.', providers: ['claude'] },
  { id: 'hooks', label: 'Hooks · Automatic actions', description: 'Actions triggered by session or tool events. Control each native event and its individual checks.', example: 'Claude supports several tool events. This ECC source provides only SessionStart for Codex.', providers: ['claude', 'codex'] },
  { id: 'mcp', label: 'MCP · Connected tools', description: 'Connections to browsers, search and other services. Select tools individually and review their required environment variables.', example: 'Some entries are ready to use; templates still need configuration. Enabling ECC does not connect every tool.', providers: ['claude', 'codex'] },
  { id: 'contexts', label: 'Contexts · Working modes', description: 'Set a development, research or review focus. Select at most one mode for each provider.', example: 'Modes are optional. Selected contexts and rules guide new conversations.', providers: ['claude', 'codex'] },
  { id: 'workflows', label: 'Workflows · Pipelines', description: 'Native Workflow scripts coordinate specialist agents through a complete sequence of work.', example: 'This source includes the experimental orch-review pipeline for Claude Code.', providers: ['claude'] },
];
export const eccDefaults = { version: 1, enabled: false, source: '', claudeHooks: 'standard', providerEnabled: { claude: true, codex: true }, selection: { claude: {}, codex: {} } };

export function parseEcc(text) {
  if (text === null || text === undefined) return { ...eccDefaults, providerEnabled: { claude: true, codex: true }, selection: { claude: {}, codex: {} } };
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || value.version !== 1 || typeof value.enabled !== 'boolean'
    || typeof value.source !== 'string' || !['off', 'minimal', 'standard', 'strict'].includes(value.claudeHooks)
    || Object.keys(value).some(key => !Object.hasOwn(eccDefaults, key))) throw new Error('Invalid global ECC settings.');
  if (value.enabled && !value.source.trim()) throw new Error('Choose the Everything Claude Code source folder.');
  const selection = value.selection === undefined ? {} : value.selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || Object.keys(selection).some(key => !['claude', 'codex'].includes(key))) throw new Error('Invalid ECC component selection.');
  for (const entries of Object.values(selection)) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)
      || Object.entries(entries).some(([key, enabled]) => !key || typeof enabled !== 'boolean')) throw new Error('Invalid ECC component selection.');
  }
  const providerEnabled = value.providerEnabled === undefined ? {} : value.providerEnabled;
  if (!providerEnabled || typeof providerEnabled !== 'object' || Array.isArray(providerEnabled)
    || Object.entries(providerEnabled).some(([key, enabled]) => !['claude', 'codex'].includes(key) || typeof enabled !== 'boolean')) throw new Error('Invalid ECC provider switches.');
  return { ...value, source: value.source.trim(), providerEnabled: { claude: true, codex: true, ...providerEnabled },
    selection: { claude: { ...selection.claude }, codex: { ...selection.codex } } };
}

export function eccItemEnabled(config, provider, item) {
  return Boolean(item.providers.includes(provider) && (config.selection?.[provider]?.[item.id] ?? item.defaultEnabled));
}

export function chooseEccItem(config, provider, item, enabled) {
  const selection = { ...config.selection[provider], [item.id]: enabled };
  // Modes are mutually exclusive, including selections retained from an unavailable source.
  if (item.group === 'contexts' && enabled) for (const key of Object.keys(selection)) if (key.startsWith('contexts:') && key !== item.id) selection[key] = false;
  config.selection = { ...config.selection, [provider]: selection };
}

export function eccAccount(provider, argv, userHome) {
  if (!['claude', 'codex'].includes(provider)) return null;
  const prefix = provider === 'codex' ? 'CODEX_HOME=' : 'CLAUDE_CONFIG_DIR=';
  return { provider, directory: argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || `${userHome}/.${provider}` };
}
