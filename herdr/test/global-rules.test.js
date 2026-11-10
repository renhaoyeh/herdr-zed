import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../mods/devkits-agents/global-rules-model.js';
import { rulesArgv } from '../mods/devkits/components/session-model.js';
import { evaluateNative } from './source-harness.js';

test('rule switches filter edited sections without losing disabled text or custom heading content', () => {
  const guide = model.splitRuleGuide(model.defaultRules.replace('Use the `herdr_tasks`', 'Always use the `herdr_tasks`')
    + '\n## Custom rules\n\nMy instructions\n\n## Herdr task progress\nThis heading is custom.');
  const selected = model.ruleSelection({ tasks: false, mcp: false });
  const text = model.composeRuleGuide(guide, selected);
  assert.match(text, /hc --skill/);
  assert.doesNotMatch(text, /Always use the `herdr_tasks`/);
  assert.match(text, /This heading is custom/);
  const saved = model.composeRuleGuide(guide, model.ruleSelection());
  const reopened = model.splitRuleGuide(saved);
  assert.equal(reopened.custom, guide.custom);
  assert.match(reopened.sections.tasks, /Always use/);
  assert.equal(model.composeRuleGuide(guide, model.ruleSelection({ core: false, tasks: false, mcp: false, custom: false })), '');
});

test('ordinary and profile launch arguments receive only selected rules for both providers', async () => {
  const { sessionRules } = await evaluateNative('../mods/devkits-agents/global-rules.js', {
    ...model, rulesPath: () => '/guide/AGENTS.md', readTextFile: async () => model.defaultRules,
    shared: () => ({ core: false, tasks: true, mcp: false, custom: false }),
  }, 'sessionRules');
  const rules = await sessionRules();
  assert.match(rules.text, /report_task/);
  assert.doesNotMatch(rules.text, /hc --skill|MCP installation/);
  for (const kind of ['claude', 'codex']) {
    for (const extra of ['', 'Review carefully.']) {
      const argv = rulesArgv({ key: kind }, [kind], rules, extra);
      assert.doesNotMatch(argv.join(' '), /hc --skill|MCP installation|append-system-prompt-file/);
      assert.match(argv.join(' '), /report_task/);
      assert.equal(argv.join(' ').includes('Review carefully.'), Boolean(extra));
    }
  }
});

test('all disabled rules and intentionally empty Guides inject no global instructions', async () => {
  for (const source of [model.defaultRules, '', null]) {
    const { sessionRules } = await evaluateNative('../mods/devkits-agents/global-rules.js', {
      ...model, rulesPath: () => '/guide', readTextFile: async () => source,
      shared: () => ({ core: false, tasks: false, mcp: false, custom: false }),
    }, 'sessionRules');
    assert.equal(await sessionRules(), null);
  }
});

test('settings keep checkbox edits as drafts and preserve them after a concurrent Guide write fails', async () => {
  const memory = {}, jobs = [], states = [];
  let source = model.defaultRules, conflict = false;
  const { globalRulesSettings } = await evaluateNative('../mods/devkits-agents/global-rules-settings.js', {
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
  view.rulesSelection.core = false;
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
  assert.equal(memory[model.ruleSettingsKey].core, false);
  assert.match(source, /hc --skill/, 'Unchecked content stays saved');
  assert.match(source, /My policy/);
  assert.equal(view.rulesSaved, true);
});
