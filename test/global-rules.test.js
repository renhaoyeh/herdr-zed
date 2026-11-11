import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../mods/herdr-zed-agents/global-rules-model.js';
import { rulesArgv } from '../components/session-model.js';
import { evaluateNative } from './source-harness.js';

test('Global Rules contains only custom instructions and preserves their headings', () => {
  assert.deepEqual(model.ruleSelection(), { custom: true });
  assert.equal(model.defaultRules, '');
  const guide = model.splitRuleGuide('# Global rules\n\n## Custom rules\n\nMy instructions\n\n## Deployment\nKeep this.');
  const text = model.composeRuleGuide(guide, model.ruleSelection());
  assert.match(text, /My instructions/); assert.match(text, /## Deployment/);
  assert.equal(model.composeRuleGuide(guide, { custom: false }), '');
});

test('both providers receive custom global text without built-in instructions', async () => {
  const { sessionRules } = await evaluateNative('../mods/herdr-zed-agents/global-rules.js', {
    ...model, rulesPath: () => '/guide/AGENTS.md', readTextFile: async () => 'My custom policy.', shared: () => undefined,
  }, 'sessionRules');
  const rules = await sessionRules();
  for (const kind of ['claude', 'codex']) {
    const argv = rulesArgv({ key: kind }, [kind], rules, 'Review carefully.').join(' ');
    assert.match(argv, /My custom policy/); assert.match(argv, /Review carefully/);
    assert.doesNotMatch(argv, /hc --skill|report_task|MCP installation/);
  }
});

test('all disabled rules and intentionally empty Guides inject no global instructions', async () => {
  for (const source of [model.defaultRules, '', null]) {
    const { sessionRules } = await evaluateNative('../mods/herdr-zed-agents/global-rules.js', {
      ...model, rulesPath: () => '/guide', readTextFile: async () => source,
      shared: () => ({ core: false, tasks: false, mcp: false, visual_studio: false, custom: false }),
    }, 'sessionRules');
    assert.equal(await sessionRules(), null);
  }
});

test('settings keep checkbox edits as drafts and preserve them after a concurrent Guide write fails', async () => {
  const memory = {}, jobs = [], states = [];
  let source = model.defaultRules, conflict = false;
  const { globalRulesSettings } = await evaluateNative('../mods/herdr-zed-agents/global-rules-settings.js', {
    ...model, rulesPath: () => '/guide', shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    readTextFile: async () => source,
    writeTextFile: async (_path, next, expected) => {
      if (conflict || source !== expected) throw new Error('File changed. Reopen Global Rules to load the latest version.');
      source = next;
    },
    EditorState: { new: () => {
      const state = { text: '', on() {}, value() { return this.text; }, set_value(text) { this.text = text; } };
      states.push(state); return state;
    } },
  }, 'globalRulesSettings');
  const view = { ...globalRulesSettings }, cx = { notify() {}, spawn: fn => jobs.push(fn(cx)) };
  view.initGlobalRules(cx); await Promise.all(jobs.splice(0));
  view.rulesSelection.custom = false;
  view.rulesCustom.set_value('My policy');
  assert.deepEqual(memory, {}, 'Drafts do not change active injection');
  const before = source;
  conflict = true;
  view.saveGlobalRules(cx); await Promise.all(jobs.splice(0));
  assert.equal(source, before);
  assert.equal(view.rulesCustom.value(), 'My policy');
  assert.deepEqual(memory, {});
  assert.match(view.rulesError, /File changed/);
  conflict = false;
  view.saveGlobalRules(cx); await Promise.all(jobs.splice(0));
  assert.equal(memory[model.ruleSettingsKey].custom, false);
  assert.match(source, /My policy/, 'Unchecked content stays saved');
  assert.match(source, /My policy/);
  assert.equal(view.rulesSaved, true);
});

test('all built-in policy is owned by Devkits Skills', () => {
  assert.deepEqual(model.ruleModules, []);
  assert.equal(model.composeRuleGuide(model.splitRuleGuide(model.defaultRules), model.ruleSelection()), '');
});
