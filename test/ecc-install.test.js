import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('install and reinstall bundle ECC outside watched mods, preserve global settings and back up replaced sources', { skip: 'vendor arrives in phase 4' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkits-ecc-install-'));
  try {
    const source = join(root, 'source'), home = join(root, 'herdr');
    await mkdir(join(source, '.claude-plugin'), { recursive: true });
    await writeFile(join(source, '.claude-plugin', 'plugin.json'), '{"name":"ecc","version":"2.2.3"}');
    await writeFile(join(source, 'SKILL.md'), 'fixture skill');
    await writeFile(join(source, '.git'), 'private repository metadata');
    // Exercise the real installer with a small source fixture instead of repeatedly copying the entire upstream repository.
    const url = new URL('../install.js', import.meta.url);
    const original = await readFile(url, 'utf8');
    const fixture = original.replace("new URL('./vendor/everything-claude-code/', import.meta.url)", `new URL(${JSON.stringify(pathToFileURL(`${source}/`).href)})`)
      .replaceAll('import.meta.url', JSON.stringify(url.href));
    assert.notEqual(fixture, original);
    const { install, reinstall } = await import(`data:text/javascript;base64,${Buffer.from(fixture).toString('base64')}`);
    await install(home);
    const bundled = join(home, 'data', 'devkits', 'ecc-source');
    assert.equal(await readFile(join(bundled, 'SKILL.md'), 'utf8'), 'fixture skill');
    await assert.rejects(access(join(bundled, '.git')), { code: 'ENOENT' });
    await assert.rejects(access(join(home, 'mods', 'herdr-zed-agents', 'ecc-source')), { code: 'ENOENT' });
    const settings = join(home, 'data', 'devkits', 'ecc.json');
    await writeFile(settings, 'existing global configuration');
    await writeFile(join(bundled, 'SKILL.md'), 'previous source');
    const { backup } = await reinstall(home);
    assert.equal(await readFile(settings, 'utf8'), 'existing global configuration');
    assert.equal(await readFile(join(bundled, 'SKILL.md'), 'utf8'), 'fixture skill');
    assert.equal(await readFile(join(backup, 'data', 'devkits', 'ecc-source', 'SKILL.md'), 'utf8'), 'previous source');
  } finally { await rm(root, { recursive: true, force: true }); }
});
