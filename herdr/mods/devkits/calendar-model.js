export const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const nextDay = (date, days = 1) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

export function localDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Enter dates as YYYY-MM-DD.');
  const [year, month, day] = value.split('-').map(Number), date = new Date(year, month - 1, day);
  if (year < 1000 || dayKey(date) !== value) throw new Error('Enter a valid calendar date.');
  return date;
}

export function monthDays(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const start = nextDay(first, -((first.getDay() + 6) % 7));
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, day) => nextDay(start, week * 7 + day)));
}

export function weekDays(date) {
  const start = nextDay(date, -((date.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, day) => nextDay(start, day));
}

export function timelineMinute(y, bounds) {
  if (!bounds || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.height) || bounds.height <= 0 || !Number.isFinite(y)) return null;
  return Math.max(0, Math.min(1440, Math.round((y - bounds.y) / bounds.height * 1440 / 15) * 15));
}

export function rangeDraft(startDate, startMinute, endDate, endMinute, allDay = false) {
  if (allDay) return { allDay: true, startDate: startDate < endDate ? startDate : endDate, endDate: startDate > endDate ? startDate : endDate, startTime: '09:00', endTime: '10:00' };
  const point = (date, minute) => {
    const day = localDate(date), value = Math.max(0, Math.min(1440, minute));
    const key = dayKey(value === 1440 ? nextDay(day) : day), time = value === 1440 ? '00:00' : `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    return { date: key, time, key: `${key}T${time}` };
  };
  let start = point(startDate, startMinute), end = point(endDate, endMinute);
  if (end.key < start.key) [start, end] = [end, start];
  if (start.key === end.key) {
    const [hour, minute] = start.time.split(':').map(Number);
    end = point(start.date, hour * 60 + minute + 15);
  }
  return { allDay: false, startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time };
}

// Layout a day on a local wall-clock axis; clip multiday events at midnight.
// Connected overlap groups share a column count so no event hides another.
export function timelineEvents(events, day, hourHeight = 40) {
  const dayStart = day.getTime(), dayEnd = nextDay(day).getTime(), height = hourHeight * 24;
  const rows = eventsOnDay(events, day).filter(event => !event.allDay).map(event => {
    const start = new Date(event.start), end = new Date(event.end);
    const from = start.getTime() <= dayStart ? 0 : start.getHours() * 60 + start.getMinutes();
    const to = end.getTime() >= dayEnd ? 1440 : end.getHours() * 60 + end.getMinutes();
    const top = Math.min(from * hourHeight / 60, height - 22);
    const eventHeight = Math.min(Math.max(22, (to - from) * hourHeight / 60), height - top);
    return { event, from, to, top, height: eventHeight, bottom: top + eventHeight };
  }).sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.event.id.localeCompare(b.event.id));
  let group = [], lanes = [], bottom = -1;
  const finish = () => { for (const row of group) row.columns = lanes.length; group = []; lanes = []; };
  for (const row of rows) {
    if (row.top >= bottom) finish();
    let column = lanes.findIndex(end => end <= row.top);
    if (column < 0) column = lanes.length;
    lanes[column] = row.bottom; row.column = column;
    group.push(row); bottom = Math.max(...lanes);
  }
  finish(); return rows;
}

export function eventsOnDay(events, day) {
  const key = dayKey(day), start = day.getTime(), end = nextDay(day).getTime();
  return events.filter(event => event.allDay ? event.start <= key && event.end > key
    : Date.parse(event.start) < end && Date.parse(event.end) > start)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.allDay ? a.start.localeCompare(b.start) : Date.parse(a.start) - Date.parse(b.start)) || a.title.localeCompare(b.title));
}

export function eventTime(event, day) {
  if (event.allDay) return 'All day';
  const start = new Date(event.start), end = new Date(event.end);
  const time = date => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${start < day ? '←' : time(start)} – ${end >= nextDay(day) ? '→' : time(end)}`;
}

function localDateTime(date, time) {
  const result = localDate(date);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) throw new Error('Enter times as HH:MM, using the 24-hour clock.');
  const [hours, minutes] = time.split(':').map(Number);
  result.setHours(hours, minutes, 0, 0);
  if (dayKey(result) !== date || result.getHours() !== hours || result.getMinutes() !== minutes)
    throw new Error('That time is unavailable in your local time zone. Choose another time.');
  return result.toISOString();
}

export function eventFromDraft(draft, id, revision) {
  const title = String(draft.title || '').trim();
  if (!title) throw new Error('Add an event title.');
  const start = draft.allDay ? dayKey(localDate(draft.startDate)) : localDateTime(draft.startDate, draft.startTime);
  const end = draft.allDay ? dayKey(nextDay(localDate(draft.endDate))) : localDateTime(draft.endDate, draft.endTime);
  if (end <= start) throw new Error('The event must end after it starts.');
  return { id, revision, title, notes: String(draft.notes || '').trim(), allDay: Boolean(draft.allDay), start, end };
}

export function eventDraft(event) {
  if (event.allDay) return { ...event, startDate: event.start, endDate: dayKey(nextDay(localDate(event.end), -1)), startTime: '09:00', endTime: '10:00' };
  const start = new Date(event.start), end = new Date(event.end);
  const time = date => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return { ...event, startDate: dayKey(start), endDate: dayKey(end), startTime: time(start), endTime: time(end) };
}

export function saveEvent(records, event, expected = null) {
  if ((records[event.id]?.revision || null) !== expected) throw new Error('This event changed in another calendar window. Reopen it to continue.');
  return { ...records, [event.id]: event };
}

export function deleteEvent(records, id, expected) {
  if (!records[id]) return records;
  if (records[id].revision !== expected) throw new Error('This event changed in another calendar window. Reopen it before deleting.');
  const next = { ...records }; delete next[id]; return next;
}
