import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseExtensionManifest } from '../mods/herdr-zed/extension-model.js';
import { evaluateNative } from './source-harness.js';

test('task sources leave status actions to the Tasks workspace', async () => {
  for (const mod of ['herdr-zed-asana', 'herdr-zed-mantisbt']) {
    const text = await readFile(new URL(`../mods/${mod}/extension.json`, import.meta.url), 'utf8');
    assert.deepEqual(parseExtensionManifest(mod, text), []);
    assert.equal(JSON.parse(text).settings.view, 'settings');
  }
});

test('the MantisBT icon resolves to its color artwork while ordinary glyphs stay SVGs', async () => {
  const renders = [];
  const render = kind => path => {
    const node = { size(value) { renders.push([kind, path, value]); return node; }, flex_none() { return node; } };
    return node;
  };
  const { glyph } = await evaluateNative('../components/icon.js', { image: render('image'), svg: render('svg') }, 'glyph');
  glyph('mantisbt', 16); glyph('list-todo', 16);
  assert.deepEqual(renders, [
    ['image', 'mods/herdr-zed/assets/icons/mantisbt.png', 16],
    ['svg', 'mods/herdr-zed/assets/icons/list-todo.svg', 16],
  ]);
  const data = await readFile(new URL('../assets/icons/mantisbt.png', import.meta.url));
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

