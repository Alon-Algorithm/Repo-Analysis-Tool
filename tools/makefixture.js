#!/usr/bin/env node
// tools/makefixture.js
//
// Builds a small synthetic repository that exercises every edge case the metric
// engine must handle:
//   - root commit (diff against the empty commit)
//   - binary files (numstat "-" entries, never measured)
//   - empty files (0/0 entries)
//   - paths with spaces and unicode, renames across directories
//   - pure renames (must not change metrics)
//   - rename + edit (changes attributed to the NEW path)
//   - deletions (lines removed on the deleted path)
//   - merge commits (excluded from H-bar) both clean and conflict-resolved
//   - empty commits
//   - .mailmap aliases (name form, email-only form)
//
// Usage: node tools/makefixture.js [targetDir]
//   (default: data/fixtures/sample)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.argv[2] ?? 'data/fixtures/sample';

const run = (args, extraEnv = {}) => {
  const res = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
};

const write = (rel, content) => {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
};

let clock = 0;
const nextDate = () =>
  new Date(Date.UTC(2024, 0, 1) + clock++ * 3600_000).toISOString();

const commit = (msg, { name = 'Alon Algorithm', email = 'alon@example.com' } = {}) => {
  const d = nextDate();
  run(['add', '-A']);
  run(['commit', '--allow-empty', '-m', msg], {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: d,
    GIT_COMMITTER_DATE: d,
  });
};

// ---------------------------------------------------------------- build

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

run(['init', '-b', 'main']);
run(['config', 'user.name', 'Alon Algorithm']);
run(['config', 'user.email', 'alon@example.com']);
run(['config', 'core.autocrlf', 'false']);

// 1. root commit: text, binary, empty file, spaced + unicode paths
write('a.txt', 'a1\na2\na3\n');
write('dir/b.txt', 'b1\nb2\n');
write('bin.dat', Buffer.from([1, 2, 3, 0, 4, 5, 6, 0, 255, 254]));
write('empty.txt', '');
write('sp ace.txt', 's1\n');
write('naïve.txt', 'u1\nu2\n');
commit('root: initial files');

// 2. edit two text files
write('a.txt', 'a1\na2x\na3\na4\na5\n');
write('dir/b.txt', 'b1\nb2\nb3\n');
commit('edit two text files');

// 3. pure rename
run(['mv', 'a.txt', 'c.txt']);
commit('pure rename a.txt -> c.txt');

// 4. rename + edit into another directory
run(['mv', 'c.txt', 'dir/c.txt']);
write('dir/c.txt', 'a1\na2y\na3\na4\na5\na6\n');
commit('move into dir and edit');

// 5. deletion
run(['rm', 'dir/b.txt']);
commit('delete dir/b.txt');

// 6. branch work + clean (--no-ff) merge
run(['checkout', '-b', 'feature']);
write('dir/c.txt', 'a1\na2y\na3\na4\na5\na6\nf1\n');
commit('feature: append f1', { name: 'Other Dev', email: 'other@example.com' });
run(['checkout', 'main']);
write('sp ace.txt', 's1\ns2\n');
commit('main: append s2');
run(['merge', '--no-ff', 'feature', '-m', 'merge feature into main']);

// 7. conflict-resolved merge (still a merge commit: excluded from metrics)
run(['checkout', '-b', 'conflict']);
write('naïve.txt', 'u1\nu2\nC1\n');
commit('conflict: change naive file', { name: 'Other Dev', email: 'other@example.com' });
run(['checkout', 'main']);
write('naïve.txt', 'u1\nu2\nM1\n');
commit('main: change naive file again');
const mergeRes = spawnSync('git', ['-C', dir, 'merge', 'conflict', '-m', 'merge conflict'], {
  encoding: 'utf8',
  env: { ...process.env },
});
if (mergeRes.status === 0) throw new Error('expected a merge conflict in fixture');
write('naïve.txt', 'u1\nu2\nC1\nM1\n');
commit('merge conflict resolved');

// 8. empty commit
commit('empty commit');

// 9. binary edit only
write('bin.dat', Buffer.from([9, 9, 0, 9]));
commit('edit binary file');

// 10. alias author (name form) - merged via .mailmap later
write('empty.txt', 'now has content\n');
commit('alias author fills empty file', { name: 'Alon Alias', email: 'alias@example.com' });

// 11. old-email author (email-only form) - merged via .mailmap later
write('sp ace.txt', 's1\ns2\ns3\n');
commit('old-email author edits spaced path', { name: 'Alon Algorithm', email: 'old@example.com' });

// 12. add the mailmap itself
write(
  '.mailmap',
  [
    'Alon Algorithm <alon@example.com> Alon Alias <alias@example.com>',
    '<alon@example.com> <old@example.com>',
    '',
  ].join('\n'),
);
commit('add .mailmap');

// ---------------------------------------------------------------- report

console.log(`fixture created at: ${dir}`);
console.log(run(['log', '--format=%h|%ad|%an <%ae>|%aN <%aE>|%s', '--date=format:%Y-%m-%d %H:%M', 'HEAD']));
console.log(`non-merge commits: ${run(['rev-list', '--no-merges', '--count', 'HEAD'])}`);
console.log(`all commits:       ${run(['rev-list', '--count', 'HEAD'])}`);
