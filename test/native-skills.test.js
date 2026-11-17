import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readNativeSkillPolicy, saveNativeSkillPolicy, nativeSkillInventory, nativeSkillFlags, nativeSkillKey, installNativeSkill, setNativeSkillEnabled } from '../mods/herdr-zed-agents/native-skills.js';
import { readCodexSkillInventory } from '../mods/herdr-zed-agents/codex-skills.js';
import { readClaudeSkills } from '../mods/herdr-zed-agents/claude-skills.js';
import { evaluateNative } from './source-harness.js';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-native-skills-'));
  const home = join(root, 'app'), user = join(root, 'user'), project = join(root, 'project'), other = join(root, 'other');
  await mkdir(project); await mkdir(other);
  const put = async (path, content) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
  try { await fn({ root, home, user, project, other, put }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const document = name => `---\nname: ${name}\ndescription: ${name} workflow\n---\nRead ../references/guide.md.`;

test('native installation follows the original source, remains outside Herdr and refuses to overwrite', async () => fixture(async ({ root, home, user, put }) => {
  const source = join(root, 'runtime/skills/review');
  await put(join(source, 'SKILL.md'), document('review'));
  await put(join(root, 'runtime/skills/references/guide.md'), 'Sibling reference');
  for (const provider of ['codex', 'claude']) {
    const installed = await installNativeSkill(user, provider, source);
    const text = await readFile(installed.path, 'utf8');
    assert.ok(text.includes(join(source, 'SKILL.md').replaceAll('\\', '/')));
    assert.match(text, /original directory/);
    await assert.rejects(installNativeSkill(user, provider, source), /preserved/);
    assert.equal(await readFile(installed.path, 'utf8'), text);
  }
  assert.equal((await readClaudeSkills(user))[0].name, 'review');
  await assert.rejects(access(join(home, 'data/herdr-zed/capabilities')), { code: 'ENOENT' });
  await assert.rejects(access(join(user, '.claude/settings.json')), { code: 'ENOENT' });
}));

test('projects inherit by default and checked saves preserve other providers and projects', async () => fixture(async ({ root, home, project, other }) => {
  const skill = join(root, 'skill/SKILL.md');
  const before = await readNativeSkillPolicy(home, project);
  assert.deepEqual(before.disabled, { claude: [], codex: [] });
  const claude = await saveNativeSkillPolicy(home, project, 'claude', [skill], before.revision);
  await assert.rejects(saveNativeSkillPolicy(home, project, 'codex', [skill], before.revision), /Refresh/);
  const codex = await saveNativeSkillPolicy(home, project, 'codex', [skill], claude.revision);
  assert.deepEqual(codex.disabled, { claude: [nativeSkillKey(skill)], codex: [nativeSkillKey(skill)] });
  assert.deepEqual((await readNativeSkillPolicy(home, other)).disabled, { claude: [], codex: [] });
  const reset = await saveNativeSkillPolicy(home, project, 'claude', [], codex.revision);
  assert.deepEqual(reset.disabled.claude, []); assert.equal(reset.disabled.codex.length, 1);
  await assert.rejects(saveNativeSkillPolicy(home, null, 'claude', [], reset.revision), /local project/);
}));

test('inventory includes native off entries and effective project exclusions without mutating accounts', async () => fixture(async ({ root, home, user, project }) => {
  const on = join(root, 'on/SKILL.md'), off = join(root, 'off/SKILL.md');
  const policy = await readNativeSkillPolicy(home, project);
  await saveNativeSkillPolicy(home, project, 'codex', [on], policy.revision);
  const values = await nativeSkillInventory(home, user, 'codex', join(root, 'account'), project, {
    codex: async () => [{ id: 'on', name: 'on', path: on, enabled: true, source: 'User' }, { id: 'off', name: 'off', path: off, enabled: false, source: 'Plugin' }],
    guidance: async () => ({ commands: [{ id: 'ecc:check', name: 'ecc-check', path: join(root, 'ecc/SKILL.md') }] }),
  });
  assert.equal(values.items.find(item => item.name === 'on').active, false);
  assert.equal(values.items.find(item => item.name === 'off').enabled, false);
  assert.equal(values.items.find(item => item.name === 'ecc-check').source, 'ECC');
  assert.equal(values.root, join(user, '.agents/skills'));
  await assert.rejects(access(join(root, 'account/config.toml')), { code: 'ENOENT' });
}));

test('Codex project flags retain existing skill settings and close the read-only service', async () => fixture(async ({ root, home, project }) => {
  const path = join(root, 'review/SKILL.md'), disabled = nativeSkillKey(path), policy = await readNativeSkillPolicy(home, project);
  await saveNativeSkillPolicy(home, project, 'codex', [path], policy.revision);
  let closes = 0;
  const result = await nativeSkillFlags(home, project, 'codex', root, { open: async () => ({ request: async (method, params) => {
    assert.equal(method, 'config/read'); assert.equal(params.cwd, project);
    return { config: { skills: { config: [{ name: 'preserve', enabled: false }, { path, enabled: true }] } } };
  }, close: async () => { closes++; } }) });
  assert.match(result.flags[1], /preserve/); assert.ok(result.flags[1].includes(JSON.stringify(disabled))); assert.match(result.flags[1], /"enabled"=false/);
  assert.equal(closes, 1);
  const { mergeSkillFlags } = await evaluateNative('../mods/herdr-zed-agents/devkits.js', {}, 'mergeSkillFlags');
  const argv = mergeSkillFlags(['claude', '--settings', '{"enabledPlugins":{"ecc":false},"skillOverrides":{"other":"off"}}', '--plugin-dir', '/ecc'], 'claude',
    ['--settings', '{"skillOverrides":{"review":"off"}}', '--plugin-dir', '/shared'], 0);
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings') + 1]), { enabledPlugins: { ecc: false }, skillOverrides: { other: 'off', review: 'off' } });
  assert.deepEqual(argv.slice(argv.indexOf('--plugin-dir')), ['--plugin-dir', '/shared', '/ecc']);
}));

test('native Codex inventory retains disabled entries and releases the service on errors', async () => fixture(async ({ root, project }) => {
  let closes = 0;
  const open = async () => ({ close: async () => { closes++; }, request: async () => ({ data: [{ skills: [{ name: 'off', description: 'Off', path: join(root, 'off/SKILL.md'), enabled: false, scope: 'user' }] }] }) });
  const items = await readCodexSkillInventory(root, project, { open });
  assert.equal(items[0].enabled, false); assert.equal(closes, 1);
  await assert.rejects(readCodexSkillInventory(root, project, { open: async () => ({ close: async () => { closes++; }, request: async () => { throw Error('failed'); } }) }), /failed/);
  assert.equal(closes, 2);
}));

test('Claude project exclusion removes the native package entry as well as the composer command', async () => fixture(async ({ root, home, user, project, put }) => {
  const source = join(user, '.claude/skills/review/SKILL.md');
  await put(source, document('review'));
  const before = await readNativeSkillPolicy(home, project);
  await saveNativeSkillPolicy(home, project, 'claude', [source], before.revision);
  const script = fileURLToPath(new URL('../mods/herdr-zed-agents/shared-skills-cli.js', import.meta.url));
  const call = async action => JSON.parse((await promisify(execFile)(process.execPath, [script, action, home, 'claude', project, '{}', join(root, 'account'), JSON.stringify({ userHome: user })])).stdout);
  assert.ok(!(await call('commands')).some(command => command.name === 'review'));
  const prepared = await call('prepare');
  assert.ok(!(prepared.nativeSkills || []).some(skill => skill.name === 'review'));
  assert.deepEqual(JSON.parse(prepared.flags[prepared.flags.indexOf('--settings') + 1]), { skillOverrides: { review: 'off' } });
  const inventory = await nativeSkillInventory(home, user, 'claude', join(root, 'account'), project);
  assert.equal(inventory.items.find(item => item.name === 'review').active, false);
}));

test('native global controls preserve unrelated settings and Claude plugin state changes all its skills', async () => fixture(async ({ root, user, put }) => {
  const personal = join(user, '.claude/skills');
  await put(join(personal, 'review/SKILL.md'), document('review'));
  await put(join(user, '.claude/settings.json'), JSON.stringify({ theme: 'keep', enabledPlugins: { 'other@market': true } }));
  await setNativeSkillEnabled(user, 'claude', join(root, 'account'), join(personal, 'review/SKILL.md'), false, true);
  assert.ok(!(await readClaudeSkills(user)).some(item => item.name === 'review'));
  assert.equal((await readClaudeSkills(user, { includeDisabled: true }))[0].enabled, false);
  await assert.rejects(setNativeSkillEnabled(user, 'claude', root, join(personal, 'review/SKILL.md'), true, true), /Refresh/);
  await put(join(personal, 'bundle/.claude-plugin/plugin.json'), JSON.stringify({ name: 'bundle', skills: './' }));
  for (const name of ['first', 'second']) await put(join(personal, `bundle/${name}/SKILL.md`), document(name));
  await setNativeSkillEnabled(user, 'claude', root, join(personal, 'bundle/first/SKILL.md'), false, true);
  const skills = await readClaudeSkills(user, { includeDisabled: true });
  assert.ok(skills.filter(item => item.plugin === 'bundle').every(item => !item.enabled));
  const config = JSON.parse(await readFile(join(user, '.claude/settings.json'), 'utf8'));
  assert.equal(config.theme, 'keep'); assert.equal(config.enabledPlugins['other@market'], true);
  let closed = false, edits;
  await setNativeSkillEnabled(user, 'codex', root, join(root, 'native/SKILL.md'), false, true, { open: async () => ({
    config: { skills: { config: [{ name: 'keep', enabled: false }] } },
    request: async () => ({ data: [{ skills: [{ path: join(root, 'native/SKILL.md'), enabled: true }] }] }),
    write: async value => { edits = value; }, close: async () => { closed = true; },
  }) });
  assert.equal(closed, true); assert.equal(edits[0].keyPath, 'skills.config');
  assert.deepEqual(edits[0].value[0], { name: 'keep', enabled: false });
}));

test('default Claude plugins cannot silently bypass a saved isolated-account exclusion', async () => fixture(async ({ home, user, project, put }) => {
  const source = join(user, '.claude/skills/bundle/review/SKILL.md');
  await put(source, document('review'));
  await put(join(user, '.claude/skills/bundle/.claude-plugin/plugin.json'), JSON.stringify({ name: 'bundle', skills: './' }));
  const policy = await readNativeSkillPolicy(home, project);
  await saveNativeSkillPolicy(home, project, 'claude', [source], policy.revision);
  await assert.rejects(nativeSkillFlags(home, project, 'claude', join(user, '.claude'), { userHome: user }), /isolated Claude account/);
  const inventory = await nativeSkillInventory(home, user, 'claude', join(user, '.claude'), project);
  assert.equal(inventory.items.find(item => item.name === 'review').canExclude, false);
}));
