// Remove only this package's generated screenshots, never Xcode or simulator data.
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
export async function resetFrames(root) {
  const folder = join(root, 'mods', 'herdr-zed-sim-frames');
  for (const path of [join(root, 'mods'), folder]) {
    const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat?.isSymbolicLink()) throw new Error('Remove the symbolic link before resetting simulator frames.');
  }
  const entries = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of entries) if (/^frame-\d+\.jpg$/.test(name)) await rm(join(folder, name), { force: true });
}
if (process.argv[2] === 'clear' && process.argv[4] === 'HERDR ZED') {
  try { await resetFrames(process.argv[3]); console.log('{}'); } catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (process.argv[2] === 'inspect') console.log('{}');
