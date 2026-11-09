// Shared: edit mods/devkits/components/claude-usage-hook.js, then npm run sync:shared.
import { appHome, readTextFile, writeTextFile } from 'herdr';

// Usage comes from Claude Code's own status line data. Another tool's status line is kept: without
// `chain` it is left alone; with `chain` it is saved and run after recording, with the same input.
export async function ensureClaudeStatusLine(directory, { chain = false } = {}) {
  const path = `${directory}/settings.json`;
  const source = await readTextFile(path);
  const data = source === null ? {} : JSON.parse(source);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const command = `node "${appHome().replace(/\\/g, '/')}/mods/devkits-usage/claude-statusline.js"`;
  const current = data.statusLine;
  const ours = /\/devkits-usage\/claude-statusline\.js"$/.test(String(current?.command || ''));
  if (ours && current.command === command) return false;
  if (current && !ours) {
    if (!chain || current.type !== 'command' || typeof current.command !== 'string') return false;
    const chainPath = `${directory}/devkits-statusline-chain.json`;
    await writeTextFile(chainPath, `${JSON.stringify(current, null, 2)}\n`, await readTextFile(chainPath));
    const backup = `${path}.devkits-backup`;
    if (await readTextFile(backup) === null) await writeTextFile(backup, source, null);
  }
  data.statusLine = { ...(current && !ours ? current : { padding: 0 }), type: 'command', command };
  await writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, source);
  return true;
}
