import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseExtensionManifest } from '../mods/devkits-zed/extension-model.js';

const manifestText = await readFile(new URL('../mods/devkits-mantisbt/extension.json', import.meta.url), 'utf8');

test('MantisBT is an optional status popup at Tasks source dimensions', () => {
  const [action] = parseExtensionManifest('devkits-mantisbt', manifestText);
  assert.equal(action.id, 'mantisbt.open');
  assert.equal(action.location, 'status.right');
  assert.deepEqual(action.popup, { view: 'browser', width: 0.9, height: 0.86, modal: false });
});

