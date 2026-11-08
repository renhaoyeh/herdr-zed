import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea, TextView } from 'gpui-base';
import { shared, setShared, agents as currentAgents, spaces as currentSpaces } from 'herdr';
import { SourceTaskReader } from './task-sources.js';
import { TaskSession } from './task-session.js';
import { boardStatuses, boardKey, liveVersion, boardPriorityOptions, boardPriorities, canStartTask, taskActions, taskManualStatusOptions, taskChildren, canAddSubtask } from './agent-board-model.js';
import { launcherLabel, launcherOption } from './model.js';
import { rememberBoardTask, projectBoardTasks, boardRecords, deleteLocalTask } from './agent-board-state.js';
import { readTaskOutput, taskIdentifier, outputMarkdown } from './agent-board-details.js';
import { glyph, AgentIcon } from './components/icon.js';
import { Button } from './components/button.js';
import { Select, SelectState } from './components/select.js';
import { SidePanelLayout, SidePanelState } from './components/side-panel.js';

export { boardTheme } from './board-theme.js';
import { boardTheme } from './board-theme.js';
import { openTaskComposer } from './task-composer.js';
const button = (id, t, options = {}) => Button(id, t, { variant: 'ghost', ...options });
const sourceName = task => task.mantisbt ? 'MantisBT' : task.asana ? 'Asana' : task.source === 'local' ? 'Local task' : task.source === 'thread' ? 'Agent thread' : 'Asana';

export default class AgentBoard {
  init(cx) {
    this.search = InputState.new({ placeholder: 'Search tasks…' });
    this.search.on('change', (_e, cx) => cx.notify());
    this.handle = cx.focus_handle(); this.statusSelect = new SelectState(cx); this.prioritySelect = new SelectState(cx); this.agentSelect = new SelectState(cx);
    this.title = InputState.new({ placeholder: 'Task title' });
    this.description = TextareaState.new({ placeholder: 'Add a description…' });
    this.description.set_auto_grow(4, 18);
    this.title.on('change', (_e, cx) => { this.saveField('name'); cx.notify(); });
    this.description.on('change', (_e, cx) => { this.saveField('notes'); cx.notify(); });
    this.title.on('blur', () => {
      if (this.editor && !this.title.value().trim()) {
        const task = this.latestTask(this.editor.project, this.editor.gid);
        if (task) this.title.set_value(task.name);
      }
    });
    this.detail = new SourceTaskReader(); this.detail.init(cx);
    this.session = new TaskSession(); this.session.init(cx);
    this.detailPanel = new SidePanelState(() => shared('devkits.task-detail-width') ?? 500,
      width => setShared('devkits.task-detail-width', width),
      { minWidth: 360, maxWidth: 880, defaultWidth: 500, minContentWidth: 320, label: 'Resize task details' });
    this.outputs = new Map();
    cx.timer.every(5000, cx => {
      if (shared('devkits.tasks-open') && this.project?.id === shared('devkits.board-project') && this.currentTask?.gid === this.selected)
        this.loadOutput(this.currentTask, this.project, cx);
    });
  }
  assignment(task, launchers, t, size = 14) {
    const key = task.agentKey || task.tabs.map(tab => shared('devkits.thread-profiles')?.[tab.id]).find(Boolean);
    const selected = launchers.find(agent => agent.key === key);
    const agent = selected || task.agents[0]?.program;
    const name = launcherLabel(selected?.name || task.agentName || agent?.name || 'Unassigned');
    return h_flex().gap(6).items_center().min_w(0).accessibility_label(`Agent: ${name}`)
      .child(agent?.icon ? AgentIcon(agent, t).size(size).flex_none() : glyph('agent', size).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(name));
  }
  compose(project, task = null, status = 'todo') {
    openTaskComposer(project, task, status);
  }
  composeSubtask(project, gid, cx) {
    const parent = this.latestTask(project, gid);
    if (!canAddSubtask(parent)) { this.relatedError = 'The parent task is unavailable or archived.'; cx.notify(); return; }
    openTaskComposer(project, null, 'todo', null, parent);
  }
  showRelated(project, gid, cx) {
    const task = this.latestTask(project, gid);
    if (!task) { this.relatedError = 'This task is no longer available.'; cx.notify(); return; }
    this.archived = Boolean(task.archived); this.show(task, project, cx);
  }
  latestTask(project, gid) {
    const current = currentSpaces().find(item => item.id === project.id) || (project.pending ? project : null);
    return current && projectBoardTasks(current, currentAgents()).find(task => task.gid === gid);
  }
  syncEditor(task, project) {
    const key = task && `${boardKey(project)}:${task.gid}`;
    if ((this.editor?.key || null) === key) return;
    this.editor = null;
    this.title.set_value(task?.name || ''); this.description.set_value(task?.notes || '');
    if (task) this.editor = { key, project, gid: task.gid };
  }
  saveField(field) {
    if (!this.editor) return;
    const { project, gid } = this.editor, task = this.latestTask(project, gid);
    if (task?.source !== 'local' || !taskActions(task).canEdit) return;
    const value = field === 'name' ? this.title.value().trim() : this.description.value();
    if ((field === 'name' && !value) || (task[field] || '') === value) return;
    rememberBoardTask(project, task, { [field]: value });
  }
  setStatus(project, gid, status) {
    const task = this.latestTask(project, gid);
    if (!taskActions(task).canSetStatus || !['todo', 'done', 'fail'].includes(status)) return false;
    rememberBoardTask(project, task, { status, manual: true, liveVersion: liveVersion(task.agents) });
    return true;
  }
  deleteTask(project, gid, cx) {
    const current = currentSpaces().find(item => item.id === project.id) || (project.pending ? project : null);
    if (!current || !deleteLocalTask(current, gid, currentAgents())) return;
    this.selected = null; this.currentTask = null; cx.notify();
  }
  cancelDrag(cx) {
    if (!this.drag) return;
    this.drag = null; this.dropStatus = null; cx.notify();
  }
  dragOver(status, event, cx) {
    if (!this.drag) return;
    const moved = Math.hypot(event.position.x - this.drag.x, event.position.y - this.drag.y) >= 5;
    if (!this.drag.active && !moved) return;
    this.drag.active = true;
    if (this.dropStatus !== status) { this.dropStatus = status; cx.notify(); }
  }
  drop(project, status, cx) {
    if (!this.drag?.active) { this.cancelDrag(cx); return; }
    const { gid } = this.drag;
    this.suppressClick = gid;
    this.setStatus(project, gid, status);
    this.cancelDrag(cx); cx.stop_propagation();
  }
  loadOutput(task, project, cx) {
    if (!task.agents.length) return;
    const key = `${project.folder}:${task.gid}`, previous = this.outputs.get(key);
    if (previous?.busy) return;
    const request = { ...previous, busy: true, error: null };
    this.outputs.set(key, request);
    cx.spawn(async cx => {
      try {
        const text = await readTaskOutput(task);
        if (this.outputs.get(key) !== request) return;
        this.outputs.set(key, { text, at: Date.now(), busy: false });
        const current = boardRecords(project)[task.gid];
        if (text && current && current.lastOutput !== text)
          rememberBoardTask(project, current, { lastOutput: text, lastOutputAt: Date.now() });
      } catch (error) { if (this.outputs.get(key) === request) this.outputs.set(key, { ...previous, error: error.message, busy: false }); }
      cx.notify();
    });
  }
  show(task, project, cx) {
    const key = JSON.stringify([boardKey(project), task.gid]);
    if (this.selected === task.gid && this.selection?.key === key && !this.detail.detailError) return;
    const selection = { key };
    this.selection = selection;
    this.relatedError = null;
    this.selected = task.gid; this.currentTask = task;
    this.detail.selected = null; this.detail.detail = null; this.detail.detailError = null;
    this.detail.detailRequest = null;
    this.detail.folder = project.folder;
    if (task.agentKey) setShared('devkits.asana-session', { ...(shared('devkits.asana-session') || {}), agent: task.agentKey });
    this.loadOutput(task, project, cx);
    if (task.source === 'local' || task.source === 'thread') { cx.notify(); return; }
    this.detail.show(task, cx); cx.notify();
  }
  render(project, agents, launchers, actions, cx) {
    this.project = project;
    if (this.projectKey !== boardKey(project)) {
      this.projectKey = boardKey(project); this.folder = project.folder; this.selected = null; this.currentTask = null;
      this.drag = null; this.dropStatus = null; this.search.set_value('');
    }
    const t = boardTheme(), tasks = projectBoardTasks(project, agents);
    const focus = shared('devkits.board-focus');
    if (focus) {
      setShared('devkits.board-focus', null);
      const task = tasks.find(task => task.gid === focus);
      if (task) { this.archived = Boolean(task.archived); this.show(task, project, cx); }
    }
    const query = this.search.value().trim().toLowerCase();
    const visible = tasks.filter(task => Boolean(task.archived) === Boolean(this.archived)
      && `${task.name} ${task.notes || ''} ${task.agentName || ''}`.toLowerCase().includes(query));
    const selected = tasks.find(task => task.gid === this.selected);
    if (!selected) this.detailPanel.end(cx);
    this.currentTask = selected || null;
    this.syncEditor(selected?.source === 'local' && taskActions(selected).canEdit ? selected : null, project);
    const icon = key => { const s = boardStatuses.find(s => s.key === key); return glyph(s.icon, 14).text_color(s.color); };
    const card = task => {
      const children = taskChildren(tasks, task.gid), completed = children.filter(child => child.status === 'done').length;
      return v_flex().id(`board-card-${task.gid}`).flex_none().p(12).gap(8).rounded(8).border(1)
      .border_color(this.selected === task.gid ? t.cardSelectedBorder : t.cardBorder)
      .bg(this.selected === task.gid ? t.cardSelected : t.card).text_size(13).cursor_default()
      .opacity(this.drag?.active && this.drag.gid === task.gid ? 0.4 : 1)
      .on_mouse_down('left', (event, _cx) => {
        this.suppressClick = null;
        if (taskActions(this.latestTask(project, task.gid)).canSetStatus) {
          this.handle.focus();
          this.drag = { gid: task.gid, x: event.position.x, y: event.position.y, active: false };
        }
      })
      .hover(el => el.bg(this.selected === task.gid ? t.cardSelected : t.cardHover)).on_click((_e, cx) => {
        // Stopping this click can also prevent the lane from receiving the release.
        const dragging = this.drag?.active;
        this.drop(project, task.status, cx);
        cx.stop_propagation();
        if (dragging || this.suppressClick === task.gid) { this.suppressClick = null; return; }
        this.show(task, project, cx);
      })
      .child(h_flex().gap(6).items_center().text_size(10).text_color(t.muted)
        .child(taskIdentifier(task)).child(div().flex_1())
        .when(Boolean(task.priority && task.priority !== 'none'), el => el.child(glyph(boardPriorities.find(priority => priority.key === task.priority)?.icon || 'priority-none', 14).text_color(task.priority === 'urgent' ? '#e4a45c' : t.muted).accessibility_label(`${task.priority} priority`))))
      .child(div().text_size(13).font_medium().child(task.name))
      .when(Boolean(task.parentTask), el => el.child(h_flex().gap(5).items_center().min_w(0).text_size(11).text_color(t.muted)
        .child(glyph('list-tree', 12)).child(div().min_w(0).truncate().child(task.parentTask.name))))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
        .child(this.assignment(task, launchers, t, 12).flex_1())
        .when(children.length > 0, el => el.child(h_flex().gap(4).items_center().accessibility_label(`${completed} of ${children.length} subtasks done`)
          .child(glyph('list-tree', 12)).child(`${completed}/${children.length}`)))
        .when(task.status === 'waiting', el => el.child(glyph('clock', 12).text_color('#b39af5'))));
    };
    const columns = h_flex().id('agent-board-columns').flex_1().h_full().min_w(0).min_h(0).overflow_x_scrollbar().px(8).gap(12)
      .on_click((_event, cx) => {
        if (this.suppressClick) { this.suppressClick = null; return; }
        if (!this.selected) return;
        this.selected = null; this.currentTask = null; this.selection = null; cx.notify();
      })
      .children(boardStatuses.map(status => {
        const rows = visible.filter(task => task.status === status.key);
        const canDrop = this.drag?.active && ['todo', 'done', 'fail'].includes(status.key)
          && taskActions(tasks.find(task => task.gid === this.drag.gid)).canSetStatus;
        return v_flex().id(`board-lane-${status.key}`).w(340).flex_none().h_full().min_h(0)
          .rounded(6).bg(canDrop && this.dropStatus === status.key ? t.selected : t.background)
          .when(Boolean(this.drag?.active), el => canDrop ? el.cursor_grabbing() : el.cursor_not_allowed())
          .on_mouse_move((event, cx) => this.dragOver(status.key, event, cx))
          .on_mouse_up('left', (_event, cx) => this.drop(project, status.key, cx))
          .child(h_flex().h(52).px(14).flex_none().gap(8).items_center().text_size(13).font_medium()
            .child(icon(status.key)).child(status.label).child(div().text_color(t.muted).font_normal().child(String(rows.length)))
            .child(div().flex_1())
            .when(!this.archived && status.key === 'todo', el => el.child(button(`board-add-${status.key}`, t, { size: 'icon' })
              .accessibility_label(`Create task in ${status.label}`).on_click((_event, cx) => {
                cx.stop_propagation(); this.compose(project, null, status.key);
              }).child(glyph('plus', 14)))))
          .child(v_flex().id(`board-column-${status.key}`).flex_1().min_h(0).overflow_y_scrollbar().px(8).gap(8).pb(24).children(rows.map(card)));
      }));
    const tab = (id, label, active, action) => button(id, t).h(28).px(10).rounded(999).border(1)
      .bg(active ? t.selected : t.control).border_color(t.controlBorder).text_color(active ? t.foreground : t.muted)
      .hover(el => el.bg(active ? t.selected : t.hover).text_color(active ? t.foreground : t.secondary))
      .accessibility_label(`${label}${active ? ', selected' : ''}`)
      .on_click((_e, cx) => { action(); this.cancelDrag(cx); cx.notify(); })
      .child(label);
    return v_flex().id('agent-board').size_full().min_w(0).min_h(0).font_family(t.fontFamily).bg(t.background).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape' && this.drag) { this.cancelDrag(cx); cx.stop_propagation(); return; }
        if (event.key === 'escape' && this.selected) { this.selected = null; this.currentTask = null; cx.stop_propagation(); cx.notify(); }
      })
      .on_mouse_up('left', (_event, cx) => this.cancelDrag(cx))
      .on_hover((inside, cx) => { if (!inside) this.cancelDrag(cx); })
      .child(h_flex().h(44).flex_none().px(24).gap(10).items_center().border_b(1).border_color(t.border).text_size(13)
        .child(glyph('columns-3', 15)).child(div().font_semibold().child('Tasks'))
        .child(div().text_color(t.muted).child('/')).child(div().truncate().text_color(t.muted).child(project.name))
        .child(div().flex_1())
        .child(button('board-asana', t).h(28).on_click(actions.asana).child('Import from Asana'))
        .child(button('board-mantisbt', t).h(28).on_click(actions.mantisbt).child('Import from MantisBT'))
        .child(button('board-new-task', t).pl(8).pr(10)
          .on_click(() => this.compose(project)).child(glyph('plus', 14)).child('New task')))
      .child(h_flex().h(44).flex_none().px(8).gap(4).items_center().text_size(12)
        .child(tab('board-active', 'All tasks', !this.archived, () => { this.archived = false; this.selected = null; }))
        .child(tab('board-archived', 'Archived', this.archived, () => { this.archived = true; this.selected = null; }))
        .child(div().flex_1())
        .child(Input.new(this.search).id('board-search').accessibility_label('Search tasks').w(180).h(28).px(10)
          .rounded(999).bg(t.control).border(1).border_color(t.controlBorder).text_size(12)))
      .child(h_flex().flex_1().min_w(0).min_h(0).child(selected
        ? SidePanelLayout('board-detail-split', this.detailPanel, columns, this.preview(selected, project, launchers, actions, t, cx, tasks))
        : columns));
  }
  subtasks(task, tasks, project, t) {
    const children = taskChildren(tasks, task.gid), completed = children.filter(child => child.status === 'done').length;
    return v_flex().id('board-subtasks').gap(8)
      .child(h_flex().gap(8).items_center().text_size(12)
        .child(div().font_medium().child('Subtasks')).child(div().text_color(t.muted).child(`${completed}/${children.length}`))
        .child(div().flex_1())
        .when(canAddSubtask(task), el => el.child(button('board-add-subtask', t).pl(8).pr(10)
          .on_click((_event, cx) => this.composeSubtask(project, task.gid, cx))
          .child(glyph('plus', 14)).child('Add subtask'))))
      .when(!children.length, el => el.child(div().text_size(12).text_color(t.muted).child('No subtasks yet')))
      .children(children.map(child => {
        const status = boardStatuses.find(status => status.key === child.status) || boardStatuses[0];
        return button(`board-subtask-${child.gid}`, t).w_full().h(36).px(8).gap(8).rounded(6).justify_start()
          .accessibility_label(`${child.name}, ${status.label}${child.archived ? ', archived' : ''}`)
          .on_click((_event, cx) => this.showRelated(project, child.gid, cx))
          .child(glyph(status.icon, 14).text_color(status.color))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(child.name))
          .when(Boolean(child.archived), el => el.child(div().text_size(10).text_color(t.muted).child('Archived')))
          .child(glyph('chevron-right', 12));
      }));
  }
  preview(task, project, launchers, actions, t, cx, tasks = []) {
    const origin = task.mantisbt || task.asana;
    const detail = task.source === 'local' || task.source === 'thread' ? { ...task, notes: task.notes || '', comments: origin?.comments || [] } : this.detail.detail;
    const output = this.outputs.get(`${project.folder}:${task.gid}`) || {};
    const text = output.text || task.lastOutput;
    const policy = taskActions(task);
    const status = boardStatuses.find(status => status.key === task.status);
    const priority = boardPriorities.find(priority => priority.key === task.priority) || boardPriorities[0];
    const latestTask = () => this.latestTask(project, task.gid);
    const setStatus = status => this.setStatus(project, task.gid, status);
    const setPriority = priority => { const current = latestTask(); if (taskActions(current).canEdit) rememberBoardTask(project, current, { priority }); };
    const editable = task.source === 'local' && policy.canEdit;
    const assignment = editable ? Select('board-task-agent', this.agentSelect, task.agentKey || 'unassigned', [
      { key: 'unassigned', label: 'Unassigned', color: t.foreground, icon: 'agent', iconColor: t.muted },
      ...launchers.map(agent => ({ ...launcherOption(agent), color: t.foreground })),
    ], 'Agent', key => {
      const current = latestTask(), agent = launchers.find(agent => agent.key === key);
      if (current?.source === 'local' && taskActions(current).canEdit)
        rememberBoardTask(project, current, { agentKey: agent?.key || null, agentName: agent?.name || null });
    }, t, { width: 190 }) : this.assignment(task, launchers, t);
    const statusValue = policy.canSetStatus
      ? Select('board-task-status', this.statusSelect, task.status, taskManualStatusOptions(t), 'Task status', setStatus, t, { width: 190 })
      : h_flex().gap(8).items_center().child(glyph(status.icon, 14).text_color(status.color)).child(status.label);
    const priorityValue = policy.canEdit
      ? Select('board-task-priority', this.prioritySelect, task.priority || 'none', boardPriorityOptions(t), 'Priority', setPriority, t, { width: 190 })
      : h_flex().gap(8).items_center().child(glyph(priority.icon, 14).text_color(t.muted)).child(priority.label);
    const launchRow = detail && canStartTask(task) ? this.session.render(detail, launchers, actions.start, t, cx) : null;
    const property = (label, value) => h_flex().min_h(28).gap(12).items_center().text_size(13)
      .child(div().w(74).flex_none().text_color(t.muted).child(label))
      .child(h_flex().min_w(0).flex_1().items_center().child(value));
    return v_flex().id('board-detail').w_full().h_full().flex_none().min_h(0).border_l(1).border_color(t.border).bg(t.background)
      .child(h_flex().h(40).flex_none().px(24).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(taskIdentifier(task)).child(div().flex_1())
        .child(button('board-close-detail', t, { size: 'icon' }).accessibility_label('Close task details')
          .on_click((_e, cx) => { this.selected = null; this.currentTask = null; cx.notify(); }).child(glyph('close', 14))))
      .child(v_flex().id('board-detail-scroll').flex_1().min_h(0).overflow_y_scrollbar().p(24).gap(20)
        .child(editable ? Input.new(this.title).id('board-task-title').accessibility_label('Task title').w_full().h(36)
          .text_size(22).font_semibold().bg(t.background).border(0) : div().text_size(22).font_semibold().child(task.name))
        .child(v_flex().gap(4)
          .child(property('Status', statusValue))
          .child(property('Agent', assignment))
          .when(Boolean(task.parentId), el => el.child(property('Parent', task.parentTask
            ? button('board-parent-task', t).max_w(260).on_click((_event, cx) => this.showRelated(project, task.parentId, cx))
              .child(glyph('list-tree', 13)).child(div().min_w(0).truncate().child(task.parentTask.name))
            : 'Unavailable task')))
          .child(property('Project', project.name)).child(property('Source', origin?.url
            ? button('board-asana-source', t).on_click((_e, cx) => cx.open_url(origin.url))
              .child(glyph('external-link', 14)).child(sourceName(task)) : sourceName(task)))
          .child(property('Priority', priorityValue)))
        .when(task.status === 'waiting', el => el.child(div().text_size(12).text_color('#b39af5').child('The agent needs your reply or approval.')))
        .when(Boolean(this.detail.detailError), el => el.child(div().text_size(12).text_color(t.destructive).child(this.detail.detailError)))
        .when(!detail && !this.detail.detailError, el => el.child(div().text_size(12).text_color(t.muted).child('Loading description…')))
        .when(editable, el => el.child(v_flex().gap(10)
          .child(div().text_size(12).font_medium().child('Description'))
          .child(Textarea.new(this.description).id('board-task-description').accessibility_label('Task description').w_full()
            .text_size(13).bg(t.background).border(0))))
        .when(!editable && Boolean(detail?.notes), el => el.child(v_flex().gap(10)
          .child(div().text_size(12).font_medium().child('Description'))
          .child(TextView.markdown(`board-description-${task.gid}`, detail.notes).selectable(true).scrollable(false).w_full().text_size(13))))
        .child(this.subtasks(task, tasks, project, t))
        .when(Boolean(this.relatedError), el => el.child(div().id('board-related-error').text_size(12).text_color(t.destructive).child(this.relatedError)))
        .when(task.tabs.length > 0, el => el.children(task.tabs.map(tab => button(`board-thread-${tab.id}`, t, { variant: 'secondary' }).h(28)
          .on_click(() => actions.thread(tab.id)).child(task.status === 'waiting' ? 'Respond to agent' : 'Open conversation').child(glyph('external-link', 12)))))
        .when(task.agents.length > 0 || Boolean(text), el => el.child(v_flex().gap(12)
          .child(h_flex().gap(8).items_center().text_size(12).font_medium()
            .child('Latest output').child(div().flex_1())
            .child(button('board-refresh-output', t, { size: 'icon' }).disabled(Boolean(output.busy)).accessibility_label('Refresh agent output')
              .on_click((_e, cx) => this.loadOutput(task, project, cx)).child(glyph('refresh-cw', 14))))
          .when(Boolean(output.error), el => el.child(div().text_size(12).text_color(t.destructive).child(output.error)))
          .when(!text && !output.error, el => el.child(div().text_size(12).text_color(t.muted).child('Reading agent output…')))
          .when(Boolean(text), el => el.child(TextView.markdown(`board-output-${task.gid}`, outputMarkdown(text)).selectable(true).scrollable(false).w_full().text_size(11)))))
        .children((detail?.comments || []).map(comment => v_flex().gap(8)
          .child(div().text_size(12).font_medium().child(comment.author))
          .child(TextView.markdown(`board-comment-${comment.gid}`, comment.text).selectable(true).scrollable(false).w_full().text_size(13)))))
      .when(Boolean(launchRow) || policy.canArchive || policy.canRestore || policy.canDelete, el => el.child(v_flex().flex_none().px(24).py(14).gap(12).border_t(1).border_color(t.border)
        .when(Boolean(launchRow), el => el.child(launchRow))
        .child(h_flex().gap(12).items_center()
          .when(policy.canArchive || policy.canRestore, el => el.child(button('board-archive-task', t).h(28).justify_start()
            .on_click((_e, cx) => task.archived ? actions.restore(task) : actions.archive(task, cx))
            .child(glyph(task.archived ? 'rotate-ccw' : 'archive', 13)).child(task.archived ? 'Restore task' : 'Archive task')))
          .child(div().flex_1())
          .when(policy.canDelete, el => el.child(button('board-delete-task', t).h(28).gap(6).text_color(t.destructive)
            .hover(el => el.bg(t.hover).text_color(t.destructive))
            .on_click((_e, cx) => this.deleteTask(project, task.gid, cx))
            .child(glyph('trash', 13)).child('Delete task'))))));
  }
}
