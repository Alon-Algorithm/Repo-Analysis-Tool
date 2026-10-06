// server/index.js
//
// Zero-dependency HTTP server: JSON API + static frontend from public/.
// `npm run dev` starts this file.
//
// API (JSON unless noted; every metric route accepts the shared filters
// kind=all|range|list, from, to, shas, author=<gid>):
//
//   GET    /api/repos                  list ingested repositories
//   POST   /api/ingest                 {kind:'url', url, name?} start a clone
//   POST   /api/ingest/zip?name=..     raw ZIP body (repo including .git)
//   GET    /api/jobs/:id               ingest progress
//   DELETE /api/repos/:id              remove a repository
//   GET    /api/repos/:id/summary      repo stats + author breakdown
//   GET    /api/repos/:id/tree?dir=    directory drill-down
//   GET    /api/repos/:id/file?path=   file detail, authors, rename history
//   GET    /api/repos/:id/authors      identities, groups, repo totals
//   GET    /api/repos/:id/timeline     ?bucket=day|week|month
//   GET    /api/repos/:id/commits      paged list (manual commit picker)
//   GET    /api/repos/:id/export.csv   CSV download in reference format
//   POST   /api/repos/:id/merges       {merges:[["Primary <p>","Alias <a>"]]}

import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { CSV_HEADER, exportRows } from './exporter.js';
import { toCsv } from './csv.js';
import { getJob, startIngest } from './ingest.js';
import {
  authorBreakdown,
  buildObjectModel,
  commitGids,
  computeTimeline,
  dirStats,
  fileStats,
  listChildren,
  renameHistory,
  repoStats,
} from './metrics.js';
import {
  HttpError,
  commitTimeBounds,
  getAuthorGroups,
  getSubjects,
  invalidateRepo,
  requireRepo,
  resolveQuery,
} from './query.js';
import * as store from './store.js';

const WEB_DIR = join(store.ROOT, 'web');
const MAX_JSON_BODY = 1 << 20; // 1 MiB
const MAX_UPLOAD = Number(process.env.RAT_MAX_UPLOAD ?? 1 << 30); // 1 GiB

// ---------------------------------------------------------------- http utils

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BODY);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const PLACEHOLDER =
  '<!doctype html><meta charset="utf-8"><title>Repo Analysis Tool</title>' +
  '<h1>Repo Analysis Tool</h1>' +
  '<p>The API is running. The dashboard build lands in the next steps — ' +
  'try <a href="/api/repos">/api/repos</a>.</p>';

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'malformed URL encoding');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(WEB_DIR, rel));
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + sep)) {
    throw new HttpError(403, 'forbidden');
  }
  let target = file;
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
  if (!existsSync(target)) {
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PLACEHOLDER);
      return;
    }
    throw new HttpError(404, 'not found');
  }
  const ext = extname(target);
  // code and markup are never stored by the browser: a dashboard left open
  // across an update must never keep running stale modules or styling
  const revalidate = ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css';
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': revalidate ? 'no-store' : 'public, max-age=3600',
  });
  await pipeline(createReadStream(target), res).catch(() => {}); // client aborts are fine
}

// ---------------------------------------------------------------- api helpers

const jobSnapshot = (job) => ({
  id: job.id,
  kind: job.kind,
  status: job.status,
  phase: job.phase,
  percent: job.percent,
  commits: job.commits,
  detail: job.detail,
  repoId: job.repoId,
  error: job.error,
});

const summarizeMeta = (meta) => ({
  id: meta.id,
  name: meta.name,
  source: meta.source,
  refSha: meta.refSha,
  importedAt: meta.importedAt,
  counts: meta.counts,
  authorMerges: meta.authorMerges ?? [],
});

const commitSetPayload = (spec, set, groups, authorFilterGid) => ({
  kind: spec.kind,
  count: set.count,
  authorFilter: authorFilterGid >= 0 ? groups.groups[authorFilterGid].label : null,
  from: spec.kind === 'range' && Number.isFinite(spec.from) ? spec.from : null,
  to: spec.kind === 'range' && Number.isFinite(spec.to) ? spec.to : null,
  shas: spec.kind === 'list' ? spec.shas : undefined,
});

const dirDisplay = (model, dirId) => (dirId === 0 ? '/' : model.dirPaths[dirId]);

const packStats = ({ dirId, pathId, path, ...stats }) => ({ dirId, pathId, path, stats });

function commitSetLabel(spec) {
  if (spec.kind === 'range') {
    const fmt = (t, dflt) => (Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 10) : dflt);
    return `range:${fmt(spec.from, 'start')}..${fmt(spec.to, 'end')}`;
  }
  if (spec.kind === 'list') return `list:${spec.shas.length} commits`;
  return 'all';
}

async function uploadZip(req, res, params) {
  const name = (params.get('name') ?? '').trim();
  mkdirSync(store.TMP_DIR, { recursive: true });
  const zipPath = store.tmpPath(`upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.zip`);
  let size = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(size > MAX_UPLOAD ? new HttpError(413, 'upload too large') : null, chunk);
    },
  });
  try {
    await pipeline(req, counter, createWriteStream(zipPath));
  } catch (err) {
    try {
      unlinkSync(zipPath);
    } catch {
      /* already gone */
    }
    throw err instanceof HttpError ? err : new HttpError(400, `upload failed: ${err.message}`);
  }
  const job = startIngest({ kind: 'zip', zipPath, name });
  job.done.then(() => {
    try {
      unlinkSync(zipPath);
    } catch {
      /* already gone */
    }
  });
  sendJson(res, 202, jobSnapshot(job));
}

// ---------------------------------------------------------------- api routes

async function handleApi(req, res, segs, url) {
  const method = req.method;
  const params = url.searchParams;

  if (segs[1] === 'repos' && segs.length === 2 && method === 'GET') {
    return sendJson(res, 200, { repos: store.listRepos().map(summarizeMeta) });
  }

  if (segs[1] === 'ingest' && method === 'POST') {
    if (segs[2] === 'zip') return uploadZip(req, res, params);
    if (segs.length === 2) {
      const body = await readJson(req);
      if (body.kind !== 'url') throw new HttpError(400, "JSON ingestion expects kind='url' (use /api/ingest/zip for archives)");
      const job = startIngest({ kind: 'url', url: body.url, name: body.name });
      return sendJson(res, 202, jobSnapshot(job));
    }
    throw new HttpError(404, 'unknown API route');
  }

  if (segs[1] === 'jobs' && segs.length === 3 && method === 'GET') {
    const job = getJob(segs[2]);
    if (!job) throw new HttpError(404, 'unknown job');
    return sendJson(res, 200, jobSnapshot(job));
  }

  if (segs[1] === 'repos' && segs.length >= 3) {
    const id = segs[2];
    const action = segs[3];

    if (!action && method === 'DELETE') {
      if (!store.loadMeta(id)) throw new HttpError(404, `unknown repository: ${id}`);
      store.removeRepo(id);
      invalidateRepo(id);
      return sendJson(res, 200, { ok: true, id });
    }

    if (action === 'merges' && method === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.merges)) throw new HttpError(400, 'merges must be an array of identity lists');
      const meta = store.updateRepoMeta(id, { authorMerges: body.merges });
      if (!meta) throw new HttpError(404, `unknown repository: ${id}`);
      invalidateRepo(id);
      const { index } = requireRepo(id);
      const groups = getAuthorGroups(id, index, meta);
      return sendJson(res, 200, {
        ok: true,
        groups: groups.groups.map((g, gid) => ({ gid, label: g.label, members: g.members.map((i) => index.authors[i]) })),
      });
    }

    if (method !== 'GET') throw new HttpError(405, `${method} not allowed`);

    switch (action) {
      case 'summary': {
        const q = resolveQuery(id, params);
        return sendJson(res, 200, {
          repo: summarizeMeta(q.meta),
          commitSet: commitSetPayload(q.spec, q.set, q.groups, q.authorFilterGid),
          bounds: commitTimeBounds(q.index),
          stats: repoStats(q.metricSet),
          authors: authorBreakdown(q.index, q.metricSet, 'dir', 0, q.groups),
        });
      }

      case 'tree': {
        const q = resolveQuery(id, params);
        const model = buildObjectModel(q.index);
        const dirParam = params.get('dir');
        let dirId = 0;
        if (dirParam !== null && dirParam !== '') {
          const cleaned = dirParam.replace(/^\/+|\/+$/g, '');
          dirId = /^\d+$/.test(cleaned) ? Number(cleaned) : model.dirIdx.get(cleaned) ?? -1;
          if (dirId < 0 || dirId >= model.nDirs) throw new HttpError(404, `unknown directory: ${dirParam}`);
        }
        const children = listChildren(q.index, q.metricSet, dirId);
        const parents = [];
        for (let d = model.dirParent[dirId]; d >= 0; d = model.dirParent[d]) {
          parents.unshift({ id: d, path: dirDisplay(model, d) });
        }
        return sendJson(res, 200, {
          commitSet: commitSetPayload(q.spec, q.set, q.groups, q.authorFilterGid),
          dir: {
            id: dirId,
            path: dirDisplay(model, dirId),
            stats: dirStats(q.metricSet, dirId),
            authors: authorBreakdown(q.index, q.metricSet, 'dir', dirId, q.groups),
          },
          parents,
          children: {
            dirs: children.dirs.map(packStats),
            files: children.files.map(packStats),
          },
        });
      }

      case 'file': {
        const q = resolveQuery(id, params);
        const pathParam = params.get('path');
        const idParam = params.get('pathId');
        let pathId = -1;
        if (idParam !== null && idParam !== '') pathId = Number(idParam);
        else if (pathParam !== null) pathId = q.index.paths.indexOf(pathParam);
        if (!Number.isInteger(pathId) || pathId < 0 || pathId >= q.index.paths.length) {
          throw new HttpError(404, `unknown file: ${pathParam ?? idParam}`);
        }
        const withCommit = (rows) =>
          rows
            .map((row) => ({ ...row, sha: q.index.commits.sha[row.commit], ct: q.index.commits.ct[row.commit] }))
            .sort((a, b) => b.ct - a.ct);
        const renames = renameHistory(q.index, pathId);
        return sendJson(res, 200, {
          commitSet: commitSetPayload(q.spec, q.set, q.groups, q.authorFilterGid),
          path: q.index.paths[pathId],
          pathId,
          stats: fileStats(q.metricSet, pathId),
          authors: authorBreakdown(q.index, q.metricSet, 'file', pathId, q.groups),
          renames: { to: withCommit(renames.renamesTo), from: withCommit(renames.renamesFrom) },
        });
      }

      case 'authors': {
        const q = resolveQuery(id, params);
        const breakdown = new Map(
          authorBreakdown(q.index, q.metricSet, 'dir', 0, q.groups).map((row) => [row.gid, row]),
        );
        return sendJson(res, 200, {
          commitSet: commitSetPayload(q.spec, q.set, q.groups, q.authorFilterGid),
          authors: q.index.authors,
          groups: q.groups.groups.map((g, gid) => ({
            gid,
            label: g.label,
            members: g.members.map((i) => q.index.authors[i]),
            merged: g.members.length > 1,
            commits: q.metricSet.groupCommits[gid],
            stats: breakdown.get(gid) ?? null,
          })),
        });
      }

      case 'timeline': {
        const q = resolveQuery(id, params);
        const bucket = params.get('bucket') ?? 'month';
        if (!['day', 'week', 'month'].includes(bucket)) throw new HttpError(400, `unknown bucket: ${bucket}`);
        return sendJson(res, 200, {
          commitSet: commitSetPayload(q.spec, q.set, q.groups, q.authorFilterGid),
          bucket,
          buckets: computeTimeline(q.index, { include: q.set.include, bucket }),
        });
      }

      case 'commits': {
        const { meta, index } = requireRepo(id);
        const groups = getAuthorGroups(id, index, meta);
        const subjects = await getSubjects(id);
        const rawAuthor = params.get('author');
        let gid = -1;
        if (rawAuthor !== null && rawAuthor !== '') {
          gid = Number(rawAuthor);
          if (!Number.isInteger(gid) || gid < 0 || gid >= groups.nGroups) {
            throw new HttpError(400, `unknown author group: ${rawAuthor}`);
          }
        }
        const query = (params.get('q') ?? '').trim().toLowerCase();
        const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);
        const limit = Math.min(500, Math.max(1, Number(params.get('limit') ?? 100) || 100));
        const { sha, ct } = index.commits;
        const gids = commitGids(index, groups);
        const commits = [];
        let total = 0;
        for (let i = 0; i < sha.length; i++) {
          if (gid >= 0 && gids[i] !== gid) continue;
          const subject = subjects.get(sha[i]) ?? '';
          if (query && !subject.toLowerCase().includes(query)) continue;
          total += 1;
          if (total > offset && commits.length < limit) {
            commits.push({ sha: sha[i], ct: ct[i], gid: gids[i], author: groups.groups[gids[i]].label, subject });
          }
        }
        return sendJson(res, 200, { total, offset, limit, commits });
      }

      case 'export':
      case 'export.csv': {
        const q = resolveQuery(id, params);
        const label = commitSetLabel(q.spec);
        const rows = exportRows(q.index, {
          repoName: q.meta.name,
          refSha: q.meta.refSha,
          commitSetLabel: label,
          metricSet: q.metricSet,
          groups: q.groups,
        });
        const filename = `${store.slugify(q.meta.name)}-${label.replace(/[^a-z0-9.-]+/gi, '_')}.csv`;
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        });
        res.end(toCsv([CSV_HEADER, ...rows]));
        return;
      }

      default:
        throw new HttpError(404, 'unknown API route');
    }
  }

  throw new HttpError(404, 'unknown API route');
}

// ---------------------------------------------------------------- server

export function createServer() {
  return httpServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const segs = url.pathname.split('/').filter(Boolean);
      if (segs[0] === 'api') {
        await handleApi(req, res, segs, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
      } else {
        throw new HttpError(405, `${req.method} not allowed`);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`Repo Analysis Tool running at http://localhost:${port}`);
  });
}
