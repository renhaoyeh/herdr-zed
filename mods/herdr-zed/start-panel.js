import { div } from 'gpui-kit';
import { v_flex, h_flex, TextareaState, Textarea } from 'gpui-base';
import { shared, setShared, window } from 'herdr';
import { Button } from './components/button.js';
import { Select, SelectState } from './components/select.js';
import { Empty, EmptyTitle, EmptyDescription } from './components/empty.js';
import { glyph, AgentIcon } from './components/icon.js';

// The program chosen last in each project, so the composer opens on it.
export const START_AGENT_KEY = 'herdr-zed.start-agent';
export const startProjectKey = project => JSON.stringify([project.machine || '', (project.folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || project.id]);
export function startChoice(programs, project, remembered = {}) {
  const key = remembered[startProjectKey(project)];
  return key === 'terminal' ? null : programs.find(agent => agent.key === key) || programs[0] || null;
}

// Start a thread: describe the task, pick a program, then Ctrl+Enter (Cmd+Enter on macOS) or Start. Plain Enter adds a
// line; nothing is sent by accident. The text becomes the agent's first message; a Terminal starts empty.
export const startPanel = {
  initStartPanel(cx) {
    this.startTask = TextareaState.new({ placeholder: 'Describe the task (optional)…' });
    this.startTask.set_auto_grow(4, 12);
    this.startTask.on('change', (_event, cx) => cx.notify());
    this.startTask.on('submit', (event, cx) => { if (event?.secondary) this.submitStart(cx); });
    this.startSelect = new SelectState(cx);
  },
  startAgents(machine, cx) {
    this.programs ||= new Map();
    const key = machine || '';
    if (!this.programs.has(key)) {
      const entry = { items: null }; this.programs.set(key, entry);
      cx.spawn(async cx => {
        try { entry.items = await this.cachedAgents(machine); }
        catch { entry.items = []; entry.error = 'Could not discover installed programs.'; }
        cx.notify();
      });
    }
    return this.programs.get(key);
  },
  welcomeView(t, cx) {
    return div().id('welcome').size_full().bg(t.background).text_color(t.foreground).flex().items_center().justify_center().p(24)
      .child(v_flex().w_full().max_w(420).gap(24)
        .child(Empty(t).gap(8).child(EmptyTitle().child('herdr-zed'))
          .child(EmptyDescription(t).child('Open a folder to start a thread.')))
        .child(Button('welcome-open-folder', t).w_full().h(36).gap(8)
          .on_click((_event, cx) => this.openProject(cx)).child(glyph('folder-open')).child('Open folder…')));
  },
  chooseStartAgent(project, key, cx) {
    setShared(START_AGENT_KEY, { ...(shared(START_AGENT_KEY) || {}), [startProjectKey(project)]: key });
    cx.notify();
  },
  submitStart(cx) {
    const start = this.startTarget;
    if (!start) return;
    const task = start.agent ? this.startTask.value().trim() : '';
    this.startThread(start.agent, { ...start.target, ...(task ? { task } : {}) });
    this.startTask.set_value('');
    cx.notify();
  },
  projectStartView(project, t, cx) {
    if (!project) return div().size_full().bg(t.background);
    const programs = this.startAgents(project.machine, cx), items = programs.items || [];
    const agent = startChoice(items, project, shared(START_AGENT_KEY) || {});
    const target = { space: project.pending ? null : project.id, folder: project.folder, projectName: project.name, machine: project.machine || null };
    this.startTarget = { agent, target };
    const shortcut = window()?.platform === 'macos' ? '⌘ Enter' : 'Ctrl+Enter';
    const options = [{ key: 'terminal', label: 'Terminal', icon: 'terminal', color: t.foreground },
      ...items.map(item => ({ key: item.key, label: item.name, icon: item.icon || 'agent', iconTint: item.tint, color: t.foreground }))];
    return div().id('project-start').size_full().bg(t.background).text_color(t.foreground).flex().items_center().justify_center().p(24)
      .child(v_flex().w_full().max_w(640).gap(12)
        .child(h_flex().gap(8).items_baseline().child(div().text_size(15).font_medium().child('Start a thread'))
          .child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(project.name)))
        .child(v_flex().border(1).border_color(t.border).bg(t.popover)
          .child(Textarea.new(this.startTask).id('project-start-task').w_full().px(12).py(10).border(0).text_size(13)
            .disabled(!agent).accessibility_label('Task for the new thread'))
          .child(h_flex().px(8).py(6).gap(8).items_center().border_t(1).border_color(t.border)
            .child(Select('project-start-agent', this.startSelect, agent?.key || 'terminal', options, 'Program',
              (key, cx) => this.chooseStartAgent(project, key, cx), t, { width: 180 }))
            .child(div().flex_1())
            .child(div().text_size(11).text_color(t.dim).child(agent ? `Enter adds a line · ${shortcut} starts` : 'A terminal starts without a task'))
            .child(Button('project-start-submit', t).h(28).gap(6).disabled(!programs.items)
              .accessibility_label(`Start ${agent?.name || 'Terminal'}`)
              .on_click((_event, cx) => this.submitStart(cx))
              .child(div().size(14).flex().items_center().justify_center().child(AgentIcon(agent, t))).child('Start'))))
        .when(!programs.items || Boolean(programs.error), el => el.child(div().text_size(12).text_color(t.muted)
          .child(programs.error || 'Looking for programs…'))));
  },
};
