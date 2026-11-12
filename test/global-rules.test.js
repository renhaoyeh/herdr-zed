import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../mods/herdr-zed-agents/global-rules-model.js';
import { rulesArgv } from '../components/session-model.js';
import { evaluateNative } from './source-harness.js';

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

test('intentionally empty Guides inject no global instructions', async () => {
  for (const source of [model.defaultRules, '', null]) {
    const { sessionRules } = await evaluateNative('../mods/herdr-zed-agents/global-rules.js', {
      ...model, rulesPath: () => '/guide', readTextFile: async () => source,
      shared: () => ({ core: false, tasks: false, mcp: false, visual_studio: false, custom: false }),
    }, 'sessionRules');
    assert.equal(await sessionRules(), null);
  }
});

test('settings keep text edits as drafts and preserve them after a concurrent Guide write fails', async () => {
  const memory = {}, jobs = [], states = [];
  let source = model.defaultRules, conflict = false;
  const { globalRulesSettings } = await evaluateNative('../mods/herdr-zed-agents/global-rules-settings.js', {
    ...model, rulesPath: () => '/guide', shared: key => memory[key], setShared: (key, value) => { memory[key] = value; },
    readTextFile: async () => source, providerDevkits: async provider => ({ summary: `- **Core** (${provider})` }),
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
  assert.equal(source, 'My policy', 'Save preserves the exact editor text');
  assert.match(source, /My policy/);
  assert.equal(view.rulesSaved, true);
});

test('session injection preserves the exact Guide including Markdown headings', async () => {
  const source = '# Global rules\n\n## Deployment\nKeep this.\n';
  const { sessionRules } = await evaluateNative('../mods/herdr-zed-agents/global-rules.js', {
    ...model, rulesPath: () => '/guide', readTextFile: async () => source,
    shared: () => ({ custom: false }),
  }, 'sessionRules');
  assert.equal((await sessionRules()).text, source);
});

test('session rules list Devkits capabilities first and the custom Guide last', () => {
  const text = model.composeSessionRules('# Global rules\n\n## Deployment\nKeep this.\n```\n# not a heading\n```',
    { summary: '- **Herdr Core** (rule): Use hc.', sections: '## Herdr Core\n\nRead hc.' }, '# ECC\nUse it.');
  assert.equal(text, '# Global rules\n\n- **Herdr Core** (rule): Use hc.\n\n## Herdr Core\n\nRead hc.\n\n'
    + '## ECC selected guidance\n\n### ECC\nUse it.\n\n## Custom rules\n\n### Deployment\nKeep this.\n```\n# not a heading\n```\n');
  assert.equal(model.composeSessionRules('', null), '');
});

test('Devkits guidance nests skill bodies, skips Codex-only skills for Claude and prints plain paths', async () => {
  const devkits = await import('../mods/herdr-zed-agents/devkits-model.js');
  const catalog = devkits.devkitsCatalog('C:\\herdr');
  catalog.rules = catalog.rules.map(item => ({ ...item, text: '---\nname: x\n---\n\n# Title\n\nBody\n\n## Sub\nMore' }));
  const config = devkits.parseDevkits(null);
  const claude = devkits.devkitsGuidance(config, catalog, {}, 'windows', [], 'claude');
  assert.match(claude.sections, /## Herdr Core\n\nBody\n\n### Sub\nMore/);
  assert.doesNotMatch(claude.sections + claude.summary, /Shared MCP|# Title|\\|"C:/);
  assert.match(claude.summary, /^- \*\*Herdr Core\*\* \(rule\)/);
  const codex = devkits.devkitsGuidance(config, catalog, {}, 'windows', [], 'codex');
  assert.match(codex.sections, /## Shared MCP installation\n\nRead the skill `C:\/herdr\/mods\/herdr-zed-agents\/assets\/skills\/shared-mcp\/SKILL.md`/);
});

test('user Rules and Skills read their name and description and stay on unless disabled', async () => {
  const devkits = await import('../mods/herdr-zed-agents/devkits-model.js');
  const items = devkits.mineItems({
    rules: [{ path: '/home/data/herdr-zed/capabilities/rules/team.md', text: '---\nname: Team conventions\ndescription: "How we work"\n---\n# Team\n\nBody' },
      { path: '/home/data/herdr-zed/capabilities/rules/plain.md', text: '# Plain\n\nFirst line.\n' },
      { path: '/home/data/herdr-zed/capabilities/rules/gone.md', text: null }],
    skills: [{ path: '/home/data/herdr-zed/capabilities/skills/deploy/SKILL.md', text: '---\nname: deploy\ndescription: Ship it\n---\nSteps' }],
  });
  assert.deepEqual(items.map(item => [item.id, item.name, item.description]), [
    ['mine:rules:team', 'Team conventions', 'How we work'], ['mine:rules:plain', 'plain', 'First line.'], ['mine:skills:deploy', 'deploy', 'Ship it']]);
  const catalog = { rules: items.filter(item => item.group === 'rules'), skills: items.filter(item => item.group === 'skills') };
  const config = devkits.withMine({ version: 2, rules: {}, skills: {} }, catalog, devkits.parseMineSelection('{"version":1,"disabled":["mine:rules:plain"]}'));
  assert.deepEqual(config.rules, { 'mine:rules:team': true, 'mine:rules:plain': false });
  const guidance = devkits.devkitsGuidance(config, catalog, {}, 'windows', [], 'claude');
  assert.deepEqual(guidance.items.map(item => [item.name, item.source]), [['Team conventions', 'mine'], ['deploy', 'mine']]);
  assert.match(guidance.sections, /## Team conventions\n\nBody/);
  assert.throws(() => devkits.parseMineSelection('{"disabled":"x"}'), /Invalid capabilities\.json/);
});
