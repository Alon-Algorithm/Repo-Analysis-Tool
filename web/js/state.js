// web/js/state.js
//
// Shared application state: selected repository, active view and the commit
// set / author filters. Views subscribe with onChange() and re-render; the
// most useful slices are mirrored into the URL hash so a reload keeps place.

import { api } from './api.js';

export const state = {
  repos: [],
  repoId: null,
  view: 'overview',
  /** commit-set + author filters, shared by every metric view */
  filters: { kind: 'all', from: null, to: null, shas: null, authorGid: -1 },
  timelineBucket: 'month',
  treeDir: null, // dir id or path inside the tree view
  filePath: null, // file path inside the file view
  groups: [], // author groups of the current repo (for the author filter)
};

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
}

export function emit() {
  persistHash();
  for (const fn of listeners) fn();
}

export const currentRepo = () => state.repos.find((repo) => repo.id === state.repoId) ?? null;

/** Query params matching the API's shared filter contract. */
export function filterParams() {
  const f = state.filters;
  return {
    kind: f.kind,
    from: f.from,
    to: f.to,
    shas: f.kind === 'list' && f.shas ? f.shas.join(',') : null,
    author: f.authorGid >= 0 ? f.authorGid : null,
  };
}

export function authorLabel() {
  if (state.filters.authorGid < 0) return null;
  return state.groups.find((group) => group.gid === state.filters.authorGid)?.label ?? null;
}

export function resetFilters() {
  state.filters = { kind: 'all', from: null, to: null, shas: null, authorGid: -1 };
}

export async function loadRepos() {
  const { repos } = await api.listRepos();
  state.repos = repos;
  if (!state.repos.some((repo) => repo.id === state.repoId)) {
    state.repoId = state.repos[0]?.id ?? null;
    resetFilters();
  }
  return state.repos;
}

/** Refreshes the author-group list used by the author filter select. */
export async function loadGroups() {
  if (!state.repoId) {
    state.groups = [];
    return;
  }
  try {
    const body = await api.authors(state.repoId);
    state.groups = body.groups;
    if (state.filters.authorGid >= state.groups.length) state.filters.authorGid = -1;
  } catch {
    state.groups = [];
  }
}

export function setRepo(id) {
  if (id === state.repoId) return;
  state.repoId = id;
  state.treeDir = null;
  state.filePath = null;
  resetFilters();
  loadGroups().then(emit);
  emit();
}

export function setView(view) {
  state.view = view;
  emit();
}

// ---------------------------------------------------------------- hash sync

function persistHash() {
  const parts = [];
  const push = (key, value) => {
    if (value !== null && value !== undefined && value !== '') parts.push(`${key}=${encodeURIComponent(value)}`);
  };
  push('repo', state.repoId);
  push('view', state.view);
  const f = state.filters;
  push('kind', f.kind !== 'all' ? f.kind : null);
  push('from', f.from);
  push('to', f.to);
  push('author', f.authorGid >= 0 ? f.authorGid : null);
  if (state.view === 'tree' && state.treeDir) push('dir', state.treeDir);
  if (state.view === 'file' && state.filePath) push('file', state.filePath);
  window.location.hash = parts.join('&');
}

export function applyHash() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.get('repo')) state.repoId = params.get('repo');
  if (params.get('view')) state.view = params.get('view');
  const f = state.filters;
  const kind = params.get('kind');
  if (kind === 'range') {
    f.kind = 'range';
    f.from = params.get('from');
    f.to = params.get('to');
  }
  const author = params.get('author');
  if (author !== null && author !== '') f.authorGid = Number(author);
  if (params.get('dir')) state.treeDir = params.get('dir');
  if (params.get('file')) state.filePath = params.get('file');
}
