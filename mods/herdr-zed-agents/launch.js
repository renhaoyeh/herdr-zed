// Provider launches (ARCHITECTURE.md §3.1): the account is prepared here, the argv is final, and the
// request is handed to the shell through shared state. The shell never rewrites a provider argv.
import { spaces, shared, setShared, window } from 'herdr';
import { validateLaunchRequest } from './components/extension-contract.js';
import { terminalArgv } from './components/session-shell.js';
import { prepareSession } from './session-preparation.js';

export const LAUNCH_REQUESTS = 'herdr-zed.launch.requests';
export const LAUNCHER_ID = 'agents';
const LAUNCH_LIFETIME = 30000;

// `origin` is passed through unchanged for the caller's own bookkeeping (e.g. a task link).
function launchOrigin(origin) {
  if (origin === null || origin === undefined) return null;
  if (typeof origin !== 'object' || Array.isArray(origin) || typeof origin.extension !== 'string'
    || typeof origin.ref !== 'string' || origin.ref.length === 0 || origin.ref.length > 200)
    throw new Error('Launch origin must be { extension, ref }.');
  return { extension: origin.extension, ref: origin.ref };
}

// Prepares the account, then appends one launch request. Returns { id, model, effort, profile }.
export async function emitLaunch(agent, target = {}, options = {}, origin = null) {
  const launchOriginValue = launchOrigin(origin);
  const project = spaces().find(space => space.id === target.space);
  const machine = target.machine || project?.machine || null;
  const { argv: prepared, session = {} } = await prepareSession(agent, target, options);
  if (!Array.isArray(prepared) || !prepared.length || prepared.some(arg => typeof arg !== 'string'))
    throw new Error('This program has no launch command.');
  // Local shells need the platform wrapper; remote launches run as given.
  const argv = machine ? prepared : terminalArgv(prepared, window()?.platform);
  const location = Object.fromEntries(Object.entries({
    space: target.space, folder: target.folder, projectName: target.projectName, machine: machine || undefined, overlay: target.overlay,
  }).filter(([, value]) => value !== undefined));
  const request = {
    id: `launch:${Date.now()}:${Math.random().toString(36).slice(2)}`, source: LAUNCHER_ID, target: location,
    name: agent.name || agent.key, argv, profile: agent.key ?? null, expiresAt: Date.now() + LAUNCH_LIFETIME,
    ...(launchOriginValue ? { origin: launchOriginValue } : {}),
  };
  const checked = validateLaunchRequest(request, { now: Date.now(), launcherId: LAUNCHER_ID, spaces: spaces() });
  if (!checked.ok) throw new Error(checked.error);
  // The shell never writes this queue (it only records handled IDs), so the provider prunes expired entries here.
  const now = Date.now(), queued = (shared(LAUNCH_REQUESTS) || []).filter(item => item && item.expiresAt > now);
  setShared(LAUNCH_REQUESTS, [...queued, request]);
  return { id: request.id, model: session.model ?? null, effort: session.effort ?? null, profile: request.profile };
}
