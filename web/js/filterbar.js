// web/js/filterbar.js
//
// The shared filter bar between the top bar and the view: commit set,
// author filter and the CSV export button. Re-rendered on every state change.

import { api } from './api.js';
import { state } from './state.js';
import { el } from './ui.js';

export function renderFilterBar() {
  const bar = document.getElementById('filterbar');
  bar.replaceChildren();

  if (!state.repoId) {
    bar.append(el('span', { class: 'muted', text: 'Add a repository to begin.' }));
    return;
  }

  bar.append(
    el('span', { class: 'muted', text: 'Full metric table export:' }),
    el('div', { class: 'spacer' }),
    el('a', { class: 'btn', href: api.exportUrl(state.repoId, {}), role: 'button' }, 'Export CSV'),
  );
}
