import { div } from 'gpui-kit';
import { v_flex } from 'gpui-base';
import { shared, setShared, theme } from 'herdr';
import FileViewer from './files.js';
import DiffViewer from './diff.js';
import { gitToastProject } from './git-result-toast.js';
import { SidePanelLayout } from './components/side-panel.js';

const editorItemKey = item => item.kind === 'commit' ? `commit:${item.commit.sha}` : item.kind;
const emptyEditorSession = () => ({ git: [], order: [], history: [], active: null, compose: false });
export const COMPOSE_TAB = 'compose';

// Files, the graph, commit diffs and the New thread composer share one tab strip. Dock selection is independent.
// The composer tab (COMPOSE_TAB) is per project and per session; it is not restored after a restart.
export default class WorkspaceEditor {
  init(cx) {
    this.handle = cx.focus_handle();
    this.sessions = new Map(); this.session = emptyEditorSession(); this.projectKey = null;
    this.files = new FileViewer(); this.files.init(cx);
    this.diff = new DiffViewer(); this.diff.init(cx); this.diff.managedTabs = true;
    this.files.onOpen = (info, cx) => this.fileOpened(info, cx);
    this.diff.onOpen = (item, cx) => this.gitOpened(item || { kind: 'changes' }, cx);
    this.diff.onRepositoryChange = () => {
      // Git tabs belong to the previously selected repository. Keep file tabs.
      this.session.git = [];
      this.session.order = this.session.order.filter(key => key.startsWith('file:'));
      this.session.history = this.session.history.filter(key => key.startsWith('file:'));
      this.diffItemKey = null; this.restoreQueued = null;
    };
    cx.bind_keys([
      { keystroke: 'ctrl-tab', action: 'herdr-zed-next-file', context: 'HerdrZedFiles' },
      { keystroke: 'ctrl-shift-tab', action: 'herdr-zed-prev-file', context: 'HerdrZedFiles' },
    ]);
  }

  focus() { this.handle.focus(); }

  openFile(project, path, cx, options) {
    this.switchProject(project);
    if (this.files.context?.id !== project.id || this.files.context?.folder !== project.folder || this.files.context?.machine !== project.machine)
      this.files.refresh(project, cx);
    this.files.show(path, cx, true, options);
  }

  close() { this.capturePreview(); this.remember(); this.files.close(); this.diff.close(); }

  capturePreview() {
    if (this.diffProjectKey !== this.projectKey) return;
    const preview = this.diff.history?.preview;
    const item = this.session.git.find(item => item.commit?.sha === preview?.commit.sha);
    if (item) item.preview = preview;
  }

  remember() {
    if (!this.projectKey) return;
    const { git, order, history, active } = this.session;
    const saved = { git: git.map(({ kind, commit }) => ({ kind, ...(commit ? { commit } : {}) })), order, history, active };
    const all = shared('herdr-zed.editor-tabs') || {};
    if (JSON.stringify(all[this.projectKey]) === JSON.stringify(order.length ? saved : undefined)) return;
    const next = { ...all };
    if (order.length) next[this.projectKey] = saved; else delete next[this.projectKey];
    setShared('herdr-zed.editor-tabs', next);
  }

  switchProject(project) {
    const key = JSON.stringify([project?.machine || '', project?.folder || project?.id || '']);
    if (this.projectKey === key) return;
    this.capturePreview(); this.remember();
    if (this.projectKey) this.diff.close();
    if (this.projectKey) this.sessions.set(this.projectKey, this.session);
    this.projectKey = key; this.diffItemKey = null; this.restoreQueued = null; this.tabSwitch = null;
    const cached = this.sessions.get(key);
    if (cached) { this.session = cached; return; }
    const saved = shared('herdr-zed.editor-tabs')?.[key];
    this.session = emptyEditorSession();
    if (!saved) return;
    const seen = new Set();
    for (const item of Array.isArray(saved.git) ? saved.git : []) {
      if (!['graph', 'changes', 'commit'].includes(item?.kind)) continue;
      if (item.kind === 'commit' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.commit?.sha || '')) continue;
      const id = editorItemKey(item);
      if (!seen.has(id)) { this.session.git.push({ kind: item.kind, commit: item.commit }); seen.add(id); }
    }
    for (const name of ['order', 'history']) this.session[name] = Array.isArray(saved[name]) ? [...new Set(saved[name].filter(key => typeof key === 'string'))] : [];
    this.session.active = typeof saved.active === 'string' ? saved.active : null;
  }

  syncTabs() {
    const keys = [...(this.files.tabs || []).map(doc => `file:${doc.path}`), ...this.session.git.map(editorItemKey),
      ...(this.session.compose ? [COMPOSE_TAB] : [])];
    const valid = new Set(keys);
    this.session.order = [...this.session.order.filter(key => valid.has(key)), ...keys.filter(key => !this.session.order.includes(key))];
    this.session.history = this.session.history.filter(key => valid.has(key));
    if (!valid.has(this.session.active)) this.session.active = this.files.file ? `file:${this.files.file}` : this.session.order.at(-1) || null;
  }

  record(key) {
    this.session.active = key;
    if (key) this.session.history = [...this.session.history.filter(item => item !== key), key];
    this.tabSwitch = null;
    this.remember();
  }

  fileOpened(info) {
    if (this.closingFile) return;
    this.capturePreview();
    if (info?.replaced) {
      const index = this.session.order.indexOf(`file:${info.replaced}`);
      if (index >= 0) this.session.order[index] = `file:${info.path}`;
    }
    this.syncTabs(); this.record(this.files.file ? `file:${this.files.file}` : null);
    setShared('herdr-zed.editor-kind', 'files');
  }

  gitOpened(item) {
    this.capturePreview();
    this.diffProjectKey = this.projectKey;
    const key = editorItemKey(item);
    const existing = this.session.git.find(entry => editorItemKey(entry) === key);
    if (!existing) this.session.git.push({ ...item });
    else if (item.commit) existing.commit = item.commit;
    this.syncTabs(); this.record(key); this.diffItemKey = key;
    setShared('herdr-zed.editor-kind', 'diff');
  }

  // New thread opens the project's composer tab, or returns to it.
  openCompose(project, cx) {
    this.switchProject(project);
    this.capturePreview();
    this.session.compose = true;
    this.syncTabs(); this.record(COMPOSE_TAB);
    cx.notify();
  }

  finishCompose(projectKey, cx) {
    if (projectKey === this.projectKey) { this.closeItem(COMPOSE_TAB, cx); return; }
    const session = this.sessions.get(projectKey);
    if (!session) return;
    session.compose = false;
    session.order = session.order.filter(key => key !== COMPOSE_TAB);
    session.history = session.history.filter(key => key !== COMPOSE_TAB);
    if (session.active === COMPOSE_TAB) session.active = session.history.at(-1) || session.order.at(-1) || null;
  }

  activate(key, cx, cycling = false) {
    this.capturePreview();
    const cycle = this.tabSwitch;
    if (key === COMPOSE_TAB) this.record(key);
    else if (key.startsWith('file:')) this.files.activate(key.slice(5), cx);
    else {
      const item = this.session.git.find(item => editorItemKey(item) === key);
      if (!item) return;
      if (this.diff.discovering) { this.record(key); cx.notify(); return; }
      if (item.kind === 'graph') this.diff.openGraph(cx);
      else if (item.kind === 'changes') this.diff.showChanges(cx);
      else this.diff.openCommit(item.commit, cx, item.preview);
    }
    if (cycling) this.tabSwitch = cycle;
    cx.notify();
  }

  closeItem(key, cx) {
    const active = this.session.active === key;
    this.capturePreview();
    const index = this.session.order.indexOf(key);
    if (key.startsWith('file:')) {
      this.closingFile = true;
      try { this.files.closeTab(key.slice(5), cx); } finally { this.closingFile = false; }
    } else if (key === COMPOSE_TAB) this.session.compose = false;
    else {
      this.session.git = this.session.git.filter(item => editorItemKey(item) !== key);
      if (this.diffItemKey === key) this.diffItemKey = null;
      if (key === 'graph') this.diff.graphMode = false;
    }
    this.session.order = this.session.order.filter(item => item !== key);
    this.session.history = this.session.history.filter(item => item !== key);
    if (active) {
      const next = this.session.history.at(-1) || this.session.order[Math.max(0, index - 1)];
      if (next) this.activate(next, cx);
      else { this.session.active = null; setShared('herdr-zed.editor-kind', 'files'); }
    }
    this.remember(); cx.notify();
  }

  closeActiveTab(cx) { if (this.session.active) this.closeItem(this.session.active, cx); }

  cycleTab(direction, cx) {
    if (!this.session.order.length) return;
    if (!this.tabSwitch) this.tabSwitch = { order: [...this.session.history].reverse().concat(this.session.order.filter(key => !this.session.history.includes(key))), index: 0 };
    const cycle = this.tabSwitch;
    cycle.index = (cycle.index + direction + cycle.order.length) % cycle.order.length;
    this.activate(cycle.order[cycle.index], cx, true);
  }

  render(project, cx, { compose } = {}) {
    this.switchProject(project);
    const dock = shared('herdr-zed.right-panel');
    const files = this.files.render(project, cx, true, false);
    this.syncTabs();
    const outputRequest = shared('herdr-zed.git-output-request');
    if (outputRequest) {
      setShared('herdr-zed.git-output-request', null);
      if (outputRequest === gitToastProject(project) && outputRequest === gitToastProject(this.diff.context) && this.diff.pushResult) {
        this.gitOpened(this.session.git.find(item => editorItemKey(item) === this.diffItemKey) || { kind: 'changes' }, cx);
        this.diff.openLog(cx);
      }
    }
    const active = this.session.active;
    const kind = active === COMPOSE_TAB ? 'compose' : active && !active.startsWith('file:') ? 'diff' : 'files';
    const diff = kind === 'diff' || dock === 'diff' ? this.diff.render(project, cx, true) : null;
    if (diff) this.diffProjectKey = this.projectKey;
    this.capturePreview();
    if (kind === 'diff' && !this.diff.discovering && this.diffItemKey !== active && this.restoreQueued !== active) {
      const key = this.projectKey;
      this.restoreQueued = active;
      cx.spawn(async cx => {
        await cx.sleep(0);
        if (this.projectKey !== key || this.session.active !== active) return;
        this.restoreQueued = null; this.activate(active, cx);
      });
    }
    const extra = this.session.git.map(item => {
      const key = editorItemKey(item);
      return { key, active: key === active, label: item.kind === 'graph' ? 'Git Graph' : item.kind === 'changes' ? 'Changes' : `Commit ${item.commit.shortSha || item.commit.sha.slice(0, 7)}`,
        icon: item.kind === 'graph' ? 'git-graph' : 'git-compare', activate: cx => this.activate(key, cx), close: cx => this.closeItem(key, cx) };
    });
    if (this.session.compose) extra.push({ key: COMPOSE_TAB, active: active === COMPOSE_TAB, label: 'New thread', icon: 'thread',
      activate: cx => this.activate(COMPOSE_TAB, cx), close: cx => this.closeItem(COMPOSE_TAB, cx) });
    const content = v_flex().size_full().min_w(0).min_h(0)
      .when(this.session.order.length > 0, el => el.child(this.files.tabBar(theme(), {
        extra, fileActive: kind === 'files', order: this.session.order, closeFile: (path, cx) => this.closeItem(`file:${path}`, cx),
      })))
      .child(div().flex_1().min_w(0).min_h(0).child(kind === 'compose' && compose ? compose() : kind === 'diff' ? diff.content
        : files.content));
    const body = dock ? SidePanelLayout('workspace-editor-split', this.files.sidePanel, content,
      dock === 'diff' ? diff.panel : files.panel) : content;
    return div().id('workspace-editor').track_focus(this.handle).key_context('HerdrZedFiles').size_full().min_h(0).bg(theme().background)
      .on_modifiers_changed(event => { if (!event.modifiers.control) this.tabSwitch = null; })
      .on_action('herdr-zed-next-file', (_event, cx) => { cx.stop_propagation(); this.cycleTab(1, cx); })
      .on_action('herdr-zed-prev-file', (_event, cx) => { cx.stop_propagation(); this.cycleTab(-1, cx); })
      .child(body);
  }
}
