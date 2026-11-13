// Shared source library and immutable launch snapshots. Never writes provider/account homes.
import { readdir, readFile, lstat, mkdir, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mineRoot, mineSelectionPath, mineItems, parseMineSelection, parseDevkits, devkitsCatalog,
  withMine, devkitsGuidance, resourceProblems, providerSupported } from './devkits-model.js';
import { parseSharedMcp } from './components/shared-mcp-model.js';
import { acquireFileLock } from './devkits-save.js';

const optional = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const entries = async path => { try { return await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const platform = () => process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

export function parseSkillMetadata(text) {
  if (text === null) return { mcps: [] };
  const value = JSON.parse(text);
  if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'providers', 'platforms', 'mcps', 'origin'].includes(key)))
    throw Error('Invalid herdr.json skill metadata. Expected version 1.');
  for (const [key, allowed] of [['providers', ['claude', 'codex']], ['platforms', ['windows', 'macos', 'linux']], ['mcps', null]]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || (allowed && !value[key].length)
      || value[key].some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name) || (allowed && !allowed.includes(name)))))
      throw Error(`Invalid skill ${key}.`);
  }
  if (value.origin !== undefined && (!object(value.origin) || Object.keys(value.origin).some(key => !['source', 'revision'].includes(key))
    || typeof value.origin.source !== 'string' || typeof value.origin.revision !== 'string')) throw Error('Invalid skill origin.');
  return { mcps: [], ...value };
}

// Read the entire tree once, so the digest and the published snapshot describe the same bytes.
export async function skillTree(root) {
  const files = []; let bytes = 0, directories = 0;
  async function visit(folder, prefix = '') {
    if (++directories > 2000) throw Error('Skill exceeds 2,000 directories.');
    for (const entry of (await entries(folder)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', '.herdr-snapshot'].includes(entry.name)) continue;
      const path = join(folder, entry.name), relative = `${prefix}${entry.name}`, info = await lstat(path);
      if (info.isSymbolicLink()) throw Error(`Skill links are not supported: ${relative}`);
      if (info.isDirectory()) await visit(path, `${relative}/`);
      else if (info.isFile()) {
        if (files.length >= 2000 || bytes + info.size > 32 * 1024 * 1024) throw Error('Skill exceeds 2,000 files or 32 MB.');
        const content = await readFile(path); bytes += content.length;
        if (bytes > 32 * 1024 * 1024) throw Error('Skill exceeds 32 MB.');
        files.push({ path: relative, content, executable: Boolean(info.mode & 0o111) });
      } else throw Error(`Unsupported skill file: ${relative}`);
    }
  }
  if ((await lstat(root)).isSymbolicLink()) throw Error('Skill source must be a real directory.');
  await visit(root);
  const digest = createHash('sha256');
  for (const file of files) digest.update(JSON.stringify([file.path, file.content.length, file.executable])).update(file.content);
  return { files, revision: digest.digest('hex') };
}
async function publishTree(root, tree) {
  const target = join(root, tree.revision);
  if (await optional(join(target, '.herdr-snapshot')) === tree.revision) return target;
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.staging-${randomUUID()}`);
  try {
    for (const file of tree.files) {
      const path = join(temporary, file.path); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { mode: file.executable ? 0o700 : 0o600 });
    }
    await writeFile(join(temporary, '.herdr-snapshot'), tree.revision);
    try { await rename(temporary, target); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || await optional(join(target, '.herdr-snapshot')) !== tree.revision) throw error; }
    return target;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function readSharedLibrary(home) {
  const root = mineRoot(home), found = { rules: [], skills: [] };
  for (const entry of await entries(join(root, 'rules'))) if (entry.isFile() && /\.md$/i.test(entry.name)) {
    const path = join(root, 'rules', entry.name); found.rules.push({ path, text: await readFile(path, 'utf8') });
  }
  for (const entry of await entries(join(root, 'skills'))) if (!entry.name.startsWith('.') && entry.isDirectory()) {
    const path = join(root, 'skills', entry.name, 'SKILL.md'), text = await optional(path);
    if (text === null) continue;
    const metadata = parseSkillMetadata(await optional(join(dirname(path), 'herdr.json')));
    const tree = await skillTree(dirname(path));
    found.skills.push({ path, text, metadata: { ...metadata, revision: tree.revision } });
  }
  return mineItems(found).sort((a, b) => a.id.localeCompare(b.id));
}
export async function readSharedState(home) {
  const [items, text] = await Promise.all([readSharedLibrary(home), optional(mineSelectionPath(home))]);
  const selection = parseMineSelection(text);
  return { items, selection, revision: hash(JSON.stringify([text, items])) };
}

export async function prepareSharedGuidance(home, provider, folder = null, switches = {}) {
  if (!['claude', 'codex'].includes(provider)) throw Error('Choose claude or codex.');
  const { items, selection } = await readSharedState(home), catalog = devkitsCatalog(home);
  let project = {}, projectMcp = {};
  if (folder) {
    const { projectIdentity, projectPolicyPath, parseProjectPolicy } = await import('./ecc-project.js');
    const identity = await projectIdentity(folder);
    const policy = parseProjectPolicy(await optional(projectPolicyPath(home, identity)), identity).providers[provider];
    project = policy?.sharedSkills || {}; projectMcp = policy?.mcp || {};
  }
  for (const kind of ['rules', 'skills']) {
    catalog[kind] = await Promise.all(catalog[kind].map(async item => {
      const policy = await optional(item.policyPath), path = policy === null ? item.path : item.policyPath;
      return { ...item, path, text: policy ?? await optional(path) };
    }));
    catalog[kind].push(...items.filter(item => item.group === kind));
  }
  const config = withMine(parseDevkits(await optional(join(home, 'data', 'herdr-zed', 'capabilities.json'))), catalog, selection, provider, project);
  const servers = parseSharedMcp(await optional(join(home, 'data', 'herdr-zed', 'shared-mcp.json'))).servers;
  for (const [name, enabled] of Object.entries({ ...projectMcp, ...switches })) if (servers[name]) servers[name] = { ...servers[name], enabled };
  const missing = [...catalog.rules, ...catalog.skills].filter(item => item.text === null).map(item => item.path);
  const nativeSkills = [], commands = [];
  for (const item of catalog.skills) {
    if (!config.skills[item.id] || !providerSupported(item, provider) || resourceProblems(item, config, servers, platform(), missing).length) continue;
    const tree = await skillTree(dirname(item.path));
    // Fail rather than mixing a newer skill with metadata read before a concurrent update.
    if (item.revision && item.revision !== tree.revision) throw Error(`${item.name} changed during launch. Retry.`);
    const name = basename(dirname(item.path));
    const snapshot = await publishTree(join(home, 'data', 'herdr-zed', 'skill-snapshots'), tree);
    item.path = join(snapshot, basename(item.path));
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) commands.push({ id: item.id, name, description: item.description.slice(0, 500), path: item.path });
    if (item.source === 'mine') nativeSkills.push({ id: item.id, name, path: snapshot, revision: tree.revision });
  }
  const guidance = devkitsGuidance(config, catalog, servers, platform(), missing, provider);
  const names = new Set();
  for (const command of commands) {
    const base = command.name;
    for (let suffix = 2; names.has(command.name); suffix++) command.name = `${base.slice(0, 72)}-${suffix}`;
    names.add(command.name);
  }
  return guidance ? { ...guidance, nativeSkills, commands } : null;
}

export async function buildSharedPackage(home, provider, skills) {
  if (!skills.length) return null;
  const files = [];
  for (const skill of skills) {
    const tree = await skillTree(skill.path);
    if (tree.revision !== skill.revision) throw Error('Skill snapshot changed. Retry preparation.');
    files.push(...tree.files.map(file => ({ ...file, path: `skills/${skill.name}/${file.path}` })));
  }
  const revision = hash(JSON.stringify([1, provider, skills.map(({ id, revision }) => [id, revision])]));
  const marketplace = `herdr-zed-shared-skills-${revision.slice(0, 16)}`, pluginId = `shared-skills@${marketplace}`;
  const json = (path, value) => files.push({ path, content: Buffer.from(JSON.stringify(value, null, 2)), executable: false });
  for (const host of ['claude', 'codex']) json(`.${host}-plugin/plugin.json`, { name: 'shared-skills', version: '1.0.0', description: 'Herdr shared Skills selection', skills: './skills/' });
  json('.agents/plugins/marketplace.json', { name: marketplace, interface: { displayName: 'Herdr Shared Skills' }, plugins: [{ name: 'shared-skills', source: { source: 'local', path: './' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] });
  const root = await publishTree(join(home, 'data', 'herdr-zed', 'skill-packages'), { revision, files });
  return { root, marketplace, pluginId };
}

// Import a checked-out/local skill. Updates require the exact current library revision.
export async function importSharedSkill(home, source, expected = null) {
  if (!isAbsolute(source)) throw Error('Choose an absolute local skill folder containing SKILL.md.');
  source = await realpath(source);
  const name = basename(source);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw Error('Skill folder name must use letters, numbers, underscores or hyphens.');
  const tree = await skillTree(source);
  if (!tree.files.some(file => file.path === 'SKILL.md')) throw Error('The selected folder must contain SKILL.md.');
  const metadata = parseSkillMetadata(tree.files.find(file => file.path === 'herdr.json')?.content.toString('utf8') ?? null);
  const root = join(mineRoot(home), 'skills'), target = join(root, name);
  await mkdir(root, { recursive: true });
  const lockPath = join(root, `.${name}.lock`);
  const lock = await acquireFileLock(lockPath);
  const temporary = join(root, `.import-${randomUUID()}`), backup = join(root, `.backup-${randomUUID()}`);
  let displaced = false, published = false;
  try {
    let current = null;
    try { current = (await skillTree(target)).revision; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== expected) throw Error('Skill already exists or changed. Reload before updating.');
    if (source === await realpath(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw Error('Choose a source outside the shared library.');
    for (const file of tree.files) {
      const path = join(temporary, file.path); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { mode: file.executable ? 0o700 : 0o600 });
    }
    await writeFile(join(temporary, 'herdr.json'), JSON.stringify({ ...metadata, version: 1, origin: { source, revision: tree.revision } }, null, 2));
    if (current && (await skillTree(target)).revision !== current) throw Error('Skill changed while importing. Reload before updating.');
    if (current) { await rename(target, backup); displaced = true; }
    try { await rename(temporary, target); published = true; } catch (error) { if (displaced) { await rename(backup, target); displaced = false; } throw error; }
    return { imported: name, sourceRevision: tree.revision };
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (displaced && published) await rm(backup, { recursive: true, force: true });
    await lock.close(); await rm(lockPath);
  }
}
