/**
 * Thin fetch layer.
 *
 * `/api/explain` and `/api/seed` may not exist yet on a given build of the
 * server, so a 404 is modelled as a first-class result (`MISSING`) rather than
 * an exception — the UI degrades to what it can prove instead of white-screening.
 */

export class ApiError extends Error {
  constructor(message, { status = 0, missing = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.missing = missing;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('Could not reach the server.', { status: 0 });
  }

  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }

  if (!res.ok) {
    const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`;
    throw new ApiError(detail, { status: res.status, missing: res.status === 404 || res.status === 405 });
  }
  return payload;
}

export const getVocabulary = () => request('/api/vocabulary');
export const getEvents = () => request('/api/events');
export const getMetrics = () => request('/api/metrics');
export const getSuggestions = (userId) => request(`/api/suggestions?userId=${encodeURIComponent(userId)}`);

export const explain = (intent, signal) => request('/api/explain', { method: 'POST', body: intent, signal });
export const recommend = (intent, signal) => request('/api/recommend', { method: 'POST', body: intent, signal });
export const match = (intent) => request('/api/match', { method: 'POST', body: intent });
export const reset = () => request('/api/reset', { method: 'POST' });
