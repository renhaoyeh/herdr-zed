import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReset, clearReset, resetShortcuts } from '../mods/herdr-zed/reset-data.js';
import { inspectReset as inspectAccounts, resetProvider, cleanDefaultClaude, signOut } from '../mods/herdr-zed-agents/reset-provider.js';
import { resetFrames } from '../mods/herdr-zed-simulator/reset-provider.js';
import { resetSystem } from '../mods/herdr-zed-system/reset-provider.js';
import { extensionMetadata, parseExtensionManifest } from '../mods/herdr-zed/extension-model.js';
import { zedKeys } from '../install.js';

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'herdr-zed-reset-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const root = join(folder, 'herdr'), userHome = join(folder, 'user'), data = join(root, 'data', 'herdr-zed');
  const put = async (path, value) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const codex = join(data, 'codex', 'one'), claude = join(data, 'claude', 'two');
  const programs = { programs: {
    codex: { run: ['codex'] }, 'herdr-zed-codex-one': { run: ['env', `CODEX_HOME=${codex}`, 'codex'] },
    'herdr-zed-claude-two': { run: ['env', `CLAUDE_CONFIG_DIR=${claude}`, 'claude'] },
    'devkits-codex-keep': { run: ['env', `CODEX_HOME=${root}/data/devkits/codex/keep`, 'codex'] },
  } };
  await put(join(root, 'programs.json'), programs);
  await put(join(root, 'shared.json'), { layout: 'herdr-zed', 'herdr-zed.tasks': ['private'], 'devkits.tasks': ['keep'], unrelated: true });
  await put(join(root, 'keys.json'), { global: { f1: 'help' }, 'layout:devkits': { f2: 'keep' }, 'layout:herdr-zed': { f3: 'custom' } });
  await put(join(codex, 'auth.json'), 'Zed credentials');
  await put(join(claude, 'history.jsonl'), 'Zed history');
  await put(join(data, 'attachments', 'image.png'), 'pasted image');
  await put(join(root, 'data', 'devkits', 'codex', 'keep', 'auth.json'), 'Devkits credentials');
  await put(join(root, 'project', 'file'), 'project files');
  await put(join(userHome, '.codex', 'auth.json'), 'default credentials');
  await put(join(userHome, '.claude', 'history.jsonl'), 'default history');
  const mod = join(root, 'mods', 'herdr-zed-agents');
  await put(join(mod, 'extension.json'), { version: 1, id: 'agents', title: 'Agents', actions: [], dataReset: { helper: 'reset-provider.js' } });
  await put(join(mod, 'reset-provider.js'), '// fixture helper');
  const calls = [], providerServices = { userHome, signOut: async account => calls.push(account), cleanCodex: async () => {} };
  const services = { stopAccounts: async () => {}, stopServices: async () => {}, idleAccounts: async () => {},
    providerRequest: async (_provider, action) => {
      if (action === 'inspect') return { accounts: (await inspectAccounts(root)).accounts.length };
      await resetProvider(root, providerServices); return {};
    } };
  return { root, folder, data, userHome, codex, claude, programs, put, calls, services, providerServices };
}

test('inspection never mutates data and enumerates only Zed accounts and shared keys', async t => {
  const f = await fixture(t), before = await readFile(join(f.root, 'shared.json'), 'utf8');
  const plan = await inspectReset(f.root, f.services.providerRequest);
  assert.equal(plan.accounts, 2);
  assert.deepEqual(plan.sharedKeys, ['herdr-zed.tasks']);
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(join(f.root, 'shared.json'), 'utf8'), before);
});

test('full reset deletes Zed data, signs out only Zed accounts and preserves Devkits and projects', async t => {
  const f = await fixture(t), before = await readFile(join(f.root, 'shared.json'), 'utf8');
  const result = await clearReset(f.root, 'HERDR ZED', f.services);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(account => account.directory.startsWith(f.data + '/')));
  assert.deepEqual(await readdir(f.data), ['extensions.json']);
  assert.deepEqual(JSON.parse(await readFile(join(f.data, 'extensions.json'))), { version: 1, extensions: ['herdr-zed-agents'] });
  const programs = JSON.parse(await readFile(join(f.root, 'programs.json')));
  assert.deepEqual(programs, { programs: { codex: f.programs.programs.codex, 'devkits-codex-keep': f.programs.programs['devkits-codex-keep'] } });
  assert.equal(await readFile(join(f.root, 'data/devkits/codex/keep/auth.json'), 'utf8'), 'Devkits credentials');
  assert.equal(await readFile(join(f.root, 'project/file'), 'utf8'), 'project files');
  assert.equal(await readFile(join(f.userHome, '.codex/auth.json'), 'utf8'), 'default credentials');
  assert.equal(await readFile(join(f.userHome, '.claude/history.jsonl'), 'utf8'), 'default history');
  assert.equal(await readFile(join(f.root, 'shared.json'), 'utf8'), before, 'Native caller owns shared-state clearing');
  assert.deepEqual(result.sharedKeys, ['herdr-zed.tasks']);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'keys.json'))), { global: { f1: 'help' }, 'layout:devkits': { f2: 'keep' }, 'layout:herdr-zed': zedKeys });
  assert.deepEqual(resetShortcuts, zedKeys);
});

test('wrong confirmation and shutdown failures preserve data before sign-out', async t => {
  const f = await fixture(t);
  await assert.rejects(clearReset(f.root, 'herdr zed', f.services), /Type HERDR ZED/);
  for (const phase of ['stopAccounts', 'stopServices', 'idleAccounts']) {
    await assert.rejects(clearReset(f.root, 'HERDR ZED', { ...f.services, [phase]: async () => { throw new Error('cannot stop'); } }), /before account sign-out/);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(join(f.codex, 'auth.json'), 'utf8'), 'Zed credentials');
});

test('sign-out failure preserves files and reports partial sign-out; retry completes', async t => {
  const f = await fixture(t);
  f.providerServices.signOut = async () => { throw new Error('logout failed'); };
  await assert.rejects(clearReset(f.root, 'HERDR ZED', f.services), /logout failed.*some accounts may already be signed out/);
  assert.equal(await readFile(join(f.codex, 'auth.json'), 'utf8'), 'Zed credentials');
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'programs.json'))), f.programs);
  f.providerServices.signOut = async () => {};
  await clearReset(f.root, 'HERDR ZED', f.services);
  await assert.rejects(readFile(join(f.codex, 'auth.json')), { code: 'ENOENT' });
});

test('account changes during sign-out abort deletion without discarding concurrent settings', async t => {
  const f = await fixture(t), changed = { ...f.programs, shells: ['zsh'] };
  f.providerServices.cleanCodex = async () => f.put(join(f.root, 'programs.json'), changed);
  await assert.rejects(clearReset(f.root, 'HERDR ZED', f.services), /Accounts changed/);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'programs.json'))), changed);
  assert.equal(await readFile(join(f.codex, 'auth.json'), 'utf8'), 'Zed credentials');
});

test('linked data roots and malformed owned program paths prevent cleanup', async t => {
  const f = await fixture(t), outside = join(f.folder, 'outside');
  await f.put(join(outside, 'keep'), 'keep');
  await rm(f.data, { recursive: true }); await symlink(outside, f.data);
  await assert.rejects(clearReset(f.root, 'HERDR ZED', f.services), /symbolic link/);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'keep');
  const g = await fixture(t);
  g.programs.programs['herdr-zed-codex-one'].run = ['env', 'CODEX_HOME=/external', 'codex'];
  await g.put(join(g.root, 'programs.json'), g.programs);
  await assert.rejects(clearReset(g.root, 'HERDR ZED', g.services), /outside Herdr Zed/);
  assert.deepEqual(g.calls, []);
});

test('concurrent reset lock prevents deletion and dead locks allow explicit retry', async t => {
  const f = await fixture(t), path = join(f.root, '.herdr-zed-reset.lock');
  await f.put(path, { pid: process.pid });
  await assert.rejects(clearReset(f.root, 'HERDR ZED', f.services), /Another Herdr Zed reset/);
  await f.put(path, { pid: 2147483647 });
  await clearReset(f.root, 'HERDR ZED', f.services);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('default Claude integration cleanup restores only this installations hook and keeps Devkits markers', async t => {
  const f = await fixture(t), directory = join(f.userHome, '.claude');
  const previous = { type: 'command', command: 'Devkits status line' };
  await f.put(join(directory, 'settings.json'), { theme: 'dark', statusLine: { type: 'command', command: `node "${f.root}/mods/herdr-zed-agents/usage/claude-statusline.js"` } });
  await f.put(join(directory, 'herdr-zed-statusline-chain.json'), previous);
  await f.put(join(directory, 'devkits-usage.json'), 'keep');
  await cleanDefaultClaude(f.root, f.userHome);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings.json'))), { theme: 'dark', statusLine: previous });
  assert.equal(await readFile(join(directory, 'devkits-usage.json'), 'utf8'), 'keep');
  await f.put(join(directory, 'settings.json'), { statusLine: { command: 'user command' } });
  await cleanDefaultClaude(f.root, f.userHome);
  assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'))).statusLine.command, 'user command');
});

test('logout uses official CLI with dedicated account environment and no authentication overrides', async () => {
  const calls = [];
  for (const provider of ['claude', 'codex']) await signOut({ provider, directory: `/zed/${provider}` }, async (...args) => calls.push(args), 'darwin');
  assert.deepEqual(calls[0].slice(0, 2), ['claude', ['auth', 'logout']]);
  assert.equal(calls[0][2].env.CLAUDE_CONFIG_DIR, '/zed/claude');
  assert.deepEqual(calls[1].slice(0, 2), ['codex', ['logout']]);
  assert.equal(calls[1][2].env.CODEX_HOME, '/zed/codex');
  for (const call of calls) for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(call[2].env[key], undefined);
});

test('reset hook contract rejects paths and arbitrary fields; all installed manifests declare reset policy', async () => {
  const manifest = { version: 1, id: 'example', title: 'Example', actions: [], dataReset: { helper: 'reset-provider.js' } };
  assert.deepEqual(extensionMetadata('example', JSON.stringify(manifest)).dataReset, manifest.dataReset);
  for (const dataReset of [{ helper: '../outside.js' }, { helper: '/outside.js' }, { helper: 'x.js', args: [] }, { helper: ['reset.js'] }, 'reset.js'])
    assert.throws(() => parseExtensionManifest('example', JSON.stringify({ ...manifest, dataReset })), /reset helper/);
  for (const mod of await readdir(new URL('../mods/', import.meta.url))) {
    const text = await readFile(new URL(`../mods/${mod}/extension.json`, import.meta.url), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!text) continue;
    assert.ok(Object.hasOwn(JSON.parse(text), 'dataReset'));
    parseExtensionManifest(mod, text);
  }
});

test('generated frame and sensor cleanup preserves code, Devkits cache and simulator data', async t => {
  const f = await fixture(t);
  await f.put(join(f.root, 'mods/herdr-zed-sim-frames/frame-0.jpg'), 'frame');
  await f.put(join(f.root, 'mods/herdr-zed-sim-frames/main.js'), 'code');
  await f.put(join(f.root, 'mods/devkits-sim-frames/frame-0.jpg'), 'keep');
  await resetFrames(f.root);
  assert.deepEqual(await readdir(join(f.root, 'mods/herdr-zed-sim-frames')), ['main.js']);
  assert.equal(await readFile(join(f.root, 'mods/devkits-sim-frames/frame-0.jpg'), 'utf8'), 'keep');
  const cache = join(f.folder, 'sensor-cache'); await mkdir(cache); await resetSystem(cache);
  await assert.rejects(readdir(cache), { code: 'ENOENT' });
});

test('reset disables only owned default ECC integrations before deleting package references', async t => {
  const f = await fixture(t), calls = [];
  const { cleanDefaultEcc } = await import('../mods/herdr-zed-agents/reset-provider.js');
  const directory = join(f.userHome, '.codex');
  await f.put(join(directory, 'herdr-zed-ecc.json'), { version: 1, provider: 'codex' });
  await f.put(join(directory, 'devkits-ecc.json'), 'keep');
  await cleanDefaultEcc(f.userHome, async (provider, account, config) => calls.push({ provider, account, enabled: config.enabled }));
  assert.deepEqual(calls, [{ provider: 'codex', account: directory, enabled: false }]);
  await assert.rejects(readFile(join(directory, 'herdr-zed-ecc.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, 'devkits-ecc.json'), 'utf8'), 'keep');
});

test('native global programs from other product data folders are excluded without hiding system programs', async () => {
  const { programInScope } = await import('../components/session-model.js');
  for (const root of ['/herdr', 'C:\\Herdr']) {
    assert.equal(programInScope({ run: ['env', `CODEX_HOME=${root}/data/devkits/codex/work`, 'codex'] }, root), false);
    assert.equal(programInScope({ run: ['env', `CODEX_HOME=${root}/data/herdr-zed/codex/work`, 'codex'] }, root), true);
    assert.equal(programInScope({ run: ['codex'] }, root), true);
    assert.equal(programInScope({ run: ['claude'] }, root), true);
  }
});

test('reset helpers inspect an isolated home through symlinked paths without running cleanup', async t => {
  const f = await fixture(t);
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const execute = promisify(execFile), copied = join(f.folder, 'bundle');
  await cp(new URL('../mods/herdr-zed/', import.meta.url), join(copied, 'mods/herdr-zed'), { recursive: true });
  await cp(new URL('../mods/herdr-zed-agents/', import.meta.url), join(copied, 'mods/herdr-zed-agents'), { recursive: true });
  await f.put(join(copied, 'data/herdr-zed/example'), 'keep');
  await f.put(join(copied, 'shared.json'), { 'herdr-zed.example': true, 'devkits.example': true });
  await symlink(copied, join(f.folder, 'linked'));
  const entry = join(f.folder, 'linked/mods/herdr-zed/reset-data.js');
  const plan = JSON.parse((await execute(process.execPath, [entry, 'inspect', copied])).stdout);
  assert.equal(plan.accounts, 0);
  assert.deepEqual(plan.sharedKeys, ['herdr-zed.example']);
  assert.equal(await readFile(join(copied, 'data/herdr-zed/example'), 'utf8'), 'keep');
});

test('cached native discovery cannot expose a foreign managed account after data isolation', async () => {
  const { evaluateNative } = await import('./source-harness.js');
  const { programInScope, configuredAgents } = await import('../components/session-model.js');
  const { availableAgents } = await evaluateNative('../mods/herdr-zed-agents/discovery.js', {
    programInScope, configuredAgents, appHome: () => '/herdr', shared: () => [],
  }, 'availableAgents');
  const profiles = [
    { key: 'codex', run: ['codex'] },
    { key: 'devkits-codex-work', run: ['env', 'CODEX_HOME=/herdr/data/devkits/codex/work', 'codex'] },
    { key: 'herdr-zed-codex-work', run: ['env', 'CODEX_HOME=/herdr/data/herdr-zed/codex/work', 'codex'] },
  ];
  assert.deepEqual(availableAgents(profiles, null).map(profile => profile.key), ['codex', 'herdr-zed-codex-work']);
});
