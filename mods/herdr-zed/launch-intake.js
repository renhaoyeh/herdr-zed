// Shell side of ARCHITECTURE §3.1: take provider launch requests, validate them, open the tab, and record which
// provider launched each tab in the thread read model (`herdr-zed.threads`). Pure except for the injected API.
import { validateLaunchRequest } from './components/extension-contract.js';

export const LAUNCH_REQUESTS = 'herdr-zed.launch.requests';
export const LAUNCH_PENDING = 'herdr-zed.launch.pending';
export const THREADS = 'herdr-zed.threads';
// A tab can appear slightly after its request expires; the pending match keeps this grace beyond expiresAt.
const PENDING_GRACE_MS = 60_000;

/** Takes and clears every queued request, so each request is processed once. */
export function takeLaunchRequests(shared, setShared) {
  const queued = shared(LAUNCH_REQUESTS);
  if (!Array.isArray(queued) || queued.length === 0) return [];
  setShared(LAUNCH_REQUESTS, []);
  return queued;
}

/** Validates each request. Returns the accepted values and one message per distinct rejection. */
export function acceptLaunchRequests(requests, { now, launcherId, spaces }) {
  const accepted = [], errors = [];
  for (const request of requests) {
    const result = validateLaunchRequest(request, { now, launcherId, spaces });
    if (result.ok) accepted.push(result.value); else errors.push(result.error);
  }
  return { accepted, errors: [...new Set(errors)] };
}

const sameTarget = (launch, space) => launch.space
  ? space.id === launch.space
  : space.folder === launch.folder && (space.machine || null) === launch.machine;

/** Remembers a launch until its tab appears. `known` lists the tab IDs that existed before the launch. */
export function pendingLaunch(request, known) {
  return { id: request.id, name: request.name, profile: request.profile, source: request.source,
    ...(request.origin ? { origin: request.origin } : {}),
    space: request.target.space || null, folder: request.target.folder, machine: request.target.machine || null,
    known, expiresAt: request.expiresAt + PENDING_GRACE_MS };
}

/**
 * Matches pending launches to new tabs and prunes closed tabs. Returns the next pending list and thread records.
 * A tab is matched once: it must be new (absent from `known`), carry the requested name, and sit in the target space.
 */
export function reconcileLaunches({ pending = [], threads = {} }, spaces, now) {
  const tabs = spaces.flatMap(space => (space.tabs || []).map(tab => ({ id: tab.id, name: tab.name, space })));
  const live = new Set(tabs.map(tab => tab.id));
  const next = {};
  for (const [tabId, record] of Object.entries(threads)) if (live.has(tabId)) next[tabId] = record;
  const remaining = [];
  for (const launch of pending) {
    const match = tabs.find(tab => !launch.known.includes(tab.id) && !next[tab.id]
      && tab.name === launch.name && sameTarget(launch, tab.space));
    if (match) {
      next[match.id] = { profile: launch.profile, source: launch.source, ...(launch.origin ? { origin: launch.origin } : {}) };
    } else if (launch.expiresAt > now) remaining.push(launch);
  }
  return { pending: remaining, threads: next };
}

/**
 * Opens the requested tab or space with argv exactly as given. The caller supplies the shell's native API.
 * `api`: { spaces, shared, setShared, run, closeOverlay }.
 */
export function openLaunch(request, api) {
  const { target } = request;
  const known = api.spaces().flatMap(space => (space.tabs || []).map(tab => tab.id));
  api.setShared(LAUNCH_PENDING, [...(api.shared(LAUNCH_PENDING) || []), pendingLaunch(request, known)]);
  api.setShared('herdr-zed.conversation-visible', { ...(api.shared('herdr-zed.conversation-visible') || {}),
    [JSON.stringify([target.machine || '', (target.folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || target.space])]: true });
  api.setShared('herdr-zed.selected-project', null);
  api.run('layout.select', { stack: 'workspace-view', child: 'main' });
  if (target.space) api.run('tab.new', { space: target.space, folder: target.folder, name: request.name, argv: request.argv });
  else api.run('space.new', { name: target.projectName, folder: target.folder, machine: target.machine || '',
    tab: request.name, argv: request.argv });
  if (target.overlay) api.closeOverlay(target.overlay);
}
