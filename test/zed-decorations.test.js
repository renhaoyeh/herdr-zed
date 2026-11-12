import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadDecorations, decorationKey, decorationTone } from '../mods/herdr-zed/decorations.js';

const read = envelopes => key => envelopes[key];

test('decorations read only the fields each decorator declared, per thread tab', () => {
  const envelopes = {
    [decorationKey('agents')]: { updatedAt: 1, threads: { 'tab-1': { badge: 'work', subtitle: 'Claude · sonnet', tone: 'warning' } } },
    [decorationKey('tasks')]: { updatedAt: 1, threads: { 'tab-1': { badge: 'TASK-7', subtitle: 'Ship it', tone: 'error' }, 'tab-2': { subtitle: 'Only' } } },
  };
  const decorators = [{ id: 'agents', fields: ['badge', 'tone'] }, { id: 'tasks', fields: ['badge', 'subtitle'] }];
  const result = threadDecorations(decorators, read(envelopes));
  // Agents declared badge and tone, so its subtitle never appears; Tasks' tone is not declared, so it is ignored.
  assert.deepEqual(result.get('tab-1'), { badge: 'work', tone: 'warning', subtitle: 'Ship it' });
  assert.deepEqual(result.get('tab-2'), { subtitle: 'Only' });
});

test('the first enabled decorator in catalog order wins a field; later decorators fill only what is missing', () => {
  const envelopes = {
    [decorationKey('first')]: { updatedAt: 1, threads: { 'tab-1': { badge: 'A' } } },
    [decorationKey('second')]: { updatedAt: 1, threads: { 'tab-1': { badge: 'B', subtitle: 'S' } } },
  };
  const result = threadDecorations([{ id: 'first', fields: ['badge'] }, { id: 'second', fields: ['badge', 'subtitle'] }], read(envelopes));
  assert.deepEqual(result.get('tab-1'), { badge: 'A', subtitle: 'S' });
});

test('invalid entries, oversize text and undeclared envelopes are dropped without affecting other threads', () => {
  const envelopes = {
    [decorationKey('agents')]: { updatedAt: 1, threads: {
      'tab-bad': { badge: 'x'.repeat(41) },
      'tab-tone': { tone: 'purple' },
      'tab-extra': { badge: 'ok', token: 'secret' },
      'tab-good': { badge: 'fine' },
    } },
  };
  const result = threadDecorations([{ id: 'agents', fields: ['badge', 'subtitle', 'tone'] }], read(envelopes));
  assert.deepEqual([...result.keys()], ['tab-good']);
  assert.equal(JSON.stringify([...result.values()]).includes('secret'), false);
  // A decorator with no stored envelope contributes nothing; a malformed envelope is ignored.
  assert.equal(threadDecorations([{ id: 'missing', fields: ['badge'] }], read({})).size, 0);
  assert.equal(threadDecorations([{ id: 'agents', fields: ['badge'] }], read({ [decorationKey('agents')]: 'junk' })).size, 0);
});

test('disabled or unavailable decorators are simply absent from the list the shell passes in', () => {
  const envelopes = { [decorationKey('agents')]: { updatedAt: 1, threads: { 'tab-1': { badge: 'work' } } } };
  assert.equal(threadDecorations([], read(envelopes)).size, 0);
});

test('tones map to the shell status tokens and default to muted', () => {
  const t = { muted: 'm', accent: 'a', blocked: 'w', ansi1: 'e' };
  assert.equal(decorationTone(t, 'accent'), 'a');
  assert.equal(decorationTone(t, 'warning'), 'w');
  assert.equal(decorationTone(t, 'error'), 'e');
  assert.equal(decorationTone(t, 'muted'), 'm');
  assert.equal(decorationTone(t, undefined), 'm');
});
