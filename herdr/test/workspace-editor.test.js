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
  const Editor = new Function('div', 'v_flex', 'shared', 'setShared', 'theme', 'FileViewer', 'DiffViewer', 'SidePanelLayout',
    source.replace(/^import .*;\r?\n/gm, '').replace('export default class', 'class') + '\nreturn WorkspaceEditor;')(
    element, element, key => store[key], (key, value) => { store[key] = value; }, () => ({}), Files, Diff,
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

async function editorHarness(store = {}) {
  const source = await readFile(new URL('../mods/devkits/workspace-editor.js', import.meta.url), 'utf8');
  const element = () => {
    const el = new Proxy({}, { get: (_target, key) => key === 'when' ? (condition, fn) => { if (condition) fn(el); return el; } : () => el });
    return el;
  };
  class Files {
    init() { this.tabs = []; this.sidePanel = {}; this.file = null; this.saved = new Map(); }
    render(project) {
      if (project.id !== this.id) {
        if (this.id) this.saved.set(this.id, { tabs: this.tabs, file: this.file });
        this.id = project.id; const saved = this.saved.get(this.id) || { tabs: [], file: null }; this.tabs = saved.tabs; this.file = saved.file;
      }
      return { content: 'file', panel: 'tree' };
    }
    tabBar(_t, options) { this.options = options; return element(); }
    activate(path, cx) { this.file = path; this.onOpen({ path }, cx); }
    show(path, cx, replaced) {
      if (replaced) this.tabs = this.tabs.filter(tab => tab.path !== replaced);
      if (!this.tabs.some(tab => tab.path === path)) this.tabs.push({ path });
      this.file = path; this.onOpen({ path, replaced }, cx);
    }
    closeTab(path, cx) { this.tabs = this.tabs.filter(tab => tab.path !== path); this.file = this.tabs.at(-1)?.path || null; this.onOpen({ path: this.file }, cx); }
    close() {}
  }
  class Diff {
    init() { this.history = {}; this.opens = []; }
    render(project) { this.context = project; return { content: 'diff', panel: 'git' }; }
    openGraph(cx) { this.graph ||= {}; this.graphMode = true; this.opens.push('graph'); this.onOpen({ kind: 'graph' }, cx); }
    openCommit(commit, cx, preview) { this.graphMode = false; this.history.preview = preview || { commit, files: [] }; this.opens.push(commit.sha); this.onOpen({ kind: 'commit', commit }, cx); }
    showChanges(cx) { this.graphMode = false; this.onOpen({ kind: 'changes' }, cx); }
    close() {}
  }
  const Editor = new Function('div', 'v_flex', 'shared', 'setShared', 'theme', 'FileViewer', 'DiffViewer', 'SidePanelLayout',
    source.replace(/^import .*;\r?\n/gm, '').replace('export default class', 'class') + '\nreturn WorkspaceEditor;')(
    element, element, key => store[key], (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); }, () => ({}), Files, Diff, (_id, _state, content) => content);
  const tasks = [], cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), bind_keys() {}, sleep: async () => {}, spawn(fn) { tasks.push(fn(cx)); } };
  const editor = new Editor(); editor.init(cx);
  return { editor, cx, store, async drain() { while (tasks.length) await Promise.all(tasks.splice(0)); } };
}

const editorCommit = letter => ({ sha: letter.repeat(40), shortSha: letter.repeat(7), subject: `Commit ${letter}`, at: 1700000000 });

test('files, Git Graph and multiple commit views share a persistent tab strip and opening a commit preserves the graph', async () => {
  const { editor, cx, store } = await editorHarness({ 'devkits.right-panel': 'diff' });
  const project = { id: 'one', folder: '/repo' }, commit = editorCommit('a'), next = editorCommit('b');
  editor.render(project, cx); editor.files.show('one.js', cx); editor.diff.openGraph(cx);
  const graph = editor.diff.graph;
  editor.diff.openCommit(commit, cx); editor.render(project, cx);
  assert.deepEqual(editor.session.order, ['file:one.js', 'graph', `commit:${commit.sha}`]);
  assert.deepEqual(editor.files.options.extra.map(tab => tab.label), ['Git Graph', 'Commit aaaaaaa']);
  assert.equal(editor.files.options.fileActive, false); assert.equal(store['devkits.right-panel'], 'diff');
  editor.activate('graph', cx); assert.equal(editor.diff.graph, graph); assert.equal(editor.diff.graphMode, true);
  editor.activate(`commit:${commit.sha}`, cx); assert.equal(editor.diff.history.preview.commit.sha, commit.sha);
  editor.diff.openCommit(next, cx); editor.diff.openCommit(commit, cx);
  assert.equal(editor.session.git.length, 3, 'Opening the same commit activates its existing tab');
  editor.activate('file:one.js', cx); editor.render(project, cx);
  assert.equal(editor.files.options.fileActive, true); assert.equal(editor.session.git.length, 3);
  editor.activate('graph', cx); editor.close();
  const { editor: restored, cx: otherCx, drain } = await editorHarness(store);
  restored.render(project, otherCx); await drain();
  assert.equal(restored.session.active, 'graph'); assert.equal(restored.diff.graphMode, true);
  assert.equal(restored.session.git.length, 3); assert.equal(store['devkits.right-panel'], 'diff');
});

test('preview replacement retains its mixed-tab position and closing a commit activates the most recent remaining item', async () => {
  const { editor, cx } = await editorHarness(); const project = { id: 'one', folder: '/repo' }, commit = editorCommit('a');
  editor.render(project, cx); editor.files.show('preview.js', cx); editor.diff.openGraph(cx); editor.diff.openCommit(commit, cx);
  editor.files.show('replacement.js', cx, 'preview.js');
  assert.deepEqual(editor.session.order, ['file:replacement.js', 'graph', `commit:${commit.sha}`]);
  editor.activate('graph', cx); editor.activate(`commit:${commit.sha}`, cx); editor.closeActiveTab(cx);
  assert.equal(editor.session.active, 'graph'); assert.equal(editor.diff.graphMode, true);
  editor.closeItem('file:replacement.js', cx);
  assert.equal(editor.session.active, 'graph', 'Closing a background file leaves the graph selected');
  editor.closeActiveTab(cx); assert.deepEqual(editor.session.order, []); assert.equal(editor.session.active, null);
});

test('editor tabs restore independently across projects and late commit results cannot reopen a closed tab', async () => {
  const { editor, cx, drain } = await editorHarness();
  const first = { id: 'one', folder: '/first' }, second = { id: 'two', folder: '/second' }, commit = editorCommit('a');
  editor.render(first, cx); editor.diff.openGraph(cx); editor.diff.openCommit(commit, cx); editor.closeItem(`commit:${commit.sha}`, cx);
  editor.diff.history.preview = { commit, files: ['late result'] }; editor.render(first, cx);
  assert.deepEqual(editor.session.git.map(tab => tab.kind), ['graph']);
  editor.render(second, cx); assert.equal(editor.session.git.length, 0);
  editor.files.show('second.js', cx); editor.render(first, cx); await drain();
  assert.equal(editor.session.active, 'graph'); assert.equal(editor.diff.graphMode, true);
  editor.render(second, cx); assert.equal(editor.session.active, 'file:second.js');
});
