import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
async function load(host = {}) {
  const source = await readFile(new URL('../mods/devkits/diff-ignore.js', import.meta.url), 'utf8');
  return new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { readBuildRules, withBuildRulesFile };')(...Object.values(host));
}

test('downloaded templates seed once, and saved edits or an intentionally empty rules file remain authoritative', async () => {
  const files = new Map(), writes = [];
  const names = ['VisualStudio.gitignore', 'Qt.gitignore'];
  const templates = await Promise.all(names.map(name => readFile(new URL(`../mods/devkits/assets/gitignore/${name}`, import.meta.url), 'utf8')));
  names.forEach((name, i) => files.set(`/home/mods/devkits/assets/gitignore/${name}`, templates[i]));
  const { readBuildRules } = await load({ appHome: () => '/home', readTextFile: async path => files.get(path) ?? null,
    writeTextFile: async (path, text, expected) => { assert.equal(files.get(path) ?? null, expected); files.set(path, text); writes.push(path); } });
  const first = await readBuildRules();
  templates.forEach(text => assert.ok(first.text.includes(text), 'Keep the downloaded template intact'));
  files.set(first.path, '*.custom\n!important.custom\n');
  assert.equal((await readBuildRules()).text, '*.custom\n!important.custom\n');
  files.set(first.path, ''); assert.equal((await readBuildRules()).text, '');
  assert.equal(writes.length, 1);
});

test('another window winning the initial rules creation is preserved', async () => {
  let calls = 0;
  const { readBuildRules } = await load({ appHome: () => '/home',
    readTextFile: async path => path.endsWith('diff-build-output.gitignore') ? ++calls === 1 ? null : 'other window' : '# template',
    writeTextFile: async () => { throw new Error('Changed on disk'); } });
  assert.equal((await readBuildRules()).text, 'other window');
});

test('remote rules preserve literal Unicode and shell punctuation and remove temporary files after success or failure', async () => {
  const execShell = async args => {
    try { return { code: 0, ...await run('git', ['-c', 'alias.devkits-shell=!sh', 'devkits-shell', ...args]) }; }
    catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const { withBuildRulesFile } = await load({ execShell });
  const text = '# 中文 $(literal) `literal` \'quoted\'\n*.obj\n!keep.obj\n' + '# padding\n'.repeat(900);
  for (const fail of [false, true]) {
    let temporary;
    const call = withBuildRulesFile({ path: '/local/rules', text }, 'remote', async path => {
      temporary = path;
      const read = await execShell(['-c', 'cat -- "$1"', 'read-rules', path]);
      assert.equal(read.stdout, text);
      if (fail) throw new Error('Read failed');
      return 'matched';
    });
    if (fail) await assert.rejects(call, /Read failed/);
    else assert.equal(await call, 'matched');
    assert.equal((await execShell(['-c', 'test ! -e "$1"', 'check-removed', temporary])).code, 0);
  }
});

test('rules editor compares revisions, retains failed drafts and publishes only successful saves', async () => {
  const source = await readFile(new URL('../mods/devkits/diff-ignore-settings.js', import.meta.url), 'utf8');
  const tasks = [], closed = [], memory = {}; let value = '', conflict = true;
  const host = {
    EditorState: { new: () => ({ set_value: text => { value = text; }, value: () => value, release() {} }) },
    readBuildRules: async () => ({ text: 'original rules' }), buildRulesPath: () => '/rules',
    writeTextFile: async (path, text, expected) => { assert.deepEqual([path, text, expected], ['/rules', 'new rules', 'original rules']); if (conflict) throw new Error('Changed on disk'); },
    shared: key => memory[key], setShared: (key, next) => { memory[key] = next; },
    props: () => ({ overlay: 'dialog' }), closeOverlay: id => closed.push(id),
  };
  const { BuildRulesSettings } = new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { BuildRulesSettings };')(...Object.values(host));
  const cx = { notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  const view = new BuildRulesSettings(); view.init(cx); await Promise.all(tasks.splice(0));
  value = 'new rules'; view.save(cx); await Promise.all(tasks.splice(0));
  assert.match(view.error, /Changed on disk/); assert.equal(value, 'new rules'); assert.deepEqual(closed, []);
  assert.deepEqual(memory, {});
  conflict = false; view.save(cx); await Promise.all(tasks.splice(0));
  assert.deepEqual(closed, ['dialog']); assert.equal(memory['devkits.diff-build-rules-revision'], 1);
});
