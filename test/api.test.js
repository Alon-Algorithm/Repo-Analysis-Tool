// test/api.test.js
//
// End-to-end test of the HTTP API: build the fixture repo, zip it, ingest it
// through the real upload route, then assert every metric endpoint against the
// same hand-computed expectations the metric engine is tested with.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from '../server/index.js';
import * as store from '../server/store.js';
import { parseCsv } from '../server/csv.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALON = 'Alon Algorithm <alon@example.com>';
const OTHER = 'Other Dev <other@example.com>';

let server;
let base;
let repoId;

async function getJson(path) {
  const res = await fetch(base + path);
  const body = await res.json();
  return { status: res.status, body };
}

async function waitForJob(jobId) {
  for (let i = 0; i < 200; i++) {
    const { body } = await getJson(`/api/jobs/${jobId}`);
    if (body.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('ingest job timed out');
}

before(async () => {
  // build + zip the fixture repo
  const tmp = join(ROOT, 'data', 'test-tmp');
  const fixtureDir = join(tmp, 'api-fixture');
  const zipPath = join(tmp, 'api-fixture.zip');
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  const gen = spawnSync(process.execPath, [join(ROOT, 'tools', 'makefixture.js'), fixtureDir], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const zip = spawnSync('zip', ['-q', '-r', zipPath, 'api-fixture'], { cwd: tmp });
  assert.equal(zip.status, 0, zip.stderr?.toString());

  // start the real HTTP server on an ephemeral port
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // ingest through the upload route
  const res = await fetch(`${base}/api/ingest/zip?name=api-fixture`, {
    method: 'POST',
    body: readFileSync(zipPath),
  });
  assert.equal(res.status, 202);
  const job = await res.json();
  const finished = await waitForJob(job.id);
  assert.equal(finished.status, 'done', finished.error ?? '');
  repoId = finished.repoId;
  assert.ok(repoId.startsWith('api-fixture-'));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (repoId) store.removeRepo(repoId);
  rmSync(join(ROOT, 'data', 'test-tmp', 'api-fixture'), { recursive: true, force: true });
  rmSync(join(ROOT, 'data', 'test-tmp', 'api-fixture.zip'), { force: true });
});

test('GET /api/repos lists the ingested repository', async () => {
  const { status, body } = await getJson('/api/repos');
  assert.equal(status, 200);
  const entry = body.repos.find((r) => r.id === repoId);
  assert.ok(entry, 'repo must be listed');
  assert.equal(entry.counts.commits, 14);
  assert.equal(entry.counts.paths, 8); // 9 numstat paths minus binary-only bin.dat
});

test('summary: repository stats, commit set and author breakdown', async () => {
  const { status, body } = await getJson(`/api/repos/${repoId}/summary`);
  assert.equal(status, 200);
  assert.deepEqual(body.stats, {
    added: 22,
    removed: 5,
    growth: 17,
    churn: 27,
    modifications: 11,
    modificationFrequency: 11 * (1 / 14),
    churnRate: 27 * (1 / 14),
  });
  assert.equal(body.commitSet.kind, 'all');
  assert.equal(body.commitSet.count, 14);
  assert.deepEqual(
    body.authors.map((a) => [a.label, a.churn, a.ownership]),
    [
      [ALON, 25, 25 / 27],
      [OTHER, 2, 2 / 27],
    ],
  );
  assert.ok(body.bounds.min < body.bounds.max);
});

test('range filter restricts the commit set (half-open)', async () => {
  const { body } = await getJson(
    `/api/repos/${repoId}/summary?kind=range&from=2024-01-01T00:00:00Z&to=2024-01-01T03:00:00Z`,
  );
  assert.equal(body.commitSet.count, 3);
  assert.equal(body.stats.added, 12);
  assert.equal(body.stats.removed, 1);
  assert.equal(body.stats.modifications, 2);
  assert.equal(body.commitSet.from, Date.UTC(2024, 0, 1) / 1000);
  assert.equal(body.commitSet.to, Date.UTC(2024, 0, 1, 3) / 1000);
});

test('author filter restricts the commit set to one group', async () => {
  const { body: authors } = await getJson(`/api/repos/${repoId}/authors`);
  const other = authors.groups.find((g) => g.label === OTHER);
  const { body } = await getJson(`/api/repos/${repoId}/summary?author=${other.gid}`);
  assert.equal(body.commitSet.count, 2);
  assert.equal(body.stats.added, 2);
  assert.equal(body.stats.modifications, 2);
  assert.equal(body.commitSet.authorFilter, OTHER);
});

test('tree drill-down walks directories and files with metrics', async () => {
  const root = await getJson(`/api/repos/${repoId}/tree`);
  assert.equal(root.status, 200);
  assert.deepEqual(root.body.dir.path, '/');
  assert.deepEqual(root.body.children.dirs.map((d) => d.path), ['dir']);
  assert.deepEqual(
    root.body.children.files.map((f) => f.path),
    ['.mailmap', 'a.txt', 'c.txt', 'empty.txt', 'naïve.txt', 'sp ace.txt'],
  );

  const dir = await getJson(`/api/repos/${repoId}/tree?dir=dir`);
  assert.deepEqual(dir.body.parents.map((p) => p.path), ['/']);
  assert.deepEqual(dir.body.children.files.map((f) => f.path), ['dir/b.txt', 'dir/c.txt']);
  assert.deepEqual(dir.body.dir.stats, {
    added: 6,
    removed: 4,
    growth: 2,
    churn: 10,
    modifications: 5,
    modificationFrequency: 5 * (1 / 14),
    churnRate: 10 * (1 / 14),
  });

  const missing = await getJson(`/api/repos/${repoId}/tree?dir=nope`);
  assert.equal(missing.status, 404);
});

test('file detail: stats, authors and rename history', async () => {
  const aTxt = await getJson(`/api/repos/${repoId}/file?path=${encodeURIComponent('a.txt')}`);
  assert.equal(aTxt.status, 200);
  assert.deepEqual(aTxt.body.stats, {
    added: 6,
    removed: 1,
    growth: 5,
    churn: 7,
    modifications: 2,
    modificationFrequency: 2 * (1 / 14),
    churnRate: 7 * (1 / 14),
  });
  assert.equal(aTxt.body.renames.from.length, 1);
  assert.equal(aTxt.body.renames.from[0].to, 'c.txt');
  assert.equal(aTxt.body.renames.from[0].sha.length, 40);

  const cTxt = await getJson(`/api/repos/${repoId}/file?path=c.txt`);
  assert.equal(cTxt.body.renames.to[0].from, 'a.txt');
  assert.equal(cTxt.body.renames.from[0].to, 'dir/c.txt');

  const binary = await getJson(`/api/repos/${repoId}/file?path=bin.dat`);
  assert.equal(binary.status, 404); // binary-only files stay out of the universe
});

test('timeline buckets activity by month', async () => {
  const { body } = await getJson(`/api/repos/${repoId}/timeline?bucket=month`);
  assert.equal(body.bucket, 'month');
  assert.equal(body.buckets.length, 1);
  assert.deepEqual(body.buckets[0], {
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

test('commit list supports paging and subject search', async () => {
  const index = store.loadIndex(repoId);
  const { body } = await getJson(`/api/repos/${repoId}/commits`);
  assert.equal(body.total, 14);
  assert.equal(body.commits.length, 14);
  assert.equal(body.commits[0].sha, index.commits.sha[0]);
  assert.ok(body.commits[0].subject.length > 0);

  const paged = await getJson(`/api/repos/${repoId}/commits?offset=10&limit=5`);
  assert.equal(paged.body.commits.length, 4);

  const none = await getJson(`/api/repos/${repoId}/commits?q=zzz-no-match`);
  assert.equal(none.body.total, 0);
});

test('export.csv matches the reference row format', async () => {
  const res = await fetch(`${base}/api/repos/${repoId}/export.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /filename="api-fixture-all\.csv"/);
  const rows = parseCsv(await res.text());
  assert.deepEqual(rows[0], [
    'repo', 'ref_sha', 'commit_set', 'commit_count', 'object_type', 'path', 'author',
    'added', 'removed', 'growth', 'churn', 'modifications',
    'modification_frequency', 'churn_rate', 'ownership',
  ]);
  const repoRow = rows[1];
  assert.deepEqual(repoRow.slice(4, 15), [
    'repository', '/', 'ALL', '22', '5', '17', '27', '11',
    String(11 * (1 / 14)), String(27 * (1 / 14)), '', // ALL rows carry frequency/rate, not ownership
  ]);
  assert.equal(repoRow[2], 'all');
  assert.equal(repoRow[3], '14');
});

test('merges unite identities everywhere, then can be reset', async () => {
  const res = await fetch(`${base}/api/repos/${repoId}/merges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ merges: [[ALON, OTHER]] }),
  });
  assert.equal(res.status, 200);
  const merged = await res.json();
  assert.equal(merged.groups.length, 1);

  const { body: summary } = await getJson(`/api/repos/${repoId}/summary`);
  assert.equal(summary.authors.length, 1);
  assert.deepEqual([summary.authors[0].label, summary.authors[0].churn, summary.authors[0].ownership], [ALON, 27, 1]);

  await fetch(`${base}/api/repos/${repoId}/merges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ merges: [] }),
  });
  const { body: reset } = await getJson(`/api/repos/${repoId}/summary`);
  assert.equal(reset.authors.length, 2);
});

test('DELETE removes the repository', async () => {
  const res = await fetch(`${base}/api/repos/${repoId}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const { body } = await getJson('/api/repos');
  assert.ok(!body.repos.some((r) => r.id === repoId));
  const again = await fetch(`${base}/api/repos/${repoId}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
  repoId = null; // already gone: skip cleanup
});

test('unknown routes and bad parameters produce clean errors', async () => {
  const { status, body } = await getJson('/api/repos/nope/summary');
  assert.equal(status, 404);
  assert.match(body.error, /unknown repository/);

  const bad = await getJson(`/api/repos/nope/tree?kind=wat`);
  assert.equal(bad.status, 404); // repo check happens first
});
