// web/js/views/commits.js
//
// Commit browser: paged and searchable list of the repository's non-merge
// commits with multi-select, used to build "list" commit sets that the whole
// dashboard can then filter by.

import { api } from '../api.js';
import { emit, state } from '../state.js';
import { el, fmtDateTime, fmtInt, shortSha, toast } from '../ui.js';

const PAGE = 50;

const viewState = {
  repoId: null,
  offset: 0,
  q: '',
  selected: new Set(),
  appliedListKey: '',
  node: null,
};

function ensureRepo() {
  if (viewState.repoId === state.repoId) return;
  viewState.repoId = state.repoId;
  viewState.offset = 0;
  viewState.q = '';
  viewState.selected = new Set();
  viewState.appliedListKey = '';
}

async function rerender() {
  const next = await render();
  viewState.node?.replaceWith(next);
}

export async function render() {
  if (!state.repoId) return el('div', { class: 'empty' }, 'Select a repository first.');
  ensureRepo();

  // when a "list" commit set is applied elsewhere (filter bar, hash), mirror
  // its shas into the checkbox selection so the browser shows it selected
  const listKey = state.filters.kind === 'list' && state.filters.shas ? state.filters.shas.join(',') : '';
  if (listKey !== viewState.appliedListKey) {
    viewState.appliedListKey = listKey;
    if (listKey) viewState.selected = new Set(state.filters.shas);
  }

  const authorGid = state.filters.authorGid >= 0 ? state.filters.authorGid : null;
  const body = await api.commits(state.repoId, {
    offset: viewState.offset,
    limit: PAGE,
    q: viewState.q || null,
    author: authorGid,
  });

  const wrap = el('div');
  viewState.node = wrap;

  // ---- toolbar
  const search = el('input', { type: 'search', placeholder: 'Search commit subjects…', value: viewState.q });
  const applySearch = () => {
    viewState.q = search.value.trim();
    viewState.offset = 0;
    rerender();
  };
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applySearch();
  });

  const selectionButton = el('button', { class: 'btn primary' }, '');
  const updateSelectionButton = () => {
    const n = viewState.selected.size;
    selectionButton.textContent = n === 0 ? 'No commits selected' : `Filter by selection (${fmtInt(n)})`;
    selectionButton.disabled = n === 0;
  };
  selectionButton.addEventListener('click', () => {
    state.filters.kind = 'list';
    state.filters.shas = [...viewState.selected];
    viewState.appliedListKey = state.filters.shas.join(',');
    toast(`Active commit set: ${fmtInt(state.filters.shas.length)} selected commits`, 'ok');
    emit();
  });

  wrap.append(
    el('div', { class: 'chip-row' },
      search,
      el('button', { class: 'btn sm', onclick: applySearch }, 'Search'),
      viewState.q ? el('button', { class: 'btn sm', onclick: () => { viewState.q = ''; viewState.offset = 0; rerender(); } }, 'Clear') : null,
      el('div', { class: 'spacer', style: 'flex:1' }),
      selectionButton,
      el('button', { class: 'btn sm', onclick: () => { viewState.selected.clear(); rerender(); } }, 'Clear selection'),
    ),
    state.filters.authorGid >= 0
      ? el('div', { class: 'chip-row', style: 'margin-top:8px' }, el('div', { class: 'chip', text: `author filter: ${state.groups.find((g) => g.gid === state.filters.authorGid)?.label ?? state.filters.authorGid}` }))
      : null,
  );

  // ---- table
  const headBox = el('input', { type: 'checkbox', title: 'Select page' });
  headBox.addEventListener('change', () => {
    for (const commit of body.commits) {
      if (headBox.checked) viewState.selected.add(commit.sha);
      else viewState.selected.delete(commit.sha);
    }
    for (const box of rowBoxes) box.checked = headBox.checked;
    updateSelectionButton();
  });

  const rowBoxes = [];
  const rows = body.commits.map((commit) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = viewState.selected.has(commit.sha);
    box.addEventListener('change', () => {
      if (box.checked) viewState.selected.add(commit.sha);
      else viewState.selected.delete(commit.sha);
      updateSelectionButton();
    });
    rowBoxes.push(box);
    return el('tr', {},
      el('td', { class: 'checkbox-cell' }, box),
      el('td', {}, el('span', { class: 'sha', title: commit.sha }, shortSha(commit.sha))),
      el('td', { class: 'nowrap', text: fmtDateTime(commit.ct) }),
      el('td', { class: 'nowrap', text: commit.author }),
      el('td', {}, el('div', { class: 'commit-subject', title: commit.subject, text: commit.subject || '(no subject)' })),
    );
  });

  updateSelectionButton();

  wrap.append(
    el('div', { class: 'table-wrap', style: 'margin-top:12px' },
      el('table', { class: 'data' },
        el('thead', {},
          el('tr', {},
            el('th', { class: 'checkbox-cell' }, headBox),
            el('th', { text: 'Commit' }),
            el('th', { text: 'Date' }),
            el('th', { text: 'Author' }),
            el('th', { text: 'Subject' }),
          ),
        ),
        el('tbody', {},
          rows.length === 0
            ? el('tr', {}, el('td', { colspan: '5' }, el('div', { class: 'empty' }, viewState.q ? 'No commits match the search.' : 'No commits in this view.')))
            : rows,
        ),
      ),
    ),
    el('div', { class: 'pagination' },
      el('button', {
        class: 'btn sm',
        disabled: viewState.offset === 0 || null,
        onclick: () => { viewState.offset = Math.max(0, viewState.offset - PAGE); rerender(); },
      }, '← Newer'),
      el('span', { class: 'page-info',
        text: body.total === 0
          ? '0 commits'
          : `${fmtInt(body.offset + 1)}–${fmtInt(body.offset + body.commits.length)} of ${fmtInt(body.total)}` }),
      el('button', {
        class: 'btn sm',
        disabled: viewState.offset + PAGE >= body.total || null,
        onclick: () => { viewState.offset += PAGE; rerender(); },
      }, 'Older →'),
    ),
  );

  return wrap;
}
