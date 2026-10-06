// web/js/filterbar.js
//
// Shared filter bar between the top bar and the view: commit set (all /
// range / list), author filter, reset and the CSV export for the active
// selection. Re-rendered on every state change, like the views.

import { api } from './api.js';
import { emit, filterParams, resetFilters, state } from './state.js';
import { el, fmtDate, fmtInt, toast } from './ui.js';

const DAY = 86400;

const setFilter = (patch) => {
  Object.assign(state.filters, patch);
  emit();
};

const filtersActive = () =>
  state.filters.kind !== 'all' || state.filters.authorGid >= 0;

function commitKindControl() {
  const group = el('div', { class: 'chip-row' });
  for (const [kind, label] of [['all', 'All'], ['range', 'Range'], ['list', 'List']]) {
    group.append(el('button', {
      class: state.filters.kind === kind ? 'btn sm primary' : 'btn sm',
      onclick: () => {
        if (state.filters.kind === kind) return;
        setFilter({ kind });
        if (kind === 'list' && !state.filters.shas) {
          toast('Pick commits in the Commits tab, then use "Filter by selection".');
        }
      },
    }, label));
  }
  return group;
}

function dateField(label, value, onpick) {
  return el('div', { class: 'field' },
    el('label', { text: label }),
    el('input', {
      type: 'date',
      value: value ?? '',
      onchange: (event) => onpick(event.target.value),
    }),
  );
}

function rangeFields() {
  const f = state.filters;
  return [
    // the API treats ranges as half-open [from, to); the pickers show whole
    // days, so the end date is stored as the following midnight
    dateField('From', f.from ? fmtDate(f.from) : '',
      (v) => setFilter({ from: v ? Date.parse(`${v}T00:00:00Z`) / 1000 : null })),
    dateField('To (inclusive)', f.to ? fmtDate(f.to - DAY) : '',
      (v) => setFilter({ to: v ? Date.parse(`${v}T00:00:00Z`) / 1000 + DAY : null })),
  ];
}

function listField() {
  const shas = state.filters.shas ?? [];
  return el('div', { class: 'field' },
    el('label', { text: 'Selected' }),
    shas.length === 0
      ? el('span', { class: 'muted', text: 'none — pick commits in the Commits tab' })
      : el('div', { class: 'chip' },
          `${fmtInt(shas.length)} commits`,
          el('button', { title: 'Clear selection', onclick: () => setFilter({ shas: null }) }, '×'),
        ),
  );
}

function authorSelect() {
  const select = el('select', {
    onchange: (event) => setFilter({ authorGid: Number(event.target.value) }),
  });
  select.append(el('option', { value: '-1', selected: state.filters.authorGid < 0 }, 'All authors'));
  const sorted = [...state.groups].sort((a, b) => b.commits - a.commits || a.label.localeCompare(b.label));
  for (const group of sorted) {
    select.append(el('option', {
      value: String(group.gid),
      selected: group.gid === state.filters.authorGid,
    }, `${group.label} (${fmtInt(group.commits)})`));
  }
  return el('div', { class: 'field' }, el('label', { text: 'Author' }), select);
}

export function renderFilterBar() {
  const bar = document.getElementById('filterbar');
  bar.replaceChildren();

  if (!state.repoId) {
    bar.append(el('span', { class: 'muted', text: 'Add a repository to begin.' }));
    return;
  }

  bar.append(
    el('div', { class: 'field' }, el('label', { text: 'Commit set' }), commitKindControl()),
    ...(state.filters.kind === 'range' ? rangeFields() : []),
    ...(state.filters.kind === 'list' ? [listField()] : []),
    authorSelect(),
    el('div', { class: 'spacer' }),
    filtersActive()
      ? el('button', { class: 'btn sm', onclick: () => { resetFilters(); emit(); } }, 'Reset filters')
      : null,
    el('a', { class: 'btn', href: api.exportUrl(state.repoId, filterParams()), role: 'button' }, 'Export CSV'),
  );
}
