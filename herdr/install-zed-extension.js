import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExtensionRegistry, parseExtensionManifest, extensionMetadata } from './mods/devkits-zed/extension-model.js';

const read = async path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });

export async function installZedExtension(home, mod) {
  if (typeof mod !== 'string' || !/^[a-z][a-z0-9-]*$/.test(mod)) throw new Error('Choose a valid extension mod name.');
  await access(join(home, 'mods/devkits-zed/main.js'));
  const source = new URL(`./mods/${mod}/`, import.meta.url);
  const manifest = await readFile(new URL('extension.json', source), 'utf8');
  parseExtensionManifest(mod, manifest);
  const destination = join(home, 'mods', mod), manifestPath = join(destination, 'extension.json');
  const registryPath = join(home, 'data/devkits-zed/extensions.json');
  const before = await read(registryPath), mods = parseExtensionRegistry(before);
  const existing = await read(manifestPath);
  if (existing !== null) parseExtensionManifest(mod, existing);
  const { dependencies } = extensionMetadata(mod, existing ?? manifest);
  const installed = [];
  let manifestAdded = false, temporary;
  const installPackage = async name => {
    const target = join(home, 'mods', name);
    try { await access(join(target, 'main.js')); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // An incomplete or user-owned directory is never merged or overwritten.
    try { await access(target); throw new Error(`Incomplete extension mod already exists: ${target}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    temporary = await mkdtemp(join(home, 'mods/.zed-extension-'));
    await cp(new URL(`./mods/${name}/`, import.meta.url), temporary, { recursive: true,
      filter: path => !path.endsWith('/gpui-kit.d.ts') && !path.endsWith('/jsconfig.json') });
    await access(join(temporary, 'main.js'));
    await rename(temporary, target); temporary = null; installed.push(target);
    return true;
  };
  try {
    for (const dependency of dependencies) await installPackage(dependency);
    const added = await installPackage(mod);
    if (!added && existing === null) { await writeFile(manifestPath, manifest, { flag: 'wx' }); manifestAdded = true; }
    if (!mods.includes(mod)) {
      await mkdir(join(home, 'data/devkits-zed'), { recursive: true });
      const path = `${registryPath}.new-${process.pid}`;
      try {
        await writeFile(path, `${JSON.stringify({ version: 1, extensions: [...mods, mod] }, null, 2)}\n`, { flag: 'wx' });
        if (await read(registryPath) !== before) throw new Error('Extension registry changed. Retry.');
        await rename(path, registryPath);
      } finally { await rm(path, { force: true }); }
    }
  } catch (error) {
    for (const path of installed.reverse()) await rm(path, { recursive: true, force: true });
    if (manifestAdded) await rm(manifestPath, { force: true });
    throw error;
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  return { mod, registry: registryPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node herdr/install-zed-extension.js <mod-name>');
    const home = process.env.HERDR_APP_HOME || join(homedir(), '.config/herdr-app');
    const result = await installZedExtension(home, process.argv[2]);
    console.log(`Registered ${result.mod}\nRegistry: ${result.registry}\nRun devkits-zed.extensions-refresh to discover it in an open workspace.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
