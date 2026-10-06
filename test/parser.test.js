// test/parser.test.js
//
// Verifies GitLogParser against handcrafted byte payloads (unit) and against a
// real `git log` extraction of the synthetic fixture repo (integration).
//
// Fixture repos are built under data/test-tmp/ (gitignored).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { GitLogParser, parseLog, logArgs } from '../server/parser.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const US = '\x1f';

// ---------------------------------------------------------------- builders

const hdr = (o) =>
  '@@' +
  [o.sha, o.parents ?? '', o.ct, o.an, o.ae, o.aN ?? o.an, o.aE ?? o.ae].join(US) +
  '\0';

const hdrNl = (o) => hdr(o) + '\n'; // header followed by entries

const ent = (a, r, p) => `${a}\t${r}\t${p}\0`;

const ren = (a, r, oldP, newP) => `${a}\t${r}\t\0${oldP}\0${newP}\0`;

const commitA = { sha: 'a'.repeat(40), parents: '', ct: 1704067200, an: 'Alon', ae: 'alon@x.com' };
const commitB = { sha: 'b'.repeat(40), parents: 'a'.repeat(40), ct: 1704070800, an: 'Other', ae: 'other@x.com' };

// ---------------------------------------------------------------- unit tests

test('parses commits with parents, timestamps and raw+canonical identities', () => {
  const raw =
    hdrNl(commitA) +
    ent(3, 0, 'a.txt') +
    ent(1, 2, 'dir/b.txt') +
    hdrNl(commitB) +
    ent(0, 0, 'empty.txt');

  const { commits, entries } = parseLog(Buffer.from(raw));

  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], { ...commitA, parents: [], aN: 'Alon', aE: 'alon@x.com' });
  assert.deepEqual(commits[1], { ...commitB, parents: ['a'.repeat(40)], aN: 'Other', aE: 'other@x.com' });
  assert.deepEqual(entries, [
    { added: 3, removed: 0, path: 'a.txt', oldPath: null },
    { added: 1, removed: 2, path: 'dir/b.txt', oldPath: null },
    { added: 0, removed: 0, path: 'empty.txt', oldPath: null },
  ]);
});

test('empty commits carry no entries and no LF separator', () => {
  const empty = { sha: 'e'.repeat(40), parents: commitB.sha, ct: 1704074400, an: 'E', ae: 'e@x.com' };
  // note: plain hdr() (no trailing LF) before the next header
  const raw = hdrNl(commitA) + ent(1, 0, 'f.txt') + hdr(empty) + hdrNl(commitB) + ent(0, 1, 'f.txt');

  const { commits, entries } = parseLog(raw);

  assert.deepEqual(commits.map((c) => c.sha), [commitA.sha, empty.sha, commitB.sha]);
  assert.equal(entries.length, 2); // empty commit contributed none
  assert.deepEqual(entries[0], { added: 1, removed: 0, path: 'f.txt', oldPath: null });
});

test('binary entries are reported with null counts', () => {
  const raw = hdrNl(commitA) + ent('-', '-', 'bin.dat');

  const { entries } = parseLog(raw);

  assert.deepEqual(entries, [{ added: null, removed: null, path: 'bin.dat', oldPath: null }]);
});

test('pure rename: the old path is attributed nothing, the new path appears', () => {
  const raw = hdrNl(commitA) + ren(0, 0, 'a.txt', 'c.txt');

  const { entries } = parseLog(raw);

  assert.deepEqual(entries, [{ added: 0, removed: 0, path: 'c.txt', oldPath: 'a.txt' }]);
});

test('rename + edit: line changes are attributed to the new path', () => {
  const raw = hdrNl(commitA) + ren(2, 1, 'c.txt', 'dir/c.txt');

  const { entries } = parseLog(raw);

  assert.deepEqual(entries, [{ added: 2, removed: 1, path: 'dir/c.txt', oldPath: 'c.txt' }]);
});

test('a rename followed by more entries does not confuse subsequent records', () => {
  const raw = hdrNl(commitA) + ren(2, 1, 'c.txt', 'dir/c.txt') + ent(5, 5, 'z.txt');

  const { entries } = parseLog(raw);

  assert.deepEqual(entries, [
    { added: 2, removed: 1, path: 'dir/c.txt', oldPath: 'c.txt' },
    { added: 5, removed: 5, path: 'z.txt', oldPath: null },
  ]);
});

test('unicode, spaced and tabbed paths survive untouched', () => {
  const raw = hdrNl(commitA) + ent(2, 0, 'naïve.txt') + ent(1, 0, 'sp ace.txt') + ent(1, 0, 'ta\tb.txt');

  const { entries } = parseLog(raw);

  assert.deepEqual(entries.map((e) => e.path), ['naïve.txt', 'sp ace.txt', 'ta\tb.txt']);
});

test('streaming: any chunk split produces identical results', () => {
  const raw = Buffer.from(
    hdrNl(commitA) +
      ent(3, 0, 'a.txt') +
      ent('-', '-', 'bin.dat') +
      ren(0, 0, 'a.txt', 'c.txt') +
      ren(2, 1, 'c.txt', 'dir/c.txt') +
      ent(0, 3, 'dir/b.txt') +
      ent(2, 0, 'naïve.txt') +
      hdr({ sha: 'e'.repeat(40), parents: commitA.sha, ct: 1704074400, an: 'E', ae: 'e@x.com' }) +
      hdrNl(commitB) +
      ent(0, 0, 'empty.txt'),
  );

  const expected = parseLog(raw);
  assert.equal(expected.commits.length, 3); // corpus is meaningful

  for (let i = 1; i < raw.length; i++) {
    const commits = [];
    const entries = [];
    const p = new GitLogParser({
      onCommit: (c) => commits.push(c),
      onEntry: (e) => entries.push(e),
    });
    p.push(raw.subarray(0, i));
    p.push(raw.subarray(i));
    p.end();
    assert.deepEqual({ commits, entries }, expected, `split at byte ${i}`);
  }
});

test('malformed and truncated streams are rejected', () => {
  assert.throws(() => parseLog(hdrNl(commitA) + 'garbage\0'), /malformed numstat/);
  assert.throws(() => parseLog(hdrNl(commitA) + '1\t2\tf.txt'), /truncated/);

  const parser = new GitLogParser();
  parser.push(hdrNl(commitA) + ren(1, 1, 'old.txt', 'new.txt').slice(0, -1));
  assert.throws(() => parser.end(), /truncated/);
});

// ---------------------------------------------------------------- integration

test('integration: parses a real git log extraction of the fixture repo', () => {
  const fixtureDir = join(ROOT, 'data', 'test-tmp', 'parser-fixture');
  rmSync(fixtureDir, { recursive: true, force: true });

  const gen = spawnSync(process.execPath, [join(ROOT, 'tools', 'makefixture.js'), fixtureDir], {
    encoding: 'utf8',
  });
  assert.equal(gen.status, 0, gen.stderr);

  const log = spawnSync('git', ['-C', fixtureDir, ...logArgs()], {
    encoding: 'buffer',
    maxBuffer: 1 << 26,
  });
  assert.equal(log.status, 0, log.stderr?.toString());

  const { commits, entries } = parseLog(log.stdout);

  // 16 commits in the fixture, 2 of them merges -> excluded from H-bar
  assert.equal(commits.length, 14);
  assert.ok(commits.every((c) => c.parents.length <= 1));

  // .mailmap canonicalisation: %an/%ae stay raw, %aN/%aE are rewritten
  const alias = commits.find((c) => c.an === 'Alon Alias');
  assert.equal(alias.aN, 'Alon Algorithm');
  assert.equal(alias.aE, 'alon@example.com');
  const oldMail = commits.find((c) => c.ae === 'old@example.com');
  assert.equal(oldMail.aE, 'alon@example.com');

  // pure rename contributes no line changes
  const pure = entries.find((e) => e.oldPath === 'a.txt');
  assert.deepEqual([pure.added, pure.removed, pure.path], [0, 0, 'c.txt']);

  // rename + edit is attributed to the new path only
  const moved = entries.find((e) => e.oldPath === 'c.txt');
  assert.deepEqual([moved.added, moved.removed, moved.path], [2, 1, 'dir/c.txt']);

  // deletion: removed lines on the deleted path
  assert.ok(entries.some((e) => e.path === 'dir/b.txt' && e.added === 0 && e.removed === 3));

  // binary files are listed but not measured
  assert.ok(entries.some((e) => e.path === 'bin.dat' && e.added === null && e.removed === null));

  // empty file edit is a real 0/0 entry (it belongs to the object universe)
  assert.ok(entries.some((e) => e.path === 'empty.txt' && e.added === 0 && e.removed === 0));

  // spaced and unicode paths survive untouched
  assert.ok(entries.some((e) => e.path === 'sp ace.txt'));
  assert.ok(entries.some((e) => e.path === 'naïve.txt'));

  // root commit diffs against the empty tree: a.txt is 3 additions
  assert.ok(entries.some((e) => e.path === 'a.txt' && e.added === 3 && e.removed === 0));
});
