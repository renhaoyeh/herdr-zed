import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
async function load(host = {}) {
  const source = await readFile(new URL('../mods/herdr-zed/diff-ignore.js', import.meta.url), 'utf8');
  return new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { readBuildRules, readBuildFilters, withBuildRulesFile };')(...Object.values(host));
}

const assets = new URL('../mods/herdr-zed/assets/gitignore/', import.meta.url);
async function bundled(files) {
  const sources = await readFile(new URL('sources.json', assets), 'utf8');
  files.set('/home/mods/herdr-zed/assets/gitignore/sources.json', sources);
  for (const { file } of JSON.parse(sources).files) files.set(`/home/mods/herdr-zed/assets/gitignore/${file}`, await readFile(new URL(file, assets), 'utf8'));
  return files;
}
const host = files => ({ appHome: () => '/home', readTextFile: async path => files.get(path) ?? null,
  writeTextFile: async (path, text, expected) => {
    if ((files.get(path) ?? null) !== expected) throw new Error('Changed on disk');
    files.set(path, text);
  } });
const RULES = '/home/data/herdr-zed/diff-build-output.gitignore', FILTERS = '/home/data/herdr-zed/diff-build-filters.json';

test('bundled templates match their recorded provenance hashes', async () => {
  const { createHash } = await import('node:crypto');
  for (const { file, sha256 } of JSON.parse(await readFile(new URL('sources.json', assets), 'utf8')).files)
    assert.equal(createHash('sha256').update(await readFile(new URL(file, assets))).digest('hex'), sha256, file);
});

test('checked templates compose in bundled order with custom rules last, regenerating the file Git reads', async () => {
  const files = await bundled(new Map());
  const { readBuildRules } = await load(host(files));
  const first = await readBuildRules();
  const seeded = JSON.parse(files.get(FILTERS));
  assert.deepEqual(seeded.templates, ['VisualStudio.gitignore', 'Qt.gitignore', 'C++.gitignore', 'CMake.gitignore', 'Node.gitignore', 'Python.gitignore']);
  assert.match(seeded.custom, /^# Lock files\n(?:.*\n)*\*-lock\.json\n/, 'Lockfiles start as editable Custom rules');
  assert.ok(first.text.endsWith(seeded.custom));
  for (const name of ['VisualStudio.gitignore', 'Qt.gitignore']) assert.ok(first.text.includes(files.get(`/home/mods/herdr-zed/assets/gitignore/${name}`)));
  assert.equal(files.get(RULES), first.text);
  files.set(FILTERS, JSON.stringify({ templates: ['Node.gitignore', 'CMake.gitignore', 'Missing.gitignore'], custom: '!keep.log\n' }));
  const next = await readBuildRules();
  assert.ok(next.text.indexOf('# github/gitignore/CMake.gitignore') < next.text.indexOf('# github/gitignore/Node.gitignore'));
  assert.ok(!next.text.includes('VisualStudio.gitignore') && !next.text.includes('Missing'));
  assert.ok(next.text.endsWith('# Custom rules and exceptions\n!keep.log\n'));
  assert.equal(files.get(RULES), next.text);
});

test('another window winning the initial filters creation is preserved', async () => {
  const files = await bundled(new Map());
  const other = JSON.stringify({ templates: ['Python.gitignore'], custom: 'other window' });
  const { readBuildFilters } = await load({ ...host(files),
    writeTextFile: async path => { files.set(path, other); throw new Error('Changed on disk'); } });
  assert.deepEqual((await readBuildFilters()).filters, { templates: ['Python.gitignore'], custom: 'other window' });
});

test('remote rules preserve literal Unicode and shell punctuation and remove temporary files after success or failure', async () => {
  const execShell = async args => {
    try { return { code: 0, ...await run('git', ['-c', 'alias.herdr-zed-shell=!sh', 'herdr-zed-shell', ...args]) }; }
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

test('rules editor saves checked templates and custom rules with revision checks, publishing only successful saves', async () => {
  const source = await readFile(new URL('../mods/herdr-zed/diff-ignore-settings.js', import.meta.url), 'utf8');
  const tasks = [], closed = [], memory = {}, writes = []; let conflict = true;
  const editor = ({ value = '' }) => ({ set_value(text) { value = text; }, value: () => value, release() {} });
  const host = {
    EditorState: { new: editor },
    readBuildFilters: async () => ({ path: '/filters.json', original: 'original',
      templates: [{ file: 'A.gitignore', label: 'A', text: 'a' }, { file: 'B.gitignore', label: 'B', text: 'b' }],
      filters: { templates: ['B.gitignore'], custom: 'mine' } }),
    serializeBuildFilters: value => JSON.stringify(value),
    writeTextFile: async (path, text, expected) => { writes.push([path, JSON.parse(text), expected]); if (conflict) throw new Error('Changed on disk'); },
    shared: key => memory[key], setShared: (key, next) => { memory[key] = next; },
    props: () => ({ overlay: 'dialog' }), closeOverlay: id => closed.push(id),
  };
  const { BuildRulesSettings } = new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nreturn { BuildRulesSettings };')(...Object.values(host));
  const cx = { notify() {}, spawn(fn) { tasks.push(fn(cx)); } };
  const view = new BuildRulesSettings(); view.init(cx); await Promise.all(tasks.splice(0));
  assert.equal(view.page, 'B.gitignore'); assert.equal(view.preview.value(), 'b');
  view.checked.add('A.gitignore'); view.custom.set_value('mine\n!keep');
  view.save(cx); await Promise.all(tasks.splice(0));
  assert.match(view.error, /Changed on disk/); assert.deepEqual(closed, []); assert.deepEqual(memory, {});
  assert.deepEqual(writes[0], ['/filters.json', { templates: ['A.gitignore', 'B.gitignore'], custom: 'mine\n!keep' }, 'original']);
  conflict = false; view.save(cx); await Promise.all(tasks.splice(0));
  assert.deepEqual(closed, []); assert.equal(view.saved, true); assert.equal(memory['herdr-zed.diff-build-rules-revision'], 1);
});
