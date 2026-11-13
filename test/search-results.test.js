import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { compileQuery } from '../mods/herdr-zed/find.js';
import { SEARCH_SCRIPT, grepArgs, globs, parseGrep, resultRows } from '../mods/herdr-zed/search-results.js';

const run = promisify(execFile);
const pattern = (query, options) => compileQuery(query, options).pattern;

test('parseGrep keeps real matches and their direct neighbours, filtered by find.js rules', () => {
  const out = ['a.js\x001\x00one', 'a.js\x002\x00Foo two', 'a.js\x003\x00three', '--', 'a.js\x009\x00foo nine\r', 'b.js\x004\x00FOO only'].join('\n');
  const smart = parseGrep(out, pattern('Foo'));
  assert.equal(smart.total, 1);
  assert.deepEqual(smart.files.map(file => file.path), ['a.js']);
  assert.deepEqual(smart.files[0].lines.map(line => [line.n, line.ranges]), [[1, []], [2, [[0, 3]]], [3, []]]);
  const loose = parseGrep(out, pattern('foo'));
  assert.equal(loose.total, 3);
  assert.equal(loose.files[0].lines.at(-1).text, 'foo nine');
});

test('resultRows adds a header per file and a gap between separate line groups', () => {
  const { files } = parseGrep(['a.js\x001\x00foo', 'a.js\x005\x00foo'].join('\n'), pattern('foo'));
  const { rows, sizes } = resultRows(files);
  assert.deepEqual(rows.map(row => row.kind), ['file', 'line', 'gap', 'line']);
  assert.equal(rows.length, sizes.length);
});

test('grepArgs narrows case-insensitively and passes the query as one argument', () => {
  assert.deepEqual(grepArgs('a; rm -rf /'), ['-i', '-F', '-e', 'a; rm -rf /', '--', '.']);
  assert.deepEqual(grepArgs('a.+b', { regex: true }, { include: 'src/', exclude: '*.min.js' }),
    ['-i', '-P', '-e', 'a.+b', '--', ':(glob)**/src/**', ':(glob,exclude)**/*.min.js']);
});

test('globs follow Zed: comma-separated, any depth without a slash, folders cover their contents', () => {
  assert.deepEqual(globs(' *.js, ./src/app/ ,docs'), ['**/*.js', 'src/app/**', '**/docs', '**/docs/**']);
  assert.deepEqual(globs(''), []);
});

test('the search script finds tracked and untracked files and skips ignored ones', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'herdr-zed search '));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await run('git', ['init', '-q', folder]);
  await writeFile(join(folder, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(folder, 'kept.txt'), 'alpha\nNeedle here\nomega\n');
  await writeFile(join(folder, 'ignored.txt'), 'needle\n');
  const { stdout } = await run('sh', ['-c', SEARCH_SCRIPT, 'test', folder, ...grepArgs('needle')]).catch(error => error);
  const result = parseGrep(stdout, pattern('needle'));
  assert.deepEqual(result.files.map(file => file.path), ['kept.txt']);
  assert.deepEqual(result.files[0].lines.map(line => line.n), [1, 2, 3]);
  await writeFile(join(folder, 'other.md'), 'needle\n');
  const search = async filters => parseGrep((await run('sh', ['-c', SEARCH_SCRIPT, 'test', folder, ...grepArgs('needle', {}, filters)]).catch(error => error)).stdout, pattern('needle'))
    .files.map(file => file.path).sort();
  assert.deepEqual(await search({}), ['kept.txt', 'other.md']);
  assert.deepEqual(await search({ include: '*.md' }), ['other.md']);
  assert.deepEqual(await search({ exclude: '*.md' }), ['kept.txt']);
});
