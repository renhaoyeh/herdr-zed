import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function details() {
  const source = await readFile(new URL('../mods/herdr-zed-tasks/agent-board-details.js', import.meta.url), 'utf8');
  return new Function(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nreturn { readTaskOutput, outputMarkdown };')();
}

test('details read actual attached agents once each and never send terminal input', async () => {
  const { readTaskOutput } = await details(), calls = [];
  const a = { address: 't1', program: { name: 'Codex' } };
  const text = await readTaskOutput({ agents: [a, a, { address: 't2', program: { name: 'Claude' } }] }, async argv => {
    calls.push(argv); return { code: 0, stdout: JSON.stringify({ text: `\x1b[32mResult from ${argv[1]}\x1b[0m` }) };
  });
  assert.deepEqual(calls, [['read', 't1', '--lines', '80', '--json'], ['read', 't2', '--lines', '80', '--json']]);
  assert.match(text, /Codex · t1\n\nResult from t1/);
  assert.match(text, /Claude · t2\n\nResult from t2/);
  assert.equal(await readTaskOutput({ agents: [] }, () => assert.fail('no attached agent')), '');
  await assert.rejects(readTaskOutput({ agents: [a] }, async () => ({ code: 1, stderr: 'Disconnected' })), /Disconnected/);
});
test('output is bounded and Markdown fences in agent output stay literal', async () => {
  const { readTaskOutput, outputMarkdown } = await details();
  const text = await readTaskOutput({ agents: [{ address: 't1' }] }, async () => ({ code: 0, stdout: JSON.stringify({ text: 'x'.repeat(14000) }) }));
  assert.equal(text.length, 12000);
  assert.equal(outputMarkdown('```js\nlet x;\n```'), '````text\n```js\nlet x;\n```\n````');
});
