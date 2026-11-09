import { appHome, readTextFile, writeTextFile } from 'herdr';

// Shared startup rules for sessions launched from Devkits on this computer.
export const rulesPath = () => `${appHome()}/data/devkits/AGENTS.md`;

const defaultRules = `# Global rules

Shared startup instructions for Herdr Devkits agent sessions.

## Herdr Core workflow

At the start of each session, before doing any work, run \`hc --skill\` and read its full output. If the output is truncated, retrieve and read the remaining text before proceeding. Follow the installed manual for running programs, delegating agents, waiting, reporting, and cleanup.

Use HC background child terminals for slow commands, including builds, test suites, and installs, as well as servers, simulators, and watchers. Keep them under the current thread; do not open a separate tab or background them with \`&\` or nohup.

When agent delegation is authorized, use HC child terminals rather than built-in subagent tools, so Herdr can track and display them. This does not authorize delegation on its own.

Use \`hc read\` and \`hc wait\` to monitor work and follow the manual for reporting and cleanup. Do not disturb terminals or agents you did not start.

## Herdr task progress

Use the \`herdr_tasks\` MCP server for local task progress. Discover its \`report_task\` tool and read the tool's description and input schema before starting actual user work. No local script path or shell command is needed.

Report \`doing\` before work and when resuming after an answer. Report \`waiting\` before asking the user a question, with the exact question in the message. Report \`done\` only when the whole task is complete, including its result, validation and remaining limitations; report \`fail\` when the attempt cannot be completed, explaining why and what was preserved. Ending a reply or a native terminal turn is not task completion. Do not report startup without a user task.

Call \`report_task\` with \`status\` and \`message\`. When the task prompt supplies a run ID, pass it unchanged in \`run\` for that attempt. Otherwise omit \`run\`: the MCP server binds reports to your own live HC terminal. Never report for another terminal or edit Herdr shared.json directly. If the MCP tool is unavailable or reporting fails, continue authorized work and mention the failure in your final response; do not guess a local script path.

## MCP installation

For local MCP setup supported by Herdr Devkits' shared MCP mechanism, default to the shared configuration at \`<Herdr home>/data/devkits/codex-mcp.json\`. Resolve Herdr home from \`HERDR_APP_HOME\` when set, otherwise \`~/.config/herdr-app\`. Confirm the current launcher supports this mechanism before claiming the MCP is available to it.

Inspect the existing shared configuration and its supported schema before editing. Preserve unrelated entries and keep the existing version/servers structure. Do not default to the current account's configuration or the agent's default home directory. Herdr synchronizes shared MCP settings into supported accounts when new local sessions start; do not claim an existing session has reloaded them.

Install reusable MCP runtimes in a shared location when supported by their setup, and register their command or local URL in the shared configuration. If setup writes only to the current account, add the intended registration to the shared configuration and remove only the duplicate entry that this setup just created. Preserve pre-existing account settings.

Keep account-authorized remote services in their account configuration. Use account-specific settings only when explicitly requested or required by the integration. Use supported environment-variable references for shared credentials rather than literal secrets.
`;

// The rules to add to a new session, or null when the file is missing or empty.
export async function sessionRules() {
  const text = await readTextFile(rulesPath());
  return text?.trim() ? { file: rulesPath(), text } : null;
}

// Writes the starting rules once; a file the person emptied stays empty.
export async function ensureRules() {
  if (await readTextFile(rulesPath()) === null) await writeTextFile(rulesPath(), defaultRules, null);
}
