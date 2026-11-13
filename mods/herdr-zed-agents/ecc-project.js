// Project policy is product data, never a file written into the user's repository.
import { readFile, realpath, stat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eccHash, readEccCatalog, eccCatalogForUi, readEccDetail } from './ecc-catalog.js';
import { parseEcc, eccItemEnabled, chooseEccItem } from './ecc-model.js';
import { parseSharedMcp, sharedMcpSupported } from './components/shared-mcp-model.js';

export async function optionalText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('Unknown or invalid project settings fields.');
}
export async function projectIdentity(folder) {
  if (typeof folder !== 'string' || !isAbsolute(folder)) throw Error('Use the absolute local project folder. Remote projects are not supported.');
  const canonical = await realpath(folder);
  if (!(await stat(canonical)).isDirectory()) throw Error('Project folder is not a directory.');
  return process.platform === 'win32' ? canonical.replaceAll('\\', '/').toLowerCase() : canonical;
}
export const projectPolicyPath = (home, folder) => join(home, 'data', 'herdr-zed', 'project-capabilities', `${eccHash(folder)}.json`);

export function parseProjectPolicy(text, folder) {
  if (text === null) return { version: 1, folder, providers: {} };
  const value = JSON.parse(text);
  fields(value, ['version', 'folder', 'providers']);
  if (value.version !== 1 || value.folder !== folder) throw Error('Invalid project policy identity.');
  fields(value.providers, ['claude', 'codex']);
  for (const policy of Object.values(value.providers)) {
    fields(policy, ['enabled', 'claudeHooks', 'selection', 'mcp']);
    if (typeof policy.enabled !== 'boolean' || !['off', 'minimal', 'standard', 'strict'].includes(policy.claudeHooks)) throw Error('Invalid project ECC switches.');
    for (const key of ['selection', 'mcp']) {
      if (!object(policy[key]) || Object.values(policy[key]).some(value => typeof value !== 'boolean')) throw Error('Project selections must be boolean maps.');
    }
  }
  return value;
}

async function readGlobalSettings(home) {
  const [globalText, mcpText] = await Promise.all([
    optionalText(join(home, 'data', 'herdr-zed', 'ecc.json')),
    optionalText(join(home, 'data', 'herdr-zed', 'shared-mcp.json')),
  ]);
  const config = parseEcc(globalText);
  config.source ||= join(home, 'mods', 'herdr-zed-agents', 'ecc-source');
  return { globalText, mcpText, config, mcp: parseSharedMcp(mcpText) };
}

export async function readProjectState(home, folder, { catalogReader = readEccCatalog } = {}) {
  const identity = await projectIdentity(folder), path = projectPolicyPath(home, identity);
  const [{ config, mcp, globalText, mcpText }, policyText] = await Promise.all([readGlobalSettings(home), optionalText(path)]);
  const catalog = await catalogReader(config.source);
  return { identity, path, config, catalog, mcp, policy: parseProjectPolicy(policyText, identity),
    revision: eccHash(JSON.stringify([globalText, mcpText, policyText, catalog.sourceRevision])) };
}

const hostPlatform = () => process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
export async function globalOverview(home, { catalogReader = readEccCatalog } = {}) {
  const { config, mcp } = await readGlobalSettings(home);
  let catalog = null, catalogError = null;
  try { catalog = await catalogReader(config.source); } catch (error) { catalogError = error.message; }
  return {
    scope: 'global', product: 'Herdr Zed', ecc: { name: 'Everything Claude Code', source: config.source, enabled: config.enabled,
      version: catalog?.version || null, catalogError, groups: catalog?.groups || [],
      providers: Object.fromEntries(['claude', 'codex'].map(provider => {
        const selected = (catalog?.items || []).filter(item => eccItemEnabled(config, provider, item));
        return [provider, { enabled: config.enabled && config.providerEnabled[provider], selectedCount: selected.length,
          selectedByGroup: Object.fromEntries((catalog?.groups || []).map(group => [group.id, selected.filter(item => item.group === group.id).length])),
          selected: selected.slice(0, 12).map(item => ({ id: item.id, group: item.group, name: item.name, description: item.description?.slice(0, 250) })),
          truncated: selected.length > 12,
        }];
      })) },
    mcp: [
      { name: 'herdr_tasks', builtin: true, enabled: true, supported: true, description: 'Local task progress and task management.' },
      { name: 'herdr_ecc', builtin: true, enabled: true, supported: true, description: 'Explain this layout’s ECC, skills and MCP configuration; inspect and configure project choices.' },
      ...Object.entries(mcp.servers).filter(([name]) => !['herdr_tasks', 'herdr_ecc'].includes(name)).map(([name, server]) => ({
        name, builtin: false, enabled: server.enabled !== false, supported: sharedMcpSupported(name, hostPlatform()), transport: server.url ? 'local-http' : 'stdio',
      })),
    ],
    notes: ['These are saved layout defaults, not an inventory of this conversation’s live tools.',
      'Enabled is a configuration choice, not proof that a connection is healthy.',
      'Project overrides can differ. Use get_project only when asking about a specific project.',
      'Unrelated account-authorized MCP services are outside this shared inventory.'],
    browse: 'Use paginated list_components for the full catalog and selected/active states; the overview samples at most 12 selected items per provider.',
  };
}

export function effectiveProjectPolicy(state, provider) {
  if (!['claude', 'codex'].includes(provider)) throw Error('Choose claude or codex.');
  return state.policy.providers[provider] || {
    enabled: state.config.enabled && state.config.providerEnabled[provider], claudeHooks: state.config.claudeHooks,
    selection: { ...state.config.selection[provider] }, mcp: {},
  };
}
export function projectSummary(state, provider) {
  const policy = effectiveProjectPolicy(state, provider);
  const config = { selection: { [provider]: policy.selection } };
  return { folder: state.identity, provider, revision: state.revision, scope: state.policy.providers[provider] ? 'project' : 'global',
    policy, selected: state.catalog.items.filter(item => eccItemEnabled(config, provider, item)).map(item => item.id),
    builtins: ['herdr_tasks', 'herdr_ecc'],
    mcp: Object.entries(state.mcp.servers).filter(([name]) => !['herdr_tasks', 'herdr_ecc'].includes(name)).map(([name, server]) => ({ name, enabled: policy.mcp[name] ?? server.enabled !== false,
      supported: sharedMcpSupported(name, process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux') })),
    appliesTo: 'New local sessions only. Running sessions and global/account settings are unchanged.' };
}

export function previewProjectPolicy(state, provider, changes) {
  fields(changes, ['enabled', 'selection', 'mcp', 'claudeHooks', 'replaceSelection']);
  const current = effectiveProjectPolicy(state, provider), next = structuredClone(current);
  if (changes.enabled !== undefined) {
    if (typeof changes.enabled !== 'boolean') throw Error('enabled must be boolean.');
    next.enabled = changes.enabled;
  }
  if (changes.claudeHooks !== undefined) {
    if (provider !== 'claude' || !['off', 'minimal', 'standard', 'strict'].includes(changes.claudeHooks)) throw Error('Invalid Claude hook profile.');
    next.claudeHooks = changes.claudeHooks;
  }
  if (changes.replaceSelection !== undefined && typeof changes.replaceSelection !== 'boolean') throw Error('replaceSelection must be boolean.');
  if (changes.replaceSelection) next.selection = Object.fromEntries(state.catalog.items.filter(item => item.providers.includes(provider)).map(item => [item.id, false]));
  if (changes.selection !== undefined) {
    if (!object(changes.selection)) throw Error('selection must be a boolean map of ECC component IDs.');
    const config = { selection: { [provider]: next.selection } };
    for (const [id, enabled] of Object.entries(changes.selection)) {
      const item = state.catalog.items.find(item => item.id === id && item.providers.includes(provider));
      if (!item || typeof enabled !== 'boolean') throw Error(`Unknown or unsupported ECC selection: ${id}`);
      if (enabled && item.unavailable) throw Error(`${id}: ${item.unavailable}`);
      chooseEccItem(config, provider, item, enabled);
    }
    next.selection = config.selection[provider];
  }
  if (changes.mcp !== undefined) {
    if (!object(changes.mcp)) throw Error('mcp must be a boolean map of configured shared connection names.');
    for (const [name, enabled] of Object.entries(changes.mcp)) {
      if (['herdr_tasks', 'herdr_ecc'].includes(name)) throw Error('Built-in management connections cannot be overridden.');
      if (!Object.hasOwn(state.mcp.servers, name) || typeof enabled !== 'boolean') throw Error(`${name}: configure this connection in MCP Connections first.`);
      if (enabled && !sharedMcpSupported(name, process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux')) throw Error(`${name}: unavailable on this platform.`);
      next.mcp[name] = enabled;
    }
  }
  const policy = { ...state.policy, providers: { ...state.policy.providers, [provider]: next } };
  const summary = projectSummary({ ...state, policy }, provider);
  const requirements = state.catalog.items.filter(item => next.enabled && summary.selected.includes(item.id) && item.group === 'mcp')
    .map(item => ({ id: item.id, requirements: item.requirements || [], unavailable: item.unavailable || null }));
  if (requirements.some(item => item.unavailable)) throw Error('Selected ECC MCP templates still need configuration.');
  return { ...summary, requirements, policyFile: policy };
}

// Lock + revision check serialize independent MCP processes without losing another provider's edits.
export async function saveProjectPolicy(home, folder, provider, changes, expectedRevision, options = {}) {
  const identity = await projectIdentity(folder), path = projectPolicyPath(home, identity), lock = `${path}.lock`;
  await mkdir(join(home, 'data', 'herdr-zed', 'project-capabilities'), { recursive: true });
  try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(await optionalText(lock));
    if (!Number.isSafeInteger(owner) || owner <= 0) throw Error('Project settings have an invalid lock. Inspect the project policy lock before retrying.');
    try { process.kill(owner, 0); throw Error('Project settings are being changed. Retry after reading the project again.'); }
    catch (ownerError) {
      if (ownerError.code !== 'ESRCH') throw ownerError;
      await unlink(lock); await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const state = await readProjectState(home, folder, options);
    if (typeof expectedRevision !== 'string' || state.revision !== expectedRevision) throw Error('Project, global settings or ECC source changed. Preview again before applying.');
    let policy;
    if (changes === null) {
      policy = structuredClone(state.policy); delete policy.providers[provider];
      if (!['claude', 'codex'].includes(provider)) throw Error('Choose claude or codex.');
    } else policy = previewProjectPolicy(state, provider, changes).policyFile;
    await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    return projectSummary(await readProjectState(home, folder, options), provider);
  } finally {
    try { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    finally { await unlink(lock); }
  }
}

export async function projectMcpCall(home, name, args, options = {}) {
  const allowed = { get_overview: [], get_project: ['folder', 'provider'], list_components: ['folder', 'provider', 'group', 'query', 'offset', 'limit'],
    read_component: ['folder', 'provider', 'id'], preview_project: ['folder', 'provider', 'changes'],
    apply_project: ['folder', 'provider', 'changes', 'revision'], reset_project: ['folder', 'provider', 'revision'] };
  if (!allowed[name]) throw Error('Unknown ECC tool.');
  fields(args, allowed[name]);
  if (name === 'get_overview') return globalOverview(home, options);
  const browsing = ['list_components', 'read_component'].includes(name);
  if ((!browsing || args.provider !== undefined) && !['claude', 'codex'].includes(args.provider)) throw Error('Choose claude or codex.');
  if (name === 'apply_project' || name === 'reset_project') return saveProjectPolicy(home, args.folder, args.provider, name === 'reset_project' ? null : args.changes, args.revision, options);
  const state = browsing && args.folder === undefined ? await (async () => {
    const settings = await readGlobalSettings(home), catalog = await (options.catalogReader || readEccCatalog)(settings.config.source);
    return { ...settings, catalog, revision: eccHash(JSON.stringify([settings.globalText, settings.mcpText, catalog.sourceRevision])) };
  })() : await readProjectState(home, args.folder, options);
  if (name === 'get_project') return projectSummary(state, args.provider);
  if (name === 'preview_project') {
    const { policyFile, ...preview } = previewProjectPolicy(state, args.provider, args.changes); return preview;
  }
  if (name === 'read_component') {
    const item = state.catalog.items.find(item => item.id === args.id && (!args.provider || item.providers.includes(args.provider)));
    if (!item) throw Error('Unknown component for this provider.');
    // MCP templates may have literal credentials in a custom source; expose setup metadata only.
    if (item.group === 'mcp') return { id: item.id, requirements: item.requirements || [], unavailable: item.unavailable || null };
    return { id: item.id, text: await readEccDetail(state.catalog, item.id) };
  }
  const { query = '', offset = 0, limit = 40, group } = args;
  if (typeof query !== 'string' || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100
    || (group !== undefined && !state.catalog.groups.some(item => item.id === group))) throw Error('Invalid catalog filter or pagination.');
  const items = eccCatalogForUi(state.catalog).items.filter(item => (!args.provider || item.providers.includes(args.provider)) && (!group || item.group === group)
    && `${item.name} ${item.description} ${item.modules?.join(' ') || ''}`.toLowerCase().includes(query.toLowerCase()));
  return { revision: state.revision, total: items.length, offset, items: items.slice(offset, offset + limit).map(item => {
    const selected = {}, active = {};
    for (const provider of ['claude', 'codex']) {
      const policy = state.policy ? effectiveProjectPolicy(state, provider) : {
        enabled: state.config.enabled && state.config.providerEnabled[provider], selection: state.config.selection[provider],
      };
      selected[provider] = eccItemEnabled({ selection: { [provider]: policy.selection } }, provider, item);
      active[provider] = policy.enabled && selected[provider];
    }
    return { ...item, selected, active };
  }) };
}
