import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { install, installExtension, update, zedKeys } from '../install.js';
import { asanaManifest, simulatorManifest } from './extension-fixtures.js';

const repo = new URL('../', import.meta.url);
const read = (path, base = repo) => readFile(new URL(path, base), 'utf8');
const readHome = (home, path) => readFile(join(home, path), 'utf8');
const writeHome = async (home, path, text) => { await mkdir(join(home, path, '..'), { recursive: true }); await writeFile(join(home, path), text); };
const missingFile = async (home, path) => assert.rejects(access(join(home, path)), { code: 'ENOENT' });
const dirOf = dir => new URL(`${pathToFileURL(dir).href}/`);

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'herdr-zed-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

// Provider packages from fixture files. They stand in for the repository so no real provider code is copied.
async function fixturePackages(t, packages) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-zed-packages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, files] of Object.entries(packages))
    for (const [file, text] of Object.entries(files)) await writeHome(root, join('mods', name, file), text);
  return dirOf(root);
}

const packages = {
  'herdr-zed-asana': { 'main.js': 'export default class Asana {}', 'extension.json': asanaManifest, 'ui.js': 'provider ui' },
  'herdr-zed-simulator': { 'main.js': 'export default class Simulator {}', 'extension.json': simulatorManifest },
  'herdr-zed-sim-frames': { 'main.js': 'export default class Frames {}' },
};

test('first install copies the shell without build-only files, adds icons and missing themes, and never switches the layout', async t => {
  const home = await tempHome(t);
  const state = '{"layout":"devkits","herdr-zed.projects":["/real/project"]}';
  await writeHome(home, 'shared.json', state);
  await writeHome(home, 'themes/herdr-zed.json', 'user theme');
  await install(home);
  assert.equal(await readHome(home, 'shared.json'), state);
  assert.equal(await readHome(home, 'mods/herdr-zed/main.js'), await read('mods/herdr-zed/main.js'));
  assert.equal(await readHome(home, 'layouts/herdr-zed.json'), await read('layouts/herdr-zed.json'));
  assert.equal(await readHome(home, 'themes/herdr-zed.json'), 'user theme', 'Existing themes are never replaced');
  for (const name of (await readdir(new URL('themes/', repo))))
    if (name !== 'herdr-zed.json') assert.equal(await readHome(home, join('themes', name)), await read(`themes/${name}`));
  assert.equal(await readHome(home, 'mods/herdr-zed/assets/icons/asana.svg'), await read('assets/icons/asana.svg'));
  assert.equal(await readHome(home, 'mods/herdr-zed/assets/preview.svg'), await read('mods/herdr-zed/assets/preview.svg'));
  await access(new URL('mods/herdr-zed/components/contract-types.d.ts', repo));
  await missingFile(home, 'mods/herdr-zed/components/contract-types.d.ts');
  await missingFile(home, 'mods/herdr-zed/components/gpui-kit.d.ts');
  await missingFile(home, 'mods/herdr-zed/gpui-kit.d.ts');
  await missingFile(home, 'mods/herdr-zed/jsconfig.json');
  await missingFile(home, 'mods/devkits');
});

test('first install refuses an existing shell or layout and writes nothing', async t => {
  const home = await tempHome(t);
  await install(home);
  await assert.rejects(install(home), /Refusing to overwrite/);
  const other = await tempHome(t);
  await writeHome(other, 'layouts/herdr-zed.json', 'mine');
  await assert.rejects(install(other), /Refusing to overwrite/);
  assert.equal(await readHome(other, 'layouts/herdr-zed.json'), 'mine');
  await missingFile(other, 'mods/herdr-zed');
});

test('first install adds shell shortcuts without overriding user bindings', async t => {
  const home = await tempHome(t);
  const keys = { global: { 'cmd-t': 'tab.new' }, 'layout:devkits': { f5: 'custom.run' }, 'layout:herdr-zed': { 'cmd-n': 'custom.new' } };
  await writeHome(home, 'keys.json', JSON.stringify(keys));
  await install(home);
  assert.deepEqual(JSON.parse(await readHome(home, 'keys.json')), { ...keys, 'layout:herdr-zed': { ...zedKeys, 'cmd-n': 'custom.new' } });
});

test('extension install is opt-in, idempotent and preserves provider code, credentials and other registrations', async t => {
  const home = await tempHome(t), root = await fixturePackages(t, packages);
  await install(home);
  await writeHome(home, 'data/herdr-zed/extensions.json', '{"version":1,"extensions":["other-mod"]}');
  await installExtension(home, 'herdr-zed-asana', { root });
  assert.deepEqual(JSON.parse(await readHome(home, 'data/herdr-zed/extensions.json')).extensions, ['other-mod', 'herdr-zed-asana']);
  await missingFile(home, 'mods/herdr-zed-mantisbt/main.js');
  await missingFile(home, 'data/herdr-zed/asana.json');
  await writeHome(home, 'mods/herdr-zed-asana/ui.js', 'custom provider implementation');
  await writeHome(home, 'data/herdr-zed/asana.json', 'private credentials');
  await installExtension(home, 'herdr-zed-asana', { root });
  assert.equal(await readHome(home, 'mods/herdr-zed-asana/ui.js'), 'custom provider implementation');
  assert.equal(await readHome(home, 'data/herdr-zed/asana.json'), 'private credentials');
});

test('extension install needs the shell and rejects invalid mod names', async t => {
  const home = await tempHome(t), root = await fixturePackages(t, packages);
  await assert.rejects(installExtension(home, 'herdr-zed-asana', { root }), /Run node install.js first/);
  await install(home);
  await assert.rejects(installExtension(home, '../escape', { root }), /valid extension mod name/);
});

test('simulator install adds declared frame package without overwriting existing runtime data', async t => {
  const home = await tempHome(t), root = await fixturePackages(t, packages);
  await install(home);
  await installExtension(home, 'herdr-zed-simulator', { root });
  await readHome(home, 'mods/herdr-zed-sim-frames/main.js');
  await writeHome(home, 'mods/herdr-zed-sim-frames/frame-0.jpg', 'existing runtime image');
  await installExtension(home, 'herdr-zed-simulator', { root });
  assert.equal(await readHome(home, 'mods/herdr-zed-sim-frames/frame-0.jpg'), 'existing runtime image');
  assert.deepEqual(JSON.parse(await readHome(home, 'data/herdr-zed/extensions.json')).extensions, ['herdr-zed-simulator'],
    'Supporting package is not registered as another extension');
});

test('incomplete dependency aborts installation without changing registry or existing files', async t => {
  const home = await tempHome(t), root = await fixturePackages(t, packages);
  await install(home);
  await writeHome(home, 'mods/herdr-zed-sim-frames/user.txt', 'keep');
  await assert.rejects(installExtension(home, 'herdr-zed-simulator', { root }), /Incomplete/);
  assert.equal(await readHome(home, 'mods/herdr-zed-sim-frames/user.txt'), 'keep');
  await missingFile(home, 'data/herdr-zed/extensions.json');
  await missingFile(home, 'mods/herdr-zed-simulator/main.js');
});

test('update refreshes installed herdr-zed mods, the layout and icons, and keeps data, shortcuts, settings and foreign files', async t => {
  const home = await tempHome(t);
  await install(home);
  await installExtension(home, 'herdr-zed-asana');
  await writeHome(home, 'mods/herdr-zed/main.js', 'local shell');
  await writeHome(home, 'mods/herdr-zed/obsolete.js', 'old file');
  await writeHome(home, 'mods/herdr-zed-asana/ui.js', 'local asana');
  await writeHome(home, 'layouts/herdr-zed.json', 'stale layout');
  const preserved = {
    'settings.json': '{"theme":"custom"}',
    'shared.json': '{"layout":"devkits","herdr-zed.projects":["/project"]}',
    'data/herdr-zed/extensions.json': '{"version":1,"extensions":["herdr-zed-asana"]}',
    'data/herdr-zed/ecc.json': 'global ECC settings',
    'data/herdr-zed/ecc-source/SKILL.md': 'user ECC source',
    'mods/custom/main.js': 'custom mod',
    'mods/devkits/main.js': 'Devkits mod',
    'layouts/devkits.json': 'other layout',
    'themes/custom.json': 'custom theme',
  };
  for (const [path, text] of Object.entries(preserved)) await writeHome(home, path, text);
  const keys = { global: { 'cmd-t': 'tab.new' }, 'layout:herdr-zed': { 'cmd-n': 'custom.new' } };
  await writeHome(home, 'keys.json', JSON.stringify(keys));

  const result = await update(home);

  assert.deepEqual(result.updated.sort(), ['herdr-zed', 'herdr-zed-asana']);
  assert.equal(await readFile(join(result.backup, 'mods/herdr-zed/main.js'), 'utf8'), 'local shell');
  assert.equal(await readFile(join(result.backup, 'mods/herdr-zed/obsolete.js'), 'utf8'), 'old file');
  assert.equal(await readFile(join(result.backup, 'mods/herdr-zed-asana/ui.js'), 'utf8'), 'local asana');
  assert.equal(await readFile(join(result.backup, 'layouts/herdr-zed.json'), 'utf8'), 'stale layout');
  assert.equal(await readFile(join(result.backup, 'keys.json'), 'utf8'), JSON.stringify(keys));
  await missingFile(home, 'mods/herdr-zed/obsolete.js');
  assert.equal(await readHome(home, 'mods/herdr-zed/main.js'), await read('mods/herdr-zed/main.js'));
  assert.equal(await readHome(home, 'mods/herdr-zed/assets/icons/asana.svg'), await read('assets/icons/asana.svg'));
  assert.equal(await readHome(home, 'mods/herdr-zed-asana/ui.js'), await read('mods/herdr-zed-asana/ui.js'));
  assert.equal(await readHome(home, 'layouts/herdr-zed.json'), await read('layouts/herdr-zed.json'));
  assert.deepEqual(JSON.parse(await readHome(home, 'keys.json')), { ...keys, 'layout:herdr-zed': { ...zedKeys, 'cmd-n': 'custom.new' } });
  for (const [path, text] of Object.entries(preserved)) assert.equal(await readHome(home, path), text, path);
  assert.deepEqual((await readdir(home)).filter(name => name.startsWith('.herdr-zed-update-')), []);
});

test('update restores every replaced path when a later step fails', async t => {
  const home = await tempHome(t);
  await install(home);
  await writeHome(home, 'mods/herdr-zed/main.js', 'original');
  await writeHome(home, 'mods/herdr-zed/obsolete.js', 'keep on failure');
  await writeHome(home, 'layouts/herdr-zed.json', 'stale layout');
  await writeHome(home, 'keys.json', '{"global":{}}');
  await assert.rejects(update(home, {
    beforeReplace: path => { if (path === join('layouts', 'herdr-zed.json')) throw new Error('interrupted'); },
  }), /interrupted/);
  assert.equal(await readHome(home, 'mods/herdr-zed/main.js'), 'original');
  assert.equal(await readHome(home, 'mods/herdr-zed/obsolete.js'), 'keep on failure');
  assert.equal(await readHome(home, 'layouts/herdr-zed.json'), 'stale layout');
  assert.equal(await readHome(home, 'keys.json'), '{"global":{}}');
  assert.deepEqual(await readdir(join(home, 'backups')), [], 'Recovery folder is removed after a clean rollback');
  assert.deepEqual((await readdir(home)).filter(name => name.startsWith('.herdr-zed-update-')), []);
});

test('update validates existing shortcuts before replacing any live file', async t => {
  const home = await tempHome(t);
  await install(home);
  await writeHome(home, 'keys.json', 'invalid JSON');
  await writeHome(home, 'mods/herdr-zed/main.js', 'original');
  await assert.rejects(update(home), SyntaxError);
  assert.equal(await readHome(home, 'mods/herdr-zed/main.js'), 'original');
  assert.equal(await readHome(home, 'keys.json'), 'invalid JSON');
  await missingFile(home, 'backups');
});

test('update requires an installed shell and leaves herdr-zed mods this repository does not provide untouched', async t => {
  const empty = await tempHome(t);
  await assert.rejects(update(empty), /Run node install.js first/);
  const home = await tempHome(t);
  await install(home);
  await writeHome(home, 'mods/herdr-zed-retired/main.js', 'retired mod');
  const result = await update(home);
  assert.deepEqual(result.skipped, ['herdr-zed-retired']);
  assert.equal(await readHome(home, 'mods/herdr-zed-retired/main.js'), 'retired mod');
});
