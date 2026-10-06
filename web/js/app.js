// web/js/app.js
//
// Bootstrap: top-bar tabs, repository picker, filter bar and the view router.
// Views are ES modules loaded on demand from ./views/.

import { renderFilterBar } from './filterbar.js';
import { applyHash, loadGroups, loadRepos, onChange, setRepo, setView, state } from './state.js';
import { clear, el, errorBox } from './ui.js';

// Views are added here as they are implemented; the first one is the fallback.
const VIEWS = [
  { id: 'overview', label: 'Overview', load: () => import('./views/overview.js') },
  { id: 'repos', label: 'Repositories', load: () => import('./views/repos.js') },
];

const activeView = () => VIEWS.find((view) => view.id === state.view) ?? VIEWS[0];

function renderTabs() {
  const tabs = document.getElementById('tabs');
  clear(tabs);
  for (const view of VIEWS) {
    tabs.append(
      el('button', {
        class: view.id === activeView().id ? 'tab active' : 'tab',
        onclick: () => setView(view.id),
      }, view.label),
    );
  }
}

function renderRepoSelect() {
  const host = document.getElementById('repo-select');
  clear(host);
  if (state.repos.length === 0) return;
  const select = el('select', {
    title: 'Active repository',
    onchange: (event) => setRepo(event.target.value),
  });
  for (const repo of state.repos) {
    select.append(el('option', { value: repo.id, selected: repo.id === state.repoId }, `${repo.name} · ${repo.counts.commits} commits`));
  }
  host.append(select);
}

async function renderView() {
  const host = document.getElementById('view');
  clear(host);
  const view = activeView();
  if (!state.repoId && view.id !== 'repos') {
    host.append(el('div', { class: 'empty' }, 'Select a repository first.'));
    return;
  }
  host.append(el('div', { class: 'loading' }, 'Loading…'));
  try {
    const module = await view.load();
    const node = await module.render();
    clear(host);
    host.append(node);
  } catch (err) {
    clear(host);
    host.append(errorBox(err.message));
  }
}

async function renderAll() {
  renderTabs();
  renderRepoSelect();
  renderFilterBar();
  await renderView();
}

// boot
try {
  applyHash();
  await loadRepos();
  await loadGroups();
} catch (err) {
  document.getElementById('view').append(errorBox(`Cannot reach the API: ${err.message}`));
}
if (!VIEWS.some((view) => view.id === state.view)) state.view = VIEWS[0].id;
onChange(renderAll);
renderAll();
