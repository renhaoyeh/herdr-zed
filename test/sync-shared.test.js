import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncShared } from '../sync-shared.js';

// A throwaway herdr folder outside any Git checkout: one source, one listed copy.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-zed-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'components'), { recursive: true });
  await mkdir(join(root, 'mods', 'panel'), { recursive: true });
  await writeFile(join(root, 'COPIES'), '# comment\nbutton.js: panel\n');
  await writeFile(join(root, 'components', 'button.js'), '// Shared button\nv1\n');
  const copy = join(root, 'mods', 'panel', 'components', 'button.js');
  return { root, copy, source: join(root, 'components', 'button.js') };
}

test('sync writes missing copies, follows source edits, and check changes nothing', async t => {
  const { root, copy, source } = await fixture(t);
  assert.equal((await syncShared({ root, check: true })).bad.length, 1);
  assert.deepEqual((await syncShared({ root })).bad, []);
  assert.equal(await readFile(copy, 'utf8'), '// Shared button\nv1\n');
  await writeFile(source, '// Shared button\nv2\n');
  assert.match((await syncShared({ root, check: true })).bad[0], /differs from/);
  assert.equal(await readFile(copy, 'utf8'), '// Shared button\nv1\n');
  assert.deepEqual((await syncShared({ root })).bad, []);
  assert.equal(await readFile(copy, 'utf8'), '// Shared button\nv2\n');
});

test('a hand-edited copy is never overwritten, and --from makes it the source', async t => {
  const { root, copy, source } = await fixture(t);
  await syncShared({ root });
  await writeFile(copy, '// Shared button\nfixed in the copy\n');
  await writeFile(source, '// Shared button\nv2\n');
  const { bad } = await syncShared({ root });
  assert.match(bad[0], /edited by hand: keep it with `npm run sync:shared -- --from .*button\.js`/);
  assert.equal(await readFile(copy, 'utf8'), '// Shared button\nfixed in the copy\n');
  assert.deepEqual((await syncShared({ root, from: copy })).bad, []);
  assert.equal(await readFile(source, 'utf8'), '// Shared button\nfixed in the copy\n');
  assert.deepEqual((await syncShared({ root, check: true })).bad, []);
});

test('unlisted copies, missing mods and unknown --from paths are reported', async t => {
  const { root, source } = await fixture(t);
  await mkdir(join(root, 'mods', 'other', 'components'), { recursive: true });
  await writeFile(join(root, 'mods', 'other', 'components', 'button.js'), '// Shared button\nold\n');
  let { bad } = await syncShared({ root });
  assert.ok(bad.some(line => /other.*looks like a copy.*add other to COPIES/.test(line)));
  assert.match((await syncShared({ root, from: join(root, 'mods', 'other', 'components', 'button.js') })).bad[0], /not a copy listed/);
  assert.equal(await readFile(source, 'utf8'), '// Shared button\nv1\n');
  await writeFile(join(root, 'COPIES'), 'button.js: panel gone\n');
  ({ bad } = await syncShared({ root }));
  assert.ok(bad.some(line => /mods\/gone is gone \(remove it from COPIES\)/.test(line)));
});
