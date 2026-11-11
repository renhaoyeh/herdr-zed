// Shared: edit components/agent-session-windows.js, then npm run sync:shared.
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, basename, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exists = file => stat(file).then(info => info.isFile(), () => false);
const within = (directory, file) => {
  const path = relative(toNamespacedPath(resolve(directory)), toNamespacedPath(resolve(file)));
  return path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

export async function codexTaskFile(directory, processes, resumedId = null) {
  if (!processes.length) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const names = await readdir(directory).catch(() => []);
  const databases = pattern => names.filter(name => pattern.test(name)).sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
  const states = [];
  const files = new Set();
  try {
    for (const name of databases(/^state_\d+\.sqlite$/)) {
      try { states.push(new DatabaseSync(join(directory, name), { readOnly: true })); } catch {}
    }
    // Resume already names the exact conversation. It need not emit a new log
    // linking that session to its new PID before the first submitted message.
    if (resumedId && /^[a-f0-9-]{36}$/i.test(resumedId)) {
      for (const state of states) {
        const file = state.prepare('SELECT rollout_path FROM threads WHERE id = ? AND source = ? AND archived = 0').get(resumedId, 'cli')?.rollout_path;
        if (typeof file !== 'string' || !/^rollout-.+\.jsonl$/i.test(basename(file))) continue;
        if (!(within(join(directory, 'sessions'), file) || within(join(directory, 'archived_sessions'), file))) continue;
        if (await exists(file)) files.add(file);
      }
      return files.size === 1 ? [...files][0] : null;
    }
    for (const name of databases(/^logs_\d+\.sqlite$/)) {
      let logs;
      try {
        logs = new DatabaseSync(join(directory, name), { readOnly: true });
        for (const process of processes) {
          if (!Number.isInteger(process.pid) || process.pid <= 0 || !Number.isFinite(process.createdAt)) continue;
          // Structured process identity plus creation time rejects logs from a reused PID.
          // Only the account's primary CLI conversation qualifies, never a sub-agent or newest file.
          const threads = logs.prepare(`SELECT DISTINCT thread_id FROM logs WHERE process_uuid GLOB ?
            AND ts * 1000.0 + ts_nanos / 1000000.0 >= ? AND thread_id IS NOT NULL LIMIT 128`)
            .all(`pid:${process.pid}:*`, process.createdAt);
          if (threads.length === 128) return null;
          for (const thread of threads) for (const state of states) {
            const row = state.prepare('SELECT rollout_path FROM threads WHERE id = ? AND source = ? AND archived = 0').get(thread.thread_id, 'cli');
            const file = row?.rollout_path;
            if (typeof file !== 'string' || !/^rollout-.+\.jsonl$/i.test(basename(file))) continue;
            if (!(within(join(directory, 'sessions'), file) || within(join(directory, 'archived_sessions'), file))) continue;
            if (await exists(file)) files.add(file);
          }
        }
      } catch {} finally { logs?.close(); }
    }
  } finally { for (const state of states) state.close(); }
  return files.size === 1 ? [...files][0] : null;
}

export async function claudeTaskFile(directory, processes) {
  const files = new Set(), projects = await readdir(join(directory, 'projects'), { withFileTypes: true }).catch(() => []);
  for (const process of processes) {
    if (!Number.isInteger(process.pid) || process.pid <= 0) continue;
    let id;
    try { id = JSON.parse(await readFile(join(directory, 'sessions', `${process.pid}.json`), 'utf8')).sessionId; } catch { continue; }
    if (!/^[a-f0-9-]{36}$/i.test(id || '')) continue;
    for (const project of projects.filter(entry => entry.isDirectory())) {
      const file = join(directory, 'projects', project.name, `${id}.jsonl`);
      if (await exists(file)) files.add(file);
    }
  }
  return files.size === 1 ? [...files][0] : null;
}

export async function locateWindowsTaskFile(pid, kind, directory, resumedId = null) {
  if (!Number.isInteger(pid) || pid <= 0 || !['codex', 'claude'].includes(kind) || !directory) return null;
  const script = fileURLToPath(new URL('./agent-process-windows.js', import.meta.url));
  const { stdout } = await promisify(execFile)('cscript.exe', ['//NoLogo', '//E:JScript', script, String(pid), kind], { timeout: 5000, windowsHide: true });
  const { processes = [] } = JSON.parse(stdout);
  return kind === 'codex' ? codexTaskFile(directory, processes, resumedId) : claudeTaskFile(directory, processes);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  locateWindowsTaskFile(Number(process.argv[2]), process.argv[3], process.argv[4], process.argv[5])
    .then(file => process.stdout.write(JSON.stringify({ file })))
    .catch(() => { process.stdout.write('{"file":null}'); process.exitCode = 1; });
}
