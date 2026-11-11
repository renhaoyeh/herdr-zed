// Resumable conversation identity of a Claude Code or Codex launch, shared by Archive (thread-archive.js) and
// auto-resume (thread-resume.js). Pure: process lookups go through the injected exec/readTextFile/home/appHome,
// so this module has no Herdr import and is tested directly.
import { commandKind, codexSessionId, resumeArgv } from './components/session-model.js';

// Shared-state keys. Records are keyed by tab id; the preference defaults to on (only `false` turns it off).
export const RESUME_RECORDS_KEY = 'herdr-zed.thread-sessions';
export const AUTO_RESUME_KEY = 'herdr-zed.auto-resume';

const UUID = /^[a-f0-9-]{36}$/i;

export const accountEnv = command => command.filter(arg => /^(?:CODEX_HOME|CLAUDE_CONFIG_DIR)=/.test(arg));
export const executable = command => command.find(arg => !arg.includes('=') && commandKind([arg]));
export const hasCredential = command => command.some(arg => /^[A-Z_][A-Z0-9_]*=/.test(arg) && /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|AUTH)/i.test(arg.split('=', 1)[0]));

const valuedOptions = new Set(['-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval', '--profile', '--permission-mode', '-c', '--config']);

// The launch's argv reopening `id`, or null when the launch carries a positional prompt (it would be sent again).
export const resumeCommand = (command, id) => {
  const executable = command.findIndex(arg => !arg.includes('=') && commandKind([arg]));
  const args = command.slice(executable + 1);
  if (args.some((arg, index) => !arg.startsWith('-') && !valuedOptions.has(args[index - 1])
      && arg !== 'resume' && arg !== id && !/^[a-f0-9-]{36}$/i.test(arg))) return null;
  return resumeArgv(command, id);
};

// Unix-like lookup: Claude reads its session file for the PID; Codex lists the rollout files its process holds open.
export async function sessionIdentity(kind, command, pid, { exec, readTextFile, home }) {
  if (kind === 'claude') {
    const dir = command.find(arg => arg.startsWith('CLAUDE_CONFIG_DIR='))?.slice(18) || `${home()}/.claude`;
    const id = JSON.parse(await readTextFile(`${dir}/sessions/${pid}.json`) || '{}').sessionId;
    return id && (await exec('sh', ['-c', 'ls "$1"/projects/*/"$2".jsonl', 'sh', dir, id])).code === 0 ? id : null;
  }
  const result = await exec('sh', ['-c', 'pids=$(pgrep -P "$1" | tr "\\n" ,)$1; lsof -Fn -p "$pids"', 'sh', String(pid)]);
  return codexSessionId(result.stdout);
}

// The session id named by the transcript file that agent-session-windows.js (shared with Tasks) found.
export function sessionIdFromFile(kind, file) {
  const name = String(file || '').split(/[\\/]/).pop() || '';
  const match = kind === 'codex' ? name.match(/^rollout-.+-([a-f0-9-]{36})\.jsonl$/i) : name.match(/^([a-f0-9-]{36})\.jsonl$/i);
  return match ? match[1] : null;
}

// Windows lookup: the same helper Tasks uses, run as a Node process. A resumed Codex launch names its id, so the
// helper can take the exact rollout instead of searching the process tree.
export async function windowsSessionIdentity(kind, command, pid, { exec, home, appHome }) {
  const prefix = kind === 'codex' ? 'CODEX_HOME=' : 'CLAUDE_CONFIG_DIR=';
  const directory = command.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || `${home()}/.${kind}`;
  const resumed = kind === 'codex' && command.includes('resume') ? command.findLast(arg => UUID.test(arg)) || null : null;
  const result = await exec('node', [`${appHome()}/mods/herdr-zed/components/agent-session-windows.js`, String(pid), kind,
    directory, ...(resumed ? [resumed] : [])]);
  if (result.code) return null;
  let file = null;
  try { file = JSON.parse(result.stdout).file; } catch { return null; }
  return sessionIdFromFile(kind, file);
}

// Records without the tab's entry (archive removes a conversation for good).
export const recordsWithout = (records, tabId) => Object.fromEntries(Object.entries(records || {}).filter(([key]) => key !== tabId));
