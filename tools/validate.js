#!/usr/bin/env node
// tools/validate.js
//
// Validates the metric engine against the reference exports in samples/.
//
// Usage:
//   node tools/validate.js                  # all samples (clones them once)
//   node tools/validate.js cjson redis      # subset by name
//   node tools/validate.js cjson=/path/to/clone   # use a local clone instead
//
// For each sample the tool:
//   1. clones the repository (bare, full history) into data/repos/ — reused on
//      later runs, or takes a local clone path,
//   2. extracts the index at the exact ref_sha recorded in the sample, reading
//      .mailmap from that same commit,
//   3. computes the full metric export and diffs it row by row against the
//      reference CSV (numeric columns compared numerically, text exactly),
//   4. reports PASS/FAIL per sample.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv } from '../server/csv.js';
import { CSV_HEADER, exportRows } from '../server/exporter.js';
import { buildIndex, startIngest } from '../server/ingest.js';
import { buildAuthorGroups, compileCommitSet, computeMetrics } from '../server/metrics.js';
import * as store from '../server/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SAMPLES = [
  { name: 'cjson', repo: 'cJSON', file: 'samples/cJSON_6d9f2443ab07.csv', url: 'https://github.com/DaveGamble/cJSON.git' },
  { name: 'redis', repo: 'redis', file: 'samples/redis_b540ca49cba8.csv', url: 'https://github.com/redis/redis.git' },
  { name: 'git', repo: 'git', file: 'samples/git_5a7d1e8045ce.csv', url: 'https://github.com/git/git.git' },
];

const NUMERIC_COLUMNS = new Set([3, 7, 8, 9, 10, 11, 12, 13, 14]);
const MAX_DETAILS = 25;

// ---------------------------------------------------------------- cli parsing

const locals = new Map();
const selected = [];
for (const arg of process.argv.slice(2)) {
  const match = /^([a-z0-9_]+)=(.+)$/i.exec(arg);
  if (match) locals.set(match[1].toLowerCase(), resolve(match[2]));
  else selected.push(arg.toLowerCase());
}
const picks = SAMPLES.filter((s) => selected.length === 0 || selected.includes(s.name));
if (picks.length === 0) {
  console.error(`unknown sample selection; choose from: ${SAMPLES.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

// ---------------------------------------------------------------- comparison

function compareRows(header, expected, got) {
  const diffs = [];
  let mismatchedRows = 0;
  const total = Math.max(expected.length, got.length);
  for (let i = 0; i < total; i++) {
    const e = expected[i];
    const g = got[i];
    if (!e || !g) {
      mismatchedRows += 1;
      if (diffs.length < MAX_DETAILS) {
        diffs.push({ row: i, column: '', expected: e ? JSON.stringify(e) : '(missing)', got: g ? JSON.stringify(g) : '(missing)' });
      }
      continue;
    }
    let rowDiffers = false;
    for (let c = 0; c < Math.max(e.length, g.length); c++) {
      const ev = e[c] ?? '';
      const gv = g[c] ?? '';
      let same;
      if (NUMERIC_COLUMNS.has(c)) {
        same = ev === '' || gv === '' ? ev === gv : Number(ev) === Number(gv);
      } else {
        same = ev === gv;
      }
      if (!same) {
        rowDiffers = true;
        if (diffs.length < MAX_DETAILS) {
          diffs.push({
            row: i,
            column: header[c] ?? `col${c}`,
            key: `${e[4]}:${e[5]}:${e[6]}`,
            expected: ev,
            got: gv,
          });
        }
      }
    }
    if (rowDiffers) mismatchedRows += 1;
  }
  return { diffs, mismatchedRows, total };
}

// ---------------------------------------------------------------- per sample

async function validateSample(sample) {
  const file = join(ROOT, sample.file);
  if (!existsSync(file)) {
    return { name: sample.name, ok: false, error: `sample file missing: ${sample.file}` };
  }
  const expectedAll = parseCsv(readFileSync(file, 'utf8'));
  const header = expectedAll[0];
  const expected = expectedAll.slice(1);
  if (JSON.stringify(header) !== JSON.stringify(CSV_HEADER)) {
    return { name: sample.name, ok: false, error: `unexpected sample header: ${header.join(',')}` };
  }
  const refSha = expected[0][1];
  const repoName = expected[0][0];

  // 1. locate the git directory (local override or managed clone)
  let gitDir;
  const local = locals.get(sample.name);
  if (local) {
    if (!existsSync(local)) return { name: sample.name, ok: false, error: `local clone not found: ${local}` };
    gitDir = existsSync(join(local, '.git')) ? join(local, '.git') : local;
  } else {
    const id = store.makeRepoId(sample.repo, sample.url);
    const meta = store.loadMeta(id);
    if (!meta) {
      console.log(`[${sample.name}] cloning ${sample.url} ...`);
      const job = startIngest({ kind: 'url', url: sample.url, name: sample.repo });
      const timer = setInterval(() => {
        if (job.status === 'running') {
          process.stdout.write(`\r[${sample.name}] ${job.phase} ${job.percent}% commits=${job.commits}      `);
        }
      }, 500);
      await job.done;
      clearInterval(timer);
      process.stdout.write('\r' + ' '.repeat(70) + '\r');
      if (job.status !== 'done') return { name: sample.name, ok: false, error: job.error };
      console.log(`[${sample.name}] clone complete (${store.loadMeta(job.repoId).counts.commits} commits at HEAD)`);
    } else {
      console.log(`[${sample.name}] using cached clone (${meta.counts.commits} commits at HEAD)`);
    }
    gitDir = store.repoGitDir(id);
  }

  // 2. extract at the exact sample ref, mailmap read from that commit
  console.log(`[${sample.name}] extracting ${refSha.slice(0, 12)} ...`);
  const t0 = Date.now();
  const index = await buildIndex(gitDir, refSha, { mailmapBlob: refSha });
  console.log(
    `[${sample.name}] ${index.commits.sha.length} non-merge commits, ${index.paths.length} paths, ` +
      `${index.authors.length} canonical authors (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  // 3. metrics + export
  const groups = buildAuthorGroups(index, []);
  const set = compileCommitSet(index, { kind: 'all' }, { authorGroups: groups });
  const metricSet = computeMetrics(index, { include: set.include, authorGroups: groups });
  const got = exportRows(index, { repoName, refSha, metricSet, groups });

  // persist our export next to the sample for manual inspection
  const outPath = join(store.DATA_DIR, 'validation', `${sample.name}-computed.csv`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, toCsv([CSV_HEADER, ...got]));

  // 4. diff
  const { diffs, mismatchedRows, total } = compareRows(header, expected, got);
  const ok = mismatchedRows === 0;
  console.log(`[${sample.name}] expected ${expected.length} rows, computed ${got.length} rows -> ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) {
    console.log(`[${sample.name}] mismatched rows: ${mismatchedRows}/${total}`);
    for (const d of diffs) {
      const where = d.key ? `${d.key} (row ${d.row})` : `row ${d.row}`;
      console.log(`    ${where} col=${d.column}: expected ${d.expected} got ${d.got}`);
    }
    console.log(`[${sample.name}] computed export written to ${outPath}`);
  }
  return { name: sample.name, ok, expected: expected.length, got: got.length, mismatchedRows };
}

// ---------------------------------------------------------------- main

const results = [];
for (const sample of picks) {
  results.push(await validateSample(sample));
}
console.log('\n=== validation summary ===');
for (const r of results) {
  if (r.error) console.log(`  ${r.name}: ERROR — ${r.error}`);
  else console.log(`  ${r.name}: ${r.ok ? 'PASS' : `FAIL (${r.mismatchedRows} mismatched rows)`} [${r.got}/${r.expected} rows]`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
