// test/ingest.test.js
//
// End-to-end test of the ZIP ingest pipeline: build the fixture repo, zip it,
// run the full ingest job, and assert the resulting index/meta are correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startIngest } from '../server/ingest.js';
import * as store from '../server/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('zip ingest builds a correct repository index', async () => {
  const tmp = join(ROOT, 'data', 'test-tmp');
  const fixtureDir = join(tmp, 'ingest-fixture');
  const zipPath = join(tmp, 'ingest-fixture.zip');
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });

  // 1. build the fixture repository
  const gen = spawnSync(process.execPath, [join(ROOT, 'tools', 'makefixture.js'), fixtureDir], {
    encoding: 'utf8',
  });
  assert.equal(gen.status, 0, gen.stderr);

  // 2. zip it (including the .git directory)
  const zip = spawnSync('zip', ['-q', '-r', zipPath, 'ingest-fixture'], { cwd: tmp });
  assert.equal(zip.status, 0, zip.stderr?.toString());
  const listing = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  assert.match(listing.stdout, /\.git\/HEAD/);

  // 3. ingest
  const job = startIngest({ kind: 'zip', zipPath, name: 'fixture' });
  await job.done;
  assert.equal(job.status, 'done', job.error ?? '');
  assert.equal(job.phase, 'done');
  const id = job.repoId;
  assert.ok(id.startsWith('fixture-'));

  // 4. meta
  const meta = store.loadMeta(id);
  assert.equal(meta.refSha.length, 40);
  assert.equal(meta.counts.commits, 14); // 16 commits, 2 merges excluded
  assert.deepEqual(meta.authorMerges, []);

  // 5. index: object universe
  const index = store.loadIndex(id);
  for (const p of [
    'a.txt',
    'c.txt',
    'dir/c.txt',
    'dir/b.txt',
    'bin.dat',
    'empty.txt',
    'naïve.txt',
    'sp ace.txt',
    '.mailmap',
  ]) {
    assert.ok(index.paths.includes(p), `universe must include ${p}`);
  }

  // 6. canonical vs raw identities (.mailmap applied by git itself)
  assert.deepEqual(
    [...index.authors].sort(),
    ['Alon Algorithm <alon@example.com>', 'Other Dev <other@example.com>'],
  );
  assert.equal(index.rawAuthors.length, 4); // Alon, Alias, old-email, Other Dev

  // 7. change rows
  const { changes, paths } = index;
  assert.equal(changes.c.length, changes.p.length);
  assert.ok(changes.c.every((c) => c >= 0 && c < meta.counts.commits));
  assert.ok(changes.p.every((p) => p >= 0 && p < paths.length));

  // the pure rename row: old path c.txt referenced, new path is the row's path
  const renameRow = changes.rn.findIndex((rn) => rn >= 0);
  assert.ok(renameRow >= 0);
  assert.equal(paths[changes.rn[renameRow]], 'c.txt');
  assert.equal(paths[changes.p[renameRow]], 'dir/c.txt');

  // binary rows keep -1 counts but still enter the universe
  const binRow = changes.p.findIndex((p) => paths[p] === 'bin.dat');
  assert.equal(changes.a[binRow], -1);
  assert.equal(changes.r[binRow], -1);

  // 8. the stored git directory is usable with --use-mailmap (bare semantics)
  const gitDir = store.repoGitDir(id);
  const bareCheck = spawnSync('git', ['-C', gitDir, 'rev-parse', '--is-bare-repository'], {
    encoding: 'utf8',
  });
  assert.equal(bareCheck.stdout.trim(), 'true');

  // 9. cleanup
  store.removeRepo(id);
  assert.equal(store.loadMeta(id), null);
});
