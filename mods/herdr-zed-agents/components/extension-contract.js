// Shared: edit components/extension-contract.js, then npm run sync:shared.
// Pure validators for provider messages (ARCHITECTURE.md §3). No imports, no native APIs.
// @ts-check
/** @import { LaunchRequest, LaunchTarget, LaunchOrigin, Validation, ThreadDecoration, GitCredentialBinding } from './contract-types.js' */

const MAX_LAUNCH_LEAD_MS = 60_000;
const MAX_NAME_LENGTH = 120;
const MAX_DECORATION_TEXT = 40;
const DECORATION_TONES = ['muted', 'accent', 'warning', 'error'];
const DECORATION_FIELDS = ['badge', 'subtitle', 'tone'];
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/i;
const MAX_CREDENTIAL_PAIRS = 8;
const MAX_ORIGIN_REF = 200;
const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** @type {(value: unknown) => value is Record<string, any>} */
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {string} error @returns {{ ok: false, error: string }} */
const fail = error => ({ ok: false, error });
/** @param {object} value @param {string[]} keys */
const hasOnlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));

/** @param {string | null | undefined} machine @param {string} folder */
export function projectKey(machine, folder) {
  return JSON.stringify([machine || '', folder]);
}

// §3.1 optional `origin` links a launch to the provider record that started it (e.g. a task run).
/** @param {unknown} origin @returns {boolean} */
const validOrigin = origin => plain(origin) && hasOnlyKeys(origin, ['extension', 'ref'])
  && typeof origin.extension === 'string' && EXTENSION_ID_PATTERN.test(origin.extension)
  && typeof origin.ref === 'string' && origin.ref.length > 0 && origin.ref.length <= MAX_ORIGIN_REF;

// §3.1. `argv` is returned as the very same array the provider sent: no quoting, rewriting or copying.
/**
 * @param {unknown} request
 * @param {{ now: number, launcherId: string | null | undefined, spaces?: { id: string, machine?: string | null }[] }} options
 * @returns {Validation<LaunchRequest>}
 */
export function validateLaunchRequest(request, { now, launcherId, spaces = [] }) {
  if (!plain(request)) return fail('Launch request must be an object.');
  const { id, source, target, name, argv, profile, expiresAt, origin } = request;
  if (typeof id !== 'string' || id.length === 0) return fail('Launch request id must be a non-empty string.');
  if (!launcherId || source !== launcherId) return fail('Launch request source is not the active launcher.');
  if (!Number.isFinite(expiresAt)) return fail('Launch request expiresAt must be a number.');
  if (expiresAt <= now) return fail('Launch request has expired.');
  if (expiresAt > now + MAX_LAUNCH_LEAD_MS) return fail('Launch request expiresAt is too far in the future.');
  if (!plain(target) || !hasOnlyKeys(target, ['space', 'folder', 'projectName', 'machine', 'overlay']))
    return fail('Launch request target is invalid.');
  if (typeof target.folder !== 'string' || target.folder.length === 0) return fail('Launch target folder must be a non-empty string.');
  if (target.projectName !== undefined && typeof target.projectName !== 'string') return fail('Launch target projectName must be a string.');
  if (target.overlay !== undefined && typeof target.overlay !== 'string') return fail('Launch target overlay must be a string.');
  if (target.machine !== undefined && target.machine !== null && typeof target.machine !== 'string')
    return fail('Launch target machine must be a string or null.');
  if (target.space !== undefined) {
    const space = spaces.find(item => item.id === target.space);
    if (!space) return fail('Launch target space is unknown.');
    if ((target.machine || null) !== (space.machine || null)) return fail('Launch target machine does not match its space.');
  }
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > MAX_NAME_LENGTH)
    return fail(`Launch request name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters.`);
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(item => typeof item !== 'string'))
    return fail('Launch request argv must be a non-empty array of strings.');
  if (profile !== null && typeof profile !== 'string') return fail('Launch request profile must be a string or null.');
  if (origin !== undefined && !validOrigin(origin)) return fail('Launch request origin must be { extension, ref } with a valid extension ID and a ref of at most 200 characters.');
  return { ok: true, value: { id, source, target: /** @type {LaunchTarget} */ (target), name, argv, profile, expiresAt,
    ...(origin === undefined ? {} : { origin: /** @type {LaunchOrigin} */ (origin) }) } };
}

// §3.3. `value` is the stored envelope `{ updatedAt, threads }`. Invalid entries are dropped; the rest is kept.
/** @param {unknown} value @returns {Record<string, ThreadDecoration>} */
export function validateDecorations(value) {
  /** @type {Record<string, ThreadDecoration>} */
  const sanitized = {};
  if (!plain(value) || !plain(value.threads)) return sanitized;
  for (const [tabId, entry] of Object.entries(value.threads)) {
    if (!plain(entry) || !hasOnlyKeys(entry, DECORATION_FIELDS)) continue;
    /** @type {Record<string, string>} */
    const clean = {};
    let valid = true;
    for (const field of ['badge', 'subtitle']) {
      if (entry[field] === undefined) continue;
      if (typeof entry[field] === 'string' && entry[field].length <= MAX_DECORATION_TEXT) clean[field] = entry[field];
      else valid = false;
    }
    if (entry.tone !== undefined) {
      if (DECORATION_TONES.includes(entry.tone)) clean.tone = entry.tone;
      else valid = false;
    }
    if (valid) sanitized[tabId] = /** @type {ThreadDecoration} */ (clean);
  }
  return sanitized;
}

// §3.5. Returns ['-c', 'key=value', ...] or throws; a violation rejects the whole binding.
/** @param {unknown} binding @returns {string[]} */
export function gitCredentialArgs(binding) {
  if (!plain(binding)) throw new Error('Git credential binding must be an object.');
  const { host, login, config } = binding;
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) throw new Error('Git credential host is invalid.');
  if (typeof login !== 'string' || !LOGIN_PATTERN.test(login)) throw new Error('Git credential login is invalid.');
  if (!Array.isArray(config) || config.length > MAX_CREDENTIAL_PAIRS) throw new Error('Git credential config must be an array of at most 8 pairs.');
  const base = `https://${host}`;
  const allowedKeys = [`credential.${base}.helper`, `credential.${base}.username`, `url.${base}/.insteadOf`];
  const insteadOfValues = [`git@${host}:`, `ssh://git@${host}/`];
  return config.flatMap(pair => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Git credential config entries must be [key, value] pairs.');
    const [key, value] = pair;
    if (typeof key !== 'string' || !allowedKeys.includes(key)) throw new Error('Git credential config key is not allowed.');
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('Git credential config value is invalid.');
    if (key.endsWith('.insteadOf') && !insteadOfValues.includes(value)) throw new Error('Git credential insteadOf value is not allowed.');
    return ['-c', `${key}=${value}`];
  });
}
