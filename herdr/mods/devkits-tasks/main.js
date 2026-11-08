import { View, div } from 'gpui-kit';
import { props, shared, knownAgents, setShared, notify, closeOverlay, theme } from 'herdr';
import { TaskRuntime } from './runtime.js';
import AgentBoard from './agent-board.js';
import TaskComposer from './task-composer.js';
import { boardTheme } from './components/task-theme.js';
export default class TasksMod extends View {
  init(_props, cx) {
    this.runtime = new TaskRuntime(); this.target = props() || {};
    if (this.target.view === 'service') { this.runtime.init(cx); return; }
    if (this.target.overlay && this.target.view !== 'task-composer') {
      const navigate = this.runtime.navigate.bind(this.runtime);
      this.runtime.navigate = event => {
        if (['close', 'thread', 'launch'].includes(event.type)) closeOverlay(this.target.overlay);
        if (event.type !== 'close') navigate(event);
      };
    }
    if (!shared('devkits.agent-cache')?.null) cx.spawn(async cx => {
      try {
        const available = (await knownAgents()).filter(agent => agent.installed);
        setShared('devkits.agent-cache', { ...(shared('devkits.agent-cache') || {}), null: available });
      } catch (error) { notify({ title: 'Could not load agents', body: error.message, level: 'error' }); }
      cx.notify();
    });
    if (this.target.view === 'task-composer') {
      this.composer = new TaskComposer(); this.composer.init(this.target, cx);
    } else { this.runtime.agentBoard = new AgentBoard(); this.runtime.agentBoard.init(cx); }
  }
  close() { this.composer?.saveDraft(); }
  render(cx) {
    if (this.target.view === 'service') return div().size_full().bg(theme().border);
    const t = boardTheme();
    if (this.composer) return this.composer.render(this.runtime.taskAssignees(this.target.project));
    const projects = this.runtime.projects();
    const project = this.target.project || projects.find(project => project.id === shared('devkits.board-project')) || projects.find(project => project.active);
    return project ? this.runtime.boardPanel(project, cx) : div().size_full().bg(t.background).text_color(t.muted).child('Select a project to open Tasks.');
  }
}
