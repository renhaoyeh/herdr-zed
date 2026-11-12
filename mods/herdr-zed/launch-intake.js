// Shell side of ARCHITECTURE §3.1: claim provider launch requests, validate them, open the tab, and record which
// provider launched each tab in the thread read model (`herdr-zed.threads`). Pure except for the injected API.
import { validateLaunchRequest } from './components/extension-contract.js';

export const LAUNCH_REQUESTS = 'herdr-zed.launch.requests';
export const LAUNCH_HANDLED = 'herdr-zed.launch.handled';
export const LAUNCH_PENDING = 'herdr-zed.launch.pending';
export const THREADS = 'herdr-zed.threads';
// A tab can appear slightly after its request expires; the pending match keeps this grace beyond expiresAt.
const PENDING_GRACE_MS = 60_000;

/**
 * Which queued requests this poll processes: unexpired, well-formed and not handled before. The queue is only read.
 * `handled` is [{ id, expiresAt }] (the caller merges its in-memory list with the shared one). Entries whose request
 * can no longer be processed are pruned; the returned list is what the caller keeps.
 */
export function claimLaunchRequests(queued, handled, now) {
  const seen = new Map();
  for (const entry of Array.isArray(handled) ? handled : []) {
    if (entry && typeof entry.id === 'string' && typeof entry.expiresAt === 'number' && entry.expiresAt > now) seen.set(entry.id, entry.expiresAt);
  }
  const claimed = [];
  for (const item of Array.isArray(queued) ? queued : []) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || seen.has(item.id)
      || typeof item.expiresAt !== 'number' || !(item.expiresAt > now)) continue;
    seen.set(item.id, item.expiresAt);
    claimed.push(item);
  }
  return { claimed, handled: [...seen].map(([id, expiresAt]) => ({ id, expiresAt })) };
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
  const { target } = request, task = request.task ? { task: request.task } : {};
  const known = api.spaces().flatMap(space => (space.tabs || []).map(tab => tab.id));
  api.setShared(LAUNCH_PENDING, [...(api.shared(LAUNCH_PENDING) || []), pendingLaunch(request, known)]);
  api.setShared('herdr-zed.conversation-visible', { ...(api.shared('herdr-zed.conversation-visible') || {}),
    [JSON.stringify([target.machine || '', (target.folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || target.space])]: true });
  api.setShared('herdr-zed.selected-project', null);
  api.run('layout.select', { stack: 'workspace-view', child: 'main' });
  if (target.space) api.run('tab.new', { space: target.space, folder: target.folder, name: request.name, argv: request.argv, ...task });
  else api.run('space.new', { name: target.projectName, folder: target.folder, machine: target.machine || '',
    tab: request.name, argv: request.argv, ...task });
  if (target.overlay) api.closeOverlay(target.overlay);
}

/**
 * One poll of the shell's launch intake. `state.handled` is the view's in-memory [{ id, expiresAt }] list. The shell
 * writes `herdr-zed.launch.handled` and its own tab keys; it never writes `herdr-zed.launch.requests`, which only the
 * provider appends to (and prunes). Every claimed request is handled once, whether it is accepted or rejected.
 * `api`: { shared, setShared, spaces, run, closeOverlay, notify, launcherId }.
 */
export function pollLaunchIntake(api, state, now) {
  const storedHandled = api.shared(LAUNCH_HANDLED) || [];
  const { claimed, handled } = claimLaunchRequests(api.shared(LAUNCH_REQUESTS), [...state.handled, ...storedHandled], now);
  state.handled = handled;
  if (JSON.stringify(handled) !== JSON.stringify(storedHandled)) api.setShared(LAUNCH_HANDLED, handled);
  const spaces = api.spaces().map(space => ({ id: space.id, machine: space.machine || null }));
  const { accepted, errors } = acceptLaunchRequests(claimed, { now, launcherId: api.launcherId, spaces });
  for (const body of errors) api.notify({ title: 'Launch request rejected', body, level: 'error' });
  for (const request of accepted) openLaunch(request, { spaces: api.spaces, shared: api.shared, setShared: api.setShared, run: api.run, closeOverlay: api.closeOverlay });
  const pending = api.shared(LAUNCH_PENDING) || [], threads = api.shared(THREADS) || {};
  if (!pending.length && !Object.keys(threads).length) return;
  const next = reconcileLaunches({ pending, threads }, api.spaces(), now);
  if (JSON.stringify(next.pending) !== JSON.stringify(pending)) api.setShared(LAUNCH_PENDING, next.pending);
  if (JSON.stringify(next.threads) !== JSON.stringify(threads)) api.setShared(THREADS, next.threads);
}
