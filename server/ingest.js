// server/ingest.js
//
// Turns a repository source (clone URL or uploaded ZIP) into a stored
// repository: a bare git directory plus a JSON index.
//
//   URL  -> git clone --bare --progress      -> data/repos/<id>/repo
//   ZIP  -> unzip -> locate .git -> move it  -> data/repos/<id>/repo
//           (+ core.bare=true so mailmap.blob defaults to HEAD:.mailmap)
//
// One `git log` pass then streams the numstat wire format through
// GitLogParser into flat index arrays — no intermediate files, O(1) chunks.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { GitLogParser, logArgs } from './parser.js';
import { cloneBare, git, streamGit, unzipFile } from './gitrun.js';
import * as store from './store.js';

// ---------------------------------------------------------------- jobs

const jobs = new Map();
let jobCounter = 0;

export function getJob(jobId) {
  return jobs.get(jobId) ?? null;
}

export function listJobs() {
  return [...jobs.values()].map(({ done, ...rest }) => rest);
}

/**
 * Starts an asynchronous ingest.
 * request: { kind: 'url', url } | { kind: 'zip', zipPath, name? }
 * Returns a job object polled by the API; `job.done` awaits completion.
 */
export function startIngest(request) {
  const job = {
    id: `job-${++jobCounter}-${Date.now().toString(36)}`,
    kind: request.kind,
    status: 'running',
    phase: 'queued',
    percent: 0,
    commits: 0,
    detail: '',
    repoId: null,
    error: null,
    done: null,
  };
  job.done = (async () => {
    try {
      job.repoId = request.kind === 'url' ? await ingestUrl(request, job) : await ingestZip(request, job);
      job.status = 'done';
      job.phase = 'done';
      job.percent = 100;
    } catch (err) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
    }
    return job;
  })();
  jobs.set(job.id, job);
  if (jobs.size > 100) {
    // drop the oldest finished job
    for (const [key, old] of jobs) {
      if (old.status !== 'running') {
        jobs.delete(key);
        break;
      }
    }
  }
  return job;
}

// ---------------------------------------------------------------- sources

function repoNameFromUrl(url) {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const segment = cleaned.split(/[/:]/).pop() ?? cleaned;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function ingestUrl(request, job) {
  const url = String(request.url ?? '').trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
    throw new Error('unsupported URL — use https://, ssh:// or git@host:path style clone URLs');
  }
  const name = request.name?.trim() || repoNameFromUrl(url);
  const id = store.makeRepoId(name, url);
  const previous = store.loadMeta(id);

  job.phase = 'cloning';
  job.percent = 0;
  job.detail = url;
  rmSync(store.repoPath(id), { recursive: true, force: true });
  mkdirSync(store.repoPath(id), { recursive: true });
  await cloneBare(url, store.repoGitDir(id), (phase, percent) => {
    job.percent = percent;
    job.detail = phase;
  });

  return finalize(id, { name, source: { kind: 'url', value: url }, previous, job });
}

async function ingestZip(request, job) {
  const zipPath = resolve(String(request.zipPath ?? ''));
  if (!existsSync(zipPath) || !statSync(zipPath).isFile()) {
    throw new Error('uploaded archive not found');
  }
  const zipBase = basename(zipPath).replace(/\.zip$/i, '');
  const staging = store.tmpPath(`${store.slugify(zipBase)}-${Date.now().toString(36)}`);

  job.phase = 'unpacking';
  job.percent = 0;
  job.detail = basename(zipPath);
  mkdirSync(staging, { recursive: true });
  try {
    await unzipFile(zipPath, staging);
    const gitDir = findGitDir(staging);
    if (!gitDir) {
      throw new Error('no .git directory found in the archive — zip the repository including its .git folder');
    }
    const guess = basename(resolve(gitDir, '..'));
    const name = request.name?.trim() || (guess && !guess.startsWith(".") && guess !== basename(staging) ? guess : zipBase);
    const id = store.makeRepoId(name, `zip:${zipBase}:${statSync(zipPath).size}`);
    const previous = store.loadMeta(id);

    rmSync(store.repoPath(id), { recursive: true, force: true });
    mkdirSync(store.repoPath(id), { recursive: true });
    renameSync(gitDir, store.repoGitDir(id));
    // normalise to bare semantics so --use-mailmap defaults to HEAD:.mailmap
    await git(['-C', store.repoGitDir(id), 'config', 'core.bare', 'true']);

    return await finalize(id, { name, source: { kind: 'zip', value: zipBase }, previous, job });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const looksLikeGitDir = (dir) =>
  existsSync(`${dir}/HEAD`) && existsSync(`${dir}/objects`) && existsSync(`${dir}/refs`);

/** Breadth-first search for the git directory inside an unpacked archive. */
function findGitDir(root) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    const dotGit = `${dir}/.git`;
    if (existsSync(dotGit)) {
      const st = statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      throw new Error('.git is a file (worktree or submodule pointer) — zip the main repository whose .git folder is included');
    }
    if (looksLikeGitDir(dir)) return dir; // the archive itself is a bare repository
    if (depth >= 4) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        queue.push({ dir: `${dir}/${entry.name}`, depth: depth + 1 });
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- index build

async function finalize(id, { name, source, previous, job }) {
  const gitDir = store.repoGitDir(id);
  const refSha = (await git(['-C', gitDir, 'rev-parse', 'HEAD'])).trim();

  job.phase = 'extracting';
  job.percent = 0;
  job.commits = 0;
  job.detail = '';
  const index = await buildIndex(gitDir, 'HEAD', {
    onTick: (n) => {
      job.commits = n;
    },
  });

  job.phase = 'indexing';
  store.saveIndex(id, index);
  store.saveMeta(id, {
    id,
    name,
    source,
    ref: 'HEAD',
    refSha,
    importedAt: new Date().toISOString(),
    counts: {
      commits: index.commits.sha.length,
      paths: index.paths.length,
      authors: index.authors.length,
      changes: index.changes.c.length,
    },
    authorMerges: previous?.authorMerges ?? [],
  });
  return id;
}

/**
 * Single extraction pass -> flat index arrays.
 * options.mailmapBlob: read identities from `<ref>:.mailmap` instead of the
 * default source (used to reproduce historical exports exactly).
 * options.onTick(n): called periodically with the commit count parsed so far.
 *
 *   commits: { sha[], ct[], author[], raw[] }   author: canonical identity idx
 *   authors/rawAuthors: "Name <email>" strings (canonical / as written)
 *   paths: the object universe (every numstat path, in first-seen order)
 *   changes: { c[], p[], a[], r[], rn[] }       c: commit idx, p: path idx,
 *           a/r: added/removed (-1 = binary, not measured), rn: rename source idx (-1 = none)
 */
export async function buildIndex(gitDir, ref, { mailmapBlob = null, onTick } = {}) {
  const commits = { sha: [], ct: [], author: [], raw: [] };
  const authors = [];
  const rawAuthors = [];
  const paths = [];
  const changes = { c: [], p: [], a: [], r: [], rn: [] };

  const authorIdx = new Map();
  const rawIdx = new Map();
  const pathIdx = new Map();

  const intern = (list, map, key) => {
    let i = map.get(key);
    if (i === undefined) {
      i = list.length;
      map.set(key, i);
      list.push(key);
    }
    return i;
  };

  let current = -1;
  let sinceTick = 0;
  const parser = new GitLogParser({
    onCommit: (c) => {
      current = commits.sha.length;
      commits.sha.push(c.sha);
      commits.ct.push(c.ct);
      commits.author.push(intern(authors, authorIdx, `${c.aN} <${c.aE}>`));
      commits.raw.push(intern(rawAuthors, rawIdx, `${c.an} <${c.ae}>`));
      if (++sinceTick >= 5000) {
        sinceTick = 0;
        if (onTick) onTick(commits.sha.length);
      }
    },
    onEntry: (e) => {
      if (current < 0) throw new Error('numstat entry before any commit header');
      const p = intern(paths, pathIdx, e.path);
      changes.c.push(current);
      changes.p.push(p);
      changes.a.push(e.added === null ? -1 : e.added);
      changes.r.push(e.removed === null ? -1 : e.removed);
      changes.rn.push(e.oldPath === null ? -1 : intern(paths, pathIdx, e.oldPath));
    },
  });

  await streamGit(['-C', gitDir, ...logArgs(ref, { mailmapBlob })], { onStdout: (chunk) => parser.push(chunk) });
  parser.end();
  if (onTick) onTick(commits.sha.length);

  return {
    version: 1,
    ref,
    generatedAt: new Date().toISOString(),
    commits,
    authors,
    rawAuthors,
    paths,
    changes,
  };
}
