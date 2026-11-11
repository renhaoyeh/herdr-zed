// herdr-zed installer. Run from the repository root (HERDR_APP_HOME selects the Herdr home, default ~/.config/herdr-app):
//   node install.js                     first install of the shell; never switches the current layout
//   node install.js --extension <mod>   register a provider package with its manifest dependencies
//   node install.js --update            refresh installed herdr-zed* mods, the layout and icons; keeps data/ and keys
import { access, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionMetadata, parseExtensionManifest, parseExtensionRegistry } from './mods/herdr-zed/extension-model.js';

// `root` is the repository (or a fixture with the same layout). Tests inject their own.
const REPO = new URL('./', import.meta.url);
const SHELL = 'herdr-zed';
const AGENTS = 'herdr-zed-agents';
const USAGE = 'Usage: node install.js | node install.js --extension <mod> | node install.js --update';
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const zedKeys = { 'cmd-n': 'herdr-zed.new-thread', 'cmd-w': 'herdr-zed.close-file' };

const missing = error => error.code === 'ENOENT';
async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
}
const readOptional = path => readFile(path, 'utf8').catch(error => { if (missing(error)) return null; throw error; });
const listDir = (dir, keep) => readdir(dir, { withFileTypes: true }).then(entries => entries.filter(keep).map(entry => entry.name));

// Build-time files stay in the repository: editor declarations and per-mod jsconfig files.
function buildOnly(path) {
  const parts = path.split(/[\\/]/), name = parts.at(-1);
  return name === 'gpui-kit.d.ts' || name === 'jsconfig.json' || (name.endsWith('.d.ts') && parts.at(-2) === 'components');
}

// Copy one mod from the repository into `destination`, which must not exist.
async function copyMod(root, name, destination) {
  await cp(new URL(`mods/${name}/`, root), destination, { recursive: true, errorOnExist: true, force: false, filter: path => !buildOnly(path) });
}

async function copyShell(root, destination) {
  await copyMod(root, SHELL, destination);
  // The shell's icons live inside its own folder (components import them from there).
  await cp(new URL('assets/icons/', root), join(destination, 'assets/icons'), { recursive: true, errorOnExist: true, force: false });
}

// Merge the shell shortcuts into keys.json without overriding any user binding.
function mergeKeys(keys) {
  return { ...keys, [`layout:${SHELL}`]: { ...zedKeys, ...keys[`layout:${SHELL}`] } };
}

// Add the shell beside any existing mods and layouts. Never replace its files, data, layout or shortcuts.
export async function install(home, { root = REPO } = {}) {
  const mod = join(home, 'mods', SHELL), layout = join(home, 'layouts', `${SHELL}.json`);
  for (const path of [mod, layout])
    if (await exists(path)) throw new Error(`Already exists: ${path}. Refusing to overwrite.`);
  await mkdir(join(home, 'mods'), { recursive: true });
  await mkdir(join(home, 'layouts'), { recursive: true });
  await mkdir(join(home, 'themes'), { recursive: true });
  const keysPath = join(home, 'keys.json');
  const before = await readOptional(keysPath);
  const keys = mergeKeys(before === null ? {} : JSON.parse(before));
  let modCreated = false, layoutCreated = false;
  const addedThemes = [];
  try {
    // Shared visual themes are copied only when missing; existing ones are never replaced.
    for (const name of await listDir(new URL('themes/', root), entry => entry.isFile() && entry.name.endsWith('.json'))) {
      const destination = join(home, 'themes', name);
      if (await exists(destination)) continue;
      addedThemes.push(destination);
      await cp(new URL(`themes/${name}`, root), destination, { errorOnExist: true, force: false });
    }
    await copyShell(root, mod); modCreated = true;
    await writeFile(layout, await readFile(new URL(`layouts/${SHELL}.json`, root)), { flag: 'wx' }); layoutCreated = true;
    const current = await readOptional(keysPath);
    if (current !== before) throw new Error('Shortcuts changed during installation. Retry.');
    await writeFile(keysPath, `${JSON.stringify(keys, null, 2)}\n`);
  } catch (error) {
    if (layoutCreated) await rm(layout, { force: true });
    if (modCreated) await rm(mod, { recursive: true, force: true });
    for (const path of addedThemes) await rm(path, { force: true });
    throw error;
  }
  return { mod, layout };
}

async function requireEccSource(source) {
  if (!(await exists(new URL('.claude-plugin/plugin.json', source))))
    throw new Error('ECC source is missing. Run git submodule update --init --recursive before installing.');
}

// ECC source is shared with Devkits (data/devkits/ecc-source). Copy it only when absent, through a staging folder.
async function copyEcc(source, target) {
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), '.ecc-source-'));
  try {
    await cp(source, staging, { recursive: true, filter: path => !['.git', 'node_modules'].includes(path.split(/[\\/]/).at(-1)) });
    await rename(staging, target);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

// Install a provider package (and its manifest dependencies) and register it. Existing user or incomplete
// directories are never merged or overwritten; any failure removes what this call added.
export async function installExtension(home, mod, { root = REPO, eccSource = new URL('vendor/everything-claude-code/', root), beforeRegister } = {}) {
  if (typeof mod !== 'string' || !/^[a-z][a-z0-9-]*$/.test(mod)) throw new Error('Choose a valid extension mod name.');
  if (!(await exists(join(home, 'mods', SHELL, 'main.js'))))
    throw new Error(`${SHELL} is not installed. Run node install.js first.`);
  const manifestText = await readFile(new URL(`mods/${mod}/extension.json`, root), 'utf8');
  parseExtensionManifest(mod, manifestText);
  const destination = join(home, 'mods', mod), manifestPath = join(destination, 'extension.json');
  const registryPath = join(home, 'data', SHELL, 'extensions.json');
  const before = await readOptional(registryPath), registered = parseExtensionRegistry(before);
  const existing = await readOptional(manifestPath);
  if (existing !== null) parseExtensionManifest(mod, existing);
  const { dependencies } = extensionMetadata(mod, existing ?? manifestText);
  const eccTarget = join(home, 'data', 'devkits', 'ecc-source');
  const copyEccSource = mod === AGENTS && !(await exists(eccTarget));
  if (copyEccSource) await requireEccSource(eccSource);

  const installed = [];
  let manifestAdded = false, eccCopied = false, temporary = null;
  const installPackage = async name => {
    const target = join(home, 'mods', name);
    if (await exists(join(target, 'main.js'))) return false;
    // An incomplete or user-owned directory is never merged or overwritten.
    if (await exists(target)) throw new Error(`Incomplete extension mod already exists: ${target}`);
    temporary = await mkdtemp(join(home, 'mods', '.zed-extension-'));
    await cp(new URL(`mods/${name}/`, root), temporary, { recursive: true, filter: path => !buildOnly(path) });
    await access(join(temporary, 'main.js'));
    await rename(temporary, target); temporary = null; installed.push(target);
    return true;
  };
  try {
    for (const dependency of dependencies) await installPackage(dependency);
    const added = await installPackage(mod);
    if (!added && existing === null) { await writeFile(manifestPath, manifestText, { flag: 'wx' }); manifestAdded = true; }
    if (copyEccSource) { await copyEcc(eccSource, eccTarget); eccCopied = true; }
    if (!registered.includes(mod)) {
      await mkdir(join(home, 'data', SHELL), { recursive: true });
      await beforeRegister?.();
      const path = `${registryPath}.new-${process.pid}`;
      try {
        await writeFile(path, `${JSON.stringify({ version: 1, extensions: [...registered, mod] }, null, 2)}\n`, { flag: 'wx' });
        if (await readOptional(registryPath) !== before) throw new Error('Extension registry changed. Retry.');
        await rename(path, registryPath);
      } finally { await rm(path, { force: true }); }
    }
  } catch (error) {
    for (const path of installed.reverse()) await rm(path, { recursive: true, force: true });
    if (manifestAdded) await rm(manifestPath, { force: true });
    if (eccCopied) await rm(eccTarget, { recursive: true, force: true });
    throw error;
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  return { mod, registry: registryPath, ecc: eccCopied ? eccTarget : null };
}

// Make target match source without moving target itself (used when a running folder cannot be moved).
async function syncDir(source, target) {
  const keep = new Set(await readdir(source));
  for (const name of await readdir(target))
    if (!keep.has(name)) await rm(join(target, name), { recursive: true, force: true });
  await cp(source, target, { recursive: true, force: true });
}

// Refresh every installed herdr-zed* mod, the layout and the shell's shortcuts from this repository.
// The complete new bundle is staged first; replaced paths move into backups/herdr-zed-<stamp>/ and are
// restored if a later step fails. data/, other settings, foreign mods, layouts and themes are never touched.
export async function update(home, { root = REPO, beforeReplace } = {}) {
  if (!(await exists(join(home, 'mods', SHELL, 'main.js')))) throw new Error(`${SHELL} is not installed. Run node install.js first.`);
  const available = new Set(await listDir(new URL('mods/', root), entry => entry.isDirectory()));
  const installed = await listDir(join(home, 'mods'), entry => entry.isDirectory() && entry.name.startsWith(SHELL));
  const mods = installed.filter(name => available.has(name)), skipped = installed.filter(name => !available.has(name));
  const layoutFile = `${SHELL}.json`, layoutInstalled = await exists(join(home, 'layouts', layoutFile));
  const keysPath = join(home, 'keys.json');
  const keysBefore = await readOptional(keysPath);
  const keysChanged = keysBefore !== null && (() => {
    const original = JSON.parse(keysBefore);
    return JSON.stringify(mergeKeys(original)) !== JSON.stringify(original);
  })();
  const keysText = keysChanged ? `${JSON.stringify(mergeKeys(JSON.parse(keysBefore)), null, 2)}\n` : null;

  const stage = await mkdtemp(join(home, '.herdr-zed-update-'));
  const changes = [];
  let backup = null;
  try {
    await mkdir(join(stage, 'mods'));
    for (const name of mods) {
      if (name === SHELL) await copyShell(root, join(stage, 'mods', name));
      else await copyMod(root, name, join(stage, 'mods', name));
    }
    const replaced = mods.map(name => join('mods', name));
    if (layoutInstalled) {
      await mkdir(join(stage, 'layouts'));
      await writeFile(join(stage, 'layouts', layoutFile), await readFile(new URL(`layouts/${layoutFile}`, root)));
      replaced.push(join('layouts', layoutFile));
    }
    if (keysChanged) {
      await writeFile(join(stage, 'keys.json'), keysText);
      replaced.push('keys.json');
      if (await readOptional(keysPath) !== keysBefore) throw new Error('Shortcuts changed during update. Retry.');
    }

    await mkdir(join(home, 'backups'), { recursive: true });
    backup = join(home, 'backups', `${SHELL}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(backup);
    for (const path of replaced) {
      const target = join(home, path), saved = join(backup, path), staged = join(stage, path);
      const change = { target, saved, staged, replaced: false, written: false, inPlace: false };
      changes.push(change);
      await mkdir(dirname(saved), { recursive: true });
      await beforeReplace?.(path);
      try { await rename(target, saved); change.replaced = true; }
      catch (error) {
        if (missing(error)) { /* new path: nothing to back up */ }
        else if (LOCKED.has(error.code) && (await stat(target)).isDirectory()) {
          // Windows keeps a running mod's folder locked: keep a copy, then update its contents in place.
          await cp(target, saved, { recursive: true });
          change.replaced = change.inPlace = true;
          await syncDir(staged, target);
          change.written = true;
          continue;
        } else throw error;
      }
      await rename(staged, target);
      change.written = true;
    }
  } catch (error) {
    const failures = [];
    for (const change of changes.reverse()) {
      try {
        if (change.inPlace) { await syncDir(change.saved, change.target); continue; }
        if (change.written) await rm(change.target, { recursive: true, force: true });
        if (change.replaced) await rename(change.saved, change.target);
      } catch (failure) { failures.push(failure); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], `Update failed; recovery files: ${backup}`);
    if (backup) await rm(backup, { recursive: true, force: true });
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
  return { backup, updated: mods, skipped, layout: layoutInstalled, keys: keysChanged };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app');
  const args = process.argv.slice(2);
  try {
    if (args.length === 0) {
      const result = await install(home);
      console.log(`Installed ${result.mod}\nLayout: ${result.layout}\nThe current layout has not been switched.`);
    } else if (args.length === 2 && args[0] === '--extension') {
      const result = await installExtension(home, args[1]);
      console.log(`Registered ${result.mod}\nRegistry: ${result.registry}${result.ecc ? `\nECC source copied to ${result.ecc}` : ''}\nRun herdr-zed.extensions-refresh to discover it in an open workspace.`);
    } else if (args.length === 1 && args[0] === '--update') {
      const result = await update(home);
      console.log(`Updated ${result.updated.join(', ')}${result.layout ? '\nLayout refreshed' : ''}${result.keys ? '\nShortcuts merged' : ''}\nBackup: ${result.backup}${result.skipped.length ? `\nSkipped (not in this repository): ${result.skipped.join(', ')}` : ''}`);
    } else throw new Error(USAGE);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
