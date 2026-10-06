// web/js/views/tree.js
//
// Directory drill-down: breadcrumbs, the directory's own metrics, tables of
// child directories and files, and the ownership breakdown of the directory.
// Clicking a directory keeps drilling; clicking a file opens the file view.

import { api } from '../api.js';
import { emit, filterParams, setView, state } from '../state.js';
import { authorsTable, commitSetLabel, el, errorBox, fmtInt, fmtNum, panel, statsGrid } from '../ui.js';

const TOP_AUTHOR_ROWS = 20;

function crumbs(body) {
  const nav = el('nav', { class: 'crumbs' });
  nav.append(el('span', { class: 'crumb', onclick: () => { state.treeDir = null; emit(); } }, '/'));
  for (const parent of body.parents) {
    nav.append(el('span', { class: 'crumb-sep', text: '›' }));
    nav.append(el('span', {
      class: 'crumb',
      onclick: () => { state.treeDir = parent.path; emit(); },
    }, parent.path));
  }
  if (body.dir.id !== 0) {
    nav.append(el('span', { class: 'crumb-sep', text: '›' }));
    nav.append(el('span', { class: 'crumb current' }, body.dir.path));
  }
  return nav;
}

function childTable(body) {
  const rows = [
    ...body.children.dirs.map((child) => ({
      name: child.path,
      dir: true,
      onopen: () => { state.treeDir = child.path; emit(); },
      stats: child.stats,
    })),
    ...body.children.files.map((child) => ({
      name: child.path,
      dir: false,
      onopen: () => { state.filePath = child.path; setView('file'); },
      stats: child.stats,
    })),
  ];
  if (rows.length === 0) return el('div', { class: 'empty' }, 'Empty directory in this commit set.');

  return el('div', { class: 'table-wrap' },
    el('table', { class: 'data' },
      el('thead', {},
        el('tr', {},
          el('th', { text: 'Name' }),
          el('th', { text: 'Added' }),
          el('th', { text: 'Removed' }),
          el('th', { text: 'Growth' }),
          el('th', { text: 'Churn' }),
          el('th', { text: 'Modifications' }),
          el('th', { text: 'Mod. frequency' }),
          el('th', { text: 'Churn rate' }),
        ),
      ),
      el('tbody', {},
        rows.map((row) => el('tr', {},
          el('td', { class: 'path' },
            el('span', { class: 'name-cell' },
              el('span', { class: row.dir ? 'icon dir' : 'icon file', text: row.dir ? '▸' : '·' }),
              el('span', { class: 'link', onclick: row.onopen }, row.name),
            ),
          ),
          el('td', { class: 'pos nowrap', text: `+${fmtInt(row.stats.added)}` }),
          el('td', { class: 'neg nowrap', text: `−${fmtInt(row.stats.removed)}` }),
          el('td', { class: 'nowrap', text: fmtInt(row.stats.growth) }),
          el('td', { class: 'nowrap', text: fmtInt(row.stats.churn) }),
          el('td', { class: 'nowrap', text: fmtInt(row.stats.modifications) }),
          el('td', { class: 'nowrap', text: fmtNum(row.stats.modificationFrequency, 3) }),
          el('td', { class: 'nowrap', text: fmtNum(row.stats.churnRate, 3) }),
        )),
      ),
    ),
  );
}

export async function render() {
  if (!state.repoId) return el('div', { class: 'empty' }, 'Select a repository first.');

  let body;
  try {
    body = await api.tree(state.repoId, state.treeDir, filterParams());
  } catch (err) {
    return errorBox(`Directory not available: ${err.message}`);
  }

  const wrap = el('div');
  wrap.append(
    crumbs(body),
    el('div', { class: 'chip-row' }, el('div', { class: 'chip', text: commitSetLabel(body.commitSet) })),
    statsGrid(body.dir.stats),
  );

  wrap.append(panel(
    { title: 'Contents', sub: body.dir.path === '/' ? 'repository root' : body.dir.path },
    childTable(body),
  ));

  const shown = body.dir.authors.slice(0, TOP_AUTHOR_ROWS);
  wrap.append(panel(
    {
      title: 'Ownership',
      sub: body.dir.authors.length > TOP_AUTHOR_ROWS ? `top ${TOP_AUTHOR_ROWS} of ${body.dir.authors.length}` : undefined,
    },
    body.dir.authors.length === 0
      ? el('div', { class: 'empty' }, 'No author churn in this directory for the active commit set.')
      : authorsTable(shown),
  ));

  return wrap;
}
