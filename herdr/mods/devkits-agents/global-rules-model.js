// Rule content stays in the editable Guide; switches control only session injection.
export const ruleModules = [
  {
    "key": "core",
    "label": "Herdr Core",
    "heading": "Herdr Core workflow",
    "description": "Read hc --skill and follow the official terminal and agent workflow.",
    "text": "## Herdr Core workflow\n\nAt the start of each session, run `hc --skill`, read its full output, and follow the installed manual for running programs, delegation, waiting, reporting and cleanup. If the output is truncated, read the remaining text before proceeding. This does not authorize delegation on its own."
  },
  {
    "key": "tasks",
    "label": "Task progress",
    "heading": "Herdr task progress",
    "description": "Ask agents to report progress through Tasks MCP.",
    "text": "## Herdr task progress\n\nUse the `herdr_tasks` MCP server for local task progress. Discover its `report_task` tool and read the tool's description and input schema before starting actual user work. No local script path or shell command is needed.\n\nReport `doing` before work and when resuming after an answer. Report `waiting` before asking the user a question, with the exact question in the message. Report `done` only when the whole task is complete, including its result, validation and remaining limitations; report `fail` when the attempt cannot be completed, explaining why and what was preserved. Ending a reply or a native terminal turn is not task completion. Do not report startup without a user task.\n\nCall `report_task` with `status` and `message`. When the task prompt supplies a run ID, pass it unchanged in `run` for that attempt. Otherwise omit `run`: the MCP server binds reports to your own live HC terminal. Never report for another terminal or edit Herdr shared.json directly. If the MCP tool is unavailable or reporting fails, continue authorized work and mention the failure in your final response; do not guess a local script path."
  },
  {
    "key": "mcp",
    "label": "Shared MCP installation",
    "heading": "MCP installation",
    "description": "Use the shared location and configuration for local MCP installations.",
    "text": "## MCP installation\n\nFor local MCP setup supported by Herdr Devkits' shared MCP mechanism, default to the shared configuration at `<Herdr home>/data/devkits/codex-mcp.json`. Resolve Herdr home from `HERDR_APP_HOME` when set, otherwise `~/.config/herdr-app`. Confirm the current launcher supports this mechanism before claiming the MCP is available to it.\n\nInspect the existing shared configuration and its supported schema before editing. Preserve unrelated entries and keep the existing version/servers structure. Do not default to the current account's configuration or the agent's default home directory. Herdr synchronizes shared MCP settings into supported accounts when new local sessions start; do not claim an existing session has reloaded them.\n\nInstall reusable MCP runtimes in a shared location when supported by their setup, and register their command or local URL in the shared configuration. If setup writes only to the current account, add the intended registration to the shared configuration and remove only the duplicate entry that this setup just created. Preserve pre-existing account settings.\n\nKeep account-authorized remote services in their account configuration. Use account-specific settings only when explicitly requested or required by the integration. Use supported environment-variable references for shared credentials rather than literal secrets."
  }
];
export const ruleSettingsKey = 'devkits.global-rules';
export const defaultRules = '# Global rules\n\n' + ruleModules.map(item => item.text).join('\n\n') + '\n';

export function ruleSelection(saved = {}) {
  return Object.fromEntries([...ruleModules.map(item => item.key), 'custom'].map(key => [key, saved?.[key] !== false]));
}

export function splitRuleGuide(text) {
  const sections = {}, custom = [];
  let source = (text || '').replace(/^# Global rules\r?\n(?:\r?\nShared startup instructions for Herdr Devkits agent sessions\.)?\s*/, '');
  const customStart = source.search(/^## Custom rules\s*$/m);
  let customText = '';
  if (customStart >= 0) {
    customText = source.slice(customStart).replace(/^## Custom rules\s*\r?\n?/, '').trim();
    source = source.slice(0, customStart);
  }
  for (const part of source.split(/(?=^## )/m)) {
    if (!part.trim()) continue;
    const heading = part.split(/\r?\n/)[0].replace(/^## /, '').trim();
    const item = ruleModules.find(item => item.heading === heading);
    if (item) sections[item.key] = [sections[item.key], part.trim()].filter(Boolean).join('\n\n');
    else custom.push(part.trim());
  }
  if (customText) custom.push(customText);
  return { sections, custom: custom.join('\n\n') };
}

export function composeRuleGuide(guide, selected) {
  const parts = ruleModules.filter(item => selected[item.key]).map(item => guide.sections[item.key] ?? item.text);
  if (selected.custom && guide.custom.trim()) parts.push('## Custom rules\n\n' + guide.custom.trim());
  return parts.length ? '# Global rules\n\n' + parts.join('\n\n') + '\n' : '';
}
