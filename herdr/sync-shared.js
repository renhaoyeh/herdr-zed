import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keeps the mods' copies of shared components equal to their one source in mods/devkits/components/.
//
// A mod can only import files inside its own folder (Herdr refuses symlinks and ../ paths that resolve
// outside it), so a component several mods use is copied into each. COPIES names the mods that carry
// a copy. Edit the source, never a copy, then run this.
//
//   npm run sync:shared                         copy every source into its mods
//   npm run sync:shared -- --check              change nothing; fail if any copy differs from its source
//   npm run sync:shared -- --from <copy>        a copy was edited by hand: make it the source, then sync
//
// A copy that differs from both its source and what this last wrote there (.sync-shared/) was edited by
// hand: it is never overwritten; the run fails and names it (keep its change with --from, or move the
// change into the source). A fresh checkout or worktree has no .sync-shared/: what git last committed of
// the source stands in for it (a copy equal to that is ours, not hand-edited).

const HERE = dirname(fileURLToPath(import.meta.url));

const read = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

const isDir = async path => { try { await readdir(path); return true; } catch { return false; } };

// The source as git last committed it (HEAD), or null outside a checkout.
const committed = path => new Promise(done => execFile('git', ['-C', dirname(path), 'show', `HEAD:./${basename(path)}`],
  { timeout: 10000 }, (error, stdout) => done(error ? null : stdout)));

async function copies(root) {
  const table = {};
  for (let line of (await readFile(join(root, 'COPIES'), 'utf8')).split('\n')) {
    line = line.split('#')[0].trim();
    if (!line) continue;
    const [name, mods] = line.split(':');
    table[name.trim()] = mods.trim().split(/\s+/).filter(Boolean);
  }
  return table;
}

async function write(path, text) {
  const temporary = `${path}.sync-${process.pid}`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

// Returns { made, bad }: the copies written and the problems that stopped a sync or failed a check.
export async function syncShared({ root = HERE, check = false, from = null } = {}) {
  const mods = join(root, 'mods'), last = join(root, '.sync-shared');
  const source = name => join(mods, 'devkits', 'components', name);
  const table = await copies(root);
  const rel = path => relative(process.cwd(), path);
  const bad = [], made = [];

  if (from) {
    const path = resolve(from), name = basename(path), mod = basename(dirname(dirname(path)));
    if (basename(dirname(path)) !== 'components' || !table[name]?.includes(mod))
      return { made, bad: [`${from} is not a copy listed in COPIES`] };
    await copyFile(path, source(name));
    made.push(`${rel(source(name))} <- ${rel(path)}`);
  }

  for (const [name, targets] of Object.entries(table)) {
    const text = await read(source(name));
    if (text === null) { bad.push(`${rel(source(name))} is missing`); continue; }
    const previous = await read(join(last, name)) ?? await committed(source(name));
    for (const mod of targets) {
      const path = join(mods, mod, 'components', name);
      if (!await isDir(join(mods, mod))) { bad.push(`${rel(path)}: mods/${mod} is gone (remove it from COPIES)`); continue; }
      const have = await read(path);
      if (have === text) continue;
      if (check) bad.push(`${rel(path)} differs from ${rel(source(name))}`);
      else if (have === null || have === previous) {
        await mkdir(dirname(path), { recursive: true });
        await write(path, text);
        made.push(rel(path));
      } else bad.push(`${rel(path)} was edited by hand: keep it with \`npm run sync:shared -- --from ${rel(path)}\`, or move the change into ${rel(source(name))}`);
    }
    if (!check) {
      await mkdir(last, { recursive: true });
      await write(join(last, name), text);
    }
    // A copy made by hand in a mod COPIES doesn't list (same name, same first line).
    const head = text.split('\n', 1)[0];
    for (const mod of (await readdir(mods)).sort()) {
      if (mod === 'devkits' || targets.includes(mod)) continue;
      const path = join(mods, mod, 'components', name);
      if ((await read(path))?.split('\n', 1)[0] === head) bad.push(`${rel(path)} looks like a copy of ${rel(source(name))}: add ${mod} to COPIES`);
    }
  }
  return { made, bad };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), check = argv.includes('--check');
  const from = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : null;
  const { made, bad } = await syncShared({ check, from });
  for (const path of made) console.log(`synced ${path}`);
  if (bad.length) {
    console.error(`sync-shared: ${check ? 'copies out of sync' : 'not synced'}:\n${bad.map(line => `  ${line}`).join('\n')}`);
    process.exitCode = 1;
  } else if (check) console.log(`sync-shared: all ${Object.values(await copies(HERE)).flat().length} copies match their source`);
}
