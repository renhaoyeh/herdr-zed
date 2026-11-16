import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSharedSkills, importSharedSkillSelection, readSharedLibrary, prepareSharedGuidance, importSharedSkill, removeSharedSkill } from '../mods/herdr-zed-agents/shared-skills.js';
import { mineSelectionPath, parseMineSelection, mineEnabled } from '../mods/herdr-zed-agents/devkits-model.js';
import { evaluateNative } from './source-harness.js';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-skill-root-')), home = join(root, 'home'), source = join(root, 'runtime');
  const put = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  const skill = async (name, base = join(source, 'skills')) => {
    const folder = join(base, name);
    await put(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Use ${name}\n---\nRead ../references/host-entry.md and resolve ../../bin/tool.exe from here.`);
    return folder;
  };
  try { await fn({ root, home, source, put, skill }); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('runtime root discovers public skills, skips runtime guides and imports only selected entries', async () => fixture(async ({ home, source, skill, put }) => {
  const ic = await skill('agent-ic'); await skill('agent-cc'); await skill('apply-notes');
  await skill('core', join(source, 'guides'));
  await put(join(source, 'skills/references/host-entry.md'), 'Shared guide');
  await put(join(source, 'bin/tool.exe'), 'native runtime');
  const scan = await discoverSharedSkills(home, source);
  assert.deepEqual(scan.items.map(item => item.slug), ['agent-cc', 'agent-ic', 'apply-notes']);
  const chosen = scan.items.filter(item => item.source === ic);
  const result = await importSharedSkillSelection(home, source, chosen, { mode: 'source', providers: ['codex', 'claude'] });
  assert.equal(result.imported.length, 1); assert.deepEqual(result.failed, []);
  const library = await readSharedLibrary(home);
  assert.equal(library.length, 1); assert.equal(library[0].origin.mode, 'source');
  for (const provider of ['codex', 'claude']) {
    const launch = await prepareSharedGuidance(home, provider);
    assert.deepEqual(launch.commands.map(item => item.name), ['agent-ic']);
    const wrapper = await readFile(launch.commands[0].path, 'utf8');
    assert.ok(wrapper.includes(join(ic, 'SKILL.md').replaceAll('\\', '/')));
    assert.match(wrapper, /original skill directory/);
  }
  assert.equal(await readFile(join(source, 'skills/references/host-entry.md'), 'utf8'), 'Shared guide');
  const installed = (await readSharedLibrary(home))[0];
  await importSharedSkill(home, ic, installed.revision, installed.origin.mode);
  assert.equal((await readSharedLibrary(home))[0].origin.mode, 'source');
}));

test('single skill and repository roots scan without following links or dependencies', async () => fixture(async ({ home, source, skill, put }) => {
  const entry = await skill('standalone', source);
  await skill('ignored', join(source, 'node_modules'));
  await put(join(source, '.git/objects/noise'), 'not a skill');
  await symlink(entry, join(source, 'linked'), 'junction');
  assert.deepEqual((await discoverSharedSkills(home, source)).items.map(item => item.name), ['standalone']);
  assert.equal((await discoverSharedSkills(home, entry)).items.length, 1);
  await assert.rejects(discoverSharedSkills(home, 'relative'), /absolute/);
  await assert.rejects(discoverSharedSkills(home, join(source, 'linked')), /real directory/);
}));

test('conflicts, stale updates and partial failures preserve existing imports', async () => fixture(async ({ root, home, source, skill }) => {
  const first = await skill('same');
  let scan = await discoverSharedSkills(home, source);
  await importSharedSkillSelection(home, source, scan.items);
  const otherRoot = join(root, 'other'); await skill('same', otherRoot);
  assert.equal((await discoverSharedSkills(home, otherRoot)).items[0].conflict, true);
  await assert.rejects(importSharedSkillSelection(home, otherRoot, [{ source: join(otherRoot, 'same') }]), /conflicting/);
  await skill('new-skill'); scan = await discoverSharedSkills(home, source);
  const installed = (await readSharedLibrary(home))[0];
  await importSharedSkill(home, first, installed.revision, 'source');
  // A separately edited library revision must not be silently overwritten.
  await writeFile(join(dirname(installed.path), 'local.txt'), 'concurrent edit');
  const result = await importSharedSkillSelection(home, source, scan.items);
  assert.equal(result.imported.length, 1); assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].message, /changed/);
  assert.equal((await readSharedLibrary(home)).length, 2);
  await assert.rejects(importSharedSkillSelection(home, source, []), /Select/);
  await assert.rejects(importSharedSkillSelection(home, source, [{ source: root }]), /Invalid/);
}));

test('new imports explicitly choose providers or remain disabled, without changing other selections', async () => fixture(async ({ home, source, skill }) => {
  await skill('one'); await skill('two');
  const scan = await discoverSharedSkills(home, source);
  await importSharedSkillSelection(home, source, [scan.items[0]], { mode: 'copy', providers: ['codex'] });
  await importSharedSkillSelection(home, source, [scan.items[1]]);
  const settings = parseMineSelection(await readFile(mineSelectionPath(home), 'utf8'));
  assert.equal(mineEnabled(settings, 'mine:skills:one', 'codex'), true);
  assert.equal(mineEnabled(settings, 'mine:skills:one', 'claude'), false);
  for (const provider of ['codex', 'claude']) assert.equal(mineEnabled(settings, 'mine:skills:two', provider), false);
  const one = (await readSharedLibrary(home)).find(item => item.id === 'mine:skills:one');
  assert.equal(one.origin.mode, undefined);
  assert.match(await readFile(one.path, 'utf8'), /Read ..\/references/);
}));

test('batch updates preserve copy or source mode and existing provider choices', async () => fixture(async ({ home, source, skill, put }) => {
  const copied = await skill('copied'), linked = await skill('linked');
  await importSharedSkill(home, copied);
  let scan = await discoverSharedSkills(home, source);
  await importSharedSkillSelection(home, source, scan.items.filter(item => !item.revision), { providers: ['claude'] });
  const previous = await readFile(mineSelectionPath(home), 'utf8');
  await put(join(copied, 'note.txt'), 'new support file');
  await put(join(linked, 'note.txt'), 'reference file');
  scan = await discoverSharedSkills(home, source);
  assert.deepEqual(scan.items.map(item => item.mode), ['copy', 'source']);
  await importSharedSkillSelection(home, source, scan.items, { mode: 'copy', providers: ['codex'] });
  const library = await readSharedLibrary(home);
  assert.equal(library[0].origin.mode, undefined); assert.equal(library[1].origin.mode, 'source');
  assert.equal(await readFile(join(dirname(library[0].path), 'note.txt'), 'utf8'), 'new support file');
  await assert.rejects(readFile(join(dirname(library[1].path), 'note.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(mineSelectionPath(home), 'utf8'), previous);
}));

test('failed new imports roll back choices and retain successful entries for retry', async () => fixture(async ({ home, source, skill, put }) => {
  const bad = await skill('bad'); await skill('good');
  await put(join(bad, 'herdr.json'), '{ invalid');
  const scan = await discoverSharedSkills(home, source);
  const result = await importSharedSkillSelection(home, source, scan.items, { providers: ['codex'] });
  assert.equal(result.imported.length, 1); assert.equal(result.failed.length, 1);
  const settings = parseMineSelection(await readFile(mineSelectionPath(home), 'utf8'));
  assert.equal(settings.providers.codex['mine:skills:bad'], undefined);
  assert.equal(settings.providers.codex['mine:skills:good'], true);
}));

test('removal checks revision and scope, preserves source, snapshots and unrelated choices', async () => fixture(async ({ home, source, skill }) => {
  const original = await skill('remove-me'); await skill('keep-me');
  await importSharedSkillSelection(home, source, (await discoverSharedSkills(home, source)).items, { providers: ['codex'] });
  const library = await readSharedLibrary(home), item = library.find(item => item.id === 'mine:skills:remove-me');
  const snapshot = (await prepareSharedGuidance(home, 'codex')).commands.find(command => command.id === item.id).path;
  await assert.rejects(removeSharedSkill(home, item.id, 'stale'), /changed/);
  await assert.rejects(removeSharedSkill(home, 'mine:skills:../escape', item.revision), /Choose/);
  assert.deepEqual(await removeSharedSkill(home, item.id, item.revision), { removed: item.id });
  assert.deepEqual((await readSharedLibrary(home)).map(item => item.id), ['mine:skills:keep-me']);
  assert.match(await readFile(join(original, 'SKILL.md'), 'utf8'), /remove-me/);
  assert.match(await readFile(snapshot, 'utf8'), /Installed source skill/);
  const settings = parseMineSelection(await readFile(mineSelectionPath(home), 'utf8'));
  assert.equal(settings.providers.codex[item.id], undefined);
  assert.equal(settings.providers.codex['mine:skills:keep-me'], true);
  // The original source is still discoverable and may be reimported without stale selections.
  await importSharedSkillSelection(home, source, (await discoverSharedSkills(home, source)).items.filter(item => !item.revision));
  const next = parseMineSelection(await readFile(mineSelectionPath(home), 'utf8'));
  assert.equal(mineEnabled(next, item.id, 'codex'), false);
}));

test('UI removal preserves shared drafts and reloads only after confirmed success', async () => {
  const calls = [], pending = [];
  const { devkitsSettings } = await evaluateNative('../mods/herdr-zed-agents/devkits-settings.js', {
    appHome: () => '/home', exec: async (_cmd, args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ removed: args[3] }) }; },
  }, 'devkitsSettings');
  const view = { ...devkitsSettings, loadDevkits() { this.loaded = true; } }, item = { id: 'mine:skills:one', revision: 'rev' };
  const cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
  view.capDirty = true; view.removeSharedSkill(cx, item); assert.equal(calls.length, 0);
  view.capDirty = false; view.removeSharedSkill(cx, item); await pending.shift();
  assert.deepEqual(calls[0].slice(1), ['remove', '/home', item.id, 'rev']);
  assert.equal(view.loaded, true); assert.equal(view.capItem, null);
});
