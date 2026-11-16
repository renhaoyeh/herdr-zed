import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodexSkills } from '../mods/herdr-zed-agents/codex-skills.js';

const account = join(tmpdir(), 'codex-native-account'), project = join(tmpdir(), 'codex-project');
const skill = (name, extra = {}) => ({ name, description: `${name} skill`, path: join(account, 'skills', name, 'SKILL.md'), enabled: true, scope: 'system', ...extra });
function fixture(skills) {
  const calls = []; let closed = 0;
  const service = { close: async () => { closed++; }, request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'skills/list') return { data: [{ cwd: project, skills, errors: [] }] };
    throw Error(`Unexpected call: ${method}`);
  } };
  return { calls, open: async directory => { assert.equal(directory, account); return service; }, get closed() { return closed; } };
}

test('installed Codex skills become New Thread commands for the project', async () => {
  const f = fixture([skill('review'), skill('off', { enabled: false }), skill('plugin', { path: null, pluginId: 'p@x' }),
    skill('bad name'), skill('review', { path: join(account, 'other', 'SKILL.md') }), skill('alpha')]);
  const items = await readCodexSkills(account, project, f);
  assert.deepEqual(items.map(item => item.name), ['alpha', 'review']);
  assert.match(items[0].id, /^codex:[a-f0-9]{16}$/);
  assert.equal(items[1].path, join(account, 'skills', 'review', 'SKILL.md'));
  assert.deepEqual(f.calls, [{ method: 'skills/list', params: { cwds: [project], forceReload: true } }]);
  assert.equal(f.closed, 1);
});

test('plugin skills named plugin:skill use the skill part, and plugin-skill when that clashes', async () => {
  const f = fixture([skill('pdf:pdf'), skill('pdf'), skill('sheets:Excel_Live')]);
  const items = await readCodexSkills(account, project, f);
  assert.deepEqual(items.map(item => item.name), ['Excel_Live', 'pdf', 'pdf-pdf']);
});

test('without a project folder the account directory is used; relative accounts are rejected', async () => {
  const f = fixture([]);
  assert.deepEqual(await readCodexSkills(account, '', f), []);
  assert.deepEqual(f.calls[0].params.cwds, [account]);
  await assert.rejects(readCodexSkills('relative'), /absolute/);
});
