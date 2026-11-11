// Claude Code status line used by Devkits: records the plan usage Claude Code provides on stdin into
// the profile's config directory, so the sidebar never needs credentials or network access. When
// Devkits took over another tool's status line, that command still runs with the same input.
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isMain } from '../node-main.js';

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

export function chained(input, directory, run = spawnSync) {
  let saved;
  try { saved = JSON.parse(readFileSync(`${directory}/devkits-statusline-chain.json`, 'utf8')); } catch { return null; }
  if (saved?.type !== 'command' || typeof saved.command !== 'string' || !saved.command) return null;
  const result = run(saved.command, { input, shell: true, encoding: 'utf8', timeout: 10000, windowsHide: true });
  return typeof result.stdout === 'string' ? result.stdout.replace(/\s+$/, '') : '';
}

export function runStatusLine() {
  const directory = process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
  let input = '', text = '', other = null;
  try { input = readFileSync(0, 'utf8'); } catch {}
  try { text = record(input, directory); } catch {}
  try { other = chained(input, directory); } catch {}
  process.stdout.write(other || text);
}

if (await isMain(import.meta.url)) runStatusLine();
