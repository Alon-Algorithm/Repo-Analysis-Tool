// web/js/views/file.js
//
// File detail: metrics of one file within the active commit set, its
// ownership breakdown and the rename history in both directions.

import { api } from '../api.js';
import { filterParams, setView, state } from '../state.js';
import {
  authorsTable,
  commitSetLabel,
  dirname,
  el,
  errorBox,
  fmtDateTime,
  fmtInt,
  panel,
  shortSha,
  statsGrid,
} from '../ui.js';

const TOP_AUTHOR_ROWS = 20;

function renameTable(rows) {
  if (rows.length === 0) return el('div', { class: 'empty' }, 'None.');
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'data' },
      el('thead', {},
        el('tr', {},
          el('th', { text: 'Commit' }),
          el('th', { text: 'Date' }),
          el('th', { text: 'From' }),
          el('th', { text: 'To' }),
        ),
      ),
      el('tbody', {},
        rows.map((row) => el('tr', {},
          el('td', {}, el('span', { class: 'sha', title: row.sha }, shortSha(row.sha))),
          el('td', { class: 'nowrap', text: fmtDateTime(row.ct) }),
          el('td', { class: 'path', text: row.from }),
          el('td', { class: 'path', text: row.to }),
        )),
      ),
    ),
  );
}

export async function render() {
  if (!state.repoId) return el('div', { class: 'empty' }, 'Select a repository first.');
  if (!state.filePath) {
    return el('div', { class: 'empty' },
      'No file selected — pick one in the ',
      el('span', { class: 'link', onclick: () => setView('tree') }, 'Tree'),
      ' view.',
    );
  }

  let body;
  try {
    body = await api.file(state.repoId, state.filePath, filterParams());
  } catch (err) {
    return errorBox(`File not available: ${err.message} (it may not exist in the active commit set).`);
  }

  const wrap = el('div');
  const dir = dirname(body.path);
  wrap.append(
    el('div', { class: 'chip-row' },
      el('div', { class: 'chip', text: 'file' }),
      el('code', { style: 'font-size:13px' }, body.path),
      el('button', {
        class: 'btn sm',
        onclick: () => {
          state.treeDir = dir || null;
          setView('tree');
        },
      }, dir ? `Open ${dir}/` : 'Open repository root'),
    ),
    el('div', { class: 'chip-row', style: 'margin-top:8px' },
      el('div', { class: 'chip', text: commitSetLabel(body.commitSet) }),
    ),
    statsGrid(body.stats),
  );

  const shown = body.authors.slice(0, TOP_AUTHOR_ROWS);
  wrap.append(panel(
    {
      title: 'Ownership',
      sub: body.authors.length > TOP_AUTHOR_ROWS ? `top ${TOP_AUTHOR_ROWS} of ${body.authors.length}` : undefined,
    },
    body.authors.length === 0
      ? el('div', { class: 'empty' }, 'No author churn for this file in the active commit set.')
      : authorsTable(shown),
  ));

  const renamed = body.renames.to.length + body.renames.from.length;
  const renamesBody = renamed === 0
    ? el('div', { class: 'empty' }, 'No renames detected at the 50% similarity threshold.')
    : el('div', { class: 'grid even' },
        el('div', {},
          el('div', { class: 'stat-label', text: 'Produced by renaming from' }),
          renameTable(body.renames.to),
        ),
        el('div', {},
          el('div', { class: 'stat-label', text: 'Renamed away to' }),
          renameTable(body.renames.from),
        ),
      );
  wrap.append(panel({ title: 'Rename history', sub: `${fmtInt(renamed)} events` }, renamesBody));

  return wrap;
}
