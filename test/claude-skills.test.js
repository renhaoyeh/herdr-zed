import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeSkills, inheritClaudeSkills } from '../mods/herdr-zed-agents/claude-skills.js';
import { prepareSharedPlugin } from '../mods/herdr-zed-agents/shared-skills-runtime.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-claude-skills-'));
  const user = join(root, 'user'), home = join(root, 'herdr'), personal = join(user, '.claude', 'skills');
  const put = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  try { await fn({ root, user, home, personal, put }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const entry = (name, policy = '') => `---\nname: ${name}\ndescription: ${name} workflow\n${policy}---\nRead ../references/guide.md.`;

test('personal skills and skills-directory plugins inherit without account writes or plugin code', async () => fixture(async ({ root, user, home, personal, put }) => {
  await put(join(personal, 'review/SKILL.md'), entry('review', 'disable-model-invocation: true\n'));
  const original = join(personal, 'rl-devtools/agent-ic/SKILL.md');
  await put(original, entry('agent-ic'));
  await put(join(personal, 'rl-devtools/references/guide.md'), 'Sibling resource');
  await put(join(personal, 'rl-devtools/.claude-plugin/plugin.json'), JSON.stringify({ name: 'rl-devtools', skills: './', hooks: { mustNotLoad: true } }));
  await put(join(personal, 'rl-devtools/hooks/hooks.json'), 'Never copy hooks');
  await put(join(personal, 'private/SKILL.md'), entry('private', 'user-invocable: false\n'));
  assert.deepEqual((await readClaudeSkills(user)).map(item => item.name), ['private', 'review', 'agent-ic']);
  const guidance = await inheritClaudeSkills(home, null, user);
  assert.deepEqual(guidance.commands.map(item => item.name), ['review', 'agent-ic']);
  assert.equal(guidance.nativeSkills.length, 3);
  const flags = await prepareSharedPlugin(home, 'claude', join(root, 'isolated-account'), guidance.nativeSkills);
  assert.equal(flags[0], '--plugin-dir');
  const wrapper = await readFile(join(flags[1], 'skills/agent-ic/SKILL.md'), 'utf8');
  assert.ok(wrapper.includes(original.replaceAll('\\', '/')));
  assert.ok(wrapper.includes('original directory'));
  assert.match(await readFile(join(flags[1], 'skills/review/SKILL.md'), 'utf8'), /disable-model-invocation: true/);
  await assert.rejects(readFile(join(flags[1], 'hooks/hooks.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'isolated-account')), { code: 'ENOENT' });
  await put(original, entry('agent-ic', 'disable-model-invocation: true\n'));
  const updated = await inheritClaudeSkills(home, null, user);
  assert.notEqual(updated.nativeSkills.find(item => item.name === 'agent-ic').revision, guidance.nativeSkills.find(item => item.name === 'agent-ic').revision);
  await assert.rejects(readFile(join(user, '.claude/settings.json')), { code: 'ENOENT' });
}));

test('shared selections own duplicate names; absent personal source is harmless', async () => fixture(async ({ user, home, personal, put }) => {
  assert.deepEqual(await readClaudeSkills(user), []);
  assert.equal(await inheritClaudeSkills(home, null, user), null);
  await put(join(personal, 'review/SKILL.md'), entry('review'));
  const shared = { commands: [{ name: 'review', id: 'mine:review' }], nativeSkills: [] };
  const guidance = await inheritClaudeSkills(home, shared, user);
  assert.deepEqual(guidance.commands, shared.commands);
  assert.deepEqual(guidance.nativeSkills, []);
}));

test('plugin source paths cannot escape their installation', async () => fixture(async ({ user, personal, put }) => {
  await put(join(personal, 'bad/.claude-plugin/plugin.json'), JSON.stringify({ skills: '../../outside' }));
  await assert.rejects(readClaudeSkills(user), /escape/);
}));

test('disabled personal plugins stay disabled and unnamed personal skills use their directory', async () => fixture(async ({ user, personal, put }) => {
  await put(join(user, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'rl-devtools@skills-dir': false } }));
  await put(join(personal, 'rl-devtools/.claude-plugin/plugin.json'), JSON.stringify({ name: 'rl-devtools', skills: './' }));
  await put(join(personal, 'rl-devtools/agent-ic/SKILL.md'), entry('agent-ic'));
  await put(join(personal, 'review/SKILL.md'), '---\ndescription: Review changes\n---\nReview.');
  assert.deepEqual((await readClaudeSkills(user)).map(item => item.name), ['review']);
}));

test('composer inventory and launch load the same personal skill without changing the account', async () => fixture(async ({ root, user, home, personal, put }) => {
  await put(join(personal, 'review/SKILL.md'), entry('review'));
  const script = fileURLToPath(new URL('../mods/herdr-zed-agents/shared-skills-cli.js', import.meta.url));
  const account = join(root, 'isolated-account');
  const invoke = async action => JSON.parse((await promisify(execFile)(process.execPath,
    [script, action, home, 'claude', '', '{}', account, JSON.stringify({ userHome: user })])).stdout);
  const listed = await invoke('commands');
  const command = listed.find(item => item.name === 'review');
  assert.match(command.id, /^claude:/);
  assert.equal(command.path, undefined);
  const prepared = await invoke('prepare');
  assert.ok(prepared.commands.some(item => item.id === command.id && item.path));
  assert.equal(prepared.flags[0], '--plugin-dir');
  assert.match(await readFile(join(prepared.flags[1], 'skills/review/SKILL.md'), 'utf8'), /original skill/);
  await assert.rejects(readFile(join(account, 'settings.json')), { code: 'ENOENT' });
}));
