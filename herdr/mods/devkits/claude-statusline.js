// Claude Code status line for Devkits Claude accounts: records the plan usage Claude Code provides
// on stdin into the account's own config directory, so the sidebar never needs credentials or network access.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function statusText(limits) {
  return [['five_hour', '5h'], ['seven_day', 'Week']]
    .filter(([slot]) => Number.isFinite(limits?.[slot]?.used_percentage))
    .map(([slot, label]) => `${label} ${Math.round(limits[slot].used_percentage)}%`).join(' · ');
}

export function record(input, directory, now = Date.now()) {
  let session;
  try { session = JSON.parse(input); } catch { return ''; }
  const limits = session?.rate_limits;
  // Claude Code omits rate_limits until the first response; keep the last recording until then.
  if (directory && limits && (limits.five_hour || limits.seven_day)) {
    const path = `${directory}/devkits-usage.json`;
    writeFileSync(`${path}.tmp`, JSON.stringify({ capturedAt: now, rate_limits: limits }));
    renameSync(`${path}.tmp`, path);
  }
  return statusText(limits);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = '';
  try { text = record(readFileSync(0, 'utf8'), process.env.CLAUDE_CONFIG_DIR); } catch {}
  process.stdout.write(text);
}
