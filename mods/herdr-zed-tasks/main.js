import { View, div } from 'gpui-kit';
import { v_flex } from 'gpui-base';
import { props, shared, setShared, notify, closeOverlay } from 'herdr';
import { TaskRuntime } from './runtime.js';
import { TasksMcpBridge } from './mcp-bridge.js';
import AgentBoard from './agent-board.js';
import TaskComposer from './task-composer.js';
import DeleteTask from './delete-task.js';
import ArchiveTask from './archive-task.js';
import { findProject } from './task-sources.js';
import { boardTheme } from './components/task-theme.js';
import { Button } from './components/button.js';
import { workspacePanel, releaseWorkspacePanel } from './components/workspace-overlay.js';
import { ImagePreview, IMAGE_PREVIEW_VIEW } from './components/image-attachments.js';
// Tasks runs as a popup/dialog extension view (see extension.json); the service view runs in the status row.
export default class TasksMod extends View {
  init(_props, cx) {
    this.runtime = new TaskRuntime(); this.target = props() || {};
    if (this.target.view === 'service') { this.runtime.init(cx); new TasksMcpBridge().init(this.runtime, cx); return; }
    if (this.target.view === IMAGE_PREVIEW_VIEW) return;
    this.runtime.close = () => { if (this.target.overlay) closeOverlay(this.target.overlay); };
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
    } else {
      this.runtime.agentBoard = new AgentBoard(); this.runtime.agentBoard.init(cx); this.runtime.agentBoard.handle.focus();
      if (this.target.focus) setShared('herdr-zed.board-focus', this.target.focus);
    }
  }
  close() { if (this.target.view === IMAGE_PREVIEW_VIEW) return; releaseWorkspacePanel(); this.composer?.saveDraft(); this.runtime.agentClient.close(); }
  render(cx) {
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
    const project = findProject(projects, this.target.context || {}) || this.target.project
      || projects.find(project => project.id === shared('herdr-zed.board-project')) || projects.find(project => project.active);
    return workspacePanel(project ? this.runtime.boardPanel(project, cx) : div().size_full().bg(t.background).text_color(t.muted).child('Select a project to open Tasks.'));
  }
}
