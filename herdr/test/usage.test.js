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

test('usage reads a saved env launcher through an npm-style shell shim on Windows', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), "devkits usage 中文 ' $(literal) "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shim = join(directory, 'codex'), server = join(directory, 'server.cjs');
  await writeFile(shim, '#!/bin/sh\nexec "$DEVKITS_FIXTURE_NODE" "$DEVKITS_FIXTURE_SERVER" "$@"\n', { mode: 0o755 });
  await writeFile(server, `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: m.id,
        result: { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 12 } } } }));
    });
  `);
  const windows = await readUsage(['env', `CODEX_HOME=${directory}`, `DEVKITS_FIXTURE_NODE=${process.execPath}`,
    `DEVKITS_FIXTURE_SERVER=${server}`, shim, '--no-daemon']);
  assert.equal(windows[0].usedPercent, 12);
});

test('Claude usage comes only from the status line recording in the account directory', async () => {
  const { claudeUsageWindows, readClaudeUsage, claudeConfigDir } = await import('../mods/devkits/usage-reader.js');
  const { record, statusText } = await import('../mods/devkits/claude-statusline.js');
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  assert.deepEqual(claudeUsageWindows({ five_hour: { used_percentage: 13.4, resets_at: 1793939999 },
    seven_day: { used_percentage: 120, resets_at: 0 }, spend_limit: { used_percentage: 5 } }), [
    { bucket: 'claude', name: '5-hour', slot: 'five_hour', minutes: 300, usedPercent: 13.4, resetsAt: 1793939999 },
    { bucket: 'claude', name: 'Weekly', slot: 'seven_day', minutes: 10080, usedPercent: 100, resetsAt: null }]);
  assert.equal(claudeConfigDir(['claude']), null);
  const directory = await mkdtemp(`${tmpdir()}/claude-usage-`);
  const run = ['env', `CLAUDE_CONFIG_DIR=${directory}`, 'claude'];
  // The built-in profile reads ~/.claude.
  await assert.rejects(readClaudeUsage(['claude'], directory), /No usage yet/);
  await assert.rejects(readClaudeUsage(run), /No usage yet/);
  // Before the first response Claude Code omits rate_limits; nothing is recorded.
  assert.equal(record(JSON.stringify({ model: {} }), directory, 1), '');
  assert.equal(record('not json', directory, 1), '');
  await assert.rejects(readClaudeUsage(run), /No usage yet/);
  const limits = { five_hour: { used_percentage: 13, resets_at: 1793939999 }, seven_day: { used_percentage: 32.4, resets_at: 1794311999 } };
  assert.equal(record(JSON.stringify({ rate_limits: limits }), directory, 5000), '5h 13% · Week 32%');
  assert.deepEqual(JSON.parse(await readFile(`${directory}/devkits-usage.json`, 'utf8')), { capturedAt: 5000, rate_limits: limits });
  assert.deepEqual(await readClaudeUsage(run), { fetchedAt: 5000, windows: claudeUsageWindows(limits) });
  assert.equal(record(JSON.stringify({}), directory, 9000), '');
  assert.equal((await readClaudeUsage(run)).fetchedAt, 5000);
  assert.equal(statusText({ seven_day: { used_percentage: 7 } }), 'Week 7%');
});

test('a chained status line receives the same input and its output replaces the usage text', async () => {
  const { chained } = await import('../mods/devkits/claude-statusline.js');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(`${tmpdir()}/claude-chain-`);
  const calls = [];
  const run = (command, options) => { calls.push([command, options.input, options.shell]); return { stdout: 'orca line  \n' }; };
  assert.equal(chained('{"a":1}', directory, run), null);
  await writeFile(`${directory}/devkits-statusline-chain.json`, JSON.stringify({ type: 'command', command: 'orca.cmd' }));
  assert.equal(chained('{"a":1}', directory, run), 'orca line');
  assert.deepEqual(calls, [['orca.cmd', '{"a":1}', true]]);
  assert.equal(chained('{}', directory, () => ({ stdout: null })), '');
  // Real process: the chained command reads stdin and its output is returned.
  const echo = `${JSON.stringify(process.execPath)} -e "process.stdin.pipe(process.stdout)"`;
  await writeFile(`${directory}/devkits-statusline-chain.json`, JSON.stringify({ type: 'command', command: echo }));
  assert.equal(chained('hello', directory), 'hello');
});
