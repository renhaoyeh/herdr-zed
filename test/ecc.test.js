import * as profiles from '../mods/herdr-zed-agents/ecc-profiles.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncEcc } from '../mods/herdr-zed-agents/ecc-sync.js';
import { parseEcc, eccAccount, eccItemEnabled, chooseEccItem } from '../mods/herdr-zed-agents/ecc-model.js';
import { readEccCatalog, eccCatalogForUi, readEccDetail } from '../mods/herdr-zed-agents/ecc-catalog.js';
import { buildEccPackage } from '../mods/herdr-zed-agents/ecc-package.js';
import { evaluateNative } from './source-harness.js';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-zed-ecc-architecture-'));
  const source = join(root, 'source'), directory = join(root, 'account'), output = join(root, 'packages');
  const put = async (path, text) => { await mkdir(join(source, path, '..'), { recursive: true }); await writeFile(join(source, path), text); };
  for (const host of ['claude', 'codex']) await put(`.${host}-plugin/plugin.json`, JSON.stringify({ name: 'ecc', version: '2.2.3', skills: './skills/' }));
  await put('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha workflow\n---\n# Alpha\nDo alpha.');
  await put('skills/beta/SKILL.md', '# Beta\n\nDo beta.'); await put('skills/beta/scripts/helper.js', 'support resource');
  await put('agents/planner.md', '---\nname: planner\ndescription: Plan features\n---\nPlan carefully.');
  await put('commands/plan.md', '---\ndescription: Plan a task\n---\nUse alpha.');
  await put('rules/common/style.md', '# Style\n\nUse readable names.');
  await put('contexts/dev.md', '# Development\n\nImplement features.'); await put('contexts/review.md', '# Review\n\nReview changes.');
  await put('workflows/review.workflow.js', '// Review pipeline');
  await put('hooks/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/hooks/pre-bash-dispatcher.js' }] }] } }));
  await put('hooks/codex-hooks.json', JSON.stringify({ hooks: { SessionStart: [{ id: 'session:start', matcher: '.*', hooks: [{ type: 'command', command: 'node scripts/hooks/session-start.js' }] }] } }));
  await put('scripts/hooks/bash-hook-dispatcher.js', "const checks=[{id:'pre:bash:alpha',profiles:'standard,strict',run:runAlpha}];");
  await put('scripts/lib/hook-flags.js', 'function getDisabledHookIds(){return new Set()} function isHookEnabled(id){const env={};const disabled = getDisabledHookIds(env);return !disabled.has(id)} module.exports={isHookEnabled};');
  await put('.mcp.json', JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: ['-e', 'process.stdout.write(process.env.TEST_API_TOKEN)'], env: { TEST_API_TOKEN: 'YOUR_API_TOKEN' } } } }));
  await put('mcp-configs/mcp-servers.json', JSON.stringify({ mcpServers: { unfinished: { command: 'node', args: ['/path/to/server.js'] } } }));
  const config = parseEcc(JSON.stringify({ version: 1, enabled: true, source, claudeHooks: 'standard' }));
  const catalog = await readEccCatalog(source);
  for (const provider of ['claude', 'codex']) config.selection[provider] = Object.fromEntries(catalog.items.filter(item => item.providers.includes(provider) && item.defaultEnabled).map(item => [item.id, true]));
  try { await fn({ root, source, directory, output, config, put }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('ECC catalog reads all architecture layers without executing source and exposes provider support and template requirements', async () => fixture(async ({ source }) => {
  const catalog = await readEccCatalog(source), ui = eccCatalogForUi(catalog);
  assert.deepEqual(new Set(catalog.items.map(item => item.group)), new Set(['agents', 'skills', 'commands', 'rules', 'contexts', 'workflows', 'hooks', 'mcp']));
  assert.equal(catalog.items.find(item => item.id === 'skills:alpha').description, 'Alpha workflow');
  assert.deepEqual(catalog.items.find(item => item.group === 'agents').providers, ['claude']);
  assert.ok(catalog.items.find(item => item.id === 'mcp:unfinished').unavailable);
  assert.deepEqual(catalog.items.find(item => item.id === 'mcp:echo').requirements, ['TEST_API_TOKEN']);
  assert.ok(ui.items.every(item => !Object.hasOwn(item, 'payload')));
  assert.match(await readEccDetail(catalog, 'skills:alpha'), /Do alpha/);
  await assert.rejects(readEccDetail(catalog, '../../outside'), /no longer exists/);
}));

test('ECC selections are independent by provider and Context selection is exclusive', async () => fixture(async ({ source, config }) => {
  const catalog = await readEccCatalog(source), skill = catalog.items.find(item => item.id === 'skills:alpha');
  chooseEccItem(config, 'claude', skill, false);
  assert.equal(eccItemEnabled(config, 'claude', skill), false); assert.equal(eccItemEnabled(config, 'codex', skill), true);
  for (const item of catalog.items.filter(item => item.group === 'contexts')) chooseEccItem(config, 'claude', item, true);
  assert.equal(catalog.items.filter(item => item.group === 'contexts' && eccItemEnabled(config, 'claude', item)).length, 1);
  assert.throws(() => parseEcc(JSON.stringify({ ...config, selection: { accounts: {} } })), /Invalid/);
  assert.deepEqual(eccAccount('codex', ['env', 'CODEX_HOME=C:/Account', 'codex'], '/home'), { provider: 'codex', directory: 'C:/Account' });
}));

test('compiled ECC packages enforce selections, preserve support resources and source, isolate providers and keep old revisions immutable', async () => fixture(async ({ source, config, output }) => {
  const catalog = await readEccCatalog(source);
  for (const id of ['skills:beta', 'agents:planner.md', 'commands:plan.md', 'workflows:review.workflow.js', 'hooks:check:pre:bash:alpha'])
    chooseEccItem(config, 'claude', catalog.items.find(item => item.id === id), false);
  chooseEccItem(config, 'claude', catalog.items.find(item => item.group === 'rules'), true);
  const claude = await buildEccPackage(config, 'claude', output, catalog), codex = await buildEccPackage(config, 'codex', output, catalog);
  await assert.rejects(access(join(claude.root, 'skills/beta/SKILL.md')), { code: 'ENOENT' });
  assert.equal(await readFile(join(claude.root, 'skills/beta/scripts/helper.js'), 'utf8'), 'support resource');
  await access(join(codex.root, 'skills/beta/SKILL.md')); await access(join(source, 'skills/beta/SKILL.md'));
  assert.match(claude.instructions, /Use readable names/); assert.equal(codex.instructions, '');
  assert.deepEqual(JSON.parse(await readFile(join(claude.root, '.mcp.json'), 'utf8')), { mcpServers: {} });
  const require = createRequire(import.meta.url);
  assert.equal(require(join(claude.root, 'scripts/lib/hook-flags.js')).isHookEnabled('pre:bash:alpha'), false);
  assert.equal(require(join(source, 'scripts/lib/hook-flags.js')).isHookEnabled('pre:bash:alpha'), true);
  const firstBytes = await readFile(join(claude.root, 'devkits-package.json'));
  chooseEccItem(config, 'claude', catalog.items.find(item => item.id === 'skills:beta'), true);
  const changed = await buildEccPackage(config, 'claude', output, catalog);
  assert.notEqual(changed.pluginId, claude.pluginId); assert.deepEqual(await readFile(join(claude.root, 'devkits-package.json')), firstBytes);
  assert.equal((await buildEccPackage(config, 'claude', output, catalog)).root, changed.root);
}));

test('native hook switches remove actual event entries and enabled MCP wrappers use runtime environment values without persisting secrets', async () => fixture(async ({ config, source, output }) => {
  const catalog = await readEccCatalog(source), hook = catalog.items.find(item => item.native && item.providers.includes('codex'));
  chooseEccItem(config, 'codex', hook, false); chooseEccItem(config, 'codex', catalog.items.find(item => item.id === 'mcp:echo'), true);
  const bundle = await buildEccPackage(config, 'codex', output, catalog);
  assert.deepEqual(JSON.parse(await readFile(join(bundle.root, 'hooks/codex-hooks.json'), 'utf8')).hooks, {});
  const server = JSON.parse(await readFile(join(bundle.root, '.mcp.json'), 'utf8')).mcpServers.echo;
  const secret = 'literal ; & $(not-a-command) value';
  const { stdout } = await promisify(execFile)(server.command, server.args, { env: { ...process.env, TEST_API_TOKEN: secret }, windowsHide: true });
  assert.equal(stdout, secret);
  assert.ok(!(await readFile(join(bundle.root, 'scripts/devkits-mcp.json'), 'utf8')).includes(secret));
}));

test('ECC sync uses revision-specific native plugins, disables only its prior package and preserves markers after failure', async () => fixture(async ({ config, directory }) => {
  const calls = [], writes = [], inventory = []; let revision = 'a'.repeat(64), failure = false;
  const packageBuilder = async () => ({ revision, root: '/built', marketplace: `herdr-zed-ecc-${revision.slice(0, 16)}`, pluginId: `ecc@herdr-zed-ecc-${revision.slice(0, 16)}`, native: true, instructions: 'Selected guidance' });
  const run = async (provider, dir, args) => {
    calls.push(args); assert.equal(dir, directory);
    if (failure && args[1] === 'configure') throw Error('native failure');
    if (args[1] === 'list') return JSON.stringify(inventory);
    if (args[1] === 'install') inventory.push({ id: args[2], scope: 'user', enabled: true });
    if (args[1] === 'disable' || args[1] === 'enable') inventory.find(item => item.id === args[2]).enabled = args[1] === 'enable';
    return '';
  };
  assert.equal((await syncEcc('claude', directory, config, { run, packageBuilder })).instructionsFile, join('/built', 'devkits-guidance.md'));
  const first = JSON.parse(await readFile(join(directory, 'herdr-zed-ecc.json'), 'utf8'));
  const count = calls.filter(args => args[1] === 'install').length; await syncEcc('claude', directory, config, { run, packageBuilder }); assert.equal(calls.filter(args => args[1] === 'install').length, count);
  revision = 'b'.repeat(64); failure = true;
  await assert.rejects(syncEcc('claude', directory, config, { run, packageBuilder }), /native failure/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'herdr-zed-ecc.json'), 'utf8')), first);
  failure = false; revision = 'a'.repeat(64); await syncEcc('claude', directory, config, { run, packageBuilder });
  assert.equal(inventory.find(item => item.id.endsWith('b'.repeat(16))).enabled, false);
  revision = 'b'.repeat(64); await syncEcc('claude', directory, config, { run, packageBuilder });
  assert.ok(calls.some(args => args[1] === 'disable' && args[2] === first.pluginId));
  const configService = async () => ({ config: { plugins: { unrelated: { enabled: true } } }, write: async edits => writes.push(edits), close: async () => {} });
  await syncEcc('codex', join(directory, 'codex'), config, { run: async () => '', packageBuilder, configService });
  assert.deepEqual(writes.at(-1), [{ keyPath: 'plugins."ecc@herdr-zed-ecc-bbbbbbbbbbbbbbbb".enabled', value: true, mergeStrategy: 'replace' }]);
}));

test('never-managed disabled ECC accounts are untouched and preparation returns selected guidance separately from argv', async () => fixture(async ({ directory, config }) => {
  await syncEcc('claude', directory, { ...config, enabled: false }, { run: () => assert.fail('must not run') });
  await assert.rejects(access(directory), { code: 'ENOENT' });
  await syncEcc('codex', directory, { ...config, providerEnabled: { claude: true, codex: false } }, { run: () => assert.fail('provider off') });
  await assert.rejects(access(directory), { code: 'ENOENT' });
  const calls = [];
  const { prepareEcc } = await evaluateNative('../mods/herdr-zed-agents/ecc.js', {
    appHome: () => '/herdr', home: () => '/home', parseEcc, eccAccount, sessionKind: () => 'codex',
    readTextFile: async () => JSON.stringify(config), exec: async (...args) => { calls.push(args); return { code: 0, stdout: '{"instructionsFile":"/selected-guidance.md"}' }; },
  }, 'prepareEcc');
  const argv = ['env', 'CODEX_HOME=/account', 'codex'];
  const prepared = await prepareEcc({}, argv); assert.deepEqual(prepared.argv, argv); assert.match(prepared.instructions, /selected-guidance\.md/);
  assert.deepEqual(calls[0][1], ['/herdr/mods/herdr-zed-agents/ecc-sync.js', 'codex', '/account', '/herdr/data/herdr-zed/ecc.json']);
}));

test('catalog requests ignore older sources and results arriving after the panel closes', async () => {
  const gates = [], tasks = [];
  const { eccSettings } = await evaluateNative('../mods/herdr-zed-agents/ecc-settings.js', {
    appHome: () => '/herdr', exec: async () => new Promise(resolve => gates.push(resolve)),
  }, 'eccSettings');
  const view = { ...eccSettings, eccSource: '/old' };
  const cx = { notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  view.loadEccCatalog(cx); view.eccSource = '/new'; view.loadEccCatalog(cx);
  gates[1]({ code: 0, stdout: '{"items":[],"version":"new"}' }); await tasks[1];
  gates[0]({ code: 0, stdout: '{"items":[],"version":"old"}' }); await tasks[0];
  assert.equal(view.eccCatalog.version, 'new'); assert.equal(view.eccCatalogInput, '/new');
  view.eccSource = '/late'; view.loadEccCatalog(cx); view.eccClosed = true;
  gates[2]({ code: 0, stdout: '{"items":[],"version":"late"}' }); await tasks[2];
  assert.equal(view.eccCatalogInput, '/new'); assert.equal(view.eccCatalog, null);
});

test('missing ECC settings use the bundled enabled default; explicit disable stays disabled', async () => {
  const { readEccConfig } = await import('../mods/herdr-zed-agents/ecc-sync.js');
  const directory = await mkdtemp(join(tmpdir(), 'ecc-default-'));
  try {
    const path = join(directory, 'ecc.json');
    const config = await readEccConfig(path);
    assert.equal(config.enabled, true);
    assert.deepEqual(config.providerEnabled, { claude: true, codex: true });
    assert.match(config.source, /herdr-zed-agents[/\\]ecc-source$/);
    await writeFile(path, JSON.stringify({ ...config, enabled: false }));
    assert.equal((await readEccConfig(path)).enabled, false);
    await writeFile(path, '{broken');
    await assert.rejects(readEccConfig(path), SyntaxError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ECC selection filter combines search and provider choices, sorting selected first without mutating catalog', async () => {
  const { eccSettings } = await evaluateNative('../mods/herdr-zed-agents/ecc-settings.js', { eccItemEnabled }, 'eccSettings');
  const items = ['off', 'on', 'other'].map(name => ({ id: name, name, providers: ['claude', 'codex'], defaultEnabled: false }));
  const view = { ...eccSettings, eccProvider: 'claude', eccFilter: 'all', eccSearch: { value: () => '' },
    eccDraft: { selection: { claude: { on: true }, codex: { other: true } } } };
  const ids = () => view.eccVisibleItems(items).map(item => item.id);
  assert.deepEqual(ids(), ['on', 'off', 'other']);
  assert.deepEqual(items.map(item => item.id), ['off', 'on', 'other']);
  view.eccFilter = 'selected'; assert.deepEqual(ids(), ['on']);
  view.eccProvider = 'codex'; assert.deepEqual(ids(), ['other']);
  view.eccSearch.value = () => 'ON'; assert.deepEqual(ids(), []);
  view.eccFilter = 'off'; assert.deepEqual(ids(), ['on']);
});

test('ECC provider filters render through the real Select with valid colors and independent popup state', async () => {
  const nodes = new Map();
  const element = () => {
    const node = {};
    const proxy = new Proxy(node, { get: (_, key) => (...args) => {
      if (key === 'when' && args[0]) args[1](proxy);
      if (key === 'id') nodes.set(args[0], node);
      if (key === 'on_click') node.click = args[0];
      if (['text_color', 'border_color', 'bg'].includes(key)) assert.equal(typeof args[0], 'string', key);
      return proxy;
    } });
    return proxy;
  };
  const base = { div: element, svg: element, image: element, h_flex: element, v_flex: element,
    DropdownMenuContent: element, DropdownMenuItem: element, NativeSelect: { new: element }, NativePopup: { new: element } };
  const { Select, SelectState } = await evaluateNative('../components/select.js', base, 'Select, SelectState');
  const { eccGroups } = await import('../mods/herdr-zed-agents/ecc-model.js');
  const { eccSettings } = await evaluateNative('../mods/herdr-zed-agents/ecc-settings.js',
    { ...base, ...profiles, Select, SelectState, eccGroups, eccItemEnabled, chooseEccItem, Button: id => element().id(id), Switch: element, AgentIcon: element, glyph: element, Input: { new: element } }, 'eccSettings');
  const cx = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {} };
  const view = { ...eccSettings, eccProvider: 'claude', eccSection: 'hooks', eccFilter: 'all', eccListPage: 0,
    eccDraft: { providerEnabled: { claude: true }, claudeHooks: 'standard', selection: { claude: {}, codex: {} } }, eccCatalog: { items: [] }, eccSearch: { value: () => '' },
    eccProfileSelect: new SelectState(cx), eccSelect: new SelectState(cx), eccFilterSelect: new SelectState(cx) };
  for (const color of ['#ffffff', '#111111']) {
    const theme = Object.fromEntries(['foreground', 'muted', 'border', 'popover', 'input', 'hover', 'selected', 'ansi3'].map(key => [key, color]));
    for (const profile of [null, 'basic', 'supervisor']) for (const filter of ['all', 'selected', 'off']) { view.eccProfileChoice = profile; view.eccFilter = filter; view.eccProviderPage(theme); }
  }
  nodes.get('ecc-selection-filter').click(null, cx);
  assert.equal(view.eccFilterSelect.open, true);
  assert.equal(view.eccSelect.open, false);
  const cost = { id: profiles.eccCostSkill, name: 'Cost', providers: ['claude', 'codex'], group: 'skills' };
  view.eccCatalog.items.push(cost); view.eccProfileChoice = null;
  view.eccDraft.selection.claude.existing = true; view.eccDraft.selection.codex.other = true;
  view.eccProfilePanel(Object.fromEntries(['foreground', 'muted', 'border', 'popover', 'input', 'hover', 'selected'].map(key => [key, '#ffffff'])));
  nodes.get('ecc-apply-cost').click(null, cx);
  assert.deepEqual(view.eccDraft.selection, { claude: { existing: true, [profiles.eccCostSkill]: true }, codex: { other: true } });
  assert.equal(view.eccDirty, true);

});

test('functional profiles are explicit, provider-specific and become Custom after manual changes', async () => {
  const catalog = await readEccCatalog(new URL('../vendor/everything-claude-code/', import.meta.url).pathname);
  const config = parseEcc(null);
  assert.equal(config.claudeHooks, 'off');
  assert.ok(catalog.items.every(item => !eccItemEnabled(config, 'claude', item)));
  for (const provider of ['claude', 'codex']) for (const profile of profiles.eccProfiles) {
    const plan = profiles.eccProfilePlan(catalog.items, provider, profile.id, true);
    assert.deepEqual(plan.missing, []);
    assert.ok(plan.items.every(item => item.providers.includes(provider) && !['hooks', 'workflows', 'mcp'].includes(item.group)));
    const before = JSON.stringify(config.selection[provider === 'claude' ? 'codex' : 'claude']);
    profiles.applyEccProfile(config, provider, catalog.items, profile.id, true);
    assert.equal(profiles.eccProfileName(config, provider, catalog.items), profile.name + ' + Cost conscious');
    assert.equal(JSON.stringify(config.selection[provider === 'claude' ? 'codex' : 'claude']), before);
  }
  config.selection.codex['skills:unknown'] = true;
  assert.equal(profiles.eccProfileName(config, 'codex', catalog.items), 'Custom');
  const before = JSON.stringify(config);
  assert.throws(() => profiles.applyEccProfile(config, 'codex', [], 'development', false), /unavailable/);
  assert.equal(JSON.stringify(config), before);
  profiles.applyEccProfile(config, 'codex', catalog.items, 'basic', false);
  assert.equal(profiles.eccProfileName(config, 'codex', catalog.items), 'Basic');
});
