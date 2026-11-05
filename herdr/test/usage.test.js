import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageWindows, readUsage } from '../mods/devkits/usage-reader.js';
import { quotaResetLabel } from '../mods/devkits/model.js';

test('resets count down in days/hours or hours/minutes; overdue and absent times stay explicit', () => {
  const now = Date.UTC(2026, 10, 6, 8);
  const short = { minutes: 300, resetsAt: now / 1000 + 83 * 60 };
  assert.equal(quotaResetLabel(short, now), 'Resets in 1h 23m');
  assert.equal(quotaResetLabel(short, now + 60 * 60000), 'Resets in 23m');
  assert.equal(quotaResetLabel(short, now + 82.5 * 60000), 'Resets in 1m');
  assert.equal(quotaResetLabel(short, now + 83 * 60000), 'Reset due · awaiting refresh');
  assert.equal(quotaResetLabel(short, now + 84 * 60000), 'Reset due · awaiting refresh');
  const weekly = { minutes: 10080, resetsAt: now / 1000 + (6 * 24 + 21) * 3600 };
  assert.equal(quotaResetLabel(weekly, now), 'Resets in 6d 21h');
  assert.equal(quotaResetLabel({ ...weekly, resetsAt: now / 1000 + 86400 }, now), 'Resets in 1d 0h');
  assert.equal(quotaResetLabel({ ...weekly, resetsAt: now / 1000 + 86340 }, now), 'Resets in 23h 59m');
  assert.equal(quotaResetLabel({ ...short, minutes: 10080 }, now), 'Resets in 1h 23m');
  for (const resetsAt of [undefined, null, 0, NaN, Infinity, '123']) {
    assert.equal(quotaResetLabel({ minutes: 300, resetsAt }, now), 'Reset time unavailable');
  }
});

test('usage preserves all actual windows, buckets, resets, and unknown durations', () => {
  assert.deepEqual(usageWindows(), []);
  assert.deepEqual(usageWindows({ rateLimitsByLimitId: {}, rateLimits: {
    primary: { windowDurationMins: 300, usedPercent: 0 },
  } }), [{ bucket: 'codex', name: 'codex', slot: 'primary', minutes: 300, usedPercent: 0, resetsAt: null }]);
  const windows = usageWindows({ rateLimitsByLimitId: {
    codex: { primary: { windowDurationMins: 10080, usedPercent: 91 },
      secondary: { windowDurationMins: 300, usedPercent: 123, resetsAt: 1234 } },
    spark: { limitName: 'Spark', primary: { usedPercent: -10 }, secondary: { usedPercent: null } },
  } });
  assert.deepEqual(windows.map(w => [w.bucket, w.minutes, w.usedPercent, w.resetsAt]),
    [['codex', 10080, 91, null], ['codex', 300, 100, 1234], ['spark', null, 0, null]]);
  assert.equal(windows[2].name, 'Spark');
});

test('usage reader performs handshake, ignores notifications, and closes its subprocess', async () => {
  const server = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    let initialized = false;
    rl.on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') {
        console.log('ignored non-JSON output');
        console.log(JSON.stringify({ id: 1, result: {} }));
      } else if (m.method === 'initialized') initialized = true;
      else if (m.method === 'account/rateLimits/read' && initialized) {
        console.log(JSON.stringify({ method: 'account/updated', params: {} }));
        console.log(JSON.stringify({ id: 2, result: { rateLimits: {
          primary: { windowDurationMins: 300, usedPercent: 42, resetsAt: 1234 }
        } } }));
      }
    });
  `;
  assert.deepEqual(await readUsage([process.execPath, '-e', server, '--']), [{ bucket: 'codex', name: 'codex', slot: 'primary', minutes: 300, usedPercent: 42, resetsAt: 1234 }]);
});

test('usage reader handles missing binary, protocol errors, and timeout', async () => {
  await assert.rejects(readUsage(['devkits-missing-codex']), /Cannot start Codex/);
  await assert.rejects(readUsage([process.execPath, '-e', `
    process.stdin.on('data', () => console.log(JSON.stringify({ id: 1, error: {} })));
  `, '--']), /initialization failed/);
  await assert.rejects(readUsage([process.execPath, '-e', 'process.stdin.resume()', '--'], 30), /timed out/);
});
