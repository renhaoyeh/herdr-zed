import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modSource = new URL('./mods/devkits-zed/', import.meta.url);
const layoutSource = new URL('./layouts/devkits-zed.json', import.meta.url);
export const zedKeys = { 'cmd-n': 'devkits-zed.new-thread', 'cmd-w': 'devkits-zed.close-file' };

// Add the port beside Devkits. Never replace its files, data, layout or shortcuts.
export async function installZed(home) {
  const mod = join(home, 'mods/devkits-zed'), layout = join(home, 'layouts/devkits-zed.json');
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
  keys['layout:devkits-zed'] = { ...zedKeys, ...keys['layout:devkits-zed'] };
  let modCreated = false, layoutCreated = false;
  const addedAssets = [];
  try {
    // These are shared visual assets, not the original mod's implementation or services.
    for (const relative of ['themes/devkits.json', 'themes/devkits-light.json', 'mods/devkits/assets/icons']) {
      const destination = join(home, relative);
      try { await access(destination); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(join(destination, '..'), { recursive: true });
      addedAssets.push(destination);
      await cp(new URL(`./${relative}`, import.meta.url), destination, { recursive: true, errorOnExist: true, force: false });
    }
    await mkdir(mod); modCreated = true;
    for (const name of await readdir(modSource)) {
      if (['gpui-kit.d.ts', 'jsconfig.json'].includes(name)) continue;
      await cp(new URL(name, modSource), join(mod, name), { recursive: true, errorOnExist: true, force: false });
    }
    await writeFile(layout, await readFile(layoutSource), { flag: 'wx' }); layoutCreated = true;
    const current = await readFile(keysPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current !== before) throw new Error('Shortcuts changed during installation. Retry.');
    await writeFile(keysPath, `${JSON.stringify(keys, null, 2)}\n`);
  } catch (error) {
    if (layoutCreated) await rm(layout);
    if (modCreated) await rm(mod, { recursive: true, force: true });
    for (const path of addedAssets) await rm(path, { recursive: true, force: true });
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
