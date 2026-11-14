import { open, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Native images resolve inside the app home; immutable copies also bypass stale decoded-image caches. */
export async function cacheImage(file, appRoot) {
  const input = await open(file, 'r');
  let bytes;
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw new Error('This image is not a regular file.');
    if (stat.size > 32 * 1024 * 1024) throw new Error('Image preview is limited to 32 MiB.');
    bytes = await input.readFile();
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Image preview is limited to 32 MiB.');
  } finally { await input.close(); }
  const name = createHash('sha256').update(bytes).digest('hex') + extname(file).toLowerCase();
  const relative = `data/herdr-zed/image-previews/${name}`, destination = join(appRoot, relative);
  await mkdir(join(appRoot, 'data/herdr-zed/image-previews'), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
  return relative;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cacheImage(process.argv[2], process.argv[3]).then(path => console.log(path)).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
