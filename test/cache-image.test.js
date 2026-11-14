import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheImage } from '../mods/herdr-zed/cache-image.js';

test('image previews copy bytes under the app root and change asset paths only when content changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-image-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "圖片 ' $.PNG"), app = join(root, 'app');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(source, png);
  const path = await cacheImage(source, app);
  assert.match(path, /^data\/herdr-zed\/image-previews\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(await readFile(join(app, path)), png);
  assert.deepEqual(await Promise.all([cacheImage(source, app), cacheImage(source, app)]), [path, path]);
  await writeFile(source, 'updated');
  assert.notEqual(await cacheImage(source, app), path);
  assert.equal((await readdir(join(app, 'data/herdr-zed/image-previews'))).length, 2);
  assert.deepEqual(await readFile(join(app, path)), png, 'existing assets remain immutable');
  await assert.rejects(cacheImage(join(root, 'missing.png'), app), /ENOENT/);
  await assert.rejects(cacheImage(root, app), /regular file/);
  const large = await open(source, 'w');
  await large.truncate(32 * 1024 * 1024 + 1); await large.close();
  await assert.rejects(cacheImage(source, app), /32 MiB/);
});
