// Thread decorations (ARCHITECTURE.md §3.3): the account label of each Agents thread and its quota tone.
import { shared, setShared } from 'herdr';
import { launcherLabel } from './components/session-model.js';

export const THREADS = 'herdr-zed.threads', DECORATIONS = 'herdr-zed.decorations.agents', USAGE = 'herdr-zed.usage.snapshot';
const MAX_TEXT = 40;

// Maps each thread's profile to its account. Threads without a known account get no decoration.
export function threadDecorations(threads = {}, agents = [], usage = []) {
  const decorations = {};
  for (const [tabId, thread] of Object.entries(threads || {})) {
    if (!thread?.profile) continue;
    const agent = agents.find(item => item.key === thread.profile);
    if (!agent) continue;
    const reading = usage.find(item => item.key === agent.key);
    const name = launcherLabel(agent.name);
    const label = name === 'Default account' ? (reading?.email || name) : name;
    const usedPercent = Math.max(-Infinity, ...(reading?.windows || [])
      .filter(window => [300, 10080].includes(window.minutes)).map(window => window.usedPercent));
    // The Usage meter's thresholds: warning from 70%, error from 90%.
    const tone = usedPercent >= 90 ? 'error' : usedPercent >= 70 ? 'warning' : null;
    decorations[tabId] = { badge: label.slice(0, MAX_TEXT), ...(tone ? { tone } : {}) };
  }
  return decorations;
}

// Publishes only when the decorations change, so the shell is not re-rendered for steady state.
export function publishDecorations() {
  const agents = shared('herdr-zed.agent-cache')?.[JSON.stringify(null)] || [];
  const usage = shared(USAGE)?.contexts?.[JSON.stringify(null)]?.usage || [];
  const next = threadDecorations(shared(THREADS), agents, usage);
  const current = shared(DECORATIONS)?.threads || {};
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  setShared(DECORATIONS, { updatedAt: Date.now(), threads: next });
}
