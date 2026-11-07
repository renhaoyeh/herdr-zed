import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dock switches preserve the document; choosing a file or diff changes the content independently', async () => {
  const source = await readFile(new URL('../mods/devkits/workspace-editor.js', import.meta.url), 'utf8');
  const store = { 'devkits.editor-kind': 'files', 'devkits.right-panel': 'files' }, renders = [], bindings = [];
  const element = () => new Proxy({}, { get: (_target, key) => key === 'when'
    ? (condition, callback) => condition ? callback(element()) : element() : () => element() });
  class Files {
    init() { this.sidePanel = {}; }
    render(project, _cx, parts) { renders.push(['files', project.id, parts]); return { content: 'file-content', panel: 'file-tree' }; }
    close() { this.closed = true; }
  }
  class Diff extends Files {
    render(project, _cx, parts) { renders.push(['diff', project.id, parts]); return { content: 'diff-content', panel: 'git-panel' }; }
  }
  const layouts = [];
  const Editor = new Function('div', 'shared', 'setShared', 'theme', 'FileViewer', 'DiffViewer', 'SidePanelLayout',
    source.replace(/^import .*;\n/gm, '').replace('export default class', 'class') + '\nreturn WorkspaceEditor;')(
    element, key => store[key], (key, value) => { store[key] = value; }, () => ({}), Files, Diff,
    (_id, _state, content, panel) => { layouts.push(panel); return content; });
  let focused = false;
  const editor = new Editor(); editor.init({ focus_handle: () => ({ focus() { focused = true; } }), bind_keys: keys => bindings.push(...keys) });
  const project = { id: 'one' };
  editor.render(project, {}); assert.deepEqual(layouts, ['file-tree']);
  store['devkits.right-panel'] = 'diff'; editor.render(project, {});
  assert.equal(layouts.at(-1), 'git-panel'); assert.equal(store['devkits.editor-kind'], 'files');
  store['devkits.right-panel'] = null; editor.render(project, {});
  assert.equal(layouts.length, 2); assert.equal(store['devkits.editor-kind'], 'files');
  editor.diff.onOpen(); assert.equal(store['devkits.editor-kind'], 'diff');
  editor.files.onOpen(); assert.equal(store['devkits.editor-kind'], 'files');
  assert.ok(bindings.every(binding => binding.context === 'DevkitsFiles'));
  editor.focus(); assert.equal(focused, true);
  editor.close(); assert.equal(editor.files.closed && editor.diff.closed, true);
});
