import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { install, installExtension, update } from '../install.js';
import { asanaManifest } from './extension-fixtures.js';

const dirOf = dir => new URL(`${pathToFileURL(dir).href}/`);
const exists = path => access(path).then(() => true, () => false);

// A fake upstream checkout (ECC source) and fake provider packages, each under a temporary root.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-zed-ecc-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vendor = join(root, 'vendor'), packages = join(root, 'packages'), home = join(root, 'herdr');
  await mkdir(join(vendor, '.claude-plugin'), { recursive: true });
  await writeFile(join(vendor, '.claude-plugin', 'plugin.json'), '{"name":"ecc","version":"2.2.3"}');
  await writeFile(join(vendor, 'SKILL.md'), 'fixture skill');
  await writeFile(join(vendor, '.git'), 'private repository metadata');
  await mkdir(join(vendor, 'node_modules'));
  await writeFile(join(vendor, 'node_modules', 'package.js'), 'dependency');
  const put = async (name, file, text) => { await mkdir(join(packages, 'mods', name), { recursive: true }); await writeFile(join(packages, 'mods', name, file), text); };
  await put('herdr-zed-agents', 'main.js', 'export default class Agents {}');
  await put('herdr-zed-agents', 'extension.json', '{"version":1,"id":"agents","title":"Agents","actions":[]}');
  await put('herdr-zed-asana', 'main.js', 'export default class Asana {}');
  await put('herdr-zed-asana', 'extension.json', asanaManifest);
  await install(home);
  return {
    home, root, packagesRoot: dirOf(packages), eccSource: dirOf(vendor), empty: dirOf(join(root, 'nothing')),
    bundled: join(home, 'data', 'devkits', 'ecc-source'),
  };
}

test('agents install copies the vendored ECC source when none exists, without git metadata or dependencies', async t => {
  const { home, packagesRoot: root, eccSource, bundled } = await fixture(t);
  const result = await installExtension(home, 'herdr-zed-agents', { root, eccSource });
  assert.equal(result.ecc, bundled);
  assert.equal(await readFile(join(bundled, 'SKILL.md'), 'utf8'), 'fixture skill');
  assert.equal(await exists(join(bundled, '.git')), false);
  assert.equal(await exists(join(bundled, 'node_modules')), false);
  assert.equal(await exists(join(home, 'mods', 'herdr-zed-agents', 'ecc-source')), false);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'data', 'herdr-zed', 'extensions.json'), 'utf8')).extensions, ['herdr-zed-agents']);
});

test('an existing ECC source is never overwritten by the agents install', async t => {
  const { home, packagesRoot: root, eccSource, bundled } = await fixture(t);
  await mkdir(bundled, { recursive: true });
  await writeFile(join(bundled, 'SKILL.md'), 'user ECC source');
  const result = await installExtension(home, 'herdr-zed-agents', { root, eccSource });
  assert.equal(result.ecc, null);
  assert.equal(await readFile(join(bundled, 'SKILL.md'), 'utf8'), 'user ECC source');
  assert.equal(await exists(join(bundled, '.git')), false, 'Nothing is copied into an existing source folder');
  assert.ok(await exists(join(home, 'mods', 'herdr-zed-agents', 'main.js')));
});

test('other extensions never copy or touch the ECC source', async t => {
  const { home, packagesRoot: root, eccSource, bundled } = await fixture(t);
  await installExtension(home, 'herdr-zed-asana', { root, eccSource });
  assert.equal(await exists(bundled), false);
});

test('a missing vendor source fails before anything is written', async t => {
  const { home, packagesRoot: root, empty, bundled } = await fixture(t);
  await assert.rejects(installExtension(home, 'herdr-zed-agents', { root, eccSource: empty }), /git submodule update --init/);
  assert.equal(await exists(bundled), false);
  assert.equal(await exists(join(home, 'mods', 'herdr-zed-agents')), false);
  assert.equal(await exists(join(home, 'data', 'herdr-zed', 'extensions.json')), false);
});

test('a failed agents install removes the ECC copy and package it added', async t => {
  const { home, packagesRoot: root, eccSource, bundled } = await fixture(t);
  await assert.rejects(installExtension(home, 'herdr-zed-agents', {
    root, eccSource, beforeRegister: () => { throw new Error('interrupted'); },
  }), /interrupted/);
  assert.equal(await exists(bundled), false);
  assert.equal(await exists(join(home, 'mods', 'herdr-zed-agents')), false);
  assert.equal(await exists(join(home, 'data', 'herdr-zed', 'extensions.json')), false);
  assert.deepEqual((await readdir(join(home, 'data', 'devkits'))).filter(name => name.startsWith('.ecc-source-')), []);
});

test('update keeps the installed ECC source and global ECC settings under data/', async t => {
  const { home, packagesRoot: root, eccSource, bundled } = await fixture(t);
  await installExtension(home, 'herdr-zed-agents', { root, eccSource });
  await writeFile(join(bundled, 'SKILL.md'), 'user edits');
  await writeFile(join(home, 'data', 'devkits', 'ecc.json'), 'global ECC settings');
  const result = await update(home);
  assert.ok(result.updated.includes('herdr-zed-agents'));
  assert.equal(await readFile(join(bundled, 'SKILL.md'), 'utf8'), 'user edits');
  assert.equal(await readFile(join(home, 'data', 'devkits', 'ecc.json'), 'utf8'), 'global ECC settings');
});
