import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from 'gpui-base';
import { shared, setShared, closeOverlay, openOverlay, run, agents as liveAgents } from 'herdr';
import { boardTheme } from './components/task-theme.js';
import { boardKey, boardPriorityOptions, taskActions } from './agent-board-model.js';
import { launcherOption, accountAddresses } from './components/session-model.js';
import { createLocalTask, rememberBoardTask, projectBoardTasks, importedTask } from './agent-board-state.js';
import { Select, SelectState } from './components/select.js';
import { Button } from './components/button.js';
import { glyph } from './components/icon.js';

export function openTaskComposer(project, task = null, status = 'todo', importTask = null, parent = null) {
  return openOverlay({ mod: 'herdr-zed-tasks', kind: 'dialog', modal: true, frame: 'none', width: 760, height: 400,
    props: { view: 'task-composer', project, task, status, importTask, parent } });
}

export default class TaskComposer {
  init(options, cx) {
    this.options = options; this.project = options.project; this.task = options.task;
    this.parent = this.task ? null : options.parent || null;
    const source = options.importTask;
    const sourceKey = source?.source === 'mantisbt' ? 'mantisbt' : 'asana';
    this.draftKey = boardKey(this.project) + (source ? `:${sourceKey}:${sourceKey === 'mantisbt' ? `${source.server}:` : ''}${source.gid}`
      : this.parent ? `:subtask:${this.parent.gid}` : '');
    const draft = this.task || shared('herdr-zed.task-drafts')?.[this.draftKey] || (source ? {
      name: source.name, notes: source.notes || '',
      [sourceKey]: { gid: source.gid, name: source.name, url: source.url, parent: source.parent, comments: source.comments || [],
        ...(source.fields ? { fields: source.fields } : {}), ...(source.customFields ? { customFields: source.customFields } : {}),
        ...(sourceKey === 'mantisbt' ? { server: source.server } : {}) },
    } : {});
    this.asana = draft.asana || null;
    this.mantisbt = draft.mantisbt || null;
    this.title = InputState.new({ placeholder: 'Task title', value: draft.name || '' });
    this.title.set_value(draft.name || '');
    this.description = TextareaState.new({ placeholder: 'Add description…' });
    this.description.set_value(draft.notes || ''); this.description.set_auto_grow(5, 12);
    this.status = 'todo'; this.agent = draft.agentKey || 'unassigned'; this.priority = draft.priority || 'none';
    this.selects = { agent: new SelectState(cx), priority: new SelectState(cx) };
    this.title.on('change', (_e, cx) => cx.notify());
    this.handle = cx.focus_handle(); this.title.focus();
  }
  saveDraft() {
    if (this.saved || this.task) return;
    const drafts = shared('herdr-zed.task-drafts') || {};
    setShared('herdr-zed.task-drafts', { ...drafts, [this.draftKey]: {
      name: this.title.value(), notes: this.description.value(), status: this.status, agentKey: this.agent, priority: this.priority,
      ...(this.asana ? { asana: this.asana } : {}), ...(this.mantisbt ? { mantisbt: this.mantisbt } : {}) } });
  }
  dismiss() { this.saveDraft(); closeOverlay(this.options.overlay); }
  editable() {
    if (this.parent) {
      const parent = projectBoardTasks(this.project, liveAgents()).find(task => task.gid === this.parent.gid);
      if (!parent || parent.archived) return false;
    }
    if (!this.task) return true;
    const current = projectBoardTasks(this.project, liveAgents()).find(task => task.gid === this.task.gid);
    return taskActions(current).canEdit;
  }
  existingImport() { return !this.task && importedTask(this.project, { asana: this.asana, mantisbt: this.mantisbt }); }
  openTask(task) {
    setShared('herdr-zed.board-focus', task.gid);
    const hub = this.options.returnHub && shared(`${this.options.returnHub}.config`);
    if (hub?.tabs?.some(tab => tab.id === 'tasks')) {
      setShared(`${hub.stateKey}.selected`, 'tasks');
      run('layout.select', { stack: hub.stack, child: `${hub.stack}-tasks` });
    }
    closeOverlay(this.options.overlay);
  }
  submit(agents, cx) {
    const existing = this.existingImport();
    if (existing) { this.saved = true; this.openTask(existing); return; }
    if (this.saved || !this.title.value().trim()) return;
    if (!this.editable()) { this.error = this.parent ? 'The parent task is unavailable or archived.' : 'This task can no longer be edited.'; cx?.notify(); return; }
    const assignment = agents.find(agent => agent.key === this.agent);
    const fields = { agentKey: assignment?.key || null, agentName: assignment?.name || null, priority: this.priority,
      status: 'todo', manual: this.task ? Boolean(this.task.manual) : false,
      ...(this.parent ? { parentId: this.parent.gid } : {}),
      ...(this.asana ? { asana: this.asana } : {}), ...(this.mantisbt ? { mantisbt: this.mantisbt } : {}) };
    let task;
    if (this.task) {
      task = { ...this.task, name: this.title.value().trim(), notes: this.description.value().trim() };
      rememberBoardTask(this.project, task, fields);
    } else {
      try { task = createLocalTask(this.project, this.title.value(), this.description.value(), fields, liveAgents()); }
      catch (error) { this.error = error.message; cx?.notify(); return; }
    }
    if (!task) return;
    this.saved = true;
    setShared('herdr-zed.task-drafts', { ...(shared('herdr-zed.task-drafts') || {}), [this.draftKey]: null });
    this.openTask(task);
  }
  render(agents) {
    const t = boardTheme(), existing = this.existingImport(), editable = this.editable(), option = (key, label) => ({ key, label, color: t.foreground });
    const pick = (key, value, options, label, width) => Select(`task-composer-${key}`, this.selects[key], value, options, label,
      value => { this[key] = value; }, t, { width, boxed: true, radius: 5 });
    return v_flex().id('task-composer').size_full().min_h(0).rounded(12).border(1).border_color(t.border).bg(t.popover)
      .shadow_lg().overflow_hidden().font_family(t.fontFamily).text_color(t.foreground).track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); this.dismiss(); }
        if (event.key === 'enter' && (event.modifiers?.platform || event.modifiers?.control)) { cx.stop_propagation(); this.submit(agents, cx); }
      })
      .child(h_flex().h(52).flex_none().px(24).gap(10).items_center().text_size(12).text_color(t.muted)
        .child(h_flex().h(24).px(8).gap(6).items_center().rounded(999).border(1).border_color(t.controlBorder).bg(t.control)
          .child(glyph('folder', 12)).child(this.project.name))
        .when(Boolean(this.parent), el => el.child(glyph('chevron-right', 12))
          .child(div().max_w(180).truncate().child(this.parent.name)))
        .child(glyph('chevron-right', 12)).child(this.task ? 'Edit task' : this.parent ? 'New subtask' : this.mantisbt ? 'Import from MantisBT' : this.asana ? 'Import from Asana' : 'New task').child(div().flex_1())
        .child(Button('composer-close', t, { variant: 'ghost', size: 'icon' }).accessibility_label('Close task composer').tooltip('Close task composer')
          .on_click(() => this.dismiss()).child(glyph('close', 14))))
      .child(v_flex().id('composer-content').flex_1().min_h(0).overflow_y_scrollbar().px(24).gap(14)
        .when(Boolean(existing), el => el.child(div().text_size(12).text_color(t.muted).child('Already imported into this project. Open the existing task to keep its edits and execution history.')))
        .child(Input.new(this.title).id('composer-title').accessibility_label('Task title').w_full().h(36).text_size(22).font_semibold().bg(t.popover).border(0))
        .child(Textarea.new(this.description).id('composer-description').accessibility_label('Task description').w_full().text_size(14).bg(t.popover).border(0))
        .when(Boolean(this.error || (this.parent && !editable)), el => el.child(div().id('composer-error').text_size(12).text_color(t.destructive)
          .child(this.error || 'The parent task is unavailable or archived.'))))
      .child(h_flex().flex_none().px(24).py(16).gap(8).items_center().flex_wrap()
        .child(h_flex().h(28).px(8).gap(8).items_center().rounded(999).border(1).border_color(t.controlBorder).bg(t.control).text_size(12)
          .child(glyph('circle', 14).text_color(t.muted)).child('Todo'))
        .child(pick('priority', this.priority, boardPriorityOptions(t), 'Priority', 120))
        .child(pick('agent', this.agent, [{ ...option('unassigned', 'Unassigned'), icon: 'agent', iconColor: t.muted }, ...agents.map(agent => launcherOption(agent, accountAddresses(shared))).map(option => ({ ...option, color: option.unknown ? t.muted : t.foreground }))], 'Agent', 180)))
      .child(h_flex().h(60).flex_none().px(24).gap(12).items_center().border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child('⌘ / Ctrl Enter'))
        .child(div().flex_1())
        .child(Button('composer-submit', t).h(28).disabled(!this.title.value().trim() || !editable)
          .on_click((_event, cx) => this.submit(agents, cx)).child(existing ? 'Open existing task' : this.task ? 'Save task' : this.parent ? 'Create subtask' : 'Create task')));
  }
}
