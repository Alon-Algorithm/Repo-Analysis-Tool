// web/js/views/repos.js
//
// Repositories: the ingested repositories with their metadata plus the
// ingestion form (git URL or ZIP upload with progress polling), used to
// pick the analysis target and to remove stale imports.

import { api } from '../api.js';
import { loadRepos, setRepo, state } from '../state.js';
import { el, fmtDateTime, fmtInt, toast } from '../ui.js';

const poll = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Streams an ingest job to completion, updating the progress UI in place. */
async function trackJob(job, renderProgress) {
  let current = job;
  while (current.status === 'running') {
    renderProgress(current);
    await poll(600);
    current = await api.job(current.id);
  }
  renderProgress(current);
  return current;
}

function progressNode() {
  return el('div', { hidden: true },
    el('div', { class: 'progress' }, el('div', { class: 'bar', style: 'width:0%' })),
    el('div', { class: 'progress-label' }),
  );
}

function setProgress(node, job) {
  node.hidden = false;
  const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));
  node.querySelector('.bar').style.width = `${percent}%`;
  node.querySelector('.progress-label').textContent =
    `${job.phase ?? job.status} · ${percent.toFixed(0)}%${job.detail ? ` · ${job.detail}` : ''}`;
}

function urlForm(onDone) {
  const input = el('input', { type: 'url', placeholder: 'https://github.com/owner/repo.git', style: 'min-width:340px' });
  const progress = progressNode();
  const button = el('button', { class: 'btn primary' }, 'Clone & analyse');
  button.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url) {
      toast('Paste a git repository URL first.', 'error');
      return;
    }
    button.disabled = true;
    try {
      const job = await api.ingestUrl(url, null);
      const finished = await trackJob(job, (j) => setProgress(progress, j));
      if (finished.status === 'error') throw new Error(finished.error ?? 'ingestion failed');
      toast(`Imported ${finished.repoId}`, 'ok');
      await onDone();
    } catch (err) {
      toast(err.message, 'error');
      progress.hidden = true;
    } finally {
      button.disabled = false;
    }
  });
  return el('div', {},
    el('div', { class: 'form-row' }, input, button),
    progress,
  );
}

function zipForm(onDone) {
  const input = el('input', { type: 'file', accept: '.zip,application/zip' });
  const progress = progressNode();
  const button = el('button', { class: 'btn primary' }, 'Upload & analyse');
  button.addEventListener('click', async () => {
    const file = input.files?.[0];
    if (!file) {
      toast('Choose a .zip archive first.', 'error');
      return;
    }
    button.disabled = true;
    try {
      const job = await api.ingestZip(file, file.name.replace(/\.zip$/i, ''));
      const finished = await trackJob(job, (j) => setProgress(progress, j));
      if (finished.status === 'error') throw new Error(finished.error ?? 'ingestion failed');
      toast(`Imported ${finished.repoId}`, 'ok');
      await onDone();
    } catch (err) {
      toast(err.message, 'error');
      progress.hidden = true;
    } finally {
      button.disabled = false;
    }
  });
  return el('div', {},
    el('div', { class: 'form-row' }, input, button),
    progress,
  );
}

function repoCard(repo, onDone) {
  const active = repo.id === state.repoId;
  const remove = el('button', { class: 'btn sm danger' }, 'Delete');
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Delete ${repo.name} and its extracted data?`)) return;
    try {
      await api.removeRepo(repo.id);
      toast(`Deleted ${repo.name}`, 'ok');
      await onDone();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  return el('div', { class: 'card' },
    el('div', { class: 'stat-label', text: repo.name }),
    el('div', { class: 'stat-hint', text: repo.source.kind === 'url' ? repo.source.value : 'zip upload' }),
    el('div', { class: 'meta-line',
      text: `${fmtInt(repo.counts.commits)} commits · ${fmtInt(repo.counts.paths)} paths · ${fmtInt(repo.counts.authors)} authors` }),
    el('div', { class: 'meta-line', text: `imported ${fmtDateTime(Date.parse(repo.importedAt) / 1000)}` }),
    el('div', { style: 'margin-top:10px; display:flex; gap:8px' },
      el('button', {
        class: active ? 'btn sm' : 'btn sm primary',
        disabled: active || null,
        onclick: () => {
          setRepo(repo.id);
          toast(`Switched to ${repo.name}`);
        },
      }, active ? 'Selected' : 'Analyse'),
      remove,
    ),
  );
}

export async function render() {
  const view = el('div');
  const refresh = async () => {
    await loadRepos();
    const next = await render();
    view.replaceWith(next);
  };

  view.append(
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', { text: 'Add a repository' })),
      el('div', { class: 'meta-line', text: 'Deep-clone a public git URL, or upload a ZIP archive of a working tree (including .git, so rename detection and mailmaps work).' }),
      el('div', { style: 'margin-top:12px' }, urlForm(refresh)),
      el('div', { style: 'margin-top:14px' },
        el('div', { class: 'stat-label', text: 'Or upload a ZIP' }),
        el('div', { style: 'margin-top:6px' }, zipForm(refresh)),
      ),
    ),
  );

  if (state.repos.length === 0) {
    view.append(el('div', { class: 'empty' }, 'No repositories yet — add one above.'));
    return view;
  }

  const grid = el('div', { class: 'grid stats', style: 'margin-top:16px' });
  for (const repo of state.repos) grid.append(repoCard(repo, refresh));
  view.append(grid);
  return view;
}
