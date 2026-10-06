// web/js/api.js
//
// Typed-ish client for the RAT HTTP API. Every call returns parsed JSON and
// throws an Error carrying the server's message on failure.

async function request(path, options) {
  const res = await fetch(path, options);
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new Error((body && body.error) || `request failed (HTTP ${res.status})`);
  return body;
}

/** Drops null/undefined/'' params so filters can be passed verbatim. */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const json = (method, data) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

export const api = {
  listRepos: () => request('/api/repos'),
  summary: (id, filters = {}) => request(`/api/repos/${encodeURIComponent(id)}/summary${qs(filters)}`),
  tree: (id, dir, filters = {}) => request(`/api/repos/${encodeURIComponent(id)}/tree${qs({ dir, ...filters })}`),
  file: (id, path, filters = {}) => request(`/api/repos/${encodeURIComponent(id)}/file${qs({ path, ...filters })}`),
  authors: (id, filters = {}) => request(`/api/repos/${encodeURIComponent(id)}/authors${qs(filters)}`),
  timeline: (id, bucket, filters = {}) =>
    request(`/api/repos/${encodeURIComponent(id)}/timeline${qs({ bucket, ...filters })}`),
  commits: (id, { offset, limit, q, author } = {}) =>
    request(`/api/repos/${encodeURIComponent(id)}/commits${qs({ offset, limit, q, author })}`),
  merge: (id, merges) => request(`/api/repos/${encodeURIComponent(id)}/merges`, json('POST', { merges })),
  removeRepo: (id) => request(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  ingestUrl: (url, name) => request('/api/ingest', json('POST', { kind: 'url', url, name })),
  ingestZip: (file, name) => request(`/api/ingest/zip${qs({ name })}`, { method: 'POST', body: file }),
  job: (jobId) => request(`/api/jobs/${encodeURIComponent(jobId)}`),
  exportUrl: (id, filters = {}) => `/api/repos/${encodeURIComponent(id)}/export.csv${qs(filters)}`,
};
