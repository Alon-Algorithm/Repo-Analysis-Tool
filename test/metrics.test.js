// test/metrics.test.js
//
// Verifies the metric engine against the synthetic fixture, whose diff
// sequence is fully known (see tools/makefixture.js):
//
//   14 non-merge commits, two canonical authors (12 + 2), one pure rename,
//   one rename+edit, one deletion, binary and empty-file edits, empty commit.
//
// Hand-computed expectations for the full commit set:
//   repository: added 22, removed 5, churn 27, growth 17, modifications 11
//   Alon Algorithm: churn 25, modifications 9   Other Dev: churn 2, modifications 2

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildIndex } from '../server/ingest.js';
import {
  buildAuthorGroups,
  buildObjectModel,
  compileCommitSet,
  computeMetrics,
  computeTimeline,
  fileStats,
  dirStats,
  repoStats,
  authorBreakdown,
  listChildren,
  renameHistory,
} from '../server/metrics.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALON = 'Alon Algorithm <alon@example.com>';
const OTHER = 'Other Dev <other@example.com>';

let index;
let groups;

before(async () => {
  const fixtureDir = join(ROOT, 'data', 'test-tmp', 'metrics-fixture');
  const gen = spawnSync(process.execPath, [join(ROOT, 'tools', 'makefixture.js'), fixtureDir], {
    encoding: 'utf8',
  });
  assert.equal(gen.status, 0, gen.stderr);
  index = await buildIndex(fixtureDir, 'HEAD');
  groups = buildAuthorGroups(index, []);
});

const allSet = () => compileCommitSet(index, { kind: 'all' }, { authorGroups: groups });
const pid = (path) => index.paths.indexOf(path);
const did = (path) => buildObjectModel(index).dirIdx.get(path);

test('commit set and canonical identities', () => {
  const { include, count } = allSet();
  assert.equal(count, 14);
  assert.equal(include.length, 14);
  assert.deepEqual(index.authors, [ALON, OTHER]);
  assert.equal(groups.nGroups, 2);
});

test('repository-level metrics for the full set', () => {
  const metricSet = computeMetrics(index, { include: allSet().include, authorGroups: groups });
  const repo = repoStats(metricSet);
  assert.equal(metricSet.commitCount, 14);
  assert.equal(repo.added, 22);
  assert.equal(repo.removed, 5);
  assert.equal(repo.growth, 17);
  assert.equal(repo.churn, 27);
  assert.equal(repo.modifications, 11); // empty commit, pure rename and binary-only commit modify nothing
  // reference arithmetic: multiply by 1/|H| (not divide)
  assert.equal(repo.modificationFrequency, 11 * (1 / 14));
  assert.equal(repo.churnRate, 27 * (1 / 14));
});

test('file metrics: renames, deletions, binary and empty files', () => {
  const metricSet = computeMetrics(index, { include: allSet().include, authorGroups: groups });

  assert.deepEqual(fileStats(metricSet, pid('a.txt')), {
    added: 6, removed: 1, growth: 5, churn: 7, modifications: 2,
    modificationFrequency: 2 * (1 / 14), churnRate: 7 * (1 / 14),
  });

  // renamed away untouched: exists in the universe with all-zero metrics
  assert.deepEqual(fileStats(metricSet, pid('c.txt')), {
    added: 0, removed: 0, growth: 0, churn: 0, modifications: 0,
    modificationFrequency: 0, churnRate: 0,
  });
  assert.deepEqual(authorBreakdown(index, metricSet, 'file', pid('c.txt'), groups), []);

  // rename + edit: all changes attributed to the new path
  assert.equal(fileStats(metricSet, pid('dir/c.txt')).added, 3);
  assert.equal(fileStats(metricSet, pid('dir/c.txt')).removed, 1);
  assert.equal(fileStats(metricSet, pid('dir/c.txt')).modifications, 2);

  // deletion: removed lines recorded on the deleted path
  const deleted = fileStats(metricSet, pid('dir/b.txt'));
  assert.deepEqual([deleted.added, deleted.removed, deleted.modifications], [3, 3, 3]);

  // binary file: in the universe, never measured
  const binary = fileStats(metricSet, pid('bin.dat'));
  assert.deepEqual([binary.added, binary.removed, binary.modifications], [0, 0, 0]);

  // empty file filled in one commit
  assert.deepEqual([fileStats(metricSet, pid('empty.txt')).added, fileStats(metricSet, pid('empty.txt')).modifications], [1, 1]);

  // spaced / unicode paths
  assert.equal(fileStats(metricSet, pid('sp ace.txt')).added, 3);
  assert.equal(fileStats(metricSet, pid('naïve.txt')).churn, 4);
});

test('directory metrics aggregate subtrees with per-commit modification dedupe', () => {
  const metricSet = computeMetrics(index, { include: allSet().include, authorGroups: groups });
  const dir = dirStats(metricSet, did('dir'));
  assert.equal(dir.added, 6); // dir/b.txt (3) + dir/c.txt (3)
  assert.equal(dir.removed, 4); // dir/b.txt (3, deleted) + dir/c.txt (1)
  assert.equal(dir.modifications, 5); // 5 distinct commits touched dir/
});

test('author breakdown: churn shares and modifications per author', () => {
  const metricSet = computeMetrics(index, { include: allSet().include, authorGroups: groups });

  const repoAuthors = authorBreakdown(index, metricSet, 'dir', 0, groups);
  assert.equal(repoAuthors.length, 2);
  assert.deepEqual(
    repoAuthors.map((a) => [a.label, a.churn, a.modifications]),
    [
      [ALON, 25, 9],
      [OTHER, 2, 2],
    ],
  );
  assert.equal(repoAuthors[0].ownership, 25 / 27);
  assert.equal(repoAuthors[1].ownership, 2 / 27);

  // a file edited by both authors: ownership splits exactly
  const naive = authorBreakdown(index, metricSet, 'file', pid('naïve.txt'), groups);
  assert.deepEqual(
    naive.map((a) => [a.label, a.churn, a.ownership]),
    [
      [ALON, 3, 3 / 4],
      [OTHER, 1, 1 / 4],
    ],
  );

  // repository root modification dedupe: per author, per commit, once
  assert.equal(metricSet.groupCommits[0], 12);
  assert.equal(metricSet.groupCommits[1], 2);
});

test('commit-set filters: half-open range and manual commit list', () => {
  const from = Date.UTC(2024, 0, 1, 0, 0, 0) / 1000;
  const to = Date.UTC(2024, 0, 1, 3, 0, 0) / 1000;
  const range = compileCommitSet(index, { kind: 'range', from, to }, { authorGroups: groups });
  assert.equal(range.count, 3); // commits at 00:00, 01:00, 02:00 — 03:00 is excluded

  const rangeSet = computeMetrics(index, { include: range.include, authorGroups: groups });
  assert.equal(repoStats(rangeSet).added, 12); // root 8 + edit 4
  assert.equal(repoStats(rangeSet).removed, 1);
  assert.equal(repoStats(rangeSet).modifications, 2); // pure rename modifies nothing

  // the two oldest commits: root (8 added) + first edit (4 added, 1 removed)
  const shas = index.commits.sha.slice(-1).concat(index.commits.sha.slice(-2, -1));
  const list = compileCommitSet(index, { kind: 'list', shas }, { authorGroups: groups });
  assert.equal(list.count, 2);
  const listSet = computeMetrics(index, { include: list.include, authorGroups: groups });
  assert.equal(repoStats(listSet).added, 12);
});

test('author filter restricts the commit set itself', () => {
  const set = compileCommitSet(index, { kind: 'all' }, { authorGroups: groups, authorFilterGid: 1 });
  assert.equal(set.count, 2); // Other Dev made two non-merge commits
  const metricSet = computeMetrics(index, { include: set.include, authorGroups: groups });
  const repo = repoStats(metricSet);
  assert.equal(repo.added, 2);
  assert.equal(repo.removed, 0);
  assert.equal(repo.modifications, 2);
  assert.equal(repo.modificationFrequency, 1);
  assert.equal(repo.churnRate, 1);
});

test('manual author merging unions identities and relabels', () => {
  const merged = buildAuthorGroups(index, [[ALON, OTHER]]);
  assert.equal(merged.nGroups, 1);
  const set = compileCommitSet(index, { kind: 'all' }, { authorGroups: merged });
  const metricSet = computeMetrics(index, { include: set.include, authorGroups: merged });
  assert.equal(metricSet.groupCommits[0], 14);
  const repoAuthors = authorBreakdown(index, metricSet, 'dir', 0, merged);
  assert.deepEqual(repoAuthors.map((a) => [a.label, a.churn, a.ownership]), [[ALON, 27, 1]]);
});

test('timeline buckets commits, lines and repository modifications', () => {
  const timeline = computeTimeline(index, { include: allSet().include, bucket: 'month' });
  assert.equal(timeline.length, 1);
  assert.deepEqual(timeline[0], {
    key: '2024-01',
    start: Date.UTC(2024, 0, 1) / 1000,
    end: Date.UTC(2024, 1, 1) / 1000,
    commits: 14,
    added: 22,
    removed: 5,
    churn: 27,
    modifications: 11,
  });
});

test('tree drill-down lists children with metrics', () => {
  const metricSet = computeMetrics(index, { include: allSet().include, authorGroups: groups });
  const root = listChildren(index, metricSet, 0);
  assert.deepEqual(root.dirs.map((d) => d.path), ['dir']);
  assert.deepEqual(
    root.files.map((f) => f.path),
    ['.mailmap', 'a.txt', 'bin.dat', 'c.txt', 'empty.txt', 'naïve.txt', 'sp ace.txt'],
  );
  const dirChildren = listChildren(index, metricSet, did('dir'));
  assert.deepEqual(dirChildren.files.map((f) => f.path), ['dir/b.txt', 'dir/c.txt']);
});

test('rename history tracks both directions', () => {
  const aTxt = pid('a.txt');
  const cTxt = pid('c.txt');
  const dirC = pid('dir/c.txt');
  assert.deepEqual(renameHistory(index, aTxt).renamesTo, []);
  assert.equal(renameHistory(index, aTxt).renamesFrom.length, 1);
  assert.equal(renameHistory(index, aTxt).renamesFrom[0].to, 'c.txt');
  assert.equal(renameHistory(index, cTxt).renamesTo[0].from, 'a.txt');
  assert.equal(renameHistory(index, cTxt).renamesFrom[0].to, 'dir/c.txt');
  assert.equal(renameHistory(index, dirC).renamesTo[0].from, 'c.txt');
});
