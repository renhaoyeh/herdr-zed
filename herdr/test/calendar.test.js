import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dayKey, nextDay, localDate, monthDays, weekDays, timelineEvents, timelineMinute, rangeDraft, eventsOnDay, eventTime, eventFromDraft, eventDraft, saveEvent, deleteEvent } from '../mods/devkits/calendar-model.js';

const draft = { title: 'Plan the next task', notes: 'Details', startDate: '2026-11-08', endDate: '2026-11-08', startTime: '09:00', endTime: '10:00', allDay: false };

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
  const model = new URL('../mods/devkits/calendar-model.js', import.meta.url).href;
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

async function ui(memory = {}, target = {}) {
  const source = await readFile(new URL('../mods/devkits/calendar.js', import.meta.url), 'utf8');
  const nodes = new Map(), texts = [], writes = [], overlays = []; let rendering = false, closed = false;
  const element = () => {
    const data = {};
    const el = new Proxy(data, { get: (_target, key) => (...args) => {
      if (key === 'when') { if (args[0]) args[1](el); }
      else if (key === 'id') nodes.set(args[0], data);
      else if (key === 'child' && typeof args[0] === 'string') texts.push(args[0]);
      else if (key === 'on_click') data.click = args[0];
      else if (key === 'on_change') data.change = args[0];
      else if (key === 'on_key_down') data.key = args[0];
      else if (key === 'on_mouse_down') { data.down ||= {}; data.down[args[0]] = args[1]; }
      else if (key === 'on_mouse_up') { data.up ||= {}; data.up[args[0]] = args[1]; }
      else if (key === 'on_mouse_move') data.move = args[0];
      else if (key === 'on_hover') data.hover = args[0];
      else if (key === 'disabled') data.disabled = args[0];
      return el;
    } }); return el;
  };
  const inputs = { new: () => {
    assert.equal(rendering, false);
    let value = '';
    return { events: {}, focusCount: 0, on(name, handler) { this.events[name] = handler; }, focus() { this.focusCount++; }, value: () => value,
      set_value: next => { assert.equal(rendering, false); value = next; }, set_auto_grow() {} };
  } };
  const host = { div: element, h_flex: element, v_flex: element, InputState: inputs, TextareaState: inputs, Input: { new: element }, Textarea: { new: element },
    shared: key => memory[key], setShared: (key, data) => { memory[key] = data; writes.push(key); }, props: () => ({ overlay: 'calendar', ...target }), openOverlay: options => { overlays.push(options); }, closeOverlay: () => { closed = true; }, boardTheme: () => ({}),
    Button: id => element().id(id), Checkbox: id => element().id(id), glyph: element, dayKey, nextDay, localDate, monthDays, weekDays, timelineEvents, timelineMinute, rangeDraft, eventsOnDay, eventTime, eventFromDraft, eventDraft, saveEvent, deleteEvent };
  const Type = new Function(...Object.keys(host), source.replace(/^import .*;\r?\n/gm, '').replace('export default class', 'return class'))(...Object.values(host));
  const cx = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {} };
  const view = new Type(); view.init(cx);
  const render = () => { rendering = true; try { view.render(); } finally { rendering = false; } };
  return { view, cx, memory, nodes, texts, writes, overlays, render, closed: () => closed };
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
  h.render(); h.nodes.get(`calendar-agenda-${first.id}`).click(null, h.cx);
  h.view.inputs.title.set_value('Changed'); h.view.save(h.cx);
  assert.equal(h.view.records()[first.id].title, 'Changed');
  h.view.edit(h.view.records()[first.id], h.cx); h.view.inputs.title.set_value('Discard this'); h.view.cancel(h.cx);
  assert.equal(h.view.records()[first.id].title, 'Changed');
  h.view.edit(h.view.records()[first.id], h.cx); h.render(); h.nodes.get('calendar-delete').click(null, h.cx);
  assert.deepEqual(h.view.records(), {}); assert.ok(h.writes.every(key => key === 'devkits.calendar-events'));
});

test('invalid forms and stale edits stay open; Escape dismisses the editor before the calendar', async () => {
  const h = await ui();
  const form = await ui({}, { calendarCreate: true }); form.view.inputs.title.set_value(''); form.view.save(form.cx);
  assert.match(form.view.error, /title/); assert.deepEqual(form.view.records(), {}); assert.equal(form.closed(), false);
  const event = eventFromDraft(draft, 'one', 'r1'); h.memory['devkits.calendar-events'] = { one: event };
  h.view.edit(event, h.cx); h.memory['devkits.calendar-events'].one = { ...event, title: 'Newer edit', revision: 'r2' };
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
  h.memory['devkits.calendar-events'] = { sample: event };
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
  const h = await ui({ 'devkits.calendar-view': 'week' }); h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
  h.nodes.get('calendar-timeline-column-2026-11-03').down.left(pointer(9, 80, 1.5), h.cx);
  h.nodes.get('calendar-timeline-column-2026-11-04').move(pointer(10, 280, 1.5), h.cx);
  h.render(); assert.ok(h.nodes.has('calendar-selection-2026-11-03')); assert.ok(h.nodes.has('calendar-selection-2026-11-04'));
  h.nodes.get('calendar-timeline-column-2026-11-04').up.left(pointer(10, 280, 1.5), h.cx);
  assert.equal(h.overlays.length, 1); assert.equal(h.overlays[0].modal, true); assert.equal(h.overlays[0].props.calendarCreate, true);
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
  const h = await ui({ 'devkits.calendar-view': 'day' }); h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
  const column = h.nodes.get('calendar-timeline-column-2026-11-08');
  column.down.left(pointer(10), h.cx); column.move(pointer(9), h.cx);
  h.nodes.get('local-calendar').key({ key: 'escape' }, h.cx); assert.equal(h.view.drag, null); assert.equal(h.closed(), false);
  column.down.left(pointer(10), h.cx); h.nodes.get('calendar-timeline-scroll-day').hover(false, h.cx);
  assert.equal(h.view.drag, null);
  column.down.left(pointer(10), h.cx); h.nodes.get('local-calendar').up.left(pointer(11), h.cx);
  assert.equal(h.view.drag, null); assert.equal(h.overlays.length, 0); assert.deepEqual(h.view.records(), {});
});

test('new-event dialogs preserve the underlying inline editor and only dismiss their own layer', async () => {
  const event = eventFromDraft(draft, 'one', 'r'); const h = await ui({ 'devkits.calendar-events': { one: event } });
  h.view.edit(event, h.cx); h.view.inputs.title.set_value('Unsaved inline edit'); h.render();
  h.nodes.get('calendar-new').click(null, h.cx); assert.equal(h.view.editing, 'one'); assert.equal(h.overlays.length, 1);
  const form = await ui(h.memory, h.overlays[0].props); form.render();
  form.nodes.get('calendar-create-dialog').key({ key: 'escape' }, form.cx);
  assert.equal(form.closed(), true); assert.equal(h.closed(), false);
  assert.equal(h.view.inputs.title.value(), 'Unsaved inline edit'); assert.equal(h.view.records().one.title, draft.title);
});

test('a pending preview survives validation failures and clears on every dialog dismissal path', async () => {
  for (const action of ['cancel', 'escape', 'backdrop', 'save']) {
    const h = await ui({ 'devkits.calendar-view': 'day' }); h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
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
    assert.deepEqual(h.memory['devkits.calendar-previews'], {});
    h.nodes.clear(); h.render(); assert.equal(h.nodes.has('calendar-selection-2026-11-08'), false);
    assert.equal(Object.keys(h.view.records()).length, action === 'save' ? 1 : 0);
  }
});

test('pending range markers are isolated across calendar windows and never persist event data', async () => {
  const memory = { 'devkits.calendar-view': 'day' }, a = await ui(memory), b = await ui(memory);
  const date = localDate('2026-11-08');
  for (const h of [a, b]) {
    h.view.choose(date, h.cx, true); h.view.startRange(date, pointer(9), h.cx, true);
    h.view.moveRange(date, pointer(10), h.cx, true); h.view.finishRange(h.cx);
  }
  const markers = memory['devkits.calendar-previews'];
  assert.equal(Object.keys(markers).length, 2); assert.ok(Object.values(markers).every(value => value === true));
  const form = await ui(memory, a.overlays[0].props); form.view.close();
  assert.equal(a.view.selectedRange(), null); assert.ok(b.view.selectedRange());
  b.view.close(); assert.equal(b.view.selectedRange(), null); assert.deepEqual(memory['devkits.calendar-previews'], {});
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

test('blank titles have a visible hint; Create and keyboard submission focus the required title without saving', async () => {
  const h = await ui({}, { calendarCreate: true }); h.view.inputs.title.set_value(''); h.render();
  assert.ok(h.nodes.has('calendar-title-hint')); assert.ok(h.texts.includes('Enter an event title.'));
  assert.notEqual(h.nodes.get('calendar-save').disabled, true, 'Create must respond with validation instead of silently disabling');
  const focused = h.view.inputs.title.focusCount;
  h.nodes.get('calendar-save').click(null, h.cx);
  assert.equal(h.view.titleError, true); assert.equal(h.view.inputs.title.focusCount, focused + 1);
  assert.equal(h.closed(), false); assert.deepEqual(h.view.records(), {});
  h.view.inputs.title.set_value('   '); h.view.inputs.title.events.change(null, h.cx);
  h.nodes.get('calendar-create-dialog').key({ key: 'enter', modifiers: { platform: true } }, h.cx);
  assert.equal(h.view.titleError, true); assert.equal(h.view.inputs.title.focusCount, focused + 2);
  assert.deepEqual(h.view.records(), {});
  h.view.inputs.title.set_value('Planning'); h.view.inputs.title.events.change(null, h.cx);
  assert.equal(h.view.titleError, false); assert.equal(h.view.error, null);
  h.nodes.clear(); h.render(); assert.equal(h.nodes.has('calendar-title-hint'), false);
  h.nodes.get('calendar-save').click(null, h.cx);
  assert.equal(Object.values(h.view.records())[0].title, 'Planning'); assert.equal(h.closed(), true);
});

test('new events default to New event and can be created immediately from both New event and a dragged range', async () => {
  for (const dragged of [false, true]) {
    const h = await ui({ 'devkits.calendar-view': 'day' });
    h.view.choose(localDate('2026-11-08'), h.cx, true); h.render();
    if (dragged) {
      const column = h.nodes.get('calendar-timeline-column-2026-11-08');
      column.down.left(pointer(9), h.cx); column.move(pointer(10.5), h.cx); column.up.left(pointer(10.5), h.cx);
    } else h.nodes.get('calendar-new').click(null, h.cx);
    const form = await ui(h.memory, h.overlays[0].props); form.render();
    assert.equal(form.view.inputs.title.value(), 'New event'); assert.equal(form.nodes.has('calendar-title-hint'), false);
    form.nodes.get('calendar-save').click(null, form.cx);
    const [saved] = Object.values(h.view.records());
    assert.equal(saved.title, 'New event'); assert.equal(form.closed(), true);
    if (dragged) { assert.equal(new Date(saved.end).getMinutes(), 30); assert.equal(h.view.selectedRange(), null); }
    const editor = await ui(h.memory); editor.view.edit(saved, editor.cx);
    editor.view.inputs.title.set_value('My plan'); editor.view.save(editor.cx);
    assert.equal(editor.view.records()[saved.id].title, 'My plan');
    editor.view.edit(editor.view.records()[saved.id], editor.cx); assert.equal(editor.view.inputs.title.value(), 'My plan');
  }
});
