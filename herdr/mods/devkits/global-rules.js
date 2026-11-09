import { div } from 'gpui-kit';
import { v_flex, TextView } from 'gpui-base';
import { appHome, home, readTextFile, writeTextFile } from 'herdr';

// Shared startup rules for sessions launched from Devkits on this computer.
export const rulesPath = () => `${appHome()}/data/devkits/AGENTS.md`;

const defaultRules = `# Global rules

Shared startup instructions for Herdr Devkits agent sessions.

## Herdr Core workflow

At the start of each session, before doing any work, run \`hc --skill\` and read its full output. If the output is truncated, retrieve and read the remaining text before proceeding. Follow the installed manual for running programs, delegating agents, waiting, reporting, and cleanup.

Use HC background child terminals for slow commands, including builds, test suites, and installs, as well as servers, simulators, and watchers. Keep them under the current thread; do not open a separate tab or background them with \`&\` or nohup.

When agent delegation is authorized, use HC child terminals rather than built-in subagent tools, so Herdr can track and display them. This does not authorize delegation on its own.

Use \`hc read\` and \`hc wait\` to monitor work and follow the manual for reporting and cleanup. Do not disturb terminals or agents you did not start.

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

// The rules, read only, on the Rules page of Settings; it rereads the file every few seconds so edits made elsewhere appear.
export class RulesPreview {
  // Reads the rules now and every few seconds after, so the Settings page can show them too.
  start(cx) {
    this.text = undefined;
    const load = async cx => {
      let text = null;
      try { text = await readTextFile(rulesPath()); } catch {}
      if (text !== this.text) { this.text = text; cx.notify(); }
    };
    cx.spawn(load);
    cx.timer.every(3000, cx => cx.spawn(load));
  }

  description() {
    const path = rulesPath(), shown = path.startsWith(`${home()}/`) ? `~${path.slice(home().length)}` : path;
    return `Added to every Claude and Codex session started here. Edit ${shown} to change them.`;
  }

  body(t) {
    return this.text?.trim()
      ? v_flex().id('rules-markdown').flex_1().min_h(0).overflow_y_scrollbar().border(1).border_color(t.border).p(16)
        .child(TextView.markdown('rules-text', this.text).selectable(true).scrollable(false).w_full())
      : div().flex_1().min_h(0).text_size(12).text_color(t.muted)
        .child(this.text === undefined ? 'Loading rules…' : 'No global rules: new sessions get no extra instructions.');
  }
}
