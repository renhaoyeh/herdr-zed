import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readSharedLibrary, readSharedState, prepareSharedGuidance, importSharedSkill, buildSharedPackage, parseSkillMetadata, skillTree } from '../mods/herdr-zed-agents/shared-skills.js';
import { prepareSharedPlugin } from '../mods/herdr-zed-agents/shared-skills-runtime.js';
import * as model from '../mods/herdr-zed-agents/devkits-model.js';
import { saveDevkitsConfig, writeChecked } from '../mods/herdr-zed-agents/devkits-save.js';
import { evaluateNative } from './source-harness.js';
import { eccAccount } from '../mods/herdr-zed-agents/ecc-model.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-shared-skills-')), home = join(root, 'home'), data = join(home, 'data', 'herdr-zed');
  const put = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  const skill = join(data, 'capabilities', 'skills', 'review');
  await put(join(skill, 'SKILL.md'), '---\nname: review\ndescription: Review with tools\n---\nRead references/check.md.');
  await put(join(skill, 'references', 'check.md'), 'Version one');
  await put(join(skill, 'assets', 'binary.dat'), Buffer.from([0, 1, 255]));
  try { await fn({ root, home, data, skill, put }); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
const pathFrom = guidance => /Read the skill `([^`]+)`/.exec(guidance.sections)[1];

test('ECC slash commands follow global and project selections and resolve immutable launch instructions', async () => fixture(async ({ home, data, root, put }) => {
  const source = join(home, 'mods', 'herdr-zed-agents', 'ecc-source');
  for (const provider of ['claude', 'codex']) await put(join(source, `.${provider}-plugin/plugin.json`), JSON.stringify({ name: 'ecc', version: '1.0.0' }));
  await put(join(source, 'skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: Alpha workflow\n---\nRead references/guide.md.');
  await put(join(source, 'skills/alpha/references/guide.md'), 'Supporting resource');
  await put(join(source, 'skills/beta/SKILL.md'), '---\nname: beta\ndescription: Beta workflow\n---\nDo beta.');
  const config = { version: 1, enabled: true, source, claudeHooks: 'off', providerEnabled: { claude: false, codex: true },
    selection: { codex: { 'skills:alpha': true } } };
  await put(join(data, 'ecc.json'), JSON.stringify(config));
  const entry = fileURLToPath(new URL('../mods/herdr-zed-agents/shared-skills-cli.js', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [entry, 'commands', home, 'codex'], { timeout: 10000 });
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(listed.map(item => item.name), ['review', 'ecc-alpha']);
  assert.ok(listed.every(item => !Object.hasOwn(item, 'path')));
  const launch = await prepareSharedGuidance(home, 'codex');
  const command = launch.commands.find(item => item.id === 'ecc:skills:alpha');
  assert.equal(await readFile(join(dirname(command.path), 'references/guide.md'), 'utf8'), 'Supporting resource');
  const { skillCommandTask } = await evaluateNative('../mods/herdr-zed-agents/session-preparation.js', {}, 'skillCommandTask');
  assert.equal(skillCommandTask('/ecc-alpha Fix the bug', command.id, launch.commands),
    `Use the skill at \`${command.path.replaceAll('\\', '/')}\` for this task. Read its SKILL.md and resolve supporting files relative to it.\n\nFix the bug`);
  assert.ok(!(await prepareSharedGuidance(home, 'claude')).commands.some(item => item.id.startsWith('ecc:')));
  const { projectIdentity, projectPolicyPath } = await import('../mods/herdr-zed-agents/ecc-project.js');
  const identity = await projectIdentity(root);
  const policy = { enabled: true, claudeHooks: 'off', selection: { 'skills:beta': true }, mcp: {} };
  await put(projectPolicyPath(home, identity), JSON.stringify({ version: 1, folder: identity, providers: { codex: policy } }));
  const project = await prepareSharedGuidance(home, 'codex', root);
  assert.deepEqual(project.commands.filter(item => item.id.startsWith('ecc:')).map(item => item.name), ['ecc-beta']);
  assert.throws(() => skillCommandTask('/ecc-alpha Fix the bug', command.id, project.commands), /no longer available/);
  await put(join(data, 'shared-skills.json'), JSON.stringify({ version: 1, disabled: ['mine:skills:review'], providers: {} }));
  const onlyEcc = await prepareSharedGuidance(home, 'codex');
  assert.deepEqual(onlyEcc.commands.map(item => item.name), ['ecc-alpha']);
  assert.equal(onlyEcc.nativeSkills.length, 0);
  await put(join(data, 'ecc.json'), JSON.stringify({ ...config, enabled: false }));
  assert.equal(await prepareSharedGuidance(home, 'codex'), null);
  assert.deepEqual((await prepareSharedGuidance(home, 'codex', root)).commands.map(item => item.name), ['ecc-beta']);
}));

test('CLI command discovery and launch preparation settle project/runtime imports in a separate process', async () => fixture(async ({ root, home }) => {
  const project = join(root, 'project'); await mkdir(project);
  const entry = fileURLToPath(new URL('../mods/herdr-zed-agents/shared-skills-cli.js', import.meta.url));
  for (const provider of ['claude', 'codex']) {
    const result = await promisify(execFile)(process.execPath, [entry, 'commands', home, provider, project], { windowsHide: true, timeout: 10000 });
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout)[0].name, 'review');
  }
  const prepared = await promisify(execFile)(process.execPath, [entry, 'prepare', home, 'claude', project, '{}', join(root, 'account')], { windowsHide: true, timeout: 10000 });
  assert.equal(prepared.stderr, '');
  assert.equal(JSON.parse(prepared.stdout).flags[0], '--plugin-dir');
}));

test('shared selection has its own file and provider switches preserve defaults', async () => fixture(async ({ home, data, put }) => {
  assert.notEqual(model.mineSelectionPath(home), join(data, 'capabilities.json').replaceAll('\\', '/'));
  await put(join(data, 'shared-skills.json'), JSON.stringify({ version: 1, disabled: [], providers: { claude: { 'mine:skills:review': false } } }));
  const claude = await prepareSharedGuidance(home, 'claude'), codex = await prepareSharedGuidance(home, 'codex');
  assert.equal(claude, null); assert.match(codex.summary, /review/);
  assert.ok((await readSharedState(home)).revision);
  assert.throws(() => model.parseMineSelection('{"version":1,"disabled":[],"providers":{"codex":{"a":"yes"}}}'), /provider selections/);
}));

test('MCP dependencies and supported provider/platform control guidance and native skills', async () => fixture(async ({ home, data, skill, put }) => {
  await put(join(skill, 'herdr.json'), JSON.stringify({ version: 1, providers: ['codex'], mcps: ['browser'] }));
  assert.equal(await prepareSharedGuidance(home, 'claude'), null);
  assert.equal(await prepareSharedGuidance(home, 'codex'), null);
  await put(join(data, 'shared-mcp.json'), JSON.stringify({ version: 1, servers: { browser: { command: 'browser', enabled: false } } }));
  assert.equal(await prepareSharedGuidance(home, 'codex'), null);
  const on = await prepareSharedGuidance(home, 'codex', null, { browser: true });
  assert.equal(on.nativeSkills.length, 1);
  assert.equal(JSON.parse(await readFile(join(data, 'shared-mcp.json'), 'utf8')).servers.browser.enabled, false);
  assert.equal(model.resourceProblems({ mcps: ['visual_studio'] }, {}, { visual_studio: { command: 'x' } }, 'linux').length, 1);
  assert.deepEqual(model.resourceProblems({ mcps: ['herdr_ecc', 'herdr_tasks'] }, {}, {}, 'linux'), []);
  assert.throws(() => parseSkillMetadata('{"version":1,"providers":["unknown"]}'), /providers/);
  assert.throws(() => parseSkillMetadata('{"version":1,"mcps":"browser"}'), /mcps/);
}));

test('concurrent launches publish one complete immutable tree including relative and binary assets', async () => fixture(async ({ home, skill, put }) => {
  const [a, b] = await Promise.all([prepareSharedGuidance(home, 'codex'), prepareSharedGuidance(home, 'codex')]);
  const oldPath = pathFrom(a);
  assert.equal(oldPath, pathFrom(b));
  assert.equal(await readFile(join(dirname(oldPath), 'references', 'check.md'), 'utf8'), 'Version one');
  assert.deepEqual(await readFile(join(dirname(oldPath), 'assets', 'binary.dat')), Buffer.from([0, 1, 255]));
  await put(join(skill, 'references', 'check.md'), 'Version two');
  const next = await prepareSharedGuidance(home, 'codex');
  assert.notEqual(pathFrom(next), oldPath);
  assert.equal(await readFile(join(dirname(oldPath), 'references', 'check.md'), 'utf8'), 'Version one');
  const plugin = await buildSharedPackage(home, 'codex', a.nativeSkills);
  assert.equal(await readFile(join(plugin.root, 'skills', 'review', 'references', 'check.md'), 'utf8'), 'Version one');
  const market = JSON.parse(await readFile(join(plugin.root, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(market.plugins[0].name, 'shared-skills');
  assert.equal(plugin.root, (await buildSharedPackage(home, 'codex', a.nativeSkills)).root);
}));

test('local imports retain origin and updates require the exact prior revision', async () => fixture(async ({ root, home, put }) => {
  const source = join(root, 'external', 'deploy');
  await put(join(source, 'SKILL.md'), '---\nname: deploy\ndescription: Deploy\n---\nSteps.');
  await put(join(source, 'herdr.json'), JSON.stringify({ version: 1, mcps: ['browser'] }));
  await importSharedSkill(home, source);
  const installed = (await readSharedLibrary(home)).find(item => item.name === 'deploy');
  assert.equal(installed.origin.source, await import('node:fs/promises').then(fs => fs.realpath(source)));
  assert.deepEqual(installed.mcps, ['browser']);
  await assert.rejects(importSharedSkill(home, source), /already exists/);
  await put(join(source, 'SKILL.md'), '---\nname: deploy\n---\nNew steps.');
  await importSharedSkill(home, source, installed.revision);
  assert.match((await readSharedLibrary(home)).find(item => item.name === 'deploy').text, /New steps/);
  await assert.rejects(importSharedSkill(home, source, installed.revision), /changed/);
  await assert.rejects(importSharedSkill(home, 'relative'), /absolute/);
}));

test('skill trees reject directory links without following them', async t => fixture(async ({ root, skill }) => {
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'outside');
  try { await symlink(outside, join(skill, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symlinks unavailable'); return; } throw error; }
  await assert.rejects(skillTree(skill), /links are not supported/);
}));

test('coordinated settings save preserves all files when shared selections conflict or a later write fails', async () => fixture(async ({ home, data, put }) => {
  const capabilities = JSON.stringify(model.parseDevkits(null)), mcp = '{"version":1,"servers":{}}';
  const shared = JSON.stringify(model.parseMineSelection(null));
  for (const [name, text] of [['capabilities.json', capabilities], ['shared-mcp.json', mcp], ['shared-skills.json', shared]]) await put(join(data, name), text);
  const next = JSON.stringify({ version: 1, disabled: [], providers: { codex: { 'mine:skills:review': false } } });
  const request = { capabilities: { expected: capabilities, text: capabilities.replace('true', 'false') }, mcp: { expected: mcp, text: mcp }, sharedSkills: { expected: shared, text: next } };
  await put(join(data, 'shared-skills.json'), next);
  await assert.rejects(saveDevkitsConfig(home, request), /changed/);
  assert.equal(await readFile(join(data, 'capabilities.json'), 'utf8'), capabilities);
  await put(join(data, 'shared-skills.json'), shared);
  await assert.rejects(saveDevkitsConfig(home, request, { write: async (path, text, expected) => {
    if (path.endsWith('shared-skills.json')) throw Error('disk failure');
    await writeChecked(path, text, expected);
  } }), /disk failure/);
  assert.equal(await readFile(join(data, 'capabilities.json'), 'utf8'), capabilities);
  assert.equal(await readFile(join(data, 'shared-skills.json'), 'utf8'), shared);
  await saveDevkitsConfig(home, request);
  assert.equal(await readFile(join(data, 'shared-skills.json'), 'utf8'), next);
}));

test('native Codex registration stays disabled after success or installation failure and preserves unrelated plugins', async () => fixture(async ({ root, home }) => {
  const directory = join(root, 'account'); await mkdir(directory);
  const id = 'shared-skills@herdr-zed-shared-skills-0123456789abcdef';
  for (const fail of [false, true]) {
    const config = { plugins: { 'other@external': { enabled: true } } };
    const services = { build: async () => ({ pluginId: id, marketplace: 'herdr-zed-shared-skills-0123456789abcdef', root: '/fixed/package' }),
      configService: async () => ({ config, close: async () => {}, write: async changes => { assert.equal(changes.length, 1); config.plugins[id].enabled = changes[0].value; } }),
      run: async () => { config.plugins[id] = { enabled: true }; if (fail) throw Error('installer failed'); } };
    if (fail) await assert.rejects(prepareSharedPlugin(home, 'codex', directory, [], services), /installer failed/);
    else assert.ok((await prepareSharedPlugin(home, 'codex', directory, [], services)).includes(`plugins.${id}.enabled=true`));
    assert.equal(config.plugins[id].enabled, false);
    assert.equal(config.plugins['other@external'].enabled, true);
    await assert.rejects(access(join(directory, '.herdr-zed-ecc.lock')), { code: 'ENOENT' });
  }
}));

test('launch adapter uses the chosen account and combines Claude plugin directories without dropping ECC', async () => {
  const calls = [];
  const { sessionDevkits } = await evaluateNative('../mods/herdr-zed-agents/devkits.js', {
    appHome: () => '/herdr', home: () => '/user', sessionKind: agent => agent.key, eccAccount,
    exec: async (_command, args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ flags: ['--plugin-dir', '/shared-fixed'], summary: 'Shared', sections: 'Read shared.' }) }; },
  }, 'sessionDevkits');
  const argv = ['env', 'CLAUDE_CONFIG_DIR=/account', 'claude', '--plugin-dir', '/ecc-fixed', '--model', 'test'];
  const prepared = await sessionDevkits({ key: 'claude' }, { folder: '/project' }, { browser: false }, argv);
  assert.deepEqual(prepared.argv, ['env', 'CLAUDE_CONFIG_DIR=/account', 'claude', '--plugin-dir', '/shared-fixed', '/ecc-fixed', '--model', 'test']);
  assert.deepEqual(calls[0].slice(-3), ['/project', '{"browser":false}', '/account']);
});

test('provider UI toggles shared skills independently and keeps MCP dependency prompts', async () => {
  const { devkitsSettings } = await evaluateNative('../mods/herdr-zed-agents/devkits-settings.js', { ...model }, 'devkitsSettings');
  const item = model.mineItems({ skills: [{ path: '/skills/review/SKILL.md', text: 'Review', metadata: { mcps: ['browser'] } }] })[0];
  const view = { ...devkitsSettings, capTab: 'codex', capMine: model.parseMineSelection(null), capConfig: model.parseDevkits(null),
    capCatalog: { rules: [], skills: [item] }, mcpConfig: { servers: {} }, capMissing: [], capPlatform: 'windows' };
  const cx = { notify() {} };
  view.setEnabled('skills', item, false);
  assert.equal(view.enabled('skills', item, 'codex'), false); assert.equal(view.enabled('skills', item, 'claude'), true);
  view.toggleDevkitsResource('skills', item, true, cx);
  assert.deepEqual(view.currentDevkitsPlan().missing, ['browser']);
  assert.equal(view.enabled('skills', item), false);
  view.mcpConfig.servers.browser = { command: 'browser' }; view.acceptDevkitsPlan(cx);
  assert.equal(view.enabled('skills', item), true);
});
