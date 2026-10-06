// server/metrics.js
//
// The metric engine. Everything derives from the index's flat change arrays
// in a single linear pass per query:
//
//   per commit h and object o:  l+, l-  (line counts in o vs h's parent)
//   growth  δ = l+ - l-
//   churn   λ = l+ + l-
//   modifications n = #commits in H with λ > 0              (per-commit deduped for directories)
//   modification frequency η = n / |H|                      (0 if |H| = 0)
//   churn rate ρ = λ / |H|
//   ownership ω = λ(o,a) / λ(o)                             (0 if λ(o) = 0)
//
// Objects: every numstat path (the file universe) plus every ancestor
// directory; the repository is the root directory (dir id 0).
//
// Commit sets: H̄ = all non-merge commits in the index; a range filter selects
// { h : from <= ct(h) < to } (half-open); a list filter selects exact shas.
// An author filter restricts the set itself: H' = { h in H : author(h) in A }.

const modelCache = new WeakMap();
const gidCache = new WeakMap();

// ---------------------------------------------------------------- object model

/** Builds the directory universe and file->parent links (cached per index). */
export function buildObjectModel(index) {
  let model = modelCache.get(index);
  if (model) return model;

  const dirIdx = new Map([['', 0]]);
  const dirPaths = [''];
  const dirParent = [-1];
  const dirOfPath = new Int32Array(index.paths.length);
  const filesOfDir = [[]];

  for (let p = 0; p < index.paths.length; p++) {
    const segments = index.paths[p].split('/');
    segments.pop(); // drop the file name
    let parent = 0;
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      let id = dirIdx.get(prefix);
      if (id === undefined) {
        id = dirPaths.length;
        dirIdx.set(prefix, id);
        dirPaths.push(prefix);
        dirParent.push(parent);
        filesOfDir.push([]);
      }
      parent = id;
    }
    dirOfPath[p] = parent;
    filesOfDir[parent].push(p);
  }

  const childDirs = dirPaths.map(() => []);
  for (let d = 1; d < dirPaths.length; d++) childDirs[dirParent[d]].push(d);

  model = {
    nDirs: dirPaths.length,
    dirPaths, // '' is the root; display as '/'
    dirParent: Int32Array.from(dirParent),
    dirOfPath,
    dirIdx,
    childDirs,
    filesOfDir,
  };
  modelCache.set(index, model);
  return model;
}

// ---------------------------------------------------------------- author groups

/**
 * Union-find over canonical identities. merges: [["Primary <p>", "Alias <a>"], ...]
 * where the first identity of each group is the display label.
 * Returns { groups: [{ label, members }], gidOfAuthor: Int32Array, nGroups }.
 */
export function buildAuthorGroups(index, merges = []) {
  const n = index.authors.length;
  const authorIdx = new Map(index.authors.map((name, i) => [name, i]));
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const labels = new Map();
  for (const group of merges) {
    if (!Array.isArray(group) || group.length === 0) continue;
    const ids = group.map((name) => authorIdx.get(name)).filter((i) => i !== undefined);
    if (ids.length === 0) continue;
    for (let k = 1; k < ids.length; k++) union(ids[0], ids[k]);
    const root = find(ids[0]);
    if (!labels.has(root)) labels.set(root, group[0]);
  }

  const gidMap = new Map();
  const groups = [];
  const gidOfAuthor = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let gid = gidMap.get(root);
    if (gid === undefined) {
      gid = groups.length;
      gidMap.set(root, gid);
      groups.push({ label: labels.get(root) ?? index.authors[i], members: [] });
    }
    groups[gid].members.push(i);
    gidOfAuthor[i] = gid;
  }
  return { groups, gidOfAuthor, nGroups: groups.length };
}

/** Per-commit group ids for an author-group config (cached per index+config). */
export function commitGids(index, authorGroups) {
  let cache = gidCache.get(index);
  if (!cache) {
    cache = new WeakMap();
    gidCache.set(index, cache);
  }
  let gids = cache.get(authorGroups);
  if (!gids) {
    const { author } = index.commits;
    const source = authorGroups.gidOfAuthor;
    gids = new Int32Array(author.length);
    for (let i = 0; i < author.length; i++) gids[i] = source[author[i]];
    cache.set(authorGroups, gids);
  }
  return gids;
}

// ---------------------------------------------------------------- commit sets

/**
 * spec: { kind: 'all' } | { kind: 'range', from?, to? } | { kind: 'list', shas }
 * Author filter (group id) restricts the set to that author's commits.
 * Returns { include: Uint8Array, count }.
 */
export function compileCommitSet(index, spec = { kind: 'all' }, { authorGroups, authorFilterGid = -1 } = {}) {
  const { sha, ct } = index.commits;
  const n = sha.length;
  const include = new Uint8Array(n);
  const kind = spec.kind ?? 'all';
  if (kind === 'all') {
    include.fill(1);
  } else if (kind === 'range') {
    const from = spec.from ?? -Infinity;
    const to = spec.to ?? Infinity;
    for (let i = 0; i < n; i++) if (ct[i] >= from && ct[i] < to) include[i] = 1;
  } else if (kind === 'list') {
    const want = new Set((spec.shas ?? []).map((s) => String(s).toLowerCase()));
    for (let i = 0; i < n; i++) if (want.has(sha[i])) include[i] = 1;
  } else {
    throw new Error(`unknown commit-set kind: ${kind}`);
  }

  if (authorFilterGid >= 0) {
    if (!authorGroups) throw new Error('author filter requires authorGroups');
    const gids = commitGids(index, authorGroups);
    for (let i = 0; i < n; i++) if (include[i] && gids[i] !== authorFilterGid) include[i] = 0;
  }

  let count = 0;
  for (let i = 0; i < n; i++) count += include[i];
  return { include, count };
}

// ---------------------------------------------------------------- aggregation

const bump = (map, gid, a, r, mods) => {
  let entry = map.get(gid);
  if (!entry) {
    entry = { added: 0, removed: 0, modifications: 0 };
    map.set(gid, entry);
  }
  entry.added += a;
  entry.removed += r;
  entry.modifications += mods;
  return entry;
};

/**
 * Single pass over the change rows of the included commits.
 * Returns per-object metrics and per-object per-author breakdowns.
 */
export function computeMetrics(index, { include, authorGroups }) {
  const model = buildObjectModel(index);
  const { changes, commits } = index;
  const nPaths = index.paths.length;
  const nDirs = model.nDirs;
  const nGroups = authorGroups.nGroups;
  const gids = commitGids(index, authorGroups);

  const fileAdded = new Float64Array(nPaths);
  const fileRemoved = new Float64Array(nPaths);
  const fileMods = new Int32Array(nPaths);
  const fileByAuthor = new Array(nPaths).fill(null);

  const dirAdded = new Float64Array(nDirs);
  const dirRemoved = new Float64Array(nDirs);
  const dirMods = new Int32Array(nDirs);
  const dirByAuthor = new Array(nDirs).fill(null);
  const dirTouch = new Int32Array(nDirs).fill(-1);

  const rowCount = changes.c.length;
  for (let i = 0; i < rowCount; i++) {
    const c = changes.c[i];
    if (!include[c]) continue;
    const a = changes.a[i];
    const r = changes.r[i];
    if (a < 0 || r < 0) continue; // binary / unmeasured: no metric effect
    if (a + r === 0) continue; // zero-churn edit: no modifications either
    const p = changes.p[i];
    const gid = gids[c];

    fileAdded[p] += a;
    fileRemoved[p] += r;
    fileMods[p] += 1;
    let fa = fileByAuthor[p];
    if (!fa) {
      fa = new Map();
      fileByAuthor[p] = fa;
    }
    bump(fa, gid, a, r, 1); // one numstat row per commit: no dedupe needed

    let d = model.dirOfPath[p];
    while (d >= 0) {
      dirAdded[d] += a;
      dirRemoved[d] += r;
      let da = dirByAuthor[d];
      if (!da) {
        da = new Map();
        dirByAuthor[d] = da;
      }
      if (dirTouch[d] !== c) {
        // first time this commit touches this directory: one modification
        dirTouch[d] = c;
        dirMods[d] += 1;
        bump(da, gid, 0, 0, 1);
      }
      bump(da, gid, a, r, 0);
      d = model.dirParent[d];
    }
  }

  // commits per group within the set
  const groupCommits = new Int32Array(nGroups);
  let commitCount = 0;
  for (let i = 0; i < commits.sha.length; i++) {
    if (!include[i]) continue;
    commitCount += 1;
    groupCommits[gids[i]] += 1;
  }

  return {
    commitCount,
    file: { added: fileAdded, removed: fileRemoved, modifications: fileMods, byAuthor: fileByAuthor },
    dir: { added: dirAdded, removed: dirRemoved, modifications: dirMods, byAuthor: dirByAuthor },
    groupCommits,
  };
}

// ---------------------------------------------------------------- accessors

export function fileStats(metricSet, pathId) {
  const added = metricSet.file.added[pathId];
  const removed = metricSet.file.removed[pathId];
  const churn = added + removed;
  const n = metricSet.file.modifications[pathId];
  const inv = metricSet.commitCount > 0 ? 1 / metricSet.commitCount : 0;
  return {
    added,
    removed,
    growth: added - removed,
    churn,
    modifications: n,
    // reference semantics: multiply by 1/|H| (not divide) — identical double result
    modificationFrequency: n * inv,
    churnRate: churn * inv,
  };
}

export function dirStats(metricSet, dirId) {
  const added = metricSet.dir.added[dirId];
  const removed = metricSet.dir.removed[dirId];
  const churn = added + removed;
  const n = metricSet.dir.modifications[dirId];
  const inv = metricSet.commitCount > 0 ? 1 / metricSet.commitCount : 0;
  return {
    added,
    removed,
    growth: added - removed,
    churn,
    modifications: n,
    // reference semantics: multiply by 1/|H| (not divide) — identical double result
    modificationFrequency: n * inv,
    churnRate: churn * inv,
  };
}

export const repoStats = (metricSet) => dirStats(metricSet, 0);

/**
 * Author breakdown for one object, sorted by churn desc (then label asc).
 * Only authors with churn > 0 are present in the breakdown (matches the
 * reference exports: author rows are emitted only when λ(o, a) > 0).
 */
export function authorBreakdown(index, metricSet, kind, objectId, authorGroups) {
  const byAuthor = (kind === 'file' ? metricSet.file.byAuthor : metricSet.dir.byAuthor)[objectId];
  if (!byAuthor) return [];
  const totalChurn = kind === 'file'
    ? metricSet.file.added[objectId] + metricSet.file.removed[objectId]
    : metricSet.dir.added[objectId] + metricSet.dir.removed[objectId];
  const rows = [];
  for (const [gid, entry] of byAuthor) {
    const churn = entry.added + entry.removed;
    rows.push({
      gid,
      label: authorGroups.groups[gid].label,
      added: entry.added,
      removed: entry.removed,
      growth: entry.added - entry.removed,
      churn,
      modifications: entry.modifications,
      ownership: totalChurn === 0 ? 0 : churn / totalChurn,
    });
  }
  rows.sort((x, y) => y.churn - x.churn || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
  return rows;
}

/** Immediate children of a directory with their metrics (for drill-down UI). */
export function listChildren(index, metricSet, dirId) {
  const model = buildObjectModel(index);
  const dirs = model.childDirs[dirId].map((id) => ({
    dirId: id,
    path: model.dirPaths[id],
    ...dirStats(metricSet, id),
  }));
  const files = model.filesOfDir[dirId].map((pathId) => ({
    pathId,
    path: index.paths[pathId],
    ...fileStats(metricSet, pathId),
  }));
  dirs.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { dirs, files };
}

/** Rename history touching a path (both directions), scanned from the rows. */
export function renameHistory(index, pathId) {
  const { changes, paths } = index;
  const renamesFrom = []; // this path renamed away to ...
  const renamesTo = []; // this path was produced by renaming ...
  for (let i = 0; i < changes.rn.length; i++) {
    const rn = changes.rn[i];
    if (rn < 0) continue;
    if (changes.p[i] === pathId) {
      renamesTo.push({ commit: changes.c[i], from: paths[rn], to: paths[pathId] });
    } else if (rn === pathId) {
      renamesFrom.push({ commit: changes.c[i], from: paths[pathId], to: paths[changes.p[i]] });
    }
  }
  return { renamesTo, renamesFrom };
}

// ---------------------------------------------------------------- timeline

const pad2 = (n) => String(n).padStart(2, '0');

function bucketInfo(bucket, ct) {
  const d = new Date(ct * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (bucket === 'day') {
    return { key: `${y}-${pad2(m + 1)}-${pad2(day)}`, start: Date.UTC(y, m, day) / 1000, end: Date.UTC(y, m, day) / 1000 + 86400 };
  }
  if (bucket === 'week') {
    const mondayOffset = (d.getUTCDay() + 6) % 7;
    const start = Date.UTC(y, m, day - mondayOffset) / 1000;
    const sd = new Date(start * 1000);
    return {
      key: `${sd.getUTCFullYear()}-${pad2(sd.getUTCMonth() + 1)}-${pad2(sd.getUTCDate())}`,
      start,
      end: start + 7 * 86400,
    };
  }
  return { key: `${y}-${pad2(m + 1)}`, start: Date.UTC(y, m, 1) / 1000, end: Date.UTC(y, m + 1, 1) / 1000 };
}

/**
 * Bucketed activity over the included commits: commit counts, line sums and
 * repository-level modifications per period, ascending by time.
 */
export function computeTimeline(index, { include, bucket = 'month' } = {}) {
  const { ct } = index.commits;
  const { changes } = index;
  const n = ct.length;
  const dirty = new Uint8Array(n); // commit modifies anything at repo level

  const buckets = new Map();
  const bucketOf = (commitIdx) => {
    const info = bucketInfo(bucket, ct[commitIdx]);
    let b = buckets.get(info.key);
    if (!b) {
      b = { key: info.key, start: info.start, end: info.end, commits: 0, added: 0, removed: 0, churn: 0, modifications: 0 };
      buckets.set(info.key, b);
    }
    return b;
  };

  let lastCommit = -1;
  let current = null;
  for (let i = 0; i < changes.c.length; i++) {
    const c = changes.c[i];
    if (!include[c]) continue;
    if (c !== lastCommit) {
      lastCommit = c;
      current = bucketOf(c);
    }
    const a = changes.a[i];
    const r = changes.r[i];
    if (a < 0 || r < 0) continue;
    current.added += a;
    current.removed += r;
    if (a + r > 0) dirty[c] = 1;
  }

  for (let i = 0; i < n; i++) {
    if (!include[i]) continue;
    const b = bucketOf(i);
    b.commits += 1;
    if (dirty[i]) b.modifications += 1;
  }

  const list = [...buckets.values()].sort((a, b) => a.start - b.start);
  for (const b of list) b.churn = b.added + b.removed;
  return list;
}
