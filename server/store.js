// server/store.js
//
// On-disk layout (all under data/, which is gitignored):
//
//   data/
//     repos/<id>/
//       meta.json    small: identity, source, counts, author merges
//       index.json   the full parsed index (commits, authors, paths, changes)
//       repo/        the bare git directory (clone result or extracted .git)
//     tmp/           scratch space for uploads and ZIP unpacking

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DATA_DIR = join(ROOT, 'data');
export const REPOS_DIR = join(DATA_DIR, 'repos');
export const TMP_DIR = join(DATA_DIR, 'tmp');

export const repoPath = (id) => join(REPOS_DIR, id);
export const repoGitDir = (id) => join(repoPath(id), 'repo');
export const metaPath = (id) => join(repoPath(id), 'meta.json');
export const indexPath = (id) => join(repoPath(id), 'index.json');
export const tmpPath = (...parts) => join(TMP_DIR, ...parts);

export function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'repo'
  );
}

export function makeRepoId(name, source) {
  const hash = createHash('sha1').update(source).digest('hex').slice(0, 8);
  return `${slugify(name)}-${hash}`;
}

// ---------------------------------------------------------------- meta

export function saveMeta(id, meta) {
  mkdirSync(repoPath(id), { recursive: true });
  writeFileSync(metaPath(id), JSON.stringify(meta, null, 2) + '\n');
}

export function loadMeta(id) {
  if (!existsSync(metaPath(id))) return null;
  return JSON.parse(readFileSync(metaPath(id), 'utf8'));
}

export function updateRepoMeta(id, patch) {
  const meta = loadMeta(id);
  if (!meta) return null;
  const next = { ...meta, ...patch };
  saveMeta(id, next);
  return next;
}

export function listRepos() {
  if (!existsSync(REPOS_DIR)) return [];
  const metas = [];
  for (const entry of readdirSync(REPOS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = loadMeta(entry.name);
    if (meta) metas.push(meta);
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name));
}

export function removeRepo(id) {
  rmSync(repoPath(id), { recursive: true, force: true });
  indexCache.delete(id);
}

// ---------------------------------------------------------------- index

const indexCache = new Map();

export function saveIndex(id, index) {
  mkdirSync(repoPath(id), { recursive: true });
  writeFileSync(indexPath(id), JSON.stringify(index));
  indexCache.set(id, index);
}

export function loadIndex(id) {
  if (indexCache.has(id)) return indexCache.get(id);
  if (!existsSync(indexPath(id))) return null;
  const index = JSON.parse(readFileSync(indexPath(id), 'utf8'));
  indexCache.set(id, index);
  return index;
}
