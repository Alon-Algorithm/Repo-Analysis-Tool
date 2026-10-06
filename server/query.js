// server/query.js
//
// Query layer between the HTTP routes and the metric engine. Turns raw query
// string parameters into a ready computed metric set, memoising each stage so
// repeated dashboard polls stay cheap:
//
//   filters     kind=all | kind=range&from=..&to=.. | kind=list&shas=a,b
//   author      author=<gid>   restricts the commit set to one author group
//   from/to     ISO dates/timestamps, unix seconds, or omitted
//
// Cached per repository: author groups (per merge config), compiled commit
// sets + metric sets (LRU), commit subjects (lazy, display-only), and the
// commit time bounds used to seed the date pickers.

import { git } from './gitrun.js';
import { buildAuthorGroups, compileCommitSet, computeMetrics } from './metrics.js';
import * as store from './store.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- lru helper

const MAX_CACHED_SETS = 12;
const MAX_CACHED_SUBJECTS = 8;

function lru(map, key, make) {
  let value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value); // refresh recency
    return value;
  }
  value = make();
  map.set(key, value);
  if (map.size > MAX_CACHED_SETS) map.delete(map.keys().next().value);
  return value;
}

// ---------------------------------------------------------------- repos

export function requireRepo(id) {
  const meta = store.loadMeta(id);
  const index = store.loadIndex(id);
  if (!meta || !index) throw new HttpError(404, `unknown repository: ${id}`);
  return { meta, index };
}

// ---------------------------------------------------------------- filters

/** Accepts ISO dates ('2024-01-01'), full timestamps, or unix seconds. */
export function parseTimeParam(value, fallback) {
  if (value === null || value === '') return fallback;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new HttpError(400, `invalid time: ${value}`);
  return ms / 1000;
}

/** Query string -> commit-set spec understood by compileCommitSet. */
export function commitSetFromQuery(params) {
  const kind = params.get('kind') ?? 'all';
  if (kind === 'range') {
    return {
      kind,
      from: parseTimeParam(params.get('from'), -Infinity),
      to: parseTimeParam(params.get('to'), Infinity),
    };
  }
  if (kind === 'list') {
    const shas = params
      .getAll('shas')
      .flatMap((value) => value.split(','))
      .map((sha) => sha.trim().toLowerCase())
      .filter(Boolean);
    return { kind, shas };
  }
  if (kind !== 'all') throw new HttpError(400, `unknown commit-set kind: ${kind}`);
  return { kind: 'all' };
}

function setCacheKey(spec) {
  if (spec.kind === 'range') return `range:${spec.from}:${spec.to}`;
  if (spec.kind === 'list') return `list:${[...spec.shas].sort().join(',')}`;
  return 'all';
}

function authorFilterFromQuery(params, groups) {
  const raw = params.get('author');
  if (raw === null || raw === '') return -1;
  const gid = Number(raw);
  if (!Number.isInteger(gid) || gid < 0 || gid >= groups.nGroups) {
    throw new HttpError(400, `unknown author group: ${raw}`);
  }
  return gid;
}

// ---------------------------------------------------------------- caches

const groupsCache = new Map();
const metricCache = new Map();
const subjectsCache = new Map();
const boundsCache = new WeakMap();

export function getAuthorGroups(id, index, meta) {
  const merges = meta.authorMerges ?? [];
  return lru(groupsCache, `${id}|${JSON.stringify(merges)}`, () => buildAuthorGroups(index, merges));
}

/**
 * The one call the metric routes need: repository + resolved filters + the
 * compiled commit set + the computed metric set, all consistently cached.
 */
export function resolveQuery(id, params) {
  const { meta, index } = requireRepo(id);
  const groups = getAuthorGroups(id, index, meta);
  const authorFilterGid = authorFilterFromQuery(params, groups);
  const spec = commitSetFromQuery(params);
  const key = `${id}|${setCacheKey(spec)}|${JSON.stringify(meta.authorMerges ?? [])}|${authorFilterGid}`;
  const { set, metricSet } = lru(metricCache, key, () => {
    const compiled = compileCommitSet(index, spec, { authorGroups: groups, authorFilterGid });
    const metrics = computeMetrics(index, { include: compiled.include, authorGroups: groups });
    return { set: compiled, metricSet: metrics };
  });
  return { meta, index, groups, spec, authorFilterGid, set, metricSet };
}

/** First/last commit timestamps in the index (for date-picker bounds). */
export function commitTimeBounds(index) {
  let bounds = boundsCache.get(index);
  if (!bounds) {
    const ct = index.commits.ct;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < ct.length; i++) {
      if (ct[i] < min) min = ct[i];
      if (ct[i] > max) max = ct[i];
    }
    bounds = { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
    boundsCache.set(index, bounds);
  }
  return bounds;
}

/**
 * sha -> commit subject map for the commits browser, fetched lazily with a
 * single git pass (subjects are display-only metadata, never metrics).
 */
export async function getSubjects(id) {
  const cached = subjectsCache.get(id);
  if (cached) return cached;
  const { meta } = requireRepo(id);
  const map = new Map();
  try {
    const out = await git([
      '-C', store.repoGitDir(id),
      'log', '-z', '--no-merges', '--format=%H%x1f%s', meta.refSha,
    ]);
    for (const record of out.split('\0')) {
      if (!record) continue;
      const sep = record.indexOf('\x1f');
      if (sep >= 0) map.set(record.slice(0, sep), record.slice(sep + 1));
    }
  } catch {
    // display-only: a missing repository just yields no subjects
  }
  subjectsCache.set(id, map);
  if (subjectsCache.size > MAX_CACHED_SUBJECTS) subjectsCache.delete(subjectsCache.keys().next().value);
  return map;
}

/** Drops every cached derivation of a repository (after delete or merges). */
export function invalidateRepo(id) {
  for (const map of [groupsCache, metricCache, subjectsCache]) {
    for (const key of [...map.keys()]) {
      if (key === id || key.startsWith(`${id}|`)) map.delete(key);
    }
  }
}
