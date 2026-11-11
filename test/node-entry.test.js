import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evaluateNative } from './source-harness.js';

const run = promisify(execFile);
async function linkedHelpers(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-node-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = join(root, 'linked-agents');
  await symlink(fileURLToPath(new URL('../mods/herdr-zed-agents/', import.meta.url)), alias,
    process.platform === 'win32' ? 'junction' : 'dir');
  return { root, alias };
}

test('finite helpers execute through symlinked paths and report missing arguments rather than silently succeeding', async t => {
  const { alias } = await linkedHelpers(t);
  for (const name of ['ecc-runtime', 'ecc-sync', 'account-storage-reader', 'devkits-save', 'shared-mcp-sync', 'mcp-probe']) {
    await assert.rejects(run(process.execPath, [join(alias, `${name}.js`)], { windowsHide: true }), error => {
      assert.equal(error.code, 1, name);
      assert.ok(error.stderr.trim(), `${name} reports why it failed`);
      return true;
    });
  }
});

test('an ECC source with no components still returns valid JSON through an aliased installation', async t => {
  const { root, alias } = await linkedHelpers(t), source = join(root, 'source');
  for (const provider of ['claude', 'codex']) {
    const directory = join(source, `.${provider}-plugin`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'plugin.json'), '{"name":"ecc","version":"test"}');
  }
  const { stdout } = await run(process.execPath, [join(alias, 'ecc-runtime.js'), 'catalog', source], { windowsHide: true });
  const catalog = JSON.parse(stdout);
  assert.deepEqual(catalog.items, []);
});

test('ECC reports empty or malformed helper replies clearly while accepting an empty component catalog', async () => {
  for (const stdout of ['', 'not JSON', '{}', '{"items":[]}']) {
    const tasks = [];
    const { eccSettings } = await evaluateNative('../mods/herdr-zed-agents/ecc-settings.js', {
      appHome: () => '/herdr', exec: async () => ({ code: 0, stdout }),
    }, 'eccSettings');
    const view = { ...eccSettings, eccSource: '/source' };
    const cx = { notify() {}, spawn: fn => tasks.push(fn(cx)) };
    view.loadEccCatalog(cx); await tasks[0];
    if (stdout === '{"items":[]}') {
      assert.deepEqual(view.eccCatalog.items, []); assert.equal(view.eccCatalogError, null);
    } else {
      assert.match(view.eccCatalogError, /Try Load source again/);
      assert.doesNotMatch(view.eccCatalogError, /Unexpected end/);
    }
  }
});
