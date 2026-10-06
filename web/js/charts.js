// web/js/charts.js
//
// Thin wrapper around the vendored ECharts bundle: shared theme tokens that
// match the dashboard palette plus mountChart() for deferred initialisation
// (ECharts can only measure the canvas once the host element is visible).
//
// Instances are tracked per host element; whenever a new chart is mounted,
// instances whose host was replaced by a re-render are disposed automatically.

const live = new Set();

export const C = {
  ink: '#1e2430',
  muted: '#68707f',
  line: '#e3e6eb',
  accent: '#4f46e5',
  pos: '#15803d',
  neg: '#dc2626',
  grid: '#eef1f6',
};

/** Shared axis styling; override per axis (e.g. splitLine off) after spreading. */
export const AXIS = {
  axisLine: { lineStyle: { color: C.line } },
  axisTick: { show: false },
  axisLabel: { color: C.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: C.grid } },
};

export const TOOLTIP = {
  backgroundColor: '#ffffff',
  borderColor: C.line,
  borderWidth: 1,
  textStyle: { color: C.ink, fontSize: 12 },
  extraCssText: 'box-shadow:0 4px 14px rgba(16,24,40,.12);border-radius:8px;',
};

export const LEGEND = {
  top: 0,
  itemWidth: 14,
  itemHeight: 8,
  textStyle: { color: C.muted, fontSize: 12 },
};

function prune() {
  for (const entry of live) {
    if (entry.host.isConnected) continue;
    entry.observer.disconnect();
    entry.instance.dispose();
    live.delete(entry);
  }
}

/** Mounts (and keeps responsive) an ECharts instance on the host element. */
export function mountChart(host, option) {
  requestAnimationFrame(() => {
    if (!host.isConnected) return;
    if (!window.echarts) throw new Error('ECharts bundle missing from /vendor/echarts.min.js');
    prune();
    const instance = window.echarts.init(host, null, { textStyle: { fontFamily: 'inherit' } });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(host);
    instance.setOption(option);
    live.add({ host, instance, observer });
  });
}
