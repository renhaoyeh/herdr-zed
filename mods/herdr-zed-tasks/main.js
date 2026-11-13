import { View, div } from 'gpui-kit';
import { v_flex } from 'gpui-base';
import { props, shared, setShared, notify, closeOverlay, nextCommand } from 'herdr';
import { TaskRuntime } from './runtime.js';
import { TasksMcpBridge } from './mcp-bridge.js';
import AgentBoard from './agent-board.js';
import TaskComposer from './task-composer.js';
import DeleteTask from './delete-task.js';
import ArchiveTask from './archive-task.js';
import { findProject, installedSources } from './task-sources.js';
import { SourceHub, sourceHubLayout, resolveSourceHub } from './components/source-hub.js';
import { boardTheme } from './components/task-theme.js';
import { Button } from './components/button.js';
import { workspacePanel, releaseWorkspacePanel, mountWorkspaceLayout, closeWorkspaceView } from './components/workspace-overlay.js';
import { ImagePreview, IMAGE_PREVIEW_VIEW } from './components/image-attachments.js';
// Tasks runs as a popup/dialog extension view (see extension.json); the service view runs in the status row.
export default class TasksMod extends View {
  init(_props, cx) {
    this.target = props() || {};
    if (typeof this.target.sourceHub === 'string') this.target = resolveSourceHub(this.target);
    if (this.target.view === 'source-hub') {
      this.hub = new SourceHub(this.target); this.hub.init();
      this.handle = cx.focus_handle(); this.handle.focus();
      cx.spawn(async () => {
        for (;;) {
          const command = await nextCommand();
          if (command.startsWith('source:')) this.hub.open(this.target.sourceHub.tabs.find(tab => tab.id === command.slice(7)));
          if (command === 'scope:all') this.hub.setScope(true);
          if (command === 'scope:project') this.hub.setScope(false);
        }
      });
      return;
    }
    if (this.target.view === 'workspace') {
      const sources = installedSources(shared('herdr-zed.extensions.catalog'));
      const tabs = [{ id: 'tasks', title: 'Tasks', mod: 'herdr-zed-tasks', scope: false, props: { view: 'local-tasks' } },
        ...sources.map(source => ({ id: source.key, title: source.label, mod: `herdr-zed-${source.key}`, props: { view: 'browser' } }))];
      const remembered = shared('herdr-zed.tasks-v2.native.selected');
      const selected = this.target.focus ? 'tasks' : tabs.some(tab => tab.id === remembered) ? remembered : tabs[0].id;
      const hub = { title: 'Tasks', hostMod: 'herdr-zed-tasks', stack: 'herdr-zed-tasks-v2-stack', selected, tabs,
        bindingsKey: 'herdr-zed.tasks-v2.bindings', stateKey: 'herdr-zed.tasks-v2.native', workspaceAction: 'tasks.open' };
      setShared(`${hub.stateKey}.selected`, selected);
      setShared(`${hub.stateKey}.config`, hub);
      this.redirected = true;
      cx.timer.after(0, () => {
        const id = `workspace:${Date.now()}`;
        mountWorkspaceLayout(sourceHubLayout(hub, this.target.context, id), hub.workspaceAction, id);
      });
      return;
    }
    if (this.target.view === IMAGE_PREVIEW_VIEW) return;
    if (!['service', 'local-tasks', 'task-composer', 'archive-task', 'delete-task', 'import-draft'].includes(this.target.view)) { this.invalidView = true; return; }
    this.runtime = new TaskRuntime();
    if (this.target.view === 'service') { this.runtime.init(cx); new TasksMcpBridge().init(this.runtime, cx); return; }
    if (this.target.view === 'local-tasks') {
      this.localHub = new SourceHub(this.target); this.localHub.init();
      this.runtime.openSource = source => this.localHub.open(this.target.sourceHub.tabs.find(tab => tab.id === source));
    }
    this.runtime.close = () => this.target.workspacePanel ? closeWorkspaceView() : closeOverlay(this.target.overlay);
    this.runtime.agentClient.init(cx);
    if (!shared('herdr-zed.agent-cache')?.null) cx.spawn(async cx => {
      try { await this.runtime.agentClient.discover(null); }
      catch (error) { notify({ title: 'Could not load agents', body: error.message, level: 'error' }); }
      cx.notify();
    });
    if (this.target.view === 'task-composer') {
      this.composer = new TaskComposer(); this.composer.init(this.target, cx);
    } else if (this.target.view === 'archive-task') {
      this.archiver = new ArchiveTask(); this.archiver.init(this.target, this.runtime, cx);
    } else if (this.target.view === 'delete-task') {
      this.deleter = new DeleteTask(); this.deleter.init(this.target, cx);
    } else if (this.target.view === 'import-draft') {
      // An integration's snapshot is revalidated before the draft opens; only the composer's Create button makes a Todo.
      const resolved = this.runtime.resolveImport(this.target);
      if (resolved.error) this.importError = resolved.error;
      else { this.composer = new TaskComposer(); this.composer.init({ project: resolved.project, task: null, parent: null, status: 'todo',
        importTask: resolved.snapshot, overlay: this.target.overlay }, cx); }
    } else if (this.localHub) {
      this.runtime.agentBoard = new AgentBoard(); this.runtime.agentBoard.init(cx); this.runtime.agentBoard.handle.focus();
    }
  }
  close() { if (this.target.view === IMAGE_PREVIEW_VIEW || this.redirected || this.invalidView) return; if (this.hub) { releaseWorkspacePanel(); return; } releaseWorkspacePanel(); this.composer?.saveDraft(); this.runtime.agentClient.close(); }
  render(cx) {
    if (this.redirected) return div().size_full();
    if (this.hub) return workspacePanel(this.hub.render().track_focus(this.handle));
    if (this.invalidView) return div().size_full();
    if (this.target.view === 'service') return div().size_full();
    if (this.target.view === IMAGE_PREVIEW_VIEW) return ImagePreview(this.target, boardTheme());
    const t = boardTheme();
    if (this.archiver) return this.archiver.render();
    if (this.deleter) return this.deleter.render();
    if (this.composer) return this.composer.render(this.runtime.taskAssignees(this.composer.project));
    if (this.importError) return v_flex().size_full().bg(t.popover).p(24).gap(12).text_color(t.foreground)
      .child(div().text_size(14).child(this.importError))
      .child(Button('import-close', t, { variant: 'secondary' }).on_click(() => closeOverlay(this.target.overlay)).child('Close'));
    const projects = this.runtime.projects();
    if (this.localHub) this.localHub.sync();
    const project = findProject(projects, this.target.context || {}) || projects.find(project => project.active);
    return workspacePanel(project ? this.runtime.boardPanel(project, cx) : div().size_full().bg(t.background).text_color(t.muted).child('Select a project to open Tasks.'));
  }
}
