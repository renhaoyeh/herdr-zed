// Shared source library and immutable launch snapshots. Never writes provider/account homes.
import { readdir, readFile, lstat, mkdir, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mineRoot, mineSelectionPath, mineItems, parseMineSelection, parseDevkits, devkitsCatalog,
  withMine, devkitsGuidance, resourceProblems, providerSupported, frontmatter } from './devkits-model.js';
import { parseSharedMcp } from './components/shared-mcp-model.js';
import { acquireFileLock, writeChecked } from './devkits-save.js';
import { parseEcc, eccItemEnabled } from './ecc-model.js';
import { readEccCatalog } from './ecc-catalog.js';
import { applyEccProfile, eccCostSkill } from './ecc-profiles.js';

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
  if (value.origin !== undefined && (!object(value.origin) || Object.keys(value.origin).some(key => !['source', 'revision', 'mode'].includes(key))
    || (value.origin.mode !== undefined && value.origin.mode !== 'source')
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
export async function publishTree(root, tree) {
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

export async function prepareSharedGuidance(home, provider, folder = null, switches = {}, options = {}) {
  if (!['claude', 'codex'].includes(provider)) throw Error('Choose claude or codex.');
  const { items, selection } = await readSharedState(home), catalog = devkitsCatalog(home);
  const { projectIdentity, projectPolicyPath, parseProjectPolicy, effectiveProjectPolicy } = await import('./ecc-project.js');
  let project = {}, projectMcp = {}, projectPolicy = { providers: {} };
  if (folder) {
    const identity = await projectIdentity(folder);
    projectPolicy = parseProjectPolicy(await optional(projectPolicyPath(home, identity)), identity);
    const policy = projectPolicy.providers[provider];
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
  const ecc = parseEcc(await optional(join(home, 'data', 'herdr-zed', 'ecc.json')));
  let policy = effectiveProjectPolicy({ config: ecc, policy: projectPolicy }, provider);
  let source;
  if (options.eccProfile != null) {
    source = await readEccCatalog(ecc.source || join(home, 'mods', 'herdr-zed-agents', 'ecc-source'));
    const config = { selection: { [provider]: { ...policy.selection } } };
    applyEccProfile(config, provider, source.items, options.eccProfile, policy.enabled && Boolean(policy.selection[eccCostSkill]));
    policy = { ...policy, enabled: true, selection: config.selection[provider] };
  }
  if (policy.enabled && Object.entries(policy.selection).some(([id, enabled]) => enabled && id.startsWith('skills:'))) {
    source ||= await readEccCatalog(ecc.source || join(home, 'mods', 'herdr-zed-agents', 'ecc-source'));
    for (const item of source.items) {
      if (item.group !== 'skills' || !eccItemEnabled({ selection: { [provider]: policy.selection } }, provider, item)) continue;
      if (item.unavailable) throw Error(`${item.name}: ${item.unavailable}`);
      const name = `ecc-${basename(dirname(item.path))}`;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) continue;
      const tree = await skillTree(join(source.source, dirname(item.path)));
      const snapshot = await publishTree(join(home, 'data', 'herdr-zed', 'skill-snapshots'), tree);
      commands.push({ id: `ecc:${item.id}`, name, description: item.description.slice(0, 500), path: join(snapshot, 'SKILL.md') });
    }
  }
  const names = new Set();
  for (const command of commands) {
    const base = command.name;
    for (let suffix = 2; names.has(command.name); suffix++) command.name = `${base.slice(0, 72)}-${suffix}`;
    names.add(command.name);
  }
  return guidance || commands.length ? { ...guidance, nativeSkills, commands } : null;
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
export async function importSharedSkill(home, source, expected = null, mode = null) {
  if (mode !== null && mode !== 'source') throw Error('Unknown skill import mode.');
  if (!isAbsolute(source)) throw Error('Choose an absolute local skill folder containing SKILL.md.');
  source = await realpath(source);
  const name = basename(source);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw Error('Skill folder name must use letters, numbers, underscores or hyphens.');
  const tree = await skillTree(source);
  if (!tree.files.some(file => file.path === 'SKILL.md')) throw Error('The selected folder must contain SKILL.md.');
  const metadata = parseSkillMetadata(tree.files.find(file => file.path === 'herdr.json')?.content.toString('utf8') ?? null);
  const sourceMode = mode === 'source';
  const sourceEntry = join(source, 'SKILL.md').replaceAll('\\', '/');
  const original = tree.files.find(file => file.path === 'SKILL.md').content.toString('utf8');
  const header = /^---\r?\n[\s\S]*?\r?\n---/.exec(original)?.[0];
  if (sourceMode && !header) throw Error('Source skills require name/description frontmatter.');
  const files = sourceMode ? [{ path: 'SKILL.md', executable: false, content: Buffer.from(`${header}\n\n# Installed source skill\n\nRead and follow the original skill at ${JSON.stringify(sourceEntry)}. Resolve all relative links, scripts and executable paths from that original skill directory, not this wrapper directory. Keep the source installation available; if it is missing, report it instead of guessing another installation.\n`) }] : tree.files;
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
    for (const file of files) {
      const path = join(temporary, file.path); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { mode: file.executable ? 0o700 : 0o600 });
    }
    await writeFile(join(temporary, 'herdr.json'), JSON.stringify({ ...metadata, version: 1, origin: { source, revision: tree.revision, ...(sourceMode ? { mode: 'source' } : {}) } }, null, 2));
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

// Discover entry points without reading binaries or traversing generated/dependency trees.
export async function discoverSharedSkills(home, source) {
  if (!isAbsolute(source)) throw Error('Choose an absolute skill, repository or runtime folder.');
  if ((await lstat(source)).isSymbolicLink()) throw Error('Skill source must be a real directory.');
  source = await realpath(source);
  const library = await readSharedLibrary(home), items = [];
  let visited = 0;
  const ignored = new Set(['node_modules', 'target', 'dist', 'build', 'vendor', 'bin', '__pycache__']);
  async function visit(folder, depth) {
    if (++visited > 2000) throw Error('Skill discovery exceeds 2,000 directories. Choose a narrower root.');
    const children = await entries(folder);
    const entry = children.find(item => item.name === 'SKILL.md' && item.isFile());
    if (entry) {
      const slug = basename(folder), text = await readFile(join(folder, entry.name), 'utf8'), meta = frontmatter(text);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug) || !meta.name || !meta.description) return;
      const existing = library.find(item => item.id === `mine:skills:${slug}`);
      const conflict = Boolean(existing && existing.origin?.source !== folder);
      items.push({ name: meta.name, description: meta.description, source: folder, slug, conflict, revision: existing?.revision || null,
        mode: existing ? existing.origin?.mode || 'copy' : null });
      if (items.length > 200) throw Error('More than 200 skills found. Choose a narrower root.');
      return;
    }
    if (depth >= 6) return;
    // Runtime/repository roots expose their public discovery entries under skills/.
    const publicSkills = children.find(item => item.name === 'skills' && item.isDirectory());
    const folders = publicSkills ? [publicSkills] : children.filter(item => item.isDirectory() && !ignored.has(item.name)
      && (!item.name.startsWith('.') || ['.agents', '.claude', '.codex'].includes(item.name)));
    for (const child of folders.sort((a, b) => a.name.localeCompare(b.name))) await visit(join(folder, child.name), depth + 1);
  }
  await visit(source, 0);
  const counts = new Map();
  for (const item of items) counts.set(item.slug, (counts.get(item.slug) || 0) + 1);
  return { source, items: items.map(item => ({ ...item, conflict: item.conflict || counts.get(item.slug) > 1 })) };
}

export async function importSharedSkillSelection(home, source, selected, options = {}) {
  if (!Array.isArray(selected) || !selected.length || selected.length > 200) throw Error('Select at least one skill.');
  const mode = options.mode ?? 'source', providers = options.providers ?? [];
  if (!['source', 'copy'].includes(mode) || !Array.isArray(providers) || providers.some(provider => !['claude', 'codex'].includes(provider)))
    throw Error('Choose an import mode and valid providers.');
  const discovered = await discoverSharedSkills(home, source), imported = [], failed = [], seen = new Set();
  for (const choice of selected) {
    const item = discovered.items.find(item => item.source === choice?.source);
    if (!item || item.conflict || seen.has(item.source)) throw Error('Invalid or conflicting skill selection. Scan the root again.');
    seen.add(item.source);
  }
  await withLibrarySettingsLock(home, async () => {
    for (const choice of selected) {
      const item = discovered.items.find(item => item.source === choice.source);
      let previous, updated;
      try {
        // Set explicit defaults before publishing a new item, so it is never briefly enabled for everyone.
        if (!item.revision) {
          previous = await optional(mineSelectionPath(home));
          const settings = parseMineSelection(previous), id = `mine:skills:${item.slug}`;
          for (const provider of ['claude', 'codex']) settings.providers[provider][id] = providers.includes(provider);
          const next = JSON.stringify(settings, null, 2);
          await writeChecked(mineSelectionPath(home), next, previous);
          updated = next;
        }
        const importMode = item.mode || mode;
        imported.push(await importSharedSkill(home, choice.source, choice.revision ?? null, importMode === 'source' ? 'source' : null));
      } catch (error) {
        if (updated !== undefined) await writeChecked(mineSelectionPath(home), previous, updated);
        failed.push({ source: choice.source, message: error.message });
      }
    }
  });
  return { imported, failed };
}

async function withLibrarySettingsLock(home, work) {
  const directory = join(home, 'data', 'herdr-zed');
  await mkdir(directory, { recursive: true });
  const path = join(directory, '.capabilities-save.lock'), lock = await acquireFileLock(path);
  try { return await work(); }
  finally { await lock.close(); await rm(path); }
}

export async function removeSharedSkill(home, id, expected) {
  const slug = /^mine:skills:([a-zA-Z0-9][a-zA-Z0-9_-]*)$/.exec(id)?.[1];
  if (!slug || typeof expected !== 'string' || !expected) throw Error('Choose a shared skill to remove.');
  return withLibrarySettingsLock(home, async () => {
    const libraryRoot = join(mineRoot(home), 'skills');
    if ((await lstat(libraryRoot)).isSymbolicLink()) throw Error('Shared library must be a real directory.');
    const root = await realpath(libraryRoot), target = join(root, slug);
    if (dirname(await realpath(target)) !== root) throw Error('Skill must be inside the shared library.');
    const lockPath = join(root, `.${slug}.lock`), lock = await acquireFileLock(lockPath);
    const removed = join(root, `.removed-${randomUUID()}`);
    let moved = false;
    try {
      if ((await skillTree(target)).revision !== expected) throw Error('Skill changed. Reload before removing.');
      const previous = await optional(mineSelectionPath(home)), settings = parseMineSelection(previous);
      settings.disabled = settings.disabled.filter(value => value !== id);
      for (const provider of ['claude', 'codex']) delete settings.providers[provider][id];
      await rename(target, removed); moved = true;
      try { await writeChecked(mineSelectionPath(home), JSON.stringify(settings, null, 2), previous); }
      catch (error) { await rename(removed, target); moved = false; throw error; }
      return { removed: id };
    } finally {
      try { if (moved) await rm(removed, { recursive: true, force: true }); }
      finally { await lock.close(); await rm(lockPath); }
    }
  });
}
