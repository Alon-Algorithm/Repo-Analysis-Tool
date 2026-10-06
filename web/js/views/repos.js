// web/js/views/repos.js
//
// Repositories view: the ingested repositories with their metadata, used to
// pick the analysis target.

import { state, setRepo } from '../state.js';
import { el, fmtDateTime, fmtInt, toast } from '../ui.js';

export async function render() {
  const wrap = el('div');

  if (state.repos.length === 0) {
    wrap.append(el('div', { class: 'empty' }, 'No repositories yet.'));
    return wrap;
  }

  const grid = el('div', { class: 'grid stats' });
  for (const repo of state.repos) {
    const active = repo.id === state.repoId;
    grid.append(
      el('div', { class: 'card' },
        el('div', { class: 'stat-label', text: repo.name }),
        el('div', { class: 'stat-hint', text: repo.source.kind === 'url' ? repo.source.value : `zip: ${repo.source.value}` }),
        el('div', { class: 'meta-line',
          text: `${fmtInt(repo.counts.commits)} commits · ${fmtInt(repo.counts.paths)} paths · ${fmtInt(repo.counts.authors)} authors` }),
        el('div', { class: 'meta-line', text: `imported ${fmtDateTime(Date.parse(repo.importedAt) / 1000)}` }),
        el('div', { style: 'margin-top:10px' },
          el('button', {
            class: active ? 'btn sm' : 'btn sm primary',
            disabled: active || null,
            onclick: () => {
              setRepo(repo.id);
              toast(`Switched to ${repo.name}`);
            },
          }, active ? 'Selected' : 'Analyse'),
        ),
      ),
    );
  }
  wrap.append(grid);
  return wrap;
}
