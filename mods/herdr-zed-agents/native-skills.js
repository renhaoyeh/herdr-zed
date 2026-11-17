// Native sources own installation and global state. Herdr stores project exclusions only.
import { readFile, mkdir, lstat, writeFile, rename, rm, unlink, realpath } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readCodexSkillInventory } from './codex-skills.js';
import { readClaudeSkills } from './claude-skills.js';
import { projectIdentity } from './ecc-project.js';
import { prepareSharedGuidance, discoverSharedSkills } from './shared-skills.js';
import { acquireFileLock, writeChecked } from './devkits-save.js';
import { openConfig } from './codex-config.js';
import { mcpToml } from './components/shared-mcp-model.js';
import { frontmatter } from './devkits-model.js';

const optional = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const hash = text => createHash('sha256').update(text || '').digest('hex');
const providerCheck = provider => { if (!['claude', 'codex'].includes(provider)) throw Error('Choose Claude Code or Codex.'); };
export const nativeSkillKey = path => process.platform === 'win32' ? resolve(path).replaceAll('\\', '/').toLowerCase() : resolve(path);

export async function readNativeSkillPolicy(home, folder) {
  if (!folder) return { folder: null, path: null, revision: hash(null), disabled: { claude: [], codex: [] } };
  const identity = await projectIdentity(folder), path = join(home, 'data', 'herdr-zed', 'skill-overrides', `${hash(identity)}.json`);
  const text = await optional(path), value = text === null ? { version: 1, folder: identity, disabled: { claude: [], codex: [] } } : JSON.parse(text);
  if (value.version !== 1 || value.folder !== identity || !value.disabled || typeof value.disabled !== 'object'
    || Object.keys(value).some(key => !['version', 'folder', 'disabled'].includes(key))
    || Object.keys(value.disabled).some(key => !['claude', 'codex'].includes(key))
    || ['claude', 'codex'].some(provider => !Array.isArray(value.disabled[provider]) || value.disabled[provider].some(path => typeof path !== 'string' || !isAbsolute(path))))
    throw Error('Invalid project skill overrides.');
  return { ...value, path, text, revision: hash(text) };
}

export async function saveNativeSkillPolicy(home, folder, provider, disabled, revision) {
  providerCheck(provider);
  if (!folder) throw Error('Choose a local project before changing its skills.');
  if (!Array.isArray(disabled) || disabled.some(path => typeof path !== 'string' || !isAbsolute(path))) throw Error('Skill exclusions must be absolute paths.');
  const initial = await readNativeSkillPolicy(home, folder);
  await mkdir(dirname(initial.path), { recursive: true });
  const lockPath = `${initial.path}.lock`, lock = await acquireFileLock(lockPath);
  try {
    const current = await readNativeSkillPolicy(home, folder);
    if (current.revision !== revision) throw Error('Project skill settings changed. Refresh before applying.');
    const next = { version: 1, folder: current.folder, disabled: { ...current.disabled, [provider]: [...new Set(disabled.map(nativeSkillKey))].sort() } };
    await writeChecked(current.path, `${JSON.stringify(next, null, 2)}\n`, current.text);
    return readNativeSkillPolicy(home, folder);
  } finally { await lock.close(); await unlink(lockPath); }
}

export async function nativeSkillFlags(home, folder, provider, directory, { open = openConfig, userHome } = {}) {
  providerCheck(provider);
  const policy = await readNativeSkillPolicy(home, folder), disabled = policy.disabled[provider];
  if (!disabled.length) return { flags: [], disabled };
  if (provider === 'claude') {
    if (!userHome) return { flags: [], disabled };
    const personal = await readClaudeSkills(userHome);
    const excluded = personal.filter(item => disabled.includes(nativeSkillKey(item.path)));
    if (nativeSkillKey(directory) === nativeSkillKey(join(userHome, '.claude')) && excluded.some(item => item.plugin))
      throw Error('This project excludes a personal plugin skill. Use an isolated Claude account or restore inheritance; native Claude manages its default-account plugins as a whole.');
    const skillOverrides = Object.fromEntries(excluded.filter(item => !item.plugin).map(item => [item.name, 'off']));
    return { flags: Object.keys(skillOverrides).length ? ['--settings', JSON.stringify({ skillOverrides })] : [], disabled };
  }
  const service = await open(directory);
  try {
    const effective = await service.request('config/read', { cwd: folder || directory, includeLayers: false });
    const existing = effective.config.skills?.config || [];
    if (!Array.isArray(existing)) throw Error('Codex returned an invalid skills configuration.');
    const values = [...existing.filter(item => !item.path || !disabled.includes(nativeSkillKey(item.path))), ...disabled.map(path => ({ path, enabled: false }))];
    return { flags: ['-c', `skills.config=${mcpToml(values)}`], disabled };
  } finally { await service.close(); }
}

export async function nativeSkillInventory(home, userHome, provider, directory, folder = '', { codex = readCodexSkillInventory, claude = readClaudeSkills, guidance = prepareSharedGuidance, open = openConfig } = {}) {
  providerCheck(provider);
  const policy = await readNativeSkillPolicy(home, folder), disabled = policy.disabled[provider];
  const native = provider === 'codex' ? await codex(directory, folder, { open })
    : (await claude(userHome, { includeDisabled: true })).map(item => ({ ...item, enabled: item.enabled !== false, source: item.plugin ? 'Personal plugin' : 'Personal', scope: 'user' }));
  const rows = native.filter(item => !item.owned).map(({ header, ...item }) => ({ ...item, kind: 'native', key: item.path ? nativeSkillKey(item.path) : item.id, inherited: !item.path || !disabled.includes(nativeSkillKey(item.path)),
    active: item.enabled && (!item.path || !disabled.includes(nativeSkillKey(item.path))), problems: item.problems || [], managed: false,
    canExclude: Boolean(item.path) && !(provider === 'claude' && item.plugin && nativeSkillKey(directory) === nativeSkillKey(join(userHome, '.claude'))) }));
  const selected = await guidance(home, provider, folder || null);
  rows.push(...(selected?.commands || []).map(item => ({ ...item,
    kind: 'managed', key: item.id, enabled: true, active: true, managed: true, source: item.id.startsWith('ecc:') ? 'ECC' : 'Herdr', problems: [] })));
  const root = join(userHome, provider === 'codex' ? '.agents' : '.claude', 'skills');
  return { provider, directory, folder: policy.folder, root, revision: policy.revision, disabled, items: rows.sort((a, b) => a.name.localeCompare(b.name)),
    inheritance: 'Unlisted skills inherit their native global state. Project changes apply to new local conversations.' };
}

export async function scanNativeSkills(home, source) {
  const result = await discoverSharedSkills(home, source);
  return result;
}

export async function setNativeSkillEnabled(userHome, provider, directory, path, enabled, expected, { open = openConfig } = {}) {
  providerCheck(provider);
  if (typeof enabled !== 'boolean' || typeof expected !== 'boolean' || !isAbsolute(path)) throw Error('Choose a native skill and its new state.');
  if (provider === 'codex') {
    const service = await open(directory);
    try {
      const result = await service.request('skills/list', { cwds: [directory], forceReload: true });
      const skill = (result.data || []).flatMap(item => item.skills || []).find(item => item.path && nativeSkillKey(item.path) === nativeSkillKey(path));
      if (!skill || skill.enabled !== expected) throw Error('The native skill changed. Refresh before applying.');
      const existing = service.config.skills?.config || [];
      if (!Array.isArray(existing)) throw Error('Codex returned an invalid skill configuration.');
      const value = [...existing.filter(item => !item.path || nativeSkillKey(item.path) !== nativeSkillKey(path)), { path, enabled }];
      await service.write([{ keyPath: 'skills.config', value, mergeStrategy: 'replace' }]);
      return { saved: true };
    } finally { await service.close(); }
  }
  const root = join(userHome, '.claude'), settingsPath = join(root, 'settings.json');
  await mkdir(root, { recursive: true });
  const lockPath = `${settingsPath}.herdr-skills.lock`, lock = await acquireFileLock(lockPath);
  try {
    const text = await optional(settingsPath), settings = JSON.parse(text || '{}');
    const skill = (await readClaudeSkills(userHome, { includeDisabled: true })).find(item => nativeSkillKey(item.path) === nativeSkillKey(path));
    if (!skill || skill.enabled !== expected) throw Error('The native skill changed. Refresh before applying.');
    if (skill.plugin) settings.enabledPlugins = { ...settings.enabledPlugins, [`${skill.plugin}@skills-dir`]: enabled };
    else settings.skillOverrides = { ...settings.skillOverrides, [skill.name]: enabled ? 'on' : 'off' };
    await writeChecked(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, text);
    return { saved: true, plugin: skill.plugin || null };
  } finally { await lock.close(); await unlink(lockPath); }
}

// An explicit install publishes a thin native entry that follows the original source.
// Sibling references remain relative to that source; no account config or scripts run.
export async function installNativeSkill(userHome, provider, source) {
  providerCheck(provider);
  if (!isAbsolute(userHome) || !isAbsolute(source)) throw Error('Use absolute user and source folders.');
  source = await realpath(source);
  const name = basename(source);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw Error('Use a skill folder with a simple name.');
  const text = await readFile(join(source, 'SKILL.md'), 'utf8');
  const header = /^---\r?\n[\s\S]*?\r?\n---/.exec(text)?.[0];
  const metadata = frontmatter(text);
  if (!header || !metadata.name || !metadata.description) throw Error('The source needs SKILL.md with name and description.');
  const root = join(userHome, provider === 'codex' ? '.agents' : '.claude', 'skills'), target = join(root, name);
  await mkdir(root, { recursive: true });
  const lockPath = join(root, `.${name}.herdr-install.lock`), lock = await acquireFileLock(lockPath);
  const stage = join(root, `.herdr-install-${randomUUID()}`);
  try {
    const exists = await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) throw Error('A native skill already uses this folder. Its files were preserved.');
    await mkdir(stage);
    await writeFile(join(stage, 'SKILL.md'), `${header}\n\nRead and follow the original skill at ${JSON.stringify(join(source, 'SKILL.md').replaceAll('\\', '/'))}. Resolve all relative links, scripts and resources from its original directory. Keep the source installed; if it is missing, report it instead of guessing.\n`);
    await writeFile(join(stage, 'herdr-source.json'), JSON.stringify({ version: 1, source }));
    await rename(stage, target);
    return { installed: true, path: join(target, 'SKILL.md'), source };
  } finally { await rm(stage, { recursive: true, force: true }); await lock.close(); await unlink(lockPath); }
}
