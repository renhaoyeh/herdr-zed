import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modSource = new URL('./mods/herdr-zed/', import.meta.url);
const layoutSource = new URL('./layouts/herdr-zed.json', import.meta.url);
const themeSource = new URL('./themes/', import.meta.url);
const iconSource = new URL('./assets/icons/', import.meta.url);
export const zedKeys = { 'cmd-n': 'herdr-zed.new-thread', 'cmd-w': 'herdr-zed.close-file' };

// Add the shell beside any existing mods and layouts. Never replace its files, data, layout or shortcuts.
export async function installZed(home) {
  const mod = join(home, 'mods/herdr-zed'), layout = join(home, 'layouts/herdr-zed.json');
  for (const path of [mod, layout]) {
    try { await access(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Already exists: ${path}. Refusing to overwrite.`);
  }
  await mkdir(join(home, 'mods'), { recursive: true });
  await mkdir(join(home, 'layouts'), { recursive: true });
  await mkdir(join(home, 'themes'), { recursive: true });
  const keysPath = join(home, 'keys.json');
  const before = await readFile(keysPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const keys = before === null ? {} : JSON.parse(before);
  keys['layout:herdr-zed'] = { ...zedKeys, ...keys['layout:herdr-zed'] };
  let modCreated = false, layoutCreated = false;
  const addedThemes = [];
  try {
    // Shared visual themes are copied only when missing; the shell's own files are never replaced.
    for (const name of (await readdir(themeSource)).filter(name => name.endsWith('.json'))) {
      const destination = join(home, 'themes', name);
      try { await access(destination); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      addedThemes.push(destination);
      await cp(new URL(name, themeSource), destination, { errorOnExist: true, force: false });
    }
    await mkdir(mod); modCreated = true;
    for (const name of await readdir(modSource)) {
      if (['gpui-kit.d.ts', 'jsconfig.json'].includes(name)) continue;
      await cp(new URL(name, modSource), join(mod, name), { recursive: true, errorOnExist: true, force: false });
    }
    // The shell's icons live inside its own folder (components import them from there).
    await cp(iconSource, join(mod, 'assets/icons'), { recursive: true, errorOnExist: true, force: false });
    await writeFile(layout, await readFile(layoutSource), { flag: 'wx' }); layoutCreated = true;
    const current = await readFile(keysPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current !== before) throw new Error('Shortcuts changed during installation. Retry.');
    await writeFile(keysPath, `${JSON.stringify(keys, null, 2)}\n`);
  } catch (error) {
    if (layoutCreated) await rm(layout);
    if (modCreated) await rm(mod, { recursive: true, force: true });
    for (const path of addedThemes) await rm(path, { force: true });
    throw error;
  }
  return { mod, layout };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const home = process.env.HERDR_APP_HOME || join(homedir(), '.config/herdr-app');
    const result = await installZed(home);
    console.log(`Installed ${result.mod}\nLayout: ${result.layout}\nThe current layout has not been switched.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
