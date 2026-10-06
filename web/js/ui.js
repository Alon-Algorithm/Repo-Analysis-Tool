// web/js/ui.js
//
// Tiny DOM/formatting helpers shared by every view (no dependencies).

/** el('div', { class: 'card', onclick: fn }, 'text', childNode, ...) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export const clear = (node) => node.replaceChildren();

export const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

export function fmtNum(x, maxFraction = 2) {
  const value = Number(x);
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: maxFraction });
}

export const fmtPct = (x) => `${(Number(x) * 100).toFixed(1)}%`;

export const fmtDate = (ts) => (ts == null ? '—' : new Date(ts * 1000).toISOString().slice(0, 10));

export const fmtDateTime = (ts) => (ts == null ? '—' : new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16));

export const shortSha = (sha) => String(sha ?? '').slice(0, 10);

export function statCard(label, value, hint) {
  return el('div', { class: 'card' },
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: value }),
    hint ? el('div', { class: 'stat-hint', text: hint }) : null,
  );
}

/** Titled section: panel({ title, sub, right }, ...body). */
export function panel({ title, sub, right }, ...body) {
  return el('section', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', { text: title }),
      sub ? el('span', { class: 'sub', text: sub }) : null,
      right ? el('span', { style: 'margin-left:auto' }, right) : null,
    ),
    ...body,
  );
}

/** Human summary of the active commit set, e.g. "range 2024-01-01 → 2024-06-01 · 123 commits". */
export function commitSetLabel(set) {
  let scope = 'all commits';
  if (set.kind === 'range') {
    scope = `range ${set.from ? fmtDate(set.from) : 'start'} → ${set.to ? fmtDate(set.to) : 'end'}`;
  } else if (set.kind === 'list') {
    scope = 'selected commits';
  }
  const author = set.authorFilter ? ` · author: ${set.authorFilter}` : '';
  return `${scope} · ${fmtInt(set.count)} commits${author}`;
}

/** Ownership bar: <div class="obar"><track><fill/></track><pct/></div> */
export function ownershipBar(value) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0));
  return el('div', { class: 'obar' },
    el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(pct * 100).toFixed(1)}%` })),
    el('div', { class: 'pct', text: fmtPct(pct) }),
  );
}

/** Author breakdown table shared by the metric views. */
export function authorsTable(rows) {
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'data' },
      el('thead', {},
        el('tr', {},
          el('th', { text: 'Author' }),
          el('th', { text: 'Added' }),
          el('th', { text: 'Removed' }),
          el('th', { text: 'Churn' }),
          el('th', { text: 'Modifications' }),
          el('th', { text: 'Ownership' }),
        ),
      ),
      el('tbody', {},
        rows.map((row) => el('tr', {},
          el('td', { text: row.label }),
          el('td', { class: 'pos nowrap', text: `+${fmtInt(row.added)}` }),
          el('td', { class: 'neg nowrap', text: `−${fmtInt(row.removed)}` }),
          el('td', { class: 'nowrap', text: fmtInt(row.churn) }),
          el('td', { class: 'nowrap', text: fmtInt(row.modifications) }),
          el('td', {}, ownershipBar(row.ownership)),
        )),
      ),
    ),
  );
}

/** Directory part of a repository path ('' for top-level files). */
export const dirname = (path) => {
  const cut = String(path).lastIndexOf('/');
  return cut < 0 ? '' : String(path).slice(0, cut);
};

/** The metric cards shared by the repository, directory and file views. */
export function statsGrid(stats, opts = {}) {
  const cards = [];
  if (opts.commits !== undefined) cards.push(statCard('Commits', fmtInt(opts.commits), 'non-merge, active set'));
  cards.push(
    statCard('Lines added', fmtInt(stats.added)),
    statCard('Lines removed', fmtInt(stats.removed)),
    statCard('Growth', fmtInt(stats.growth), 'added − removed'),
    statCard('Churn', fmtInt(stats.churn), 'added + removed'),
    statCard('Modifications', fmtInt(stats.modifications), 'commits touching it'),
    statCard('Modification frequency', fmtNum(stats.modificationFrequency, 4), 'per commit'),
    statCard('Churn rate', fmtNum(stats.churnRate, 4), 'churn per commit'),
  );
  return el('div', { class: 'grid stats', style: 'margin-top:12px' }, ...cards);
}

let toastTimer = null;
export function toast(message, kind = 'info', ms = 3200) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, ms);
}

export function errorBox(message) {
  return el('div', { class: 'error-box', text: message });
}

/** Sort helper for numeric columns (descending first click). */
export function sortRows(rows, key, dir) {
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (typeof x === 'string') return dir * x.localeCompare(y);
    return dir * ((x ?? 0) - (y ?? 0));
  });
}
