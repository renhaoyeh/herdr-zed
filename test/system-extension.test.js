import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExtensionManifest } from '../mods/herdr-zed/extension-model.js';

const run = promisify(execFile);

test('SYSTEM exposes its sampler and readings without a duplicate status action', async () => {
  const text = await readFile(new URL('../mods/herdr-zed-system/extension.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(text);
  assert.deepEqual(parseExtensionManifest('herdr-zed-system', text), []);
  assert.deepEqual(manifest.services, [{ view: 'service' }]);
  assert.deepEqual(manifest.surfaces.map(surface => surface.view), ['widgets', 'inline']);

  const main = await readFile(new URL('../mods/herdr-zed-system/main.js', import.meta.url), 'utf8');
  assert.match(main, /if \(this\.view === 'service'\) \{\s*this\.monitor\.init\(cx\)/);
  assert.match(main, /this\.monitor\.renderDetails\(t\)/);
});

test('hardware reader CLI runs when invoked through a symlink path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'system-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reader = new URL('../mods/herdr-zed-system/hardware-reader.js', import.meta.url);
  const alias = join(directory, 'reader.js');
  try { await symlink(reader, alias); }
  catch (error) {
    if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) return t.skip(`Symlink creation is unavailable: ${error.code}`);
    throw error;
  }
  const { stdout } = await run(process.execPath, [alias, 'null', '{"sensors":false}'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(typeof result.updatedAt, 'number');
  assert.ok(result.sample && typeof result.sample === 'object');
});
