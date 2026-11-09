// HTTP transport only; authentication negotiation stays private to this module.
const authSchemes = new Map();

export function normalizeUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '').replace(/\/api\/rest(?:\/index\.php)?$/i, '');
  if (!/^https?:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/i.test(url))
    throw new Error('Enter the MantisBT server URL, for example https://mantis.example.com.');
  return url;
}

// 2.28 and earlier use a bare token; newer servers also accept Bearer tokens.
// Remember the negotiated scheme only in memory, never in shared UI state.
export async function mantisRequest(connection, path, request = fetch) {
  const url = normalizeUrl(connection.url), token = String(connection.token || '').trim();
  if (!token) throw new Error('Enter a personal access token.');
  const key = JSON.stringify([url, token]);
  const send = scheme => request(`${url}/api/rest${path}`, {
    headers: { Authorization: scheme === 'token' ? token : `Bearer ${token}`, Accept: 'application/json' },
  });
  let scheme = authSchemes.get(key) || 'token', response = await send(scheme);
  // Older MantisBT versions also return 403 for invalid token formats.
  if ((response.status === 401 || response.status === 403) && !authSchemes.has(key)) {
    scheme = 'bearer'; response = await send(scheme);
  }
  if (response.status === 401) {
    authSchemes.delete(key);
    throw Object.assign(new Error('MantisBT rejected this token. Enter a new personal access token.'), { unauthorized: true });
  }
  let body;
  try { body = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(new Error(response.status === 403
    ? authSchemes.has(key)
      ? 'This MantisBT account does not have permission to read this resource.'
      : 'MantisBT rejected the API token or denied access. Check the token and account permissions.'
    : body?.message || body?.description || `MantisBT returned ${response.status}.`), { status: response.status });
  if (!body || typeof body !== 'object') throw new Error('The server did not return MantisBT API data. Check the server URL and REST API configuration.');
  authSchemes.set(key, scheme);
  return body;
}

