import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNative } from './source-harness.js';

const first = { id: 'one', folder: '/one', name: 'One' };
const second = { id: 'two', folder: '/two', name: 'Two' };

async function scenario(pasteClipboardImage = async () => null) {
  const tabs = [], jobs = [], finished = [], launched = [];
  const input = { text: '', handlers: {}, on(name, fn) { this.handlers[name] = fn; }, set_auto_grow() {},
    value() { return this.text; }, set_value(text) { this.text = text; } };
  const { startPanel } = await evaluateNative('../mods/herdr-zed/start-panel.js', {
    TextareaState: { new: () => input }, ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    spaces: () => tabs, shared: () => null, withAttachments: text => text, pasteClipboardImage,
    notify: message => assert.fail(message.body),
  }, 'startPanel');
  const cx = { notify() {}, spawn: fn => jobs.push(fn(cx)) };
  const view = { ...startPanel, editor: { finishCompose: key => finished.push(key) },
    startThread: (_agent, target) => launched.push(target), startSession: () => ({ picker: true }),
    composerView: project => project };
  view.initStartPanel(cx);
  const show = project => { view.editor.projectKey = project.folder; return view.projectStartView(project, {}, cx); };
  // Use the native launch path so no real launcher or session is touched.
  view.openLauncher = (project, task) => launched.push({ space: project.id, task });
  return { view, input, cx, tabs, jobs, finished, launched, show };
}

test('New thread restores each project draft, attachments and selected skill on return', async () => {
  const h = await scenario();
  h.show(first); h.input.set_value('/review First task');
  h.view.startImages = [{ path: '/first.png' }];
  h.view.startCommandSelection = { id: 'review', name: 'review', scope: 'first' };
  h.view.startMenuOpen = 'program';
  assert.equal(h.show(second), second);
  assert.equal(h.input.value(), ''); assert.deepEqual(h.view.startImages, []);
  assert.equal(h.view.startCommandSelection, null); assert.equal(h.view.startMenuOpen, null);
  h.input.set_value('Second task'); h.view.startImages = [{ path: '/second.png' }];
  h.show({ ...first, id: 'reopened', folder: '/one/' });
  assert.equal(h.input.value(), '/review First task');
  assert.deepEqual(h.view.startImages, [{ path: '/first.png' }]);
  assert.equal(h.view.startCommandSelection.id, 'review');
  assert.equal(h.view.startTarget.target.space, 'reopened');
  h.show({ ...first, machine: 'remote' }); assert.equal(h.input.value(), '', 'remote drafts stay separate');
  h.show(second); assert.equal(h.input.value(), 'Second task');
  assert.deepEqual(h.view.startImages, [{ path: '/second.png' }]);
});

test('a background launch clears only its originating draft; a timeout preserves it for retry', async () => {
  const h = await scenario();
  h.show(first); h.input.set_value('Launch first'); h.view.submitStart(h.cx);
  h.show(second); h.input.set_value('Keep second'); h.view.startImages = [{ path: '/second.png' }];
  h.tabs.push({ ...first, tabs: [{ id: 'new' }] }); h.view.settleStart(h.cx);
  assert.deepEqual(h.launched, [{ space: 'one', task: 'Launch first' }]);
  assert.deepEqual(h.finished, ['/one']);
  assert.equal(h.input.value(), 'Keep second');
  assert.deepEqual(h.view.startImages, [{ path: '/second.png' }]);
  h.show(first); assert.equal(h.input.value(), '');
  h.input.set_value('Retry first'); h.view.submitStart(h.cx);
  h.show(second); h.view.settleStart(h.cx, Date.now() + 60000);
  assert.equal(h.view.startPending, null);
  h.show(first); assert.equal(h.input.value(), 'Retry first');
  h.show(second); assert.equal(h.input.value(), 'Keep second');
});

test('a pasted image finishing after a project switch stays with its original draft', async () => {
  let resolve;
  const h = await scenario(() => new Promise(done => { resolve = done; }));
  h.show(first); h.input.handlers.paste_other({}, h.cx);
  h.show(second); resolve({ path: '/first.png' }); await Promise.all(h.jobs);
  assert.deepEqual(h.view.startImages, []);
  h.show(first); assert.deepEqual(h.view.startImages, [{ path: '/first.png' }]);
});
