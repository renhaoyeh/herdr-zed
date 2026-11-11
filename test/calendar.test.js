import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dayKey, nextDay, localDate, monthDays, weekDays, timelineEvents, timelineMinute, rangeDraft, eventsOnDay, eventTime, eventFromDraft, eventDraft, saveEvent, deleteEvent } from '../mods/herdr-zed-calendar/calendar-model.js';
import { calendarContent, taskTokenId, taskTokenRef, mentionTrigger, calendarEntries, taskLinkState } from '../mods/herdr-zed-calendar/calendar-tasks.js';

import { taskIndex } from '../components/tasks-model.js';
import { boardTasks } from '../mods/herdr-zed-tasks/agent-board-model.js';
import { evaluateNative } from './source-harness.js';

const draft = { title: 'Plan the next task', notes: 'Details', startDate: '2026-11-08', endDate: '2026-11-08', startTime: '09:00', endTime: '10:00', allDay: false };

test('closing a Calendar composer returns keyboard focus only to its owning calendar', async () => {
  let target = { overlay: 'parent' }, receive, focused = 0;
  const commands = [];
  const { CalendarMod } = await evaluateNative('../mods/herdr-zed-calendar/main.js', {
    View: class {}, LocalCalendar: class { handle = { focus: () => focused++ }; init() {} close() {} },
    props: () => target, nextCommand: () => new Promise(resolve => { receive = resolve; }),
    run: command => commands.push(command), listTasks() {}, tasksSnapshot() {}, openTaskBoard() {},
  }, 'CalendarMod');
  const parent = new CalendarMod();
  parent.init({}, { spawn: fn => { void fn({ notify() {} }); } });
  receive('focus:another-calendar'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(focused, 0);
  target = { overlay: 'composer', calendarCreate: true, calendarParent: 'parent' };
  const form = new CalendarMod(); form.init({}, {}); form.close();
  assert.deepEqual(commands, ['herdr-zed-calendar.focus:parent']);
  receive('focus:parent'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(focused, 1);
});

test('due dates project into Calendar without copying tasks or mutating independent scheduled events', () => {
  const id = taskTokenId({ folder: '/project' }, 'local:one');
  const task = { id, name: 'Fix login', dueDate: '2026-11-12', status: 'doing' };
  const event = eventFromDraft({ ...draft, taskLink: { id, label: task.name } }, 'work', 'r1');
  const records = [event], before = structuredClone(records);
  let entries = calendarEntries(records, [task]);
  assert.equal(entries.length, 2); assert.equal(entries[1].dueMarker, true);
  assert.equal(entries[1].start, '2026-11-12'); assert.equal(entries[1].end, '2026-11-13');
  assert.equal(taskLinkState(event.taskLink, [{ ...task, name: 'Renamed', status: 'done' }]).label, 'Renamed');
  assert.equal(taskLinkState(event.taskLink, [{ ...task, status: 'done' }]).state, 'Done');
  entries = calendarEntries(records, [{ ...task, archived: true }]);
  assert.deepEqual(entries, records); assert.equal(taskLinkState(event.taskLink, [{ ...task, archived: true }]).state, 'Archived');
  entries = calendarEntries(records, []); assert.deepEqual(entries, records);
  assert.equal(taskLinkState(event.taskLink, [], { '["","/project"]': { 'local:one': { name: 'Fix login' } } }).state, 'Deleted task');
  assert.deepEqual(records, before);
  const moved = eventFromDraft({ ...eventDraft(event), startDate: '2026-11-10', endDate: '2026-11-10' }, event.id, 'r2');
  assert.equal(task.dueDate, '2026-11-12'); assert.deepEqual(moved.taskLink, event.taskLink);
  assert.equal(eventFromDraft({ ...eventDraft(moved), taskLink: null }, event.id, 'r3').taskLink, undefined);
});

test('scheduled task forms preserve the event when unlinking; due markers only navigate to Tasks', async () => {
  const task = { id: taskTokenId({ folder: '/project' }, 'local:one'), name: 'Fix login', status: 'todo', dueDate: '2026-11-08' };
  const h = await ui({}, { calendarCreate: true, draft: { ...draft, taskLink: { id: task.id, label: task.name } } }, { tasks: () => [task] });
  h.render(); assert.ok(h.nodes.has('calendar-linked-task'));
  h.nodes.get('calendar-unlink-task').click(null, h.cx); h.view.save(h.cx);
  const event = Object.values(h.view.records())[0]; assert.equal(event.title, draft.title); assert.equal(event.taskLink, undefined);
  const opened = [], calendar = await ui(h.memory, {}, { tasks: () => [task], openTask: id => { opened.push(id); return true; } });
  const due = calendarEntries([], [task])[0]; calendar.view.edit(due, calendar.cx);
  assert.deepEqual(opened, [task.id]); assert.equal(calendar.view.composing, undefined);
  assert.deepEqual(calendar.view.records(), h.view.records());
});

test('the month grid starts on Monday, covers adjacent months and keeps date-only values local', () => {
  const weeks = monthDays(new Date(2026, 10, 8));
  assert.equal(weeks.length, 6); assert.ok(weeks.every(week => week.length === 7));
  assert.equal(dayKey(weeks[0][0]), '2026-10-26'); assert.equal(weeks[0][0].getDay(), 1);
  assert.equal(dayKey(weeks[5][6]), '2026-12-06');
  assert.equal(dayKey(localDate('2028-02-29')), '2028-02-29');
  assert.throws(() => localDate('2026-02-29'), /valid calendar date/);
  assert.throws(() => localDate('2026-13-01'), /valid calendar date/);
  assert.throws(() => localDate('11/08/2026'), /YYYY-MM-DD/);
});

test('events round-trip through local form inputs and all-day end dates are inclusive in the editor', () => {
  const event = eventFromDraft(draft, 'one', 'r1');
  assert.equal(new Date(event.start).getHours(), 9); assert.equal(new Date(event.end).getHours(), 10);
  const edited = eventDraft(event);
  for (const key of Object.keys(draft)) assert.equal(edited[key], draft[key]);
  const all = eventFromDraft({ ...draft, allDay: true, endDate: '2026-11-10' }, 'all', 'r2');
  assert.equal(all.start, '2026-11-08'); assert.equal(all.end, '2026-11-11');
  assert.equal(eventDraft(all).endDate, '2026-11-10');
  assert.equal(eventsOnDay([all], localDate('2026-11-10')).length, 1);
  assert.equal(eventsOnDay([all], localDate('2026-11-11')).length, 0);
  assert.equal(eventTime(all, localDate(all.start)), 'All day');
});

test('invalid titles, times and backwards ranges cannot be saved', () => {
  for (const fields of [{ title: ' ' }, { startTime: '25:00' }, { endTime: '08:00' }, { endTime: '09:00' }, { endDate: '2026-11-07' }, { allDay: true, endDate: '2026-11-07' }])
    assert.throws(() => eventFromDraft({ ...draft, ...fields }, 'bad', 'r'));
});

test('cross-midnight events appear on each overlapping day and timed events sort by their actual instant', () => {
  const day = localDate('2026-11-08');
  const overnight = eventFromDraft({ ...draft, startDate: '2026-11-07', startTime: '23:00', endTime: '01:00' }, 'overnight', 'r');
  const boundary = eventFromDraft({ ...draft, startDate: '2026-11-07', startTime: '23:00', endTime: '00:00' }, 'boundary', 'r');
  const allDay = eventFromDraft({ ...draft, allDay: true }, 'all', 'r');
  const later = eventFromDraft(draft, 'later', 'r');
  assert.deepEqual(eventsOnDay([later, boundary, overnight, allDay], day).map(e => e.id), ['all', 'overnight', 'later']);
  assert.ok(eventTime(overnight, day).startsWith('←'));
  assert.equal(eventsOnDay([overnight, allDay], nextDay(day)).length, 0);
});

test('date-time validation rejects nonexistent DST times and keeps all-day dates across DST', async () => {
  const model = new URL('../mods/herdr-zed-calendar/calendar-model.js', import.meta.url).href;
  const script = `import assert from 'node:assert/strict'; import {eventFromDraft,eventsOnDay,localDate} from ${JSON.stringify(model)};
    const draft = {title:'DST',startDate:'2026-03-08',endDate:'2026-03-08',startTime:'02:30',endTime:'04:00'};
    assert.throws(() => eventFromDraft(draft,'one','r'), /unavailable/);
    const all = eventFromDraft({...draft,allDay:true},'all','r');
    assert.equal(all.end,'2026-03-09'); assert.equal(eventsOnDay([all],localDate('2026-03-08')).length,1);`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' } });
});

test('saving and deleting merge current records and reject a stale editor without changing other events', () => {
  const one = eventFromDraft(draft, 'one', 'r1'), two = { ...one, id: 'two', revision: 'r2' };
  const records = saveEvent({ two }, one);
  assert.equal(records.two, two); assert.equal(records.one, one);
  assert.throws(() => saveEvent(records, { ...one, title: 'Old edit' }, 'stale'), /changed/);
  assert.throws(() => deleteEvent(records, 'one', 'stale'), /changed/);
  assert.deepEqual(Object.keys(deleteEvent(records, 'one', 'r1')), ['two']);
  assert.equal(deleteEvent(records, 'missing', 'r'), records);
  assert.equal(records.one, one, 'updates never mutate the previous snapshot');
});

async function ui(memory = {}, target = {}, options = {}) {
  const source = await readFile(new URL('../mods/herdr-zed-calendar/calendar.js', import.meta.url), 'utf8');
  const nodes = new Map(), texts = [], writes = [], overlays = [], controls = [], bindings = [], elements = new WeakMap(); let rendering = false, closed = false;
  const element = () => {
    const data = {};
    const el = new Proxy(data, { get: (_target, key) => (...args) => {
      if (key === 'when') { if (args[0]) args[1](el); }
      else if (key === 'id') nodes.set(args[0], data);
      else if (key === 'child') { (data.children ||= []).push(args[0]); if (typeof args[0] === 'string') texts.push(args[0]); }
      else if (key === 'on_click') data.click = args[0];
      else if (key === 'on_change') data.change = args[0];
      else if (key === 'on_key_down') data.key = args[0];
      else if (key === 'on_action') (data.actions ||= {})[args[0]] = args[1];
      else if (key === 'key_context') data.keyContext = args[0];
      else if (key === 'on_size_change') data.sizeChange = args[0];
      else if (key === 'on_mouse_down') { data.down ||= {}; data.down[args[0]] = args[1]; }
      else if (key === 'on_mouse_up') { data.up ||= {}; data.up[args[0]] = args[1]; }
      else if (key === 'on_mouse_move') data.move = args[0];
      else if (key === 'on_hover') data.hover = args[0];
      else if (key === 'disabled') data.disabled = args[0];
      else if (key === 'token') data.token = args[0];
      else if (key === 'on_token_click') data.tokenClick = args[0];
      else if (key === 'on_mouse_down_out') data.outside = args[0];
      else if (key === 'anchor') data.anchor = args[0];
      else if (key === 'content') data.content = args[0];
      return el;
    } }); elements.set(el, data); return el;
  };
  const inputs = { new: () => {
    assert.equal(rendering, false);
    let value = '', tokens = [];
    return { events: {}, focusCount: 0, on(name, handler) { this.events[name] = handler; }, focus() { this.focusCount++; }, value: () => value,
      content: () => structuredClone({ text: value, tokens }), tokens: () => structuredClone(tokens),
      set_selected_range(range) { this.selection = range; },
      replace_range_with_token(range, token) {
        const delta = token.text.length - (range.end - range.start);
        tokens = tokens.filter(span => span.range.end <= range.start || span.range.start >= range.end)
          .map(span => span.range.start >= range.end ? { ...span, range: { start: span.range.start + delta, end: span.range.end + delta } } : span);
        value = value.slice(0, range.start) + token.text + value.slice(range.end);
        tokens.push({ range: { start: range.start, end: range.start + token.text.length }, token });
      },
      set_value: next => { assert.equal(rendering, false); value = typeof next === 'string' ? next : next.text; tokens = typeof next === 'string' ? [] : structuredClone(next.tokens); }, set_auto_grow() {} };
  } };
  const inputElement = state => { const el = element(); controls.push({ state, data: elements.get(el) }); return el; };
  const host = { div: element, h_flex: element, v_flex: element, InputState: inputs, TextareaState: inputs, Input: { new: inputElement }, Textarea: { new: inputElement }, Popup: { new: (id, trigger) => element().id(id).child(trigger) }, mentionTrigger, calendarEntries, taskLinkState,
    shared: key => memory[key], setShared: (key, data) => { memory[key] = data; writes.push(key); }, props: () => ({ overlay: 'calendar', ...target }), openOverlay: options => { overlays.push(options); }, closeOverlay: () => { closed = true; }, boardTheme: () => ({}),
    Button: id => element().id(id), Checkbox: id => element().id(id), glyph: element, dayKey, nextDay, localDate, monthDays, weekDays, timelineEvents, timelineMinute, rangeDraft, eventsOnDay, eventTime, eventFromDraft, eventDraft, saveEvent, deleteEvent };
  const Type = new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace('export default class', 'return class'))(...Object.values(host));
  const cx = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {}, bind_keys: entries => bindings.push(...entries) };
  const view = new Type(options); view.init(cx);
  const render = () => {
    controls.length = 0; rendering = true;
    try {
      view.render();
      for (const { state, data } of controls)
        for (const span of state.tokens()) data.token?.({ ...span, line_height: 24, available_width: 300 });
    } finally { rendering = false; }
  };
  return { view, cx, memory, nodes, texts, writes, overlays, render, elements, bindings, closed: () => closed };
}

test('the local calendar creates, edits, persists across views, cancels and deletes through its native controls', async () => {
  const h = await ui(); h.render();
  assert.ok(h.nodes.has('local-calendar')); assert.ok(h.nodes.has('calendar-new'));
  assert.equal(h.texts.some(text => /Google|OAuth|sign.in/i.test(text)), false);
  h.nodes.get('calendar-new').click(null, h.cx);
  assert.equal(h.overlays.length, 1); assert.equal(h.view.composing, undefined);
  const form = await ui(h.memory, h.overlays[0].props); form.render(); assert.ok(form.nodes.has('calendar-create-dialog'));
  for (const [key, value] of Object.entries(draft)) if (form.view.inputs[key]) form.view.inputs[key].set_value(value);
  form.view.notes.set_value(draft.notes); form.nodes.get('calendar-save').click(null, form.cx);
  const first = Object.values(h.view.records())[0]; assert.equal(first.title, draft.title); assert.equal(form.closed(), true);
  form.view.save(form.cx); assert.equal(Object.keys(h.view.records()).length, 1, 'a queued second submit cannot create a duplicate event');
  const reopened = await ui(h.memory); assert.equal(Object.values(reopened.view.records())[0].id, first.id);
  h.view.choose(localDate(draft.startDate), h.cx, true); h.render(); h.nodes.get(`calendar-agenda-${first.id}`).click(null, h.cx);
  h.view.inputs.title.set_value('Changed'); h.view.save(h.cx);
  assert.equal(h.view.records()[first.id].title, 'Changed');
  h.view.edit(h.view.records()[first.id], h.cx); h.view.inputs.title.set_value('Discard this'); h.view.cancel(h.cx);
  assert.equal(h.view.records()[first.id].title, 'Changed');
  h.view.edit(h.view.records()[first.id], h.cx); h.render(); h.nodes.get('calendar-delete').click(null, h.cx);
  assert.deepEqual(h.view.records(), {}); assert.ok(h.writes.every(key => key === 'herdr-zed.calendar-events'));
});

test('invalid forms and stale edits stay open; Escape dismisses the editor before the calendar', async () => {
  const h = await ui();
  const form = await ui({}, { calendarCreate: true }); form.view.inputs.title.set_value(''); form.view.save(form.cx);
  assert.match(form.view.error, /title/); assert.deepEqual(form.view.records(), {}); assert.equal(form.closed(), false);
  const event = eventFromDraft(draft, 'one', 'r1'); h.memory['herdr-zed.calendar-events'] = { one: event };
  h.view.edit(event, h.cx); h.memory['herdr-zed.calendar-events'].one = { ...event, title: 'Newer edit', revision: 'r2' };
  h.view.save(h.cx); assert.match(h.view.error, /changed/); assert.equal(h.view.records().one.title, 'Newer edit');
  h.view.remove(h.cx); assert.match(h.view.error, /changed/); assert.ok(h.view.records().one);
  h.render(); h.nodes.get('local-calendar').key({ key: 'escape' }, h.cx); assert.equal(h.view.composing, false); assert.equal(h.closed(), false);
  h.nodes.get('local-calendar').key({ key: 'escape' }, h.cx); assert.equal(h.closed(), true);
  h.view.choose(localDate('2026-12-15'), h.cx, true); h.view.moveMonth(1, h.cx);
  assert.equal(h.view.selected, '2027-01-15');
});

test('selecting a spillover date keeps the displayed month and its grid fixed', async () => {
  const h = await ui(); h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
  const before = monthDays(h.view.month).map(week => week.map(dayKey));
  h.nodes.get('calendar-date-2026-10-26').click(null, h.cx);
  assert.equal(h.view.selected, '2026-10-26'); assert.equal(h.view.month.getMonth(), 10);
  assert.deepEqual(monthDays(h.view.month).map(week => week.map(dayKey)), before);
  h.render(); assert.ok(h.nodes.has('calendar-cell-2026-12-06'));
  h.nodes.get('calendar-cell-2026-12-06').click(null, h.cx);
  assert.equal(h.view.selected, '2026-12-06'); assert.equal(h.view.month.getMonth(), 10);
});

test('Day, Week and Month preserve selection, navigate their own periods and remember the chosen view', async () => {
  const h = await ui(); h.view.choose(localDate('2026-12-31'), h.cx, true); h.render();
  const event = eventFromDraft({ ...draft, startDate: '2026-12-31', endDate: '2026-12-31' }, 'sample', 'r');
  h.memory['herdr-zed.calendar-events'] = { sample: event };
  h.nodes.get('calendar-view-day').click(null, h.cx); h.render();
  assert.equal(h.view.selected, '2026-12-31'); assert.ok(h.nodes.has('calendar-day-view'));
  assert.ok(h.nodes.has('calendar-timed-2026-12-31-sample'));
  h.nodes.get('calendar-next').click(null, h.cx); assert.equal(h.view.selected, '2027-01-01');
  h.nodes.get('calendar-view-week').click(null, h.cx); h.render();
  assert.ok(h.nodes.has('calendar-week-view')); assert.ok(h.nodes.has('calendar-timeline-column-2026-12-28'));
  assert.ok(h.view.periodLabel().includes('2026') && h.view.periodLabel().includes('2027'));
  h.nodes.get('calendar-next').click(null, h.cx); assert.equal(h.view.selected, '2027-01-08');
  const reopened = await ui(h.memory); assert.equal(reopened.view.view, 'week');
  h.view.setView('month', h.cx); h.view.choose(localDate('2027-01-31'), h.cx, true); h.view.navigate(1, h.cx);
  assert.equal(h.view.selected, '2027-02-28'); assert.deepEqual(Object.keys(h.view.records()), ['sample']);
});

test('weekly timelines start Monday and split overlapping, all-day and cross-midnight events correctly', () => {
  const day = localDate('2026-11-08');
  assert.deepEqual(weekDays(day).map(dayKey), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  const make = (id, startTime, endTime, fields = {}) => eventFromDraft({ ...draft, startTime, endTime, ...fields }, id, 'r');
  const one = make('one', '09:00', '10:00'), two = make('two', '09:30', '10:30'), three = make('three', '10:30', '11:30');
  const overnight = make('overnight', '23:00', '01:00', { startDate: '2026-11-07' });
  const allDay = make('all-day', '09:00', '10:00', { allDay: true });
  const rows = timelineEvents([three, one, allDay, two, overnight], day);
  assert.equal(rows.length, 4); assert.equal(rows[0].event.id, 'overnight'); assert.equal(rows[0].top, 0); assert.equal(rows[0].height, 40);
  assert.equal(rows[1].top, 360); assert.equal(rows[1].height, 40); assert.equal(rows[1].columns, 2);
  assert.equal(rows[2].columns, 2); assert.notEqual(rows[1].column, rows[2].column);
  assert.equal(rows[3].columns, 1); assert.equal(rows[3].top, 420);
  const tiny = make('tiny', '23:58', '23:59'); const [last] = timelineEvents([tiny], day);
  assert.ok(last.height >= 22 && last.top + last.height <= 960);
});

test('pointer time mapping respects scrolling, zoom, 15-minute snapping and midnight', () => {
  for (const zoom of [1, 1.5, 2]) {
    const bounds = { x: 50, y: -240 * zoom, width: 200 * zoom, height: 960 * zoom };
    assert.equal(timelineMinute(bounds.y + 9.25 / 24 * bounds.height, bounds), 555);
    assert.equal(timelineMinute(bounds.y - 20, bounds), 0);
    assert.equal(timelineMinute(bounds.y + bounds.height + 20, bounds), 1440);
  }
  assert.equal(timelineMinute(400, null), null);
  assert.deepEqual(rangeDraft('2026-11-08', 600, '2026-11-08', 540), {
    allDay: false, startDate: '2026-11-08', startTime: '09:00', endDate: '2026-11-08', endTime: '10:00',
  });
  assert.equal(rangeDraft('2026-11-08', 1425, '2026-11-08', 1440).endDate, '2026-11-09');
  assert.equal(rangeDraft('2026-11-08', 1425, '2026-11-08', 1440).endTime, '00:00');
});

const pointer = (hour, x = 80, zoom = 1) => {
  const bounds = { x: 50 * zoom, y: -240 * zoom, width: 200 * zoom, height: 960 * zoom };
  return { bounds, position: { x: x * zoom, y: bounds.y + hour / 24 * bounds.height } };
};

test('dragging a scrolled weekly timeline previews the range and opens a prefilled create dialog without saving', async () => {
  const h = await ui({ 'herdr-zed.calendar-view': 'week' }); h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
  h.nodes.get('calendar-timeline-column-2026-11-03').down.left(pointer(9, 80, 1.5), h.cx);
  h.nodes.get('calendar-timeline-column-2026-11-04').move(pointer(10, 280, 1.5), h.cx);
  h.render(); assert.ok(h.nodes.has('calendar-selection-2026-11-03')); assert.ok(h.nodes.has('calendar-selection-2026-11-04'));
  h.nodes.get('calendar-timeline-column-2026-11-04').up.left(pointer(10, 280, 1.5), h.cx);
  assert.equal(h.overlays.length, 1); assert.equal(h.overlays[0].modal, true); assert.equal(h.overlays[0].props.calendarCreate, true);
  assert.equal(h.overlays[0].props.calendarParent, 'calendar');
  assert.equal(h.overlays[0].props.draft.startDate, '2026-11-03'); assert.equal(h.overlays[0].props.draft.endDate, '2026-11-04');
  assert.equal(h.overlays[0].props.draft.startTime, '09:00'); assert.equal(h.overlays[0].props.draft.endTime, '10:00');
  assert.deepEqual(h.view.selectedRange(), h.overlays[0].props.draft, 'the released range remains visible behind its dialog');
  h.nodes.get('calendar-timeline-scroll-week').hover(false, h.cx);
  assert.ok(h.view.selectedRange(), 'moving the pointer into the dialog must not clear the pending preview');
  assert.deepEqual(h.view.records(), {}); assert.equal(h.view.composing, undefined);
  h.nodes.get('calendar-timeline-column-2026-11-04').click(null, h.cx);
  assert.equal(h.view.selected, '2026-11-03', 'the release click must not move selection to the range end');
  const form = await ui(h.memory, h.overlays[0].props); form.render();
  assert.equal(form.view.inputs.startTime.value(), '09:00'); assert.equal(form.view.inputs.endDate.value(), '2026-11-04');
  form.nodes.get('calendar-cancel').click(null, form.cx); assert.equal(form.closed(), true); assert.deepEqual(h.view.records(), {});
  assert.equal(h.view.selectedRange(), null);
});

test('reverse month dragging creates an inclusive all-day range while a normal click only selects', async () => {
  const h = await ui(); h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
  const start = h.nodes.get('calendar-cell-2026-11-30'), end = h.nodes.get('calendar-cell-2026-11-28');
  start.down.left(pointer(9, 280), h.cx); end.move(pointer(9, 80), h.cx); end.up.left(pointer(9, 80), h.cx);
  const initial = h.overlays[0].props.draft;
  assert.equal(initial.allDay, true); assert.equal(initial.startDate, '2026-11-28'); assert.equal(initial.endDate, '2026-11-30');
  const form = await ui(h.memory, h.overlays[0].props); form.view.inputs.title.set_value('Three days'); form.view.save(form.cx);
  const [saved] = Object.values(h.view.records()); assert.equal(saved.start, '2026-11-28'); assert.equal(saved.end, '2026-12-01');
  end.down.left(pointer(9, 80), h.cx); end.up.left(pointer(9, 80), h.cx); end.click(null, h.cx);
  assert.equal(h.overlays.length, 1); assert.equal(h.view.selected, '2026-11-28');
});

test('Escape, leaving the grid and an outside release cancel selection without opening a dialog', async () => {
  const h = await ui({ 'herdr-zed.calendar-view': 'day' }); h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
  const column = h.nodes.get('calendar-timeline-column-2026-11-08');
  column.down.left(pointer(10), h.cx); column.move(pointer(9), h.cx);
  h.nodes.get('local-calendar').key({ key: 'escape' }, h.cx); assert.equal(h.view.drag, null); assert.equal(h.closed(), false);
  column.down.left(pointer(10), h.cx); h.nodes.get('calendar-timeline-scroll-day').hover(false, h.cx);
  assert.equal(h.view.drag, null);
  column.down.left(pointer(10), h.cx); h.nodes.get('local-calendar').up.left(pointer(11), h.cx);
  assert.equal(h.view.drag, null); assert.equal(h.overlays.length, 0); assert.deepEqual(h.view.records(), {});
});

test('new-event dialogs preserve the underlying inline editor and only dismiss their own layer', async () => {
  const event = eventFromDraft(draft, 'one', 'r'); const h = await ui({ 'herdr-zed.calendar-events': { one: event } });
  h.view.edit(event, h.cx); h.view.inputs.title.set_value('Unsaved inline edit'); h.render();
  h.nodes.get('calendar-new').click(null, h.cx); assert.equal(h.view.editing, 'one'); assert.equal(h.overlays.length, 1);
  const form = await ui(h.memory, h.overlays[0].props); form.render();
  form.nodes.get('calendar-create-dialog').key({ key: 'escape' }, form.cx);
  assert.equal(form.closed(), true); assert.equal(h.closed(), false);
  assert.equal(h.view.inputs.title.value(), 'Unsaved inline edit'); assert.equal(h.view.records().one.title, draft.title);
});

test('a pending preview survives validation failures and clears on every dialog dismissal path', async () => {
  for (const action of ['cancel', 'escape', 'backdrop', 'save']) {
    const h = await ui({ 'herdr-zed.calendar-view': 'day' }); h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
    const column = h.nodes.get('calendar-timeline-column-2026-11-08');
    column.down.left(pointer(9), h.cx); column.move(pointer(10), h.cx); column.up.left(pointer(10), h.cx);
    h.nodes.clear(); h.render(); assert.ok(h.nodes.has('calendar-selection-2026-11-08'));
    const form = await ui(h.memory, h.overlays[0].props); form.view.inputs.title.set_value(''); form.render(); form.view.save(form.cx);
    assert.match(form.view.error, /title/); assert.ok(h.view.selectedRange()); assert.deepEqual(h.view.records(), {});
    if (action === 'cancel') form.nodes.get('calendar-cancel').click(null, form.cx);
    if (action === 'escape') form.nodes.get('calendar-create-dialog').key({ key: 'escape' }, form.cx);
    if (action === 'backdrop') form.view.close(); // Main forwards the native overlay-close lifecycle.
    if (action === 'save') { form.view.inputs.title.set_value('Saved event'); form.view.save(form.cx); }
    assert.equal(h.view.selectedRange(), null, action);
    assert.deepEqual(h.memory['herdr-zed.calendar-previews'], {});
    h.nodes.clear(); h.render(); assert.equal(h.nodes.has('calendar-selection-2026-11-08'), false);
    assert.equal(Object.keys(h.view.records()).length, action === 'save' ? 1 : 0);
  }
});

test('pending range markers are isolated across calendar windows and never persist event data', async () => {
  const memory = { 'herdr-zed.calendar-view': 'day' }, a = await ui(memory), b = await ui(memory);
  const date = localDate('2026-11-08');
  for (const h of [a, b]) {
    h.view.choose(date, h.cx, true); h.view.startRange(date, pointer(9), h.cx, true);
    h.view.moveRange(date, pointer(10), h.cx, true); h.view.finishRange(h.cx);
  }
  const markers = memory['herdr-zed.calendar-previews'];
  assert.equal(Object.keys(markers).length, 2); assert.ok(Object.values(markers).every(value => value === true));
  const form = await ui(memory, a.overlays[0].props); form.view.close();
  assert.equal(a.view.selectedRange(), null); assert.ok(b.view.selectedRange());
  b.view.close(); assert.equal(b.view.selectedRange(), null); assert.deepEqual(memory['herdr-zed.calendar-previews'], {});
  assert.deepEqual(a.view.records(), {});
});

test('All day uses native change events, hides/restores time inputs and saves the selected mode', async () => {
  const h = await ui({}, { calendarCreate: true, draft }); h.render();
  assert.ok(h.nodes.get('calendar-all-day').change, 'native checkboxes report their new value through on_change');
  assert.equal(h.nodes.get('calendar-all-day').click, undefined);
  assert.ok(h.nodes.has('calendar-input-startTime')); assert.ok(h.nodes.has('calendar-input-endTime'));
  h.nodes.get('calendar-all-day').change(true, h.cx); h.nodes.clear(); h.render();
  assert.equal(h.view.allDay, true);
  assert.equal(h.nodes.has('calendar-input-startTime'), false); assert.equal(h.nodes.has('calendar-input-endTime'), false);
  h.nodes.get('calendar-all-day').change(false, h.cx); h.nodes.clear(); h.render();
  assert.equal(h.view.allDay, false); assert.ok(h.nodes.has('calendar-input-startTime'));
  assert.equal(h.view.inputs.startTime.value(), '09:00'); assert.equal(h.view.inputs.endTime.value(), '10:00');
  h.nodes.get('calendar-all-day').change(true, h.cx); h.view.save(h.cx);
  const [saved] = Object.values(h.view.records());
  assert.equal(saved.allDay, true); assert.equal(saved.start, '2026-11-08'); assert.equal(saved.end, '2026-11-09');
  const editor = await ui(h.memory); editor.view.edit(saved, editor.cx); editor.render();
  editor.nodes.get('calendar-all-day').change(false, editor.cx); editor.view.save(editor.cx);
  assert.equal(editor.view.records()[saved.id].allDay, false);
  assert.equal(new Date(editor.view.records()[saved.id].start).getHours(), 9);
});

test('blank titles disable Create with a visible hint; keyboard submission validates and typing enables Create', async () => {
  const h = await ui({}, { calendarCreate: true }); h.view.inputs.title.set_value(''); h.render();
  assert.ok(h.nodes.has('calendar-title-hint')); assert.ok(h.texts.includes('Enter an event title.'));
  assert.equal(h.nodes.get('calendar-save').disabled, true);
  const focused = h.view.inputs.title.focusCount;
  h.view.save(h.cx);
  assert.equal(h.view.titleError, true); assert.equal(h.view.inputs.title.focusCount, focused + 1);
  assert.equal(h.closed(), false); assert.deepEqual(h.view.records(), {});
  h.view.inputs.title.set_value('   '); h.view.inputs.title.events.change(null, h.cx);
  h.nodes.get('calendar-create-dialog').key({ key: 'enter', modifiers: { platform: true } }, h.cx);
  assert.equal(h.view.titleError, true); assert.equal(h.view.inputs.title.focusCount, focused + 2);
  assert.deepEqual(h.view.records(), {});
  h.view.inputs.title.set_value('Planning'); h.view.inputs.title.events.change(null, h.cx);
  assert.equal(h.view.titleError, false); assert.equal(h.view.error, null);
  h.nodes.clear(); h.render(); assert.equal(h.nodes.has('calendar-title-hint'), false);
  assert.equal(h.nodes.get('calendar-save').disabled, false);
  h.nodes.get('calendar-save').click(null, h.cx);
  assert.equal(Object.values(h.view.records())[0].title, 'Planning'); assert.equal(h.closed(), true);
});

test('new events and dragged ranges require an entered title while existing names and supplied drafts are preserved', async () => {
  for (const dragged of [false, true]) {
    const h = await ui({ 'herdr-zed.calendar-view': 'day' });
    h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
    if (dragged) {
      const column = h.nodes.get('calendar-timeline-column-2026-11-08');
      column.down.left(pointer(9), h.cx); column.move(pointer(10.5), h.cx); column.up.left(pointer(10.5), h.cx);
    } else h.nodes.get('calendar-new').click(null, h.cx);
    const form = await ui(h.memory, h.overlays[0].props); form.render();
    assert.equal(form.view.inputs.title.value(), ''); assert.equal(form.nodes.has('calendar-title-hint'), true);
    assert.equal(form.nodes.get('calendar-save').disabled, true);
    form.view.save(form.cx); assert.deepEqual(form.view.records(), {}); assert.equal(form.closed(), false);
    if (dragged) assert.ok(h.view.selectedRange(), 'required-title validation keeps the selected range');
    form.view.inputs.title.set_value('Planning'); form.view.inputs.title.events.change(null, form.cx); form.render();
    assert.equal(form.nodes.get('calendar-save').disabled, false);
    form.nodes.get('calendar-save').click(null, form.cx);
    const [saved] = Object.values(h.view.records());
    assert.equal(saved.title, 'Planning'); assert.equal(form.closed(), true);
    if (dragged) { assert.equal(new Date(saved.end).getMinutes(), 30); assert.equal(h.view.selectedRange(), null); }
    const editor = await ui(h.memory); editor.view.edit(saved, editor.cx);
    editor.view.inputs.title.set_value('My plan'); editor.view.save(editor.cx);
    assert.equal(editor.view.records()[saved.id].title, 'My plan');
    editor.view.edit(editor.view.records()[saved.id], editor.cx); assert.equal(editor.view.inputs.title.value(), 'My plan');
  }
  const supplied = await ui({}, { calendarCreate: true, draft: { ...draft, title: 'Supplied title' } }); supplied.render();
  assert.equal(supplied.view.inputs.title.value(), 'Supplied title'); assert.equal(supplied.nodes.get('calendar-save').disabled, false);
});

const mentionProject = { id: 'p1', folder: '/work/app', name: 'App', tabs: [] };
const mentionTask = (name = 'Fix login', gid = 'local:one', project = mentionProject) => ({ id: taskTokenId(project, gid), gid, name, source: 'local', project });

test('calendar task inventory uses project-scoped IDs and includes saved, imported and live thread tasks without writes', () => {
  const other = { ...mentionProject, id: 'p2', folder: '/work/other', name: 'Other' };
  const remote = { ...mentionProject, id: 'remote:p1', machine: 'remote' };
  const project = { ...mentionProject, tabs: [{ id: 'thread1', name: 'Agent task' }] };
  const records = { '["","/work/app"]': { one: { gid: 'one', source: 'local', name: 'Fix login' }, old: { gid: 'old', source: 'local', name: 'Archived', archived: true } },
    '["","/work/other"]': { one: { gid: 'one', source: 'asana', name: 'Fix login' } } };
  const links = { imported: { gid: 'imported', source: 'mantisbt', name: 'Imported', folder: project.folder } };
  const before = JSON.stringify({ records, links });
  const snapshot = { projects: Object.fromEntries([project, other, remote].map(project => [JSON.stringify([project.machine || '', project.folder]), { project, tasks: boardTasks(project, [], records[JSON.stringify(['', project.folder])] || {}, links, project.tabs || [], [{ tab: 'thread1', status: 'working' }]) }])) };
  const tasks = taskIndex(snapshot);
  assert.equal(tasks.length, 5); assert.equal(JSON.stringify({ records, links }), before);
  assert.equal(tasks.find(task => task.gid === 'thread:thread1').status, 'todo');
  assert.equal(tasks.find(task => task.gid === 'old').archived, true, 'retain existing archived references for navigation');
  const sameNames = tasks.filter(task => task.name === 'Fix login');
  assert.equal(sameNames.length, 2); assert.notEqual(sameNames[0].id, sameNames[1].id);
  assert.deepEqual(taskTokenRef(sameNames[0].id), { machine: '', folder: project.folder, gid: 'one' });
  assert.equal(taskTokenId({ ...project, name: 'Renamed project', folder: '/work/app/' }, 'one'), sameNames[0].id);
  assert.equal(taskTokenRef('not-json'), null); assert.equal(taskTokenRef('["task",1,"/work/app","one"]'), null);
});

test('mention detection handles mid-text edits, UTF-16 offsets and pasted queries without treating email addresses as mentions', () => {
  assert.deepEqual(mentionTrigger('Before  after', 'Before @ after'), { range: { start: 7, end: 8 }, query: '' });
  assert.deepEqual(mentionTrigger('📅 ', '📅 @Fix login'), { range: { start: 3, end: 13 }, query: 'Fix login' });
  assert.deepEqual(mentionTrigger('', '@'), { range: { start: 0, end: 1 }, query: '' });
  assert.equal(mentionTrigger('user', 'user@'), null); assert.equal(mentionTrigger('', 'user@example.com'), null);
  assert.equal(mentionTrigger('@one', '@one'), null);
  assert.equal(mentionTrigger('', '@Fix login', [{ range: { start: 0, end: 10 } }]), null);
});

test('native task tokens persist with trimmed UTF-16 ranges and cannot survive removal or stale plain text', () => {
  const task = mentionTask(), token = { id: task.id, text: '@Fix login', label: task.name };
  const content = { text: '  📅 @Fix login  ', tokens: [{ range: { start: 5, end: 15 }, token }] };
  assert.deepEqual(calendarContent(content), { text: '📅 @Fix login', tokens: [{ range: { start: 3, end: 13 }, token }] });
  const event = eventFromDraft({ ...draft, notes: content.text, notesContent: content }, 'one', 'r1');
  assert.deepEqual(event.notesContent, calendarContent(content));
  assert.deepEqual(eventDraft(JSON.parse(JSON.stringify(event))).notesContent, event.notesContent);
  const removed = eventFromDraft({ ...draft, notes: 'Removed', notesContent: { text: 'Removed', tokens: [] } }, 'one', 'r2');
  assert.equal(removed.notesContent, undefined);
  assert.equal(eventFromDraft({ ...draft, notesContent: content }, 'one', 'r3').notesContent, undefined);
  assert.equal(calendarContent({ ...content, tokens: [{ range: { start: 0, end: 2 }, token }] }).tokens.length, 0);
});

test('typing @ searches tasks across projects, inserts an atomic token and persists it through event editing', async () => {
  const task = mentionTask(), other = mentionTask('Fix login', 'local:one', { ...mentionProject, folder: '/work/other', name: 'Other' });
  const options = { tasks: () => [task, other, { ...mentionTask('Archived'), archived: true }] };
  const h = await ui({}, { calendarCreate: true, draft: { title: 'Planning' } }, options); h.render();
  h.view.notes.set_value('Prepare  tomorrow'); h.view.notes.events.change(null, h.cx);
  h.view.notes.set_value('Prepare @ tomorrow'); h.view.notes.events.change(null, h.cx); h.render();
  assert.ok(h.nodes.has('calendar-task-picker')); assert.equal(h.view.mentionItems().length, 2);
  assert.equal(h.view.mentionSearch.focusCount, 1); assert.equal(h.writes.length, 0);
  h.view.mentionSearch.set_value('Other'); h.view.mentionSearch.events.change(null, h.cx); h.render();
  assert.equal(h.view.mentionItems().length, 1); h.nodes.get('calendar-task-option-0').click(null, h.cx);
  assert.equal(h.view.notes.value(), 'Prepare @Fix login tomorrow');
  assert.equal(h.view.notes.tokens()[0].token.id, other.id); assert.equal(h.view.mention, null);
  h.view.save(h.cx); assert.equal(h.closed(), true);
  const event = Object.values(h.view.records())[0]; assert.equal(event.notesContent.tokens[0].token.id, other.id);
  const reopened = await ui(h.memory, {}, options); reopened.view.edit(event, reopened.cx); reopened.render();
  assert.deepEqual(reopened.view.notes.content(), event.notesContent);
  reopened.view.notes.set_value('Removed the reference'); reopened.view.notes.events.change(null, reopened.cx); reopened.view.save(reopened.cx);
  assert.equal(reopened.view.records()[event.id].notesContent, undefined);
});

test('task picker Enter and Escape affect only the picker; empty results and disappearing tasks cannot insert or save', async () => {
  let tasks = [mentionTask(), mentionTask('Review', 'local:two')], stopped = 0;
  const h = await ui({}, { calendarCreate: true }, { tasks: () => tasks });
  const cx = { ...h.cx, stop_propagation: () => { stopped++; } };
  const typeAt = () => { h.view.inputs.title.set_value(''); h.view.inputs.title.events.change(null, cx); h.view.inputs.title.set_value('@'); h.view.inputs.title.events.change(null, cx); h.render(); };
  typeAt(); h.nodes.get('calendar-create-dialog').actions['herdr-zed-calendar-mention-down'](null, cx); h.render();
  h.nodes.get('calendar-create-dialog').actions['herdr-zed-calendar-mention-confirm'](null, cx);
  assert.equal(h.view.inputs.title.value(), '@Review'); assert.equal(h.closed(), false); assert.equal(h.writes.length, 0);
  h.view.mentionSearch.events.submit(null, cx); assert.equal(h.view.inputs.title.tokens().length, 1, 'a native submit following the key event cannot insert twice');
  typeAt(); h.nodes.get('calendar-create-dialog').actions['herdr-zed-calendar-mention-dismiss'](null, cx);
  assert.equal(h.view.mention, null); assert.equal(h.view.composing, true); assert.equal(h.view.inputs.title.value(), '@');
  typeAt(); h.view.mentionSearch.set_value('missing'); h.render(); h.nodes.get('calendar-create-dialog').actions['herdr-zed-calendar-mention-confirm'](null, cx);
  assert.ok(h.texts.includes('No tasks found')); assert.equal(h.view.inputs.title.value(), '@'); assert.equal(h.writes.length, 0);
  h.view.mentionSearch.set_value(''); h.render(); const staleClick = h.nodes.get('calendar-task-option-0').click;
  tasks = []; staleClick(null, cx); assert.equal(h.view.inputs.title.tokens().length, 1, 'only the temporary @ anchor remains'); assert.equal(h.closed(), false);
  h.view.dismissMention(cx); assert.equal(h.view.inputs.title.tokens().length, 0); assert.ok(stopped >= 4);
});

test('saved task tokens navigate by stable identity after renames; missing tasks show an error and keep the calendar open', async () => {
  let tasks = [mentionTask()], opened = [];
  const h = await ui({}, { calendarCreate: true }, { tasks: () => tasks, openTask: id => { if (!tasks.some(task => task.id === id)) return false; opened.push(id); return true; } });
  h.view.inputs.title.set_value('@'); h.view.inputs.title.events.change(null, h.cx); h.render();
  h.nodes.get('calendar-task-option-0').click(null, h.cx);
  h.view.visitTask(tasks[0].id, h.cx); assert.equal(opened.length, 0, 'creation never navigates away from its draft');
  h.view.save(h.cx); const event = Object.values(h.view.records())[0];
  tasks = [{ ...tasks[0], name: 'Renamed', archived: true }];
  const reopened = await ui(h.memory, {}, { tasks: () => tasks, openTask: h.view.openTask }); reopened.view.edit(event, reopened.cx); reopened.render();
  const token = reopened.view.inputs.title.tokens()[0].token;
  reopened.nodes.get('calendar-input-title').token({ token, line_height: 24, available_width: 300 });
  assert.ok(reopened.texts.includes('@Renamed · Archived'));
  reopened.nodes.get('calendar-input-title').tokenClick({ token }, reopened.cx);
  assert.equal(reopened.closed(), true); assert.deepEqual(opened, [token.id]);
  const missing = await ui(h.memory, {}, { tasks: () => [], openTask: () => false }); missing.view.edit(event, missing.cx); missing.render();
  missing.nodes.get('calendar-input-title').tokenClick({ token }, missing.cx);
  assert.equal(missing.closed(), false); assert.match(missing.view.error, /no longer available/);
  assert.deepEqual(missing.view.inputs.title.tokens()[0].token, token, 'deleted task labels remain readable');
});

test('the picker is anchored to the native @ glyph in both fields and dismissal preserves text, existing links and the caret', async () => {
  const task = mentionTask(), token = { id: task.id, text: '@Fix login', label: task.name };
  for (const field of ['title', 'notes']) {
    const h = await ui({}, { calendarCreate: true }, { tasks: () => [task] });
    const input = h.view.mentionInput(field), prefix = field === 'notes' ? '@Fix login\n📅 Discuss ' : '@Fix login and ';
    const existing = { range: { start: 0, end: 10 }, token };
    input.set_value({ text: prefix, tokens: [existing] }); input.events.change(null, h.cx);
    input.set_value({ text: prefix + '@Review', tokens: [existing] }); input.events.change(null, h.cx);
    const anchor = input.tokens().find(span => span.token.id === h.view.mention.anchor);
    assert.deepEqual(anchor.range, { start: prefix.length, end: prefix.length + 1 });
    assert.equal(anchor.token.text, '@', 'only the @ glyph determines the popup anchor, including after pasted queries');
    h.render(); const popup = h.nodes.get(`calendar-${field}-mentions`);
    assert.equal(popup.anchor, 'top_left');
    assert.deepEqual(h.elements.get(popup.children[0]).children, ['@'], 'the trigger is the inline glyph, not the entire field');
    assert.ok(h.nodes.has('calendar-task-picker'));
    input.events.change(null, h.cx); assert.ok(h.view.mention, 'a token-only native change preserves the open picker');
    h.nodes.get('calendar-create-dialog').actions['herdr-zed-calendar-mention-dismiss'](null, h.cx);
    assert.equal(input.value(), prefix + '@Review'); assert.deepEqual(input.tokens(), [existing]);
    assert.deepEqual(input.selection, { start: prefix.length + 7, end: prefix.length + 7 });
    assert.equal(h.closed(), false); assert.equal(h.writes.length, 0);
  }
});

test('outside dismissal and saving an open picker never retain temporary anchor tokens', async () => {
  for (const action of ['outside', 'save']) {
    const h = await ui({}, { calendarCreate: true, draft: { title: 'Planning' } }, { tasks: () => [mentionTask()] });
    h.view.notes.set_value('Discuss @'); h.view.notes.events.change(null, h.cx); h.render();
    const focusCount = h.view.notes.focusCount;
    if (action === 'outside') h.nodes.get('calendar-task-picker').outside(null, h.cx);
    else h.view.save(h.cx);
    assert.equal(h.view.mention, null); assert.deepEqual(h.view.notes.content(), { text: 'Discuss @', tokens: [] });
    assert.equal(h.view.notes.focusCount, focusCount, 'outside actions retain their own focus');
    if (action === 'save') {
      const saved = Object.values(h.view.records())[0];
      assert.equal(saved.notes, 'Discuss @'); assert.equal(saved.notesContent, undefined);
    }
  }
});

test('scoped native input actions move one row at a time, wrap, filter, confirm and dismiss', async () => {
  const tasks = Array.from({ length: 12 }, (_, index) => mentionTask(`Task ${index + 1}`, `local:${index}`));
  const h = await ui({}, { calendarCreate: true }, { tasks: () => tasks });
  h.view.notes.set_value('@'); h.view.notes.events.change(null, h.cx); h.render();
  assert.deepEqual(h.bindings.map(binding => binding.keystroke), ['up', 'down', 'enter', 'escape']);
  assert.ok(h.bindings.every(binding => binding.context === 'HerdrZedCalendarMention > Input'));
  assert.equal(h.nodes.get('calendar-create-dialog').keyContext, 'HerdrZedCalendarMention');
  assert.equal(h.nodes.get('calendar-task-picker').key, undefined, 'raw key handlers must not also move the highlight');
  const press = key => {
    const action = h.bindings.find(binding => binding.keystroke === key).action;
    h.nodes.get('calendar-create-dialog').actions[action]({ action }, h.cx); h.render();
  };
  press('up'); assert.equal(h.view.mentionIndex, 11);
  press('down'); assert.equal(h.view.mentionIndex, 0);
  press('down'); assert.equal(h.view.mentionIndex, 1);
  h.view.mentionSearch.set_value('Task 12'); h.view.mentionSearch.events.change(null, h.cx); h.render();
  assert.equal(h.view.mentionIndex, 0);
  press('enter'); assert.equal(h.view.notes.tokens()[0].token.id, tasks[11].id);
  assert.equal(h.nodes.get('calendar-create-dialog').keyContext, undefined, 'calendar inputs regain their normal bindings after the picker closes');
  assert.equal(h.writes.length, 0); assert.equal(h.closed(), false);
  h.view.notes.set_value(''); h.view.notes.events.change(null, h.cx);
  h.view.notes.set_value('@'); h.view.notes.events.change(null, h.cx); h.render();
  press('escape'); assert.equal(h.view.mention, null); assert.equal(h.view.composing, true); assert.equal(h.closed(), false);
});

test('the search receives focus after its inline popup mounts, once per opening, and obsolete mounts cannot steal focus', async () => {
  const h = await ui({}, { calendarCreate: true }, { tasks: () => [mentionTask()] });
  h.view.notes.set_value('Link @'); h.view.notes.events.change(null, h.cx); h.render();
  const oldAnchor = h.view.mention.anchor, mounted = h.nodes.get(`calendar-task-search-host-${oldAnchor}`).sizeChange;
  const initialFocus = h.view.mentionSearch.focusCount;
  mounted({ width: 292, height: 36 }, h.cx); assert.equal(h.view.mentionSearch.focusCount, initialFocus + 1);
  mounted({ width: 280, height: 36 }, h.cx); assert.equal(h.view.mentionSearch.focusCount, initialFocus + 1);
  h.view.dismissMention(h.cx); mounted({ width: 292, height: 36 }, h.cx);
  assert.equal(h.view.mentionSearch.focusCount, initialFocus + 1);
  h.view.notes.set_value('Link '); h.view.notes.events.change(null, h.cx);
  h.view.notes.set_value('Link @'); h.view.notes.events.change(null, h.cx); h.render();
  const nextAnchor = h.view.mention.anchor; assert.notEqual(nextAnchor, oldAnchor);
  const nextFocus = h.view.mentionSearch.focusCount; mounted({ width: 292, height: 36 }, h.cx);
  assert.equal(h.view.mentionSearch.focusCount, nextFocus);
  h.nodes.get(`calendar-task-search-host-${nextAnchor}`).sizeChange({ width: 292, height: 36 }, h.cx);
  assert.equal(h.view.mentionSearch.focusCount, nextFocus + 1);
});
