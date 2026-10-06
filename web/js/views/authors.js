// web/js/views/authors.js
//
// Authors: the identity groups detected for the repository, their activity
// and the manual merge configuration. .mailmap entries are already applied
// during ingestion; merges configured here are stored on the repository and
// affect every metric view.

import { api } from '../api.js';
import { currentRepo, emit, loadGroups, state } from '../state.js';
import { el, fmtInt, panel, toast } from '../ui.js';

const LIMIT = 150;

function badge(identity, highlight) {
  return el('span', { class: highlight ? 'badge merged' : 'badge', title: identity }, identity);
}

function groupRow(group, onSplit) {
  const cells = [
    el('td', {}, badge(group.label, true)),
    el('td', {}, el('span', { class: 'chip-row' },
      group.members.map((identity) => badge(identity, identity === group.label)))),
    el('td', { class: 'nowrap', text: fmtInt(group.commits) }),
    el('td', { class: 'nowrap', text: group.stats ? fmtInt(group.stats.churn) : '—' }),
    el('td', { class: 'nowrap', text: group.stats ? fmtInt(group.stats.modifications) : '—' }),
  ];
  if (group.merged) {
    cells.push(el('td', {}, el('button', { class: 'btn sm', onclick: () => onSplit(group) }, 'Split')));
  } else {
    cells.push(el('td', { class: 'muted nowrap', text: `${group.members.length} identity` }));
  }
  return el('tr', {}, cells);
}

export async function render() {
  if (!state.repoId) return el('div', { class: 'empty' }, 'Select a repository first.');

  const body = await api.authors(state.repoId);
  const groups = body.groups;
  const merges = currentRepo()?.authorMerges ?? [];
  const mergedGroups = groups.filter((group) => group.merged).length;
  const sorted = [...groups].sort((a, b) => b.commits - a.commits || a.label.localeCompare(b.label));

  const refresh = async () => {
    await loadGroups();
    emit();
  };

  const split = async (group) => {
    const touched = new Set(group.members);
    const next = merges.filter((list) => !list.some((identity) => touched.has(identity)));
    try {
      await api.merge(state.repoId, next);
      toast(`Split "${group.label}" back into ${group.members.length} identities`, 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const wrap = el('div');
  wrap.append(el('div', { class: 'chip-row' },
    el('div', { class: 'chip', text: `${fmtInt(groups.length)} identity groups` }),
    mergedGroups > 0 ? el('div', { class: 'chip', text: `${fmtInt(mergedGroups)} from manual merges` }) : null,
    el('span', { class: 'muted', text: 'Identities are already coalesced with the repository .mailmap.' }),
  ));

  // ---- merge form
  const selectA = el('select', { title: 'Identity to merge into the other' });
  const selectB = el('select', { title: 'Identity that receives the merge (its label wins)' });
  for (const group of sorted) {
    const option = () => el('option', { value: String(group.gid) }, `${group.label} (${fmtInt(group.commits)} commits)`);
    selectA.append(option());
    selectB.append(option());
  }
  if (sorted.length > 1) selectB.selectedIndex = 1;

  const mergeButton = el('button', { class: 'btn primary' }, 'Merge');
  mergeButton.addEventListener('click', async () => {
    const a = Number(selectA.value);
    const b = Number(selectB.value);
    if (a === b) {
      toast('Pick two different identities.', 'error');
      return;
    }
    const source = groups[a];
    const target = groups[b];
    const touched = new Set([...source.members, ...target.members]);
    const entry = [target.label];
    for (const identity of [...target.members, ...source.members]) {
      if (!entry.includes(identity)) entry.push(identity);
    }
    const next = merges.filter((list) => !list.some((identity) => touched.has(identity)));
    next.push(entry);
    mergeButton.disabled = true;
    try {
      await api.merge(state.repoId, next);
      toast(`Merged "${source.label}" into "${target.label}"`, 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
      mergeButton.disabled = false;
    }
  });

  wrap.append(panel(
    { title: 'Merge identities', sub: 'e.g. work and personal emails of the same person' },
    el('div', { class: 'form-row' },
      el('div', { class: 'field' }, el('label', { text: 'Merge' }), selectA),
      el('div', { class: 'field' }, el('label', { text: 'Into (label wins)' }), selectB),
      mergeButton,
    ),
    el('div', { class: 'meta-line', text: 'The merged group is labelled with the second identity and counts as one author in every metric and filter.' }),
  ));

  // ---- groups table
  const filterInput = el('input', { type: 'search', placeholder: 'Filter by name or email…' });
  const tbody = el('tbody', {});
  const count = el('span', { class: 'page-info' });
  const renderRows = () => {
    const needle = filterInput.value.trim().toLowerCase();
    const matching = sorted.filter((group) => !needle
      || group.label.toLowerCase().includes(needle)
      || group.members.some((identity) => identity.toLowerCase().includes(needle)));
    tbody.replaceChildren(
      ...(matching.length === 0
        ? [el('tr', {}, el('td', { colspan: '6' }, el('div', { class: 'empty' }, 'No identities match.')))]
        : matching.slice(0, LIMIT).map((group) => groupRow(group, split))),
    );
    count.textContent = matching.length > LIMIT
      ? `showing top ${fmtInt(LIMIT)} of ${fmtInt(matching.length)} matching`
      : `${fmtInt(matching.length)} shown`;
  };

  filterInput.addEventListener('input', renderRows);
  renderRows();

  wrap.append(panel(
    { title: 'Identity groups', sub: 'by commit count', right: el('span', { class: 'chip-row' }, filterInput, count) },
    el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('thead', {},
          el('tr', {},
            el('th', { text: 'Label' }),
            el('th', { text: 'Identities' }),
            el('th', { text: 'Commits' }),
            el('th', { text: 'Churn' }),
            el('th', { text: 'Modifications' }),
            el('th', { text: '' }),
          ),
        ),
        tbody,
      ),
    ),
  ));

  return wrap;
}
