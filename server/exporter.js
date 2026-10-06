// server/exporter.js
//
// Builds the reference-format metric export for a repository:
//
//   objects:  repository ('/') first, then directories and files in flat
//             ASCII order of their full paths
//   rows:     per object one "ALL" row, then one row per author with
//             churn > 0 sorted by churn descending
//   columns:  repo,ref_sha,commit_set,commit_count,object_type,path,author,
//             added,removed,growth,churn,modifications,
//             modification_frequency,churn_rate,ownership
//
// Integer-valued columns print as integers; float-valued columns print
// Python-style so that mathematically integral floats keep their ".0"
// (0.0, 1.0, ...) exactly like the reference samples.

import { authorBreakdown, buildObjectModel, dirStats, fileStats } from './metrics.js';

export const CSV_HEADER = [
  'repo',
  'ref_sha',
  'commit_set',
  'commit_count',
  'object_type',
  'path',
  'author',
  'added',
  'removed',
  'growth',
  'churn',
  'modifications',
  'modification_frequency',
  'churn_rate',
  'ownership',
];

/** Python-style float formatting: integral floats keep a ".0" suffix. */
export function pyFloat(x) {
  if (Number.isInteger(x)) return `${x}.0`;
  return String(x);
}

// flat ASCII (UTF-16 code unit) order — locale-independent
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Returns the export rows (arrays of column strings) for a computed metric
 * set. `groups` comes from buildAuthorGroups; `metricSet` from computeMetrics.
 */
export function exportRows(index, { repoName, refSha, commitSetLabel = 'all', metricSet, groups }) {
  const model = buildObjectModel(index);
  const count = String(metricSet.commitCount);
  const rows = [];

  const pushObject = (objectType, displayPath, kind, objectId) => {
    const stats = kind === 'file' ? fileStats(metricSet, objectId) : dirStats(metricSet, objectId);
    rows.push([
      repoName,
      refSha,
      commitSetLabel,
      count,
      objectType,
      displayPath,
      'ALL',
      String(stats.added),
      String(stats.removed),
      String(stats.growth),
      String(stats.churn),
      String(stats.modifications),
      pyFloat(stats.modificationFrequency),
      pyFloat(stats.churnRate),
      '',
    ]);
    for (const author of authorBreakdown(index, metricSet, kind, objectId, groups)) {
      rows.push([
        repoName,
        refSha,
        commitSetLabel,
        count,
        objectType,
        displayPath,
        author.label,
        String(author.added),
        String(author.removed),
        String(author.growth),
        String(author.churn),
        String(author.modifications),
        '',
        '',
        pyFloat(author.ownership),
      ]);
    }
  };

  pushObject('repository', '/', 'dir', 0);

  const dirIds = [];
  for (let d = 1; d < model.nDirs; d++) dirIds.push(d);
  dirIds.sort((a, b) => cmp(model.dirPaths[a], model.dirPaths[b]));
  for (const d of dirIds) pushObject('directory', model.dirPaths[d], 'dir', d);

  const pathIds = [];
  for (let p = 0; p < index.paths.length; p++) pathIds.push(p);
  pathIds.sort((a, b) => cmp(index.paths[a], index.paths[b]));
  for (const p of pathIds) pushObject('file', index.paths[p], 'file', p);

  return rows;
}
