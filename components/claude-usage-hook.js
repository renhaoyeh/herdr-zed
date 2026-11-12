// Shared: edit components/claude-usage-hook.js, then npm run sync:shared.
import { appHome, readTextFile, writeTextFile } from 'herdr';

// Usage comes from Claude Code's own status line data. Another tool's status line is kept: without
// `chain` it is left alone; with `chain` it is saved and run after recording, with the same input.
// An `owned` directory (an account herdr-zed created) always gets this status line. A Devkits usage
// status line is never kept or chained: it is replaced like a stale copy of this one.
export async function ensureClaudeStatusLine(directory, { chain = false, owned = false } = {}) {
  const path = `${directory}/settings.json`;
  const source = await readTextFile(path);
  const data = source === null ? {} : JSON.parse(source);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const command = `node "${appHome().replace(/\\/g, '/')}/mods/herdr-zed-agents/usage/claude-statusline.js"`;
  const current = data.statusLine;
  const ours = /\/herdr-zed-agents\/usage\/claude-statusline\.js"$/.test(String(current?.command || ''));
  if (ours && current.command === command) return false;
  const replace = ours || owned || /\/devkits-usage\/claude-statusline\.js"$/.test(String(current?.command || ''));
  if (current && !replace) {
    if (!chain || current.type !== 'command' || typeof current.command !== 'string') return false;
    const chainPath = `${directory}/herdr-zed-statusline-chain.json`;
    await writeTextFile(chainPath, `${JSON.stringify(current, null, 2)}\n`, await readTextFile(chainPath));
    const backup = `${path}.herdr-zed-backup`;
    if (await readTextFile(backup) === null) await writeTextFile(backup, source, null);
  }
  data.statusLine = { ...(current && !replace ? current : { padding: 0 }), type: 'command', command };
  await writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, source);
  return true;
}
