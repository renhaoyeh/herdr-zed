import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';
import { eccAccount } from '../mods/herdr-zed-agents/ecc-model.js';

function elements() {
  const events = {}, text = [];
  const make = (type, id) => {
    let key = id || type;
    const element = new Proxy({}, { get: (_target, method) => {
      if (method === 'then') return undefined;
      if (method === 'when') return (condition, callback) => { if (condition) callback(element); return element; };
      return (...args) => {
        if (method === 'id') key = args[0];
        if (method === 'child' && typeof args[0] === 'string') text.push(args[0]);
        if (String(method).startsWith('on_')) (events[key] ||= {})[method] = args[0];
        return element;
      };
    } });
    return element;
  };
  return { events, text, host: { div: () => make('div'), v_flex: () => make('v'), h_flex: () => make('h'),
    Button: id => make('button', id), Switch: id => make('switch', id), Select: id => make('select', id),
    Input: { new: () => make('input') }, DialogDescription: () => make('description'), ApplyFooter: () => make('footer') } };
}
const theme = { foreground: '#fff', muted: '#999', dim: '#777', border: '#333', input: '#222', selected: '#555', popover: '#111' };

async function setup(extra = {}) {
  const mock = elements(), pending = [];
  const cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
  const { skillSettings } = await evaluateNative('../mods/herdr-zed-agents/skills-settings.js', {
    ...mock.host, home: () => '/user', eccAccount, sessionKind: agent => agent.kind, launcherLabel: value => value,
    ...extra,
  }, 'skillSettings');
  const view = { ...skillSettings, skillsProvider: 'claude', skillsScope: 'project', skillsProject: '/project', skillsAccounts: [],
    skillsSearch: { value: () => '' }, skillsDisabled: [], skillsInventory: { root: '/user/.claude/skills', revision: 'old', disabled: [],
      items: [{ id: 'review', key: '/review/SKILL.md', name: 'review', source: 'Personal', path: '/review/SKILL.md', enabled: true, canExclude: true }] } };
  return { ...mock, view, cx, pending };
}

test('Skills page shows sources and scopes and its project switch records only the difference', async () => {
  const { view, events, text, cx } = await setup();
  view.skillsPage(theme);
  assert.ok(text.includes('All projects')); assert.ok(text.includes('This project'));
  assert.ok(text.some(value => value.startsWith('Personal source:')));
  events['skill-project-enabled'].on_change(false, cx);
  assert.deepEqual(view.skillsDisabled, ['/review/SKILL.md']); assert.equal(view.skillsDirty, true);
  events['skill-project-enabled'].on_change(true, cx);
  assert.deepEqual(view.skillsDisabled, []); assert.equal(view.skillsDirty, false);
});

test('stale native inventory replies cannot replace another provider or a closed page', async () => {
  const { view, cx, pending } = await setup();
  const reads = [];
  view.skillsCall = () => new Promise(resolve => reads.push(resolve));
  view.loadSkills(cx); view.skillsProvider = 'codex'; view.loadSkills(cx);
  reads[1]({ disabled: [], items: [{ id: 'current' }] }); await pending[1];
  reads[0]({ disabled: [], items: [{ id: 'stale' }] }); await pending[0];
  assert.equal(view.skillsInventory.items[0].id, 'current');
  view.loadSkills(cx); view.skillsClosed = true;
  reads[2]({ disabled: [], items: [{ id: 'closed' }] }); await pending[2];
  assert.equal(view.skillsInventory, null);
});

test('failed native apply retains the project draft and its error for retry', async () => {
  const { view, cx, pending } = await setup();
  view.skillsDirty = true; view.skillsDisabled = ['/review/SKILL.md'];
  view.skillsCall = async () => { throw Error('Changed in another window'); };
  view.saveSkills(cx); await Promise.all(pending);
  assert.equal(view.skillsDirty, true); assert.equal(view.skillsSaving, false);
  assert.equal(view.skillsError, 'Changed in another window');
  assert.deepEqual(view.skillsDisabled, ['/review/SKILL.md']);
});
