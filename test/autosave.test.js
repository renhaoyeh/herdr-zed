import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autosave } from '../components/autosave.js';

test('autosave writes once the form has been still for the delay, never on load, and keeps a failed edit for retry', async () => {
  let value = 'a', fail = false;
  const writes = [], cx = { notify() {} };
  const auto = new Autosave({ snapshot: () => value, valid: () => value !== '', delay: 500,
    save: async () => { writes.push(value); if (fail) throw new Error('locked'); } });
  auto.tick(cx, 0);
  assert.deepEqual(writes, [], 'nothing before the form is loaded');
  auto.reset();
  auto.tick(cx, 1000); assert.deepEqual(writes, [], 'loading is not written back');
  value = 'ab'; auto.tick(cx, 1000); auto.tick(cx, 1300);
  assert.deepEqual(writes, [], 'still typing');
  value = 'abc'; auto.tick(cx, 1400); auto.tick(cx, 1800);
  assert.deepEqual(writes, [], 'the delay restarts on each edit');
  await auto.tick(cx, 1900);
  assert.deepEqual(writes, ['abc']); assert.equal(auto.status(), 'Saved'); assert.equal(auto.dirty(), false);
  value = ''; auto.tick(cx, 3000); auto.tick(cx, 4000);
  assert.deepEqual(writes, ['abc'], 'an invalid form is not written');
  value = 'x'; fail = true; await auto.flush(cx);
  assert.equal(auto.status(), 'locked'); assert.equal(auto.dirty(), true, 'a failed edit stays to retry');
  auto.tick(cx, 9000); auto.tick(cx, 9999);
  assert.deepEqual(writes, ['abc', 'x'], 'a failed value is not retried on every tick');
  fail = false; await auto.flush(cx);
  assert.deepEqual(writes, ['abc', 'x', 'x']); assert.equal(auto.dirty(), false);
});
