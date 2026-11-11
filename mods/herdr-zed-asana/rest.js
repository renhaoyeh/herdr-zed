// HTTP transport only; usable by both Herdr and Node callers.
const api = 'https://app.asana.com/api/1.0';

export async function asanaRequest(token, path, request = fetch) {
  const response = await request(`${api}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  let body = null;
  try { body = await response.json(); } catch {}
  if (response.status === 401) throw Object.assign(new Error('Asana rejected this token. Enter a new personal access token.'), { unauthorized: true });
  if (!response.ok) throw Object.assign(new Error(body?.errors?.[0]?.message || `Asana returned ${response.status}.`), { status: response.status });
  return body || {};
}

