import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea, Popup } from 'gpui-base';
import { shared, setShared, props, openOverlay, closeOverlay } from 'herdr';
import { boardTheme } from './components/task-theme.js';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { glyph } from './components/icon.js';
import { mentionTrigger, calendarEntries, taskLinkState } from './calendar-tasks.js';
import { dayKey, nextDay, localDate, monthDays, weekDays, timelineEvents, timelineMinute, rangeDraft, eventsOnDay, eventTime, eventFromDraft, eventDraft, saveEvent, deleteEvent } from './calendar-model.js';

const storageKey = 'herdr-zed.calendar-events';
const previewKey = 'herdr-zed.calendar-previews';
// Only lifecycle markers cross views; the unsaved range stays in its parent.
const clearPreview = id => {
  const previews = shared(previewKey) || {};
  if (!id || !previews[id]) return;
  const next = { ...previews }; delete next[id]; setShared(previewKey, next);
};
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dateLabel = date => `${weekdays[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;

export default class LocalCalendar {
  constructor({ tasks = () => [], openTask = () => false, deleted = () => ({}) } = {}) { this.tasks = tasks; this.openTask = openTask; this.deleted = deleted; }

  init(cx) {
    const now = new Date(); this.month = new Date(now.getFullYear(), now.getMonth(), 1); this.selected = dayKey(now);
    const savedView = shared('herdr-zed.calendar-view'); this.view = ['day', 'week', 'month'].includes(savedView) ? savedView : 'month';
    this.handle = cx.focus_handle(); this.handle.focus(); this.inputs = {};
    for (const [key, placeholder] of Object.entries({ title: 'Event title', startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', startTime: '09:00', endTime: '10:00' })) {
      const input = InputState.new({ placeholder });
      input.on('change', (_event, cx) => {
        this.error = null;
        if (key === 'title') { this.titleError = false; this.changedMention('title', cx); }
        cx.notify();
      });
      this.inputs[key] = input;
    }
    this.notes = TextareaState.new({ placeholder: 'Add notes… Type @ to link a task' }); this.notes.set_auto_grow(3, 6);
    this.notes.on('change', (_event, cx) => { this.changedMention('notes', cx); cx.notify(); });
    this.mentionSearch = InputState.new({ placeholder: 'Search tasks…' });
    this.mentionSearch.on('change', (_event, cx) => { this.mentionIndex = 0; cx.notify(); });
    this.mentionSearch.on('submit', (_event, cx) => {
      if (this.mention) this.confirmMention(cx);
    });
    // Input consumes arrow/Enter/Escape actions before raw key handlers run.
    // Match its context only inside this picker, overriding its editing bindings.
    cx.bind_keys([
      { keystroke: 'up', action: 'herdr-zed-calendar-mention-up', context: 'HerdrZedCalendarMention > Input' },
      { keystroke: 'down', action: 'herdr-zed-calendar-mention-down', context: 'HerdrZedCalendarMention > Input' },
      { keystroke: 'enter', action: 'herdr-zed-calendar-mention-confirm', context: 'HerdrZedCalendarMention > Input' },
      { keystroke: 'escape', action: 'herdr-zed-calendar-mention-dismiss', context: 'HerdrZedCalendarMention > Input' },
    ]);
    this.mentionHandle = cx.focus_handle(); this.previousText = {};
    this.creating = Boolean(props()?.calendarCreate);
    this.previewId = props()?.calendarPreview || null;
    if (this.creating) this.edit(null, cx, props()?.draft || {});
  }

  records() { return shared(storageKey) || {}; }
  taskEventLabel(event) {
    const link = taskLinkState(event.taskLink, this.tasks(), this.deleted());
    return `${link.label} · ${link.state}`;
  }
  eventLabel(event) {
    if (!event.taskLink) return event.title;
    const link = taskLinkState(event.taskLink, this.tasks(), this.deleted());
    return event.dueMarker ? `Due · ${link.label} · ${link.state}` : `${event.title} · ${link.state}`;
  }

  choose(date, cx, reveal = false) {
    this.selected = dayKey(date);
    if (reveal) this.month = new Date(date.getFullYear(), date.getMonth(), 1);
    cx.notify();
  }

  chooseClicked(date, cx) {
    if (this.suppressClick) { this.suppressClick = false; return; }
    this.choose(date, cx);
  }

  moveMonth(delta, cx) {
    this.month = new Date(this.month.getFullYear(), this.month.getMonth() + delta, 1);
    const day = Math.min(localDate(this.selected).getDate(), new Date(this.month.getFullYear(), this.month.getMonth() + 1, 0).getDate());
    this.selected = dayKey(new Date(this.month.getFullYear(), this.month.getMonth(), day)); cx.notify();
  }

  setView(view, cx) {
    if (!['day', 'week', 'month'].includes(view) || this.view === view) return;
    this.cancelRange(cx); this.view = view; setShared('herdr-zed.calendar-view', view);
    this.choose(localDate(this.selected), cx, true);
  }

  navigate(delta, cx) {
    this.cancelRange(cx);
    if (this.view === 'month') this.moveMonth(delta, cx);
    else this.choose(nextDay(localDate(this.selected), delta * (this.view === 'week' ? 7 : 1)), cx, true);
  }

  periodLabel() {
    if (this.view === 'month') return `${months[this.month.getMonth()]} ${this.month.getFullYear()}`;
    const day = localDate(this.selected);
    if (this.view === 'day') return `${dateLabel(day)}, ${day.getFullYear()}`;
    const days = weekDays(day), start = days[0], end = days[6];
    return `${months[start.getMonth()]} ${start.getDate()}${start.getFullYear() !== end.getFullYear() ? `, ${start.getFullYear()}` : ''} – ${months[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
  }

  edit(event, cx, initial = {}, previewId = null) {
    if (event?.dueMarker) { this.visitTask(event.taskLink.id, cx); return; }
    if (!event && !this.creating) {
      this.cancelRange(cx);
      try {
        openOverlay({ mod: 'herdr-zed-calendar', kind: 'dialog', frame: 'none', modal: true, width: 560, height: 480,
          props: { view: 'calendar', calendarCreate: true, calendarPreview: previewId, calendarParent: props()?.overlay,
            draft: { startDate: this.selected, endDate: this.selected, ...initial } } });
      } catch (error) { clearPreview(previewId); throw error; }
      return;
    }
    this.editing = event?.id || null; this.revision = event?.revision || null; this.composing = true; this.error = null; this.titleError = false;
    const draft = event ? eventDraft(event) : { title: '', notes: '', startDate: this.selected, endDate: this.selected, startTime: '09:00', endTime: '10:00', allDay: false, ...initial };
    this.taskLink = draft.taskLink || null;
    this.mention = null;
    for (const [key, input] of Object.entries(this.inputs)) input.set_value(key === 'title' ? draft.titleContent || draft.title : draft[key]);
    this.notes.set_value(draft.notesContent || draft.notes || ''); this.allDay = draft.allDay;
    this.previousText = { title: this.inputs.title.value(), notes: this.notes.value() };
    this.inputs.title.focus(); cx.notify();
  }

  cancel(cx) {
    if (this.mention) this.dismissMention(cx, false);
    if (this.creating) { this.composing = false; clearPreview(this.previewId); closeOverlay(props().overlay); return; }
    this.composing = false; this.editing = null; this.error = null; this.handle.focus(); cx.notify();
  }

  cancelRange(cx) { if (this.drag) { this.drag = null; cx.notify(); } }

  close() { clearPreview(this.previewId); clearPreview(this.pendingRange?.id); }

  startRange(date, event, cx, timed = false, clickToCreate = false) {
    if (this.creating) return;
    const minute = timed ? timelineMinute(event.position.y, event.bounds) : 0;
    if (minute === null) return;
    cx.stop_propagation(); this.handle.focus(); this.suppressClick = false;
    this.drag = { startDate: dayKey(date), endDate: dayKey(date), startMinute: timed ? Math.min(1425, minute) : 0,
      endMinute: minute, timed, clickToCreate: timed || clickToCreate, x: event.position.x, y: event.position.y, active: false };
    cx.notify();
  }

  moveRange(date, event, cx, timed = false) {
    const drag = this.drag;
    if (!drag || drag.timed !== timed) return;
    const minute = timed ? timelineMinute(event.position.y, event.bounds) : 0;
    if (minute === null) return;
    const endDate = dayKey(date), active = drag.active || Math.hypot(event.position.x - drag.x, event.position.y - drag.y) >= 4;
    if (endDate !== drag.endDate || minute !== drag.endMinute || active !== drag.active) {
      Object.assign(drag, { endDate, endMinute: minute, active }); cx.notify();
    }
  }

  finishRange(cx) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (!drag.active && !drag.clickToCreate) { cx.notify(); return; }
    const draft = rangeDraft(drag.startDate, drag.startMinute, drag.endDate, drag.endMinute, !drag.timed);
    const id = uid();
    clearPreview(this.pendingRange?.id);
    this.pendingRange = { id, draft };
    setShared(previewKey, { ...(shared(previewKey) || {}), [id]: true });
    this.choose(localDate(draft.startDate), cx);
    this.edit(null, cx, draft, id); this.suppressClick = true; cx.stop_propagation(); cx.notify();
  }

  selectedRange() {
    const drag = this.drag;
    if (drag) return rangeDraft(drag.startDate, drag.startMinute, drag.endDate, drag.endMinute, !drag.timed);
    return this.pendingRange && shared(previewKey)?.[this.pendingRange.id] ? this.pendingRange.draft : null;
  }

  save(cx) {
    if (!this.composing) return;
    if (this.mention) this.dismissMention(cx, false);
    if (!this.inputs.title.value().trim()) {
      this.error = 'Enter an event title.'; this.titleError = true; this.inputs.title.focus(); cx.notify(); return;
    }
    try {
      const event = eventFromDraft({ ...Object.fromEntries(Object.entries(this.inputs).map(([key, input]) => [key, input.value().trim()])),
        titleContent: this.inputs.title.content(), notes: this.notes.value(), notesContent: this.notes.content(), allDay: this.allDay,
        taskLink: this.taskLink }, this.editing || uid(), uid());
      setShared(storageKey, saveEvent(this.records(), event, this.revision));
      this.choose(localDate(event.allDay ? event.start : dayKey(new Date(event.start))), cx, true);
      this.cancel(cx);
    } catch (error) { this.error = error.message; cx.notify(); }
  }

  remove(cx) {
    if (!this.editing) return;
    try { setShared(storageKey, deleteEvent(this.records(), this.editing, this.revision)); this.cancel(cx); }
    catch (error) { this.error = error.message; cx.notify(); }
  }

  mentionInput(field) { return field === 'title' ? this.inputs.title : this.notes; }

  changedMention(field, cx) {
    const input = this.mentionInput(field), text = input.value();
    const previous = this.previousText[field] || '';
    this.previousText[field] = text;
    if (!this.composing || this.insertingMention || previous === text) return;
    if (this.mention) this.dismissMention(cx, false);
    const trigger = mentionTrigger(previous, text, input.tokens());
    if (!trigger) return;
    this.mention = { field, ...trigger, text, anchor: `calendar-mention:${uid()}` };
    // The native editor lays this temporary @ token out at the actual glyph,
    // accounting for shaped text, wrapping, zoom and its own scroll offset.
    this.insertingMention = true;
    try { input.replace_range_with_token({ start: trigger.range.start, end: trigger.range.start + 1 }, { id: this.mention.anchor, text: '@' }); }
    finally { this.insertingMention = false; }
    this.mentionIndex = 0; this.mentionSearch.set_value(trigger.query); this.mentionSearch.focus(); cx.notify();
  }

  mentionItems() {
    const query = this.mentionSearch.value().trim().toLowerCase();
    return this.tasks().filter(task => !task.archived && `${task.name} ${task.project.name}`.toLowerCase().includes(query));
  }

  moveMention(delta, cx) {
    if (!this.mention) return;
    const count = this.mentionItems().length, index = Math.min(this.mentionIndex, Math.max(0, count - 1));
    this.mentionIndex = count ? (index + delta + count) % count : 0;
    cx.notify();
  }

  confirmMention(cx) {
    const items = this.mentionItems();
    this.insertMention(items[Math.min(this.mentionIndex, Math.max(0, items.length - 1))]?.id, cx);
  }

  dismissMention(cx, focus = true) {
    const mention = this.mention; this.mention = null;
    if (mention) {
      const input = this.mentionInput(mention.field), content = input.content();
      if (content.tokens.some(({ token }) => token.id === mention.anchor))
        input.set_value({ ...content, tokens: content.tokens.filter(({ token }) => token.id !== mention.anchor) });
      if (focus) {
        const caret = Math.min(mention.range.end, content.text.length);
        input.set_selected_range({ start: caret, end: caret }); input.focus();
      }
    }
    cx.notify();
  }

  insertMention(id, cx) {
    const mention = this.mention, task = this.mentionItems().find(task => task.id === id);
    if (!mention || !task) return;
    const input = this.mentionInput(mention.field);
    if (input.value() !== mention.text) { this.dismissMention(cx); return; }
    this.mention = null; this.insertingMention = true;
    try { input.replace_range_with_token(mention.range, { id: task.id, text: `@${task.name}`, label: task.name }); }
    finally { this.insertingMention = false; }
    this.previousText[mention.field] = input.value(); input.focus(); cx.notify();
  }

  visitTask(id, cx) {
    if (this.creating) return;
    const opened = this.openTask(id);
    if (opened === null) return; // The Tasks owner is validating this navigation request.
    if (opened) closeOverlay(props().overlay);
    else { this.error = 'This task is no longer available in your projects.'; cx.notify(); }
  }

  mentionField(field, control, t) {
    const tasks = this.tasks(), mention = this.mention?.field === field ? this.mention : null;
    return control.token(context => {
      if (mention && context.token.id === mention.anchor)
        return Popup.new(`calendar-${field}-mentions`, div().h(context.line_height).text_size(field === 'title' ? 20 : 13).child('@'))
          .relative().anchor('top_left').content(div().pt(4).child(this.mentionMenu(t)));
      const task = tasks.find(task => task.id === context.token.id);
      const state = taskLinkState({ id: context.token.id, label: context.token.label || context.token.text.slice(1) }, tasks, this.deleted());
      return div().px(4).rounded(4).bg(context.selected ? t.solid : t.selected).text_color(context.selected ? t.solid_foreground : t.secondary)
        .max_w(context.available_width).truncate().text_size(Math.min(14, context.line_height * 0.7))
        .child(`@${state.label}${!task || task.archived ? ` · ${state.state}` : ''}`);
    }).on_token_click((event, cx) => {
      if (event.token.id === this.mention?.anchor) this.mentionSearch.focus();
      else this.visitTask(event.token.id, cx);
    });
  }

  mentionMenu(t) {
    const anchor = this.mention?.anchor, items = this.mentionItems(), index = Math.min(this.mentionIndex, Math.max(0, items.length - 1));
    return v_flex().id('calendar-task-picker').w(300).p(4).rounded(12).border(1).border_color(t.border)
      .bg(t.popover).font_family(t.fontFamily).font_normal().text_color(t.foreground).text_size(13).shadow_md()
      .track_focus(this.mentionHandle).role('list_box').accessibility_label('Link a task')
      .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
      .on_mouse_down_out((_event, cx) => this.dismissMention(cx, false))
      .child(div().id(`calendar-task-search-host-${anchor}`).on_size_change((_size, cx) => {
        // Inline content mounts during layout, after the initial focus request.
        if (this.mention?.anchor === anchor && this.focusedMention !== anchor) {
          this.focusedMention = anchor; this.mentionSearch.focus(); cx.notify();
        }
      }).child(Input.new(this.mentionSearch).id('calendar-task-search').accessibility_label('Search tasks')
        .w_full().h(36).px(10).border(0).border_b(1).border_color(t.border).bg(t.popover)))
      .child(v_flex().max_h(224).overflow_y_scroll()
        .when(!items.length, el => el.child(div().p(12).text_color(t.muted).child('No tasks found')))
        .children(items.map((task, i) => h_flex().id(`calendar-task-option-${i}`).h(40).px(10).gap(8).rounded(8)
          .items_center().bg(i === index ? t.menuHover : t.popover).hover(el => el.bg(t.menuHover))
          .role('list_box_option').accessibility_label(`${task.name}, ${task.project.name}`)
          .when(i === index, el => el.aria_active_descendant())
          .on_click((_event, cx) => { cx.stop_propagation(); this.insertMention(task.id, cx); })
          .child(glyph('circle', 13).text_color(t.muted))
          .child(v_flex().flex_1().min_w(0).gap(2).child(div().truncate().child(task.name))
            .child(div().truncate().text_size(10).text_color(t.muted).child(task.project.name))))));
  }

  editor(t) {
    const titleBlank = !this.inputs.title.value().trim();
    const field = (key, label) => v_flex().flex_1().min_w(0).gap(6)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(Input.new(this.inputs[key]).id(`calendar-input-${key}`).accessibility_label(label).w_full().h(32).px(8).text_size(12)
        .border(1).border_color(t.controlBorder).rounded(5).bg(t.control));
    return v_flex().flex_1().min_h(0).gap(16)
      .child(h_flex().items_center().gap(8).flex_none()
        .child(div().flex_1().text_size(13).font_medium().child(this.editing ? 'Edit event' : 'New event'))
        .child(Button('calendar-editor-close', t, { variant: 'ghost', size: 'icon' }).accessibility_label('Cancel event editing').tooltip('Cancel event editing')
          .child(glyph('close')).on_click((_event, cx) => this.cancel(cx))))
      .child(v_flex().flex_1().min_h(0).gap(16).overflow_y_scroll()
        .child(v_flex().gap(4)
          .child(this.mentionField('title', Input.new(this.inputs.title).id('calendar-input-title').accessibility_label('Event title (required)').w_full().h(36).text_size(20).font_semibold().bg(t.background).border(0)
            .when(Boolean(this.titleError), el => el.border_b(1).border_color(t.destructive)), t))
          .when(titleBlank, el => el.child(div().id('calendar-title-hint').text_size(12).text_color(this.titleError ? t.destructive : t.muted)
            .child('Enter an event title.'))))
        .child(Checkbox('calendar-all-day', Boolean(this.allDay), t).text_size(12).child('All day')
          .on_change((checked, cx) => { this.allDay = checked; this.error = null; cx.notify(); }))
        .child(h_flex().gap(12).child(field('startDate', 'Start date')).child(field('endDate', 'End date')))
        .when(!this.allDay, el => el.child(h_flex().gap(12).child(field('startTime', 'Start time')).child(field('endTime', 'End time'))))
        .child(div().text_size(11).text_color(t.muted).child(this.allDay ? 'Dates use YYYY-MM-DD. Includes the end date.' : 'Dates: YYYY-MM-DD · Times: HH:MM (24-hour)'))
        .when(Boolean(this.taskLink), el => {
          const link = taskLinkState(this.taskLink, this.tasks(), this.deleted());
          return el.child(v_flex().id('calendar-linked-task').gap(6)
            .child(div().text_size(11).text_color(t.muted).child('Scheduled task'))
            .child(div().text_size(13).child(`${link.label} · ${link.state}`))
            .child(h_flex().gap(6)
              .when(!this.creating, row => row.child(Button('calendar-open-linked-task', t, { variant: 'ghost' }).child('Open task')
                .on_click((_e, cx) => this.visitTask(this.taskLink.id, cx))))
              .child(Button('calendar-unlink-task', t, { variant: 'ghost' }).child('Unlink')
                .on_click((_e, cx) => { this.taskLink = null; cx.notify(); }))));
        })
        .child(this.mentionField('notes', Textarea.new(this.notes).id('calendar-input-notes').accessibility_label('Event notes').w_full().text_size(13).bg(t.background).border(0), t))
        .child(div().text_size(11).text_color(t.muted).child('Type @ in the title or notes to link a task.'))
        .when(Boolean(this.error && !this.titleError), el => el.child(div().text_size(12).text_color(t.destructive).child(this.error))))
      .child(h_flex().flex_none().gap(8).items_center().flex_wrap()
        .when(Boolean(this.editing), el => el.child(Button('calendar-delete', t, { variant: 'ghost' }).text_color(t.destructive).child('Delete event').on_click((_event, cx) => this.remove(cx))))
        .child(div().flex_1())
        .child(Button('calendar-cancel', t, { variant: 'outline' }).child('Cancel').on_click((_event, cx) => this.cancel(cx)))
        .child(Button('calendar-save', t).disabled(titleBlank).when(titleBlank, el => el.opacity(0.45))
          .child(this.editing ? 'Save' : 'Create event').on_click((_event, cx) => this.save(cx))));
  }

  agenda(t, events) {
    const day = localDate(this.selected), items = eventsOnDay(events, day);
    return v_flex().flex_1().min_h(0).gap(16)
      .child(h_flex().flex_none().items_center().gap(8)
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(14).font_medium().child(dateLabel(day)))
          .child(div().text_size(11).text_color(t.muted).child(`${items.length} ${items.length === 1 ? 'event' : 'events'}`)))
        .child(Button('calendar-day-add', t, { variant: 'ghost', size: 'icon' }).accessibility_label('New event on selected day').tooltip('New event on selected day').child(glyph('plus')).on_click((_event, cx) => this.edit(null, cx))))
      .child(v_flex().flex_1().min_h(0).gap(8).overflow_y_scroll()
        .when(!items.length, el => el.child(v_flex().py(32).gap(12).items_start()
          .child(div().text_size(13).text_color(t.muted).child('No events on this day'))
          .child(Button('calendar-empty-add', t, { variant: 'outline' }).child('Add event').on_click((_event, cx) => this.edit(null, cx)))))
        .children(items.map(event => Button(`calendar-agenda-${event.id}`, t, { variant: 'ghost' }).w_full().h_auto().p(12).rounded(8).justify_start()
          .bg(t.card).border(1).border_color(t.cardBorder).hover(el => el.bg(t.cardHover))
          .on_click((_event, cx) => this.edit(event, cx))
          .child(v_flex().flex_1().min_w(0).gap(6)
            .child(div().text_size(13).text_color(t.foreground).child(event.title))
            .when(Boolean(event.taskLink), el => el.child(div().text_size(11).text_color(t.muted)
              .child(this.taskEventLabel(event))))
            .child(div().text_size(11).text_color(t.muted).child(eventTime(event, day)))
            .when(Boolean(event.notes), el => el.child(div().truncate().text_size(12).text_color(t.muted).child(event.notes)))))));
  }

  grid(t, events) {
    const today = dayKey(new Date()), weeks = monthDays(this.month), range = this.selectedRange();
    return v_flex().id('calendar-month-grid').flex_1().min_w(0).min_h(0).overflow_y_scroll()
      .on_hover((inside, cx) => { if (!inside && this.drag && !this.drag.timed) this.cancelRange(cx); })
      .child(h_flex().h(32).flex_none().border_b(1).border_color(t.border)
        .children(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => div().flex_1().flex().items_center().justify_center().text_size(11).text_color(t.muted).child(day))))
      .children(weeks.map((week, row) => h_flex().flex_1().min_h(82).items_stretch()
        .children(week.map((date, col) => {
          const key = dayKey(date), items = eventsOnDay(events, date), selected = key === this.selected;
          return v_flex().id(`calendar-cell-${key}`).flex_1().min_w(0).min_h(0).p(5).gap(3).overflow_hidden()
            .bg(range && key >= range.startDate && key <= range.endDate ? `${t.solid}33` : selected ? t.selected : t.background)
            .when(col < 6, el => el.border_r(1)).when(row < 5, el => el.border_b(1)).border_color(t.border)
            .on_mouse_down('left', (event, cx) => this.startRange(date, event, cx))
            .on_mouse_move((event, cx) => this.moveRange(date, event, cx))
            .on_mouse_up('left', (event, cx) => { this.moveRange(date, event, cx); this.finishRange(cx); })
            .on_click((_event, cx) => this.chooseClicked(date, cx))
            .child(h_flex().flex_none().child(Button(`calendar-date-${key}`, t, { variant: 'ghost', size: 'icon-sm' }).size(24)
              .bg(key === today ? t.solid : '#00000000').text_color(key === today ? t.solid_foreground : date.getMonth() === this.month.getMonth() ? t.secondary : t.muted)
              .accessibility_label(date.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })).tooltip(date.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))
              .on_mouse_down('left', (event, cx) => this.startRange(date, event, cx))
              .on_mouse_up('left', (event, cx) => { this.moveRange(date, event, cx); this.finishRange(cx); })
              .child(String(date.getDate())).on_click((_event, cx) => { cx.stop_propagation(); this.chooseClicked(date, cx); })))
            .children(items.slice(0, 2).map(event => Button(`calendar-chip-${key}-${event.id}`, t, { variant: 'ghost' }).w_full().h(21).px(5).rounded(4).justify_start().gap(4)
              .bg(t.card).text_color(t.secondary).hover(el => el.bg(t.cardHover))
              .accessibility_label(`${event.title}, ${eventTime(event, date)}`)
              .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); this.suppressClick = false; })
              .on_mouse_up('left', (_event, cx) => { if (this.drag) this.finishRange(cx); })
              .on_click((_event, cx) => {
                cx.stop_propagation();
                if (this.suppressClick) { this.suppressClick = false; return; }
                if (this.drag) { this.finishRange(cx); return; }
                this.choose(date, cx); this.edit(event, cx);
              })
              .child(div().size(4).flex_none().rounded(2).bg(t.solid))
              .child(div().min_w(0).truncate().text_size(11).child(this.eventLabel(event)))))
            .when(items.length > 2, el => el.child(div().text_size(10).text_color(t.muted).child(`+${items.length - 2} more`)));
        }))));
  }

  timeline(t, events) {
    const day = localDate(this.selected), days = this.view === 'week' ? weekDays(day) : [day], hourHeight = 40;
    const today = dayKey(new Date()), range = this.selectedRange();
    let preview = null;
    if (range && !range.allDay) {
      try { preview = eventFromDraft({ ...range, title: 'New event' }, 'selection', 'selection'); } catch {}
    }
    const eventButton = (event, date, id) => Button(id, t, { variant: 'ghost' }).w_full().h_auto().min_h(22).px(6).py(3).rounded(4).justify_start()
      .bg(t.selected).text_color(t.secondary).hover(el => el.bg(t.cardHover))
      .accessibility_label(`${event.title}, ${eventTime(event, date)}`)
      .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); this.suppressClick = false; })
      .on_mouse_up('left', (_event, cx) => { if (this.drag) this.finishRange(cx); })
      .on_click((_event, cx) => {
        cx.stop_propagation();
        if (this.suppressClick) { this.suppressClick = false; return; }
        if (this.drag) { this.finishRange(cx); return; }
        this.choose(date, cx); this.edit(event, cx);
      });
    return v_flex().id(`calendar-${this.view}-view`).flex_1().min_w(0).min_h(0)
      .child(h_flex().h(44).flex_none().items_stretch().border_b(1).border_color(t.border)
        .child(div().w(52).flex_none())
        .children(days.map(date => Button(`calendar-timeline-day-${dayKey(date)}`, t, { variant: 'ghost' }).flex_1().min_w(0).h_full().rounded(0)
          .bg(dayKey(date) === this.selected ? t.selected : '#00000000')
          .text_color(dayKey(date) === today ? t.solid : t.secondary)
          .child(`${weekdays[date.getDay()].slice(0, 3)} ${date.getDate()}`)
          .on_click((_event, cx) => this.choose(date, cx)))))
      .child(h_flex().flex_none().min_h(42).max_h(108).overflow_y_scroll().items_stretch().border_b(1).border_color(t.border)
        .on_hover((inside, cx) => { if (!inside && this.drag && !this.drag.timed) this.cancelRange(cx); })
        .child(div().w(52).flex_none().pt(8).px(5).text_size(10).text_color(t.muted).child('All day'))
        .children(days.map(date => v_flex().id(`calendar-all-day-cell-${dayKey(date)}`).flex_1().min_w(0).gap(3).p(4).border_l(1).border_color(t.border)
          .bg(range?.allDay && dayKey(date) >= range.startDate && dayKey(date) <= range.endDate ? `${t.solid}33` : '#00000000')
          .on_mouse_down('left', (event, cx) => this.startRange(date, event, cx, false, true))
          .on_mouse_move((event, cx) => this.moveRange(date, event, cx))
          .on_mouse_up('left', (event, cx) => { this.moveRange(date, event, cx); this.finishRange(cx); })
          .children(eventsOnDay(events, date).filter(event => event.allDay).map(event => eventButton(event, date, `calendar-all-day-${dayKey(date)}-${event.id}`)
            .child(div().min_w(0).truncate().text_size(11).child(this.eventLabel(event))))))))
      .child(h_flex().id(`calendar-timeline-scroll-${this.view}`).flex_1().min_h(0).overflow_y_scroll().items_stretch()
        .on_hover((inside, cx) => { if (!inside && this.drag?.timed) this.cancelRange(cx); })
        .child(div().relative().w(52).h(hourHeight * 24).flex_none()
          .children(Array.from({ length: 24 }, (_, hour) => div().absolute().top(hour * hourHeight + 3).left(5).text_size(10).text_color(t.muted)
            .child(`${String(hour).padStart(2, '0')}:00`))))
        .children(days.map(date => div().id(`calendar-timeline-column-${dayKey(date)}`).relative().flex_1().min_w(0).h(hourHeight * 24)
          .border_l(1).border_color(t.border).bg(dayKey(date) === this.selected ? t.card : t.background)
          .cursor_crosshair()
          .on_mouse_down('left', (event, cx) => this.startRange(date, event, cx, true))
          .on_mouse_move((event, cx) => this.moveRange(date, event, cx, true))
          .on_mouse_up('left', (event, cx) => { this.moveRange(date, event, cx, true); this.finishRange(cx); })
          .on_click((_event, cx) => this.chooseClicked(date, cx))
          .children(Array.from({ length: 24 }, (_, hour) => div().absolute().top(hour * hourHeight).left(0).right(0).h(hourHeight)
            .border_t(1).border_color(t.border)))
          .children(preview ? timelineEvents([preview], date, hourHeight).map(row => div().id(`calendar-selection-${dayKey(date)}`)
            .absolute().top(row.top).left(2).right(2).h(row.height).rounded(4).border(1).border_color(t.solid).bg(`${t.solid}33`).p(3)
            .child(div().text_size(11).text_color(t.solid).child(eventTime(preview, date)))) : [])
          .children(timelineEvents(events, date, hourHeight).map(row => div().absolute().top(row.top).left(`${row.column * 100 / row.columns}%`)
            .w(`${100 / row.columns}%`).h(row.height).px(2).pb(1)
            .child(eventButton(row.event, date, `calendar-timed-${dayKey(date)}-${row.event.id}`).h_full().items_start().overflow_hidden()
              .child(v_flex().flex_1().min_w(0).gap(2)
                .child(div().min_w(0).truncate().text_size(11).font_medium().child(this.eventLabel(row.event)))
                .when(row.height >= 36, el => el.child(div().truncate().text_size(10).text_color(t.muted).child(eventTime(row.event, date)))))))))));
  }

  mentionKeyboard(root) {
    // Register at the owning view, outside the inline token's layout callback.
    return root.when(Boolean(this.mention), el => el.key_context('HerdrZedCalendarMention')
      .on_action('herdr-zed-calendar-mention-up', (_event, cx) => { cx.stop_propagation(); this.moveMention(-1, cx); })
      .on_action('herdr-zed-calendar-mention-down', (_event, cx) => { cx.stop_propagation(); this.moveMention(1, cx); })
      .on_action('herdr-zed-calendar-mention-confirm', (_event, cx) => { cx.stop_propagation(); this.confirmMention(cx); })
      .on_action('herdr-zed-calendar-mention-dismiss', (_event, cx) => { cx.stop_propagation(); this.dismissMention(cx); }));
  }

  render() {
    const t = boardTheme(), events = calendarEntries(Object.values(this.records()), this.tasks()), close = () => closeOverlay(props().overlay);
    if (this.creating) return this.mentionKeyboard(v_flex().id('calendar-create-dialog').size_full().min_h(0).p(24).rounded(12).border(1).border_color(t.border)
      .bg(t.popover).font_family(t.fontFamily).text_color(t.foreground).role('dialog').accessibility_label('New event').track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); this.cancel(cx); }
        else if (event.key === 'enter' && (event.modifiers?.platform || event.modifiers?.control)) { cx.stop_propagation(); this.save(cx); }
      }).child(this.editor({ ...t, background: t.popover })));
    return this.mentionKeyboard(v_flex().id('local-calendar').size_full().min_h(0).overflow_hidden().when(!props()?.docked, el => el.rounded(12).border(1).border_color(t.border))
      .bg(t.background).font_family(t.fontFamily).text_color(t.foreground).role('dialog').accessibility_label('Calendar').track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); if (this.drag) this.cancelRange(cx); else this.composing ? this.cancel(cx) : close(); }
        else if (this.composing && event.key === 'enter' && (event.modifiers?.platform || event.modifiers?.control)) { cx.stop_propagation(); this.save(cx); }
      })
      .on_mouse_up('left', (_event, cx) => this.cancelRange(cx))
      .on_hover((inside, cx) => { if (!inside) this.cancelRange(cx); })
      .child(h_flex().h(56).flex_none().px(20).gap(10).items_center().border_b(1).border_color(t.border)
        .child(glyph('calendar', 16).text_color(t.muted)).child(div().text_size(14).font_semibold().child('Calendar'))
        .child(div().flex_1())
        .child(h_flex().gap(4).items_center().children([['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([view, label]) =>
          Button(`calendar-view-${view}`, t, { variant: 'outline' }).bg(this.view === view ? t.selected : t.control)
            .hover(el => el.bg(this.view === view ? t.selected : t.hover)).accessibility_label(`${label} view${this.view === view ? ', selected' : ''}`)
            .child(label).on_click((_event, cx) => this.setView(view, cx)))))
        .child(Button('calendar-today', t, { variant: 'outline' }).child('Today').on_click((_event, cx) => this.choose(new Date(), cx, true)))
        .child(Button('calendar-new', t).child(glyph('plus')).child('New event').on_click((_event, cx) => this.edit(null, cx)))
        .child(Button('calendar-close', t, { variant: 'ghost', size: 'icon' }).accessibility_label('Close calendar').tooltip('Close calendar').child(glyph('close')).on_click(close)))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .child(v_flex().flex_1().min_w(0).min_h(0)
          .child(h_flex().h(52).flex_none().px(16).gap(6).items_center()
            .child(div().flex_1().text_size(16).font_medium().child(this.periodLabel()))
            .child(Button('calendar-prev', t, { variant: 'ghost', size: 'icon' }).accessibility_label(`Previous ${this.view}`).tooltip(`Previous ${this.view}`).child(glyph('chevron-left')).on_click((_event, cx) => this.navigate(-1, cx)))
            .child(Button('calendar-next', t, { variant: 'ghost', size: 'icon' }).accessibility_label(`Next ${this.view}`).tooltip(`Next ${this.view}`).child(glyph('chevron-right')).on_click((_event, cx) => this.navigate(1, cx))))
          .child(this.view === 'month' ? this.grid(t, events) : this.timeline(t, events)))
        .child(v_flex().w(340).flex_none().min_h(0).p(20).border_l(1).border_color(t.border)
          .child(this.composing ? this.editor(t) : this.agenda(t, events))))
      .child(h_flex().h(32).flex_none().px(20).items_center().border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(`${this.view === 'month' ? 'Drag across dates to add an event' : 'Drag to select time · 15-minute steps'} · Local calendar · Times use your computer’s time zone`))));
  }
}
