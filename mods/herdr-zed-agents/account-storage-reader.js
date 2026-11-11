import { isMain } from './node-main.js';
// Finite, metadata-only reader. Never opens file contents or follows child symlinks.
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { storageGroup, storageGroups } from './account-storage-model.js';

export async function readAccountStorage(directory, { maxEntries = 200000, maxMilliseconds = 12000 } = {}) {
  if (!isAbsolute(directory)) throw new Error('Account data directory must be absolute.');
  const result = { bytes: 0, groups: Object.fromEntries(storageGroups.map(([key]) => [key, 0])),
    partial: false, skippedLinks: 0, missing: false };
  let root;
  try { root = await realpath(directory); }
  catch (error) { if (error.code === 'ENOENT') return { ...result, missing: true }; throw error; }
  const deadline = Date.now() + maxMilliseconds, pending = [{ path: root, group: null }];
  let entries = 0;
  while (pending.length) {
    if (entries >= maxEntries || Date.now() >= deadline) { result.partial = true; break; }
    const item = pending.pop();
    let info;
    try { info = await lstat(item.path); }
    catch (error) { if (error.code !== 'ENOENT') result.partial = true; continue; }
    entries++;
    if (info.isSymbolicLink()) { result.skippedLinks++; continue; }
    if (info.isFile()) {
      result.bytes += info.size;
      result.groups[item.group || 'other'] += info.size;
    } else if (info.isDirectory()) {
      let children;
      try { children = await readdir(item.path); }
      catch (error) { if (error.code !== 'ENOENT') result.partial = true; continue; }
      for (const name of children) pending.push({ path: join(item.path, name), group: item.group || storageGroup(name) });
    }
  }
  return result;
}

if (await isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await readAccountStorage(process.argv[2]))); }
  catch { console.error('Could not read account data sizes.'); process.exitCode = 1; }
}
