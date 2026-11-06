export const localDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'];

export function summarize(events, days = 30, now = new Date(), filters = {}) {
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - days + 1);
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  const rows = events.filter(e => (!days || e.timestamp >= start.getTime()) && e.timestamp <= end.getTime()
    && Object.entries(filters).every(([key, value]) => !value || e[key] === value));
  const totals = Object.fromEntries(fields.map(key => [key, 0]));
  const groups = Object.fromEntries(['day', 'model', 'project', 'account', 'session'].map(key => [key, new Map()]));
  for (const event of rows) {
    for (const key of fields) totals[key] += event[key] || 0;
    for (const [key, map] of Object.entries(groups)) {
      const id = event[key], row = map.get(id) || { label: id, ...Object.fromEntries(fields.map(key => [key, 0])),
        timestamp: 0, model: event.model, project: event.project, account: event.account };
      for (const field of fields) row[field] += event[field] || 0;
      row.timestamp = Math.max(row.timestamp, event.timestamp); map.set(id, row);
    }
  }
  const daily = [];
  if (days) for (let i = 0; i < days; i++) {
    const date = new Date(start); date.setDate(date.getDate() + i); const label = localDay(date);
    daily.push(groups.day.get(label) || { label, total: 0 });
  }
  return { totals, sessions: groups.session.size, daily: days ? daily : [...groups.day.values()].sort((a, b) => a.label.localeCompare(b.label)),
    ...Object.fromEntries(['model', 'project', 'account', 'session'].map(key => [key, [...groups[key].values()].sort((a, b) => b.total - a.total)])) };
}

