export const storageGroups = [
  ['conversations', 'Chat & file history'],
  ['cache', 'Caches & temp files'],
  ['extensions', 'Plugins and skills'],
  ['runtime', 'Runtime & tools'],
  ['logs', 'Diagnostic logs'],
  ['other', 'Other files'],
];

export function accountStorageDirectory(agent, home) {
  const key = agent?.profileKey || agent?.key || '';
  const kind = key === 'codex' || key.startsWith('herdr-zed-codex-') ? 'codex'
    : key === 'claude' || key.startsWith('herdr-zed-claude-') ? 'claude' : null;
  if (!kind) return null;
  const prefix = kind === 'codex' ? 'CODEX_HOME=' : 'CLAUDE_CONFIG_DIR=';
  const directory = agent.run?.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || `${home}/.${kind}`;
  return { kind, directory };
}

export function storageGroup(name) {
  if (['sessions', 'archived_sessions', 'projects', 'file-history', 'history.jsonl'].includes(name)
    || /^thread_history_\d+\.sqlite(?:-(?:wal|shm))?$/.test(name)) return 'conversations';
  if (['cache', '.cache', 'tmp', '.tmp', 'shell_snapshots', 'shell-snapshots'].includes(name)) return 'cache';
  if (['plugins', 'skills', 'agents', 'commands', 'rules', 'workflows', 'output-styles', 'vendor_imports'].includes(name)) return 'extensions';
  if (['packages', 'computer-use'].includes(name)) return 'runtime';
  if (['log', 'logs', 'debug', 'telemetry'].includes(name) || /^logs_.*\.sqlite(?:-(?:wal|shm))?$/.test(name)) return 'logs';
  return 'other';
}

export function storageSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000, index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
  return `${value.toFixed(1)} ${units[index]}`;
}
