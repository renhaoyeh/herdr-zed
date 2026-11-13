import test from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery, findInText, textRuns, FindState } from '../mods/herdr-zed/find.js';

const find = (text, query, options) => findInText(text, compileQuery(query, options).pattern);

test('plain queries ignore case unless the query has an uppercase letter (smart case)', () => {
  assert.deepEqual(find('Foo foo FOO', 'foo'), [[0, 3], [4, 7], [8, 11]]);
  assert.deepEqual(find('Foo foo FOO', 'Foo'), [[0, 3]]);
  assert.deepEqual(find('Foo foo FOO', 'foo', { caseSensitive: true }), [[4, 7]]);
  assert.deepEqual(find('a.b axb', 'a.b'), [[0, 3]]);
  assert.deepEqual(find('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(find('abc', ''), []);
});

test('whole word bounds only the word-character ends of the query', () => {
  assert.deepEqual(find('foo foobar barfoo foo_x foo', 'foo', { wholeWord: true }), [[0, 3], [24, 27]]);
  assert.deepEqual(find('a.b(x) .b(', '.b(', { wholeWord: true }), [[1, 4], [7, 10]]);
  assert.deepEqual(find('變數 變數名', '變數', { wholeWord: true }), [[0, 2]]);
});

test('regex queries match patterns, skip empty matches and report syntax errors', () => {
  assert.deepEqual(find('let a1 = b22', '[a-z]\\d+', { regex: true }), [[4, 6], [9, 12]]);
  assert.deepEqual(find('abc', 'x*', { regex: true }), []);
  assert.deepEqual(find('id ID', 'id', { regex: true, wholeWord: true }), [[0, 2], [3, 5]]);
  const { pattern, error } = compileQuery('(', { regex: true });
  assert.equal(pattern, null);
  assert.ok(error);
});

test('textRuns splits at changed-range and match boundaries', () => {
  const runs = textRuns(10, [2, 6], [{ range: [4, 8], current: true }]);
  assert.deepEqual(runs.map(r => [r.start, r.end, r.mark, r.hit, r.current]), [
    [0, 2, false, false, false], [2, 4, true, false, false], [4, 6, true, true, true], [6, 8, false, true, true], [8, 10, false, false, false],
  ]);
});

test('FindState caches matches, reports regex errors and wraps the active match', () => {
  const state = new FindState();
  let query = 'x';
  state.input = { value: () => query };
  state.open = true;
  let calls = 0;
  const source = {}, collect = () => { calls++; return [1, 2, 3]; };
  assert.equal(state.matches(source, collect).length, 3);
  state.matches(source, collect);
  assert.equal(calls, 1);
  state.move(3, -1); assert.equal(state.index, 2);
  state.move(3, 1); assert.equal(state.index, 0);
  state.toggle('wholeWord'); state.matches(source, collect);
  assert.equal(calls, 2);
  query = '('; state.toggle('regex');
  assert.deepEqual(state.matches(source, collect), []);
  assert.ok(state.error);
  state.open = false;
  assert.deepEqual(state.matches(source, collect), []);
  assert.equal(state.error, null);
});
