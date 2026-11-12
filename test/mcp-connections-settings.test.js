import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { parseSharedMcp, sharedMcpSupported } from '../components/shared-mcp-model.js';

async function fixture() {
  const state = (text = '') => ({ value: () => text, set_value(value) { text = value; } });
  const { mcpSetupSettings: api } = await evaluateNative('../mods/herdr-zed-agents/mcp-setup-settings.js', {
    InputState: { new: () => state() }, parseSharedMcp, sharedMcpSupported, devkitsMcpPresets: [],
  }, 'mcpSetupSettings');
  const jobs = [], cx = { notify() {}, spawn(fn) { jobs.push(fn(cx)); } };
  const view = { ...api, mcpConfig: { version: 1, servers: {} }, capPlatform: 'macos', capVerified: {},
    probeMcp: async () => ({ toolsCount: 1, verifiedAt: 1 }) };
  return { view, jobs, cx };
}

test('existing connections remain configurable and verification stages a draft', async () => {
  const { view, jobs, cx } = await fixture();
  view.mcpConfig.servers.existing = { command: 'keep' };
  view.openMcpSetup('existing', cx);
  view.capSetup.command.set_value('updated');
  view.testMcpSetup(cx); await Promise.all(jobs);
  assert.equal(view.capSetup, null);
  assert.equal(view.mcpDirty, true);
  assert.equal(view.mcpConfig.servers.existing.command, 'updated');
});

test('setup cannot create an arbitrary new connection', async () => {
  const { view, cx } = await fixture();
  for (const name of [null, '', 'new-server']) {
    view.openMcpSetup(name, cx);
    assert.equal(view.capSetup, undefined);
  }
  assert.deepEqual(view.mcpConfig.servers, {});
});
