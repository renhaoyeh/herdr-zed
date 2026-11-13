// Shared: edit components/extension-contract.js, then npm run sync:shared.
// Pure validators for provider messages (ARCHITECTURE.md §3). No imports, no native APIs.
// @ts-check
/** @import { LaunchRequest, LaunchTarget, LaunchOrigin, Validation, ThreadDecoration, GitCredentialBinding, ComposerChoice, ComposerField, ComposerUsage, ComposerUsageWindow, LaunchIntent, ComposerCommand, ComposerCommandRequest } from './contract-types.js' */

const MAX_LAUNCH_LEAD_MS = 60_000;
const MAX_NAME_LENGTH = 120;
const MAX_TASK_LENGTH = 20000;
const MAX_DECORATION_TEXT = 40;
const DECORATION_TONES = ['muted', 'accent', 'warning', 'error'];
const DECORATION_FIELDS = ['badge', 'subtitle', 'tone'];
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/i;
const MAX_CREDENTIAL_PAIRS = 8;
const MAX_ORIGIN_REF = 200;
const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const TARGET_KEYS = ['space', 'folder', 'projectName', 'machine', 'overlay'];

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

// §3.1 target shape, shared by launch requests and the Terminal command. `space: null` means a project that
// is not a space yet (the picker's context for a pending project); it is treated as absent.
/**
 * @param {unknown} target
 * @param {{ id: string, machine?: string | null }[]} [spaces]
 * @returns {Validation<LaunchTarget>}
 */
export function validateLaunchTarget(target, spaces = []) {
  if (!plain(target) || !hasOnlyKeys(target, TARGET_KEYS)) return fail('Launch request target is invalid.');
  if (typeof target.folder !== 'string' || target.folder.length === 0) return fail('Launch target folder must be a non-empty string.');
  if (target.projectName !== undefined && typeof target.projectName !== 'string') return fail('Launch target projectName must be a string.');
  if (target.overlay !== undefined && typeof target.overlay !== 'string') return fail('Launch target overlay must be a string.');
  if (target.machine !== undefined && target.machine !== null && typeof target.machine !== 'string')
    return fail('Launch target machine must be a string or null.');
  if (target.space !== undefined && target.space !== null) {
    const space = spaces.find(item => item.id === target.space);
    if (!space) return fail('Launch target space is unknown.');
    if ((target.machine || null) !== (space.machine || null)) return fail('Launch target machine does not match its space.');
  }
  return { ok: true, value: /** @type {LaunchTarget} */ (target) };
}

// §3.1. `argv` is returned as the very same array the provider sent: no quoting, rewriting or copying.
/**
 * @param {unknown} request
 * @param {{ now: number, launcherId: string | null | undefined, spaces?: { id: string, machine?: string | null }[] }} options
 * @returns {Validation<LaunchRequest>}
 */
export function validateLaunchRequest(request, { now, launcherId, spaces = [] }) {
  if (!plain(request)) return fail('Launch request must be an object.');
  const { id, source, target, name, argv, profile, expiresAt, origin, task } = request;
  if (typeof id !== 'string' || id.length === 0) return fail('Launch request id must be a non-empty string.');
  if (!launcherId || source !== launcherId) return fail('Launch request source is not the active launcher.');
  if (!Number.isFinite(expiresAt)) return fail('Launch request expiresAt must be a number.');
  if (expiresAt <= now) return fail('Launch request has expired.');
  if (expiresAt > now + MAX_LAUNCH_LEAD_MS) return fail('Launch request expiresAt is too far in the future.');
  const checkedTarget = validateLaunchTarget(target, spaces);
  if (!checkedTarget.ok) return fail(checkedTarget.error);
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > MAX_NAME_LENGTH)
    return fail(`Launch request name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters.`);
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(item => typeof item !== 'string'))
    return fail('Launch request argv must be a non-empty array of strings.');
  if (profile !== null && typeof profile !== 'string') return fail('Launch request profile must be a string or null.');
  if (origin !== undefined && !validOrigin(origin)) return fail('Launch request origin must be { extension, ref } with a valid extension ID and a ref of at most 200 characters.');
  if (task !== undefined && (typeof task !== 'string' || task.trim().length === 0 || task.length > MAX_TASK_LENGTH))
    return fail(`Launch request task must be a non-empty string of at most ${MAX_TASK_LENGTH} characters.`);
  return { ok: true, value: { id, source, target: checkedTarget.value, name, argv, profile, expiresAt,
    ...(origin === undefined ? {} : { origin: /** @type {LaunchOrigin} */ (origin) }),
    ...(task === undefined ? {} : { task }) } };
}

// §3.1 Composer: the launcher publishes `herdr-zed.composer.<id>` = { updatedAt, machines: { [machine | '']: { choices } } }.
// Returns the machine's valid choices only; a malformed choice or field is dropped, never repaired.
const MAX_LABEL = 80, KEY_PATTERN = /^[\w.:@#-]{1,200}$/;
/** @param {unknown} field @returns {field is ComposerField} */
const validField = field => plain(field) && typeof field.id === 'string' && KEY_PATTERN.test(field.id)
  && typeof field.label === 'string' && field.label.length > 0 && field.label.length <= MAX_LABEL
  && (field.type === 'toggle' ? hasOnlyKeys(field, ['id', 'label', 'type', 'value']) && typeof field.value === 'boolean'
    : field.type === 'select' && hasOnlyKeys(field, ['id', 'label', 'type', 'value', 'options']) && Array.isArray(field.options)
      && field.options.length > 0 && field.options.every(option => plain(option) && hasOnlyKeys(option, ['key', 'label', 'only'])
        && typeof option.key === 'string' && KEY_PATTERN.test(option.key)
        && typeof option.label === 'string' && option.label.length > 0 && option.label.length <= MAX_LABEL
        && (option.only === undefined || plain(option.only) && Object.values(option.only).every(keys => Array.isArray(keys) && keys.every(key => typeof key === 'string'))))
      && field.options.some(option => option.key === field.value));
/** @param {unknown} envelope @param {string | null | undefined} machine @returns {ComposerChoice[] | null} */
export function composerChoices(envelope, machine) {
  const entry = plain(envelope) && plain(envelope.machines) ? envelope.machines[machine || ''] : null;
  if (!plain(entry) || !Array.isArray(entry.choices)) return null;
  return entry.choices.filter(choice => plain(choice) && hasOnlyKeys(choice, ['key', 'label', 'icon', 'tint', 'fields'])
    && typeof choice.key === 'string' && KEY_PATTERN.test(choice.key) && choice.key !== 'terminal'
    && typeof choice.label === 'string' && choice.label.length > 0 && choice.label.length <= MAX_LABEL
    && (choice.icon === undefined || typeof choice.icon === 'string') && (choice.tint === undefined || typeof choice.tint === 'boolean')
    && Array.isArray(choice.fields) && choice.fields.every(validField));
}
/** @param {unknown} window @returns {window is ComposerUsageWindow} */
const validWindow = window => plain(window) && hasOnlyKeys(window, ['label', 'minutes', 'usedPercent', 'resetsAt'])
  && typeof window.label === 'string' && window.label.length > 0 && window.label.length <= MAX_LABEL
  && Number.isFinite(window.minutes) && /** @type {number} */ (window.minutes) > 0
  && Number.isFinite(window.usedPercent) && (window.resetsAt === null || Number.isFinite(window.resetsAt));
/** The machine's quota readings in display order; a malformed account is dropped. @param {unknown} envelope @param {string | null | undefined} machine @returns {ComposerUsage[]} */
export function composerUsage(envelope, machine) {
  const entry = plain(envelope) && plain(envelope.machines) ? envelope.machines[machine || ''] : null;
  if (!plain(entry) || !Array.isArray(entry.usage)) return [];
  return entry.usage.filter(account => plain(account) && hasOnlyKeys(account, ['key', 'label', 'icon', 'tint', 'muted', 'menu', 'windows'])
    && typeof account.key === 'string' && KEY_PATTERN.test(account.key)
    && typeof account.label === 'string' && account.label.length > 0 && account.label.length <= MAX_LABEL
    && (account.icon === undefined || typeof account.icon === 'string') && (account.tint === undefined || typeof account.tint === 'boolean')
    && (account.muted === undefined || typeof account.muted === 'boolean')
    && (account.menu === undefined || (plain(account.menu) && hasOnlyKeys(account.menu, ['view', 'width'])
      && typeof account.menu.view === 'string' && EXTENSION_ID_PATTERN.test(account.menu.view)
      && Number.isFinite(account.menu.width) && account.menu.width > 0 && account.menu.width <= 2400))
    && Array.isArray(account.windows) && account.windows.every(validWindow));
}
/** A select option is offered while every field it names holds one of its keys. @param {{ only?: Record<string, string[]> }} option @param {Record<string, unknown>} values */
export const composerOptionShown = (option, values) => !option.only
  || Object.entries(option.only).every(([field, keys]) => keys.includes(/** @type {string} */ (values[field])));
/**
 * The intent the shell appends to `herdr-zed.launch.intents`; the launcher takes its own off the queue.
 * @param {{ launcher: string, target: LaunchTarget, choice: string, values: Record<string, string | boolean>, task?: string, command?: string, now: number }} input
 * @returns {LaunchIntent}
 */
export function launchIntent({ launcher, target, choice, values, task, command, now }) {
  return { id: `intent:${now}:${Math.random().toString(36).slice(2)}`, launcher, target, choice, values,
    ...(task ? { task: task.slice(0, MAX_TASK_LENGTH) } : {}), ...(command ? { command } : {}), expiresAt: now + 30_000 };
}

export const COMPOSER_COMMAND_REQUESTS = 'herdr-zed.composer-command.requests';
export const COMPOSER_COMMAND_RESULTS = 'herdr-zed.composer-command.results';
/** @param {unknown} value @param {number} now @param {{id:string, machine?:string|null}[]} spaces @returns {value is ComposerCommandRequest} */
export function validComposerCommandRequest(value, now, spaces) {
  return plain(value) && hasOnlyKeys(value, ['id', 'launcher', 'choice', 'target', 'expiresAt'])
    && typeof value.id === 'string' && KEY_PATTERN.test(value.id)
    && typeof value.launcher === 'string' && EXTENSION_ID_PATTERN.test(value.launcher)
    && typeof value.choice === 'string' && KEY_PATTERN.test(value.choice)
    && typeof value.expiresAt === 'number' && value.expiresAt > now && value.expiresAt <= now + 60_000
    && validateLaunchTarget(value.target, spaces).ok;
}
/** Reject malformed command results; the shell never interprets provider IDs. @param {unknown} value @param {number} [now] @returns {ComposerCommand[] | null} */
export function composerCommands(value, now = Date.now()) {
  if (!plain(value) || typeof value.expiresAt !== 'number' || value.expiresAt <= now || !Array.isArray(value.items) || value.items.length > 1000) return null;
  const ids = new Set(), names = new Set();
  for (const item of value.items) {
    if (!plain(item) || !hasOnlyKeys(item, ['id', 'name', 'description']) || typeof item.id !== 'string' || !KEY_PATTERN.test(item.id)
      || typeof item.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.name)
      || typeof item.description !== 'string' || item.description.length > 500 || ids.has(item.id) || names.has(item.name)) return null;
    ids.add(item.id); names.add(item.name);
  }
  return value.items;
}

// Terminal row (ARCHITECTURE §3.1): the Agents picker asks the shell for the native Terminal choice. The mod command
// channel delivers only a command string (as the usage and system clients do), so the target travels as encoded JSON:
// run('herdr-zed.' + newTerminalCommand(target)). The shell reads it with readNewTerminalCommand and opens the tab
// exactly as the native picker's Terminal choice does: createNativeThread(null, target).
export const NEW_TERMINAL_PREFIX = 'new-terminal:';
/** @param {Record<string, any>} [target] @returns {string} */
export function newTerminalCommand(target = {}) {
  const { space, folder, projectName, machine, overlay } = target;
  const body = Object.fromEntries(Object.entries({ space, folder, projectName, machine, overlay })
    .filter(([, value]) => value !== undefined));
  return `${NEW_TERMINAL_PREFIX}${encodeURIComponent(JSON.stringify(body))}`;
}
/** @returns {null | Validation<LaunchTarget>} null when the command is not a Terminal request */
export function readNewTerminalCommand(command, spaces = []) {
  if (typeof command !== 'string' || !command.startsWith(NEW_TERMINAL_PREFIX)) return null;
  let target;
  try { target = JSON.parse(decodeURIComponent(command.slice(NEW_TERMINAL_PREFIX.length))); }
  catch { return fail('Terminal request is not valid JSON.'); }
  return validateLaunchTarget(target, spaces);
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

// Unsaved changes (ARCHITECTURE §3.9): a page in a Settings, Extensions or Agents dialog with edits it has not saved
// sets `herdr-zed.unsaved.<overlay id>` to true, from a timer or state change and never during render, and back to null.
// The shell asks before closing or leaving that dialog. A page closes it through the shell, never with closeOverlay:
// run('herdr-zed.' + SETTINGS_CLOSE_COMMAND).
/** @param {string} overlay @returns {string} */
export const unsavedKey = overlay => `herdr-zed.unsaved.${overlay}`;
export const SETTINGS_CLOSE_COMMAND = 'settings-close';

// Surface height (ARCHITECTURE §3.10): a sidebar.bottom surface reports the px height of its content here, from a timer
// and only when it changes; the shell sizes the surface's block to it (96-420px).
/** @param {string} extension @param {string} surface @returns {string} */
export const surfaceHeightKey = (extension, surface) => `herdr-zed.surface-height.${extension}.${surface}`;
