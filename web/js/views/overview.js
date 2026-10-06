// web/js/views/overview.js
//
// Overview: repository totals for the active commit set, the activity
// timeline (added / removed / commits per bucket) and the author breakdown
// with churn and ownership shares.

import { api } from '../api.js';
import { AXIS, C, LEGEND, TOOLTIP, mountChart } from '../charts.js';
import { emit, filterParams, state } from '../state.js';
import { commitSetLabel, authorsTable, el, fmtNum, panel, statsGrid } from '../ui.js';

const BUCKETS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
const TOP_CHART_AUTHORS = 12;
const TOP_TABLE_AUTHORS = 20;

function timelineOption(buckets) {
  const zoom = buckets.length > 40;
  return {
    tooltip: { ...TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { ...LEGEND, data: ['Added', 'Removed', 'Commits'] },
    grid: { left: 58, right: 52, top: 36, bottom: zoom ? 56 : 30 },
    xAxis: { type: 'category', data: buckets.map((b) => b.key), ...AXIS, splitLine: { show: false } },
    yAxis: [
      { type: 'value', name: 'lines', nameTextStyle: { color: C.muted }, ...AXIS },
      { type: 'value', name: 'commits', minInterval: 1, nameTextStyle: { color: C.muted }, ...AXIS, splitLine: { show: false } },
    ],
    series: [
      { name: 'Added', type: 'bar', stack: 'churn', barMaxWidth: 24, itemStyle: { color: C.pos }, data: buckets.map((b) => b.added) },
      { name: 'Removed', type: 'bar', stack: 'churn', barMaxWidth: 24, itemStyle: { color: C.neg }, data: buckets.map((b) => b.removed) },
      {
        name: 'Commits', type: 'line', yAxisIndex: 1, symbolSize: 5,
        itemStyle: { color: C.accent }, lineStyle: { color: C.accent, width: 2 },
        data: buckets.map((b) => b.commits),
      },
    ],
    dataZoom: zoom ? [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 6 }] : undefined,
  };
}

function authorsOption(rows) {
  return {
    tooltip: { ...TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 58, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', ...AXIS },
    yAxis: { type: 'category', inverse: true, data: rows.map((r) => r.label), ...AXIS, splitLine: { show: false } },
    series: [{
      type: 'bar',
      data: rows.map((r) => r.churn),
      barMaxWidth: 16,
      itemStyle: { color: C.accent, borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: 'right', color: C.muted, fontSize: 11, formatter: ({ value }) => fmtNum(value) },
    }],
  };
}

export async function render() {
  if (!state.repoId) return el('div', { class: 'empty' }, 'Select a repository first.');

  const params = filterParams();
  const [summary, timeline] = await Promise.all([
    api.summary(state.repoId, params),
    api.timeline(state.repoId, state.timelineBucket, params),
  ]);

  const { stats, commitSet, authors } = summary;
  const wrap = el('div');

  wrap.append(
    el('div', { class: 'chip-row' }, el('div', { class: 'chip', text: commitSetLabel(commitSet) })),
    statsGrid(stats, { commits: commitSet.count }),
  );

  const bucketButtons = el('div', { class: 'chip-row' });
  for (const [id, label] of BUCKETS) {
    bucketButtons.append(el('button', {
      class: id === state.timelineBucket ? 'btn sm primary' : 'btn sm',
      onclick: () => {
        if (state.timelineBucket === id) return;
        state.timelineBucket = id;
        emit();
      },
    }, label));
  }

  const timelineHost = el('div', { class: 'chart' });
  wrap.append(panel(
    { title: 'Activity over time', sub: `bucketed by ${state.timelineBucket}`, right: bucketButtons },
    timeline.buckets.length === 0
      ? el('div', { class: 'empty' }, 'No commits in this selection.')
      : timelineHost,
  ));
  if (timeline.buckets.length > 0) mountChart(timelineHost, timelineOption(timeline.buckets));

  const shown = authors.slice(0, TOP_TABLE_AUTHORS);
  const body = [authorsTable(shown)];
  if (authors.length > 0) {
    const authorsHost = el('div', { class: 'chart', style: `height:${Math.max(150, Math.min(TOP_CHART_AUTHORS, authors.length) * 30)}px` });
    mountChart(authorsHost, authorsOption(authors.slice(0, TOP_CHART_AUTHORS)));
    body.unshift(authorsHost);
  }
  wrap.append(panel(
    {
      title: 'Authors by churn',
      sub: authors.length > TOP_TABLE_AUTHORS ? `showing top ${TOP_TABLE_AUTHORS} of ${authors.length}` : undefined,
    },
    ...(authors.length === 0 ? [el('div', { class: 'empty' }, 'No author churn in this selection.')] : body),
  ));

  return wrap;
}
