import { formatBroadcastTime } from '../core/normalization.js';

const charts = new Map();
export function renderChart(element, option) {
  if (!globalThis.echarts) { element.textContent = 'Для графиков требуется загрузка Apache ECharts.'; return null; }
  let entry = charts.get(element);
  if (!entry) {
    const chart = globalThis.echarts.init(element);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    entry = { chart, observer }; charts.set(element, entry);
  }
  entry.chart.setOption(option, { notMerge: true });
  return entry.chart;
}

export function renderComparison(element, result) {
  const rows = result.mode === 'dayOfWeek' ? result.baseline : result.current.slots;
  const series = result.mode === 'dayOfWeek' ? [
    { name: 'Средняя доля', data: rows.map(row => row.meanShare), width: 3 },
    { name: 'Медианная доля', data: rows.map(row => row.medianShare), width: 2 },
    ...result.curves.map(curve => ({ name: curve.dateISO, data: curve.slots.map(row => row.meanShare), width: 1 })),
  ] : [
    { name: 'Период A', data: rows.map(row => row.meanShare), width: 3 },
    { name: 'Период B', data: result.baseline.slots.map(row => row.meanShare), width: 2 },
  ];
  return renderChart(element, {
    tooltip: { trigger: 'axis', renderMode: 'richText' }, legend: { type: 'scroll' },
    grid: { left: 55, right: 25, top: 50, bottom: 75 },
    xAxis: { type: 'category', data: rows.map(row => formatBroadcastTime(row.startSec).slice(0, 5)) },
    yAxis: { type: 'value', name: 'Share, %' }, dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 12 }],
    series: series.map(row => ({ type: 'line', name: row.name, data: row.data, showSymbol: false, connectNulls: false, lineStyle: { width: row.width } })),
  });
}

export function disposeCharts() {
  for (const { chart, observer } of charts.values()) { observer.disconnect(); chart.dispose(); }
  charts.clear();
}
