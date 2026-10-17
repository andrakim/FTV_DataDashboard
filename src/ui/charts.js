import { audienceKey } from '../analytics/comparator.js';
import { dateLabel, METRIC_LABELS, UNITS, WEEKDAYS, timeLabel, number } from './format.js';

const charts = new Map();
// High-contrast distinct palette for multi-day curves and period comparisons
export const DAY_CURVE_COLORS = Object.freeze([
  '#2563eb', // Cobalt Blue
  '#16a34a', // Emerald Green
  '#ea580c', // Vivid Orange
  '#9333ea', // Royal Purple
  '#e11d48', // Crimson Rose
  '#0891b2', // Cyan Teal
  '#ca8a04', // Amber Gold
  '#4f46e5', // Indigo
]);
export const PERIOD_COLORS = Object.freeze(['#2563eb', '#ea580c']);
const colors = DAY_CURVE_COLORS;

export function renderChart(element, option, onClick) {
  if (!globalThis.echarts) { element.textContent = 'Графики недоступны: проверьте подключение к интернету.'; return null; }
  let entry = charts.get(element);
  if (!entry) {
    element.textContent = '';
    const chart = globalThis.echarts.init(element);
    const observer = new ResizeObserver(() => { if (element.clientWidth) chart.resize(); });
    observer.observe(element); entry = { chart, observer }; charts.set(element, entry);
  }
  entry.chart.setOption({ animation: false, color: option.color ?? colors, textStyle: { fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", fontSize: 11 }, ...option }, { notMerge: true });
  entry.chart.off('click'); if (onClick) entry.chart.on('click', onClick);
  entry.chart.resize();
  return entry.chart;
}

function buildTooltipFormatter(metric, mode) {
  const digits = metric === 'atsMin' || metric === 'reach' ? 1 : 2;
  const unit = UNITS[metric] ?? '%';
  return params => {
    const items = Array.isArray(params) ? params : [params];
    if (!items.length) return '';
    const header = items[0].axisValueLabel ?? items[0].name ?? '';
    const lines = [header];
    const baselineItem = mode === 'dayOfWeekSlots'
      ? items.find(item => item.seriesName === 'Среднее по доступной сетке')
      : mode === 'ab' && items.length === 2 ? items[1] : null;
    const baseVal = typeof baselineItem?.value === 'number' && Number.isFinite(baselineItem.value) ? baselineItem.value : null;

    for (const item of items) {
      const val = typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null;
      const formatted = val != null ? `${number(val, digits)} ${unit}` : '—';
      let deltaText = '';
      if (val != null && baseVal != null && item !== baselineItem && (mode === 'ab' || (mode === 'dayOfWeekSlots' && item.seriesName !== 'Медиана'))) {
        const diff = val - baseVal;
        const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
        deltaText = ` (${sign}${number(Math.abs(diff), digits)})`;
      }
      lines.push(`${item.marker ?? '•'} ${item.seriesName}: ${formatted}${deltaText}`);
    }
    return lines.join('\n');
  };
}

function axisChart(element, { categories, series, metric = 'share', zoom = false, bar = false, hideLegend = false, palette = colors, tooltipMode = null, onClick }) {
  return renderChart(element, {
    color: palette,
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, formatter: buildTooltipFormatter(metric, tooltipMode) },
    legend: { show: !hideLegend, type: 'scroll', bottom: zoom ? 42 : 0, itemWidth: 14, itemHeight: 8, textStyle: { color: '#334155', fontSize: 11, fontWeight: 600 } },
    grid: { left: 52, right: 20, top: 28, bottom: hideLegend ? (zoom ? 58 : 28) : (zoom ? 95 : 46) },
    xAxis: { type: 'category', data: categories, boundaryGap: bar, axisLine: { lineStyle: { color: '#cbd5e1' } }, axisTick: { show: false }, axisLabel: { color: '#475569', fontSize: 10 } },
    yAxis: { type: 'value', name: `${METRIC_LABELS[metric]}, ${UNITS[metric]}`, nameTextStyle: { color: '#475569', fontSize: 10, fontWeight: 600 }, splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } }, axisLabel: { color: '#475569', fontSize: 10 } },
    dataZoom: zoom ? [{ type: 'inside' }, { type: 'slider', bottom: hideLegend ? 6 : 0, height: 20, borderColor: '#cbd5e1' }] : [],
    series: series.map((row, i) => {
      const isBar = (row.type ?? (bar ? 'bar' : 'line')) === 'bar';
      const color = row.color;
      return {
        type: bar ? 'bar' : 'line',
        ...row,
        data: row.data,
        connectNulls: false,
        showSymbol: row.showSymbol ?? (categories.length < 24),
        symbolSize: row.symbolSize ?? (i === 0 && !isBar ? 6 : 5),
        barMaxWidth: 32,
        emphasis: { focus: 'series', blurScope: 'coordinateSystem', lineStyle: { width: (row.width ?? 2) + 1.2 } },
        blur: { lineStyle: { opacity: 0.16 }, itemStyle: { opacity: 0.2 } },
        lineStyle: { width: row.width ?? (i === 0 ? 2.6 : 1.9), type: row.dashed ? 'dashed' : 'solid', opacity: row.opacity ?? 1, ...(color ? { color } : {}) },
        itemStyle: isBar ? { borderRadius: [4, 4, 0, 0], ...(color ? { color } : {}) } : (color ? { color } : undefined),
      };
    }),
  }, onClick);
}

export function renderDailyTrend(element, daily, { audience = '18-54', metric = 'share', onClick } = {}) {
  const key = audienceKey(audience);
  return axisChart(element, { categories: daily.map(row => dateLabel(row.dateISO)), metric, zoom: daily.length > 31,
    series: [{ name: 'FTV (UZ/RU)', color: '#2563eb', data: daily.map(row => row[key]?.[metric] ?? null), areaStyle: { color: 'rgba(37, 99, 235, 0.08)' } }],
    onClick: params => { if (params.componentType === 'series') onClick?.(daily[params.dataIndex]?.dateISO); } });
}

export function renderComparison(element, result, { metric = 'share', chartView = 'daily', data, curveDates = [], labels = ['Период A', 'Период B'], onDate } = {}) {
  const key = audienceKey(result.mode === 'dayOfWeek' ? result.summary.audience : result.current.audience);
  if (chartView === 'daily') {
    if (result.mode === 'dayOfWeek') {
      const rows = result.summary.dates.map(date => data.daily_metrics.find(row => row.dateISO === date));
      return axisChart(element, { categories: rows.map(row => dateLabel(row.dateISO)), metric, bar: true, palette: ['#2563eb', '#0f172a'],
        series: [
          { name: 'Показатель дня', color: '#2563eb', data: rows.map(row => row[key]?.[metric] ?? null) },
          { name: 'Среднее по выбранным дням', type: 'line', color: '#0f172a', width: 2.2, dashed: true, showSymbol: false, data: rows.map(() => result.summary.daily[metric].mean) },
        ],
        onClick: params => { if (params.componentType === 'series') onDate?.(rows[params.dataIndex]?.dateISO); } });
    }
    if (result.mode === 'week') return axisChart(element, { categories: WEEKDAYS, metric, palette: PERIOD_COLORS, tooltipMode: 'ab',
      series: ['current', 'baseline'].map((k, i) => ({
        name: labels[i], color: PERIOD_COLORS[i], width: i === 0 ? 2.8 : 2.2, dashed: i === 1,
        areaStyle: i === 0 ? { color: 'rgba(37, 99, 235, 0.07)' } : undefined,
        data: result.weekdays.map(row => row[k].daily[metric].mean),
      })) });
    if (result.mode === 'year') return axisChart(element, { categories: ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'], metric, palette: PERIOD_COLORS, tooltipMode: 'ab',
      series: ['current', 'baseline'].map((k, i) => ({
        name: labels[i], color: PERIOD_COLORS[i], width: i === 0 ? 2.8 : 2.2, dashed: i === 1,
        areaStyle: i === 0 ? { color: 'rgba(37, 99, 235, 0.07)' } : undefined,
        data: result.monthly.map(row => row[k].daily[metric].mean),
      })) });
    return axisChart(element, { categories: labels, metric, bar: true, palette: PERIOD_COLORS,
      series: [{ name: METRIC_LABELS[metric], data: [
        { value: result.current.daily[metric].mean, itemStyle: { color: PERIOD_COLORS[0] } },
        { value: result.baseline.daily[metric].mean, itemStyle: { color: PERIOD_COLORS[1] } },
      ] }] });
  }
  if (chartView === 'dayparts') {
    const current = result.mode === 'dayOfWeek' ? result.summary.dayparts : result.current.dayparts;
    return axisChart(element, { categories: current.map(row => row.label), metric, bar: true, palette: PERIOD_COLORS, tooltipMode: result.mode === 'dayOfWeek' ? null : 'ab',
      series: [{ name: result.mode === 'dayOfWeek' ? 'Средний профиль' : labels[0], color: PERIOD_COLORS[0], data: current.map(row => row[metric]) },
        ...(result.mode === 'dayOfWeek' ? [] : [{ name: labels[1], color: PERIOD_COLORS[1], data: result.baseline.dayparts.map(row => row[metric]) }])] });
  }
  const rows = result.mode === 'dayOfWeek' ? result.baseline : result.current.slots;
  const meanKey = metric === 'share' ? 'meanShare' : 'meanRtg', medianKey = metric === 'share' ? 'medianShare' : 'medianRtg';
  const filteredCurves = result.mode === 'dayOfWeek' ? result.curves.filter(curve => curveDates.includes(curve.dateISO)) : [];
  const series = result.mode === 'dayOfWeek' ? [
    { name: 'Среднее по доступной сетке', color: '#0f172a', data: rows.map(row => row[meanKey]), width: 3, z: 4, areaStyle: { color: 'rgba(15, 23, 42, 0.04)' } },
    { name: 'Медиана', color: '#64748b', data: rows.map(row => row[medianKey]), width: 1.8, dashed: true, z: 3 },
    ...filteredCurves.map((curve, idx) => {
      const color = DAY_CURVE_COLORS[idx % DAY_CURVE_COLORS.length];
      const isLatest = idx === filteredCurves.length - 1;
      return {
        name: dateLabel(curve.dateISO, true),
        color,
        data: curve.slots.map(row => row[meanKey]),
        width: isLatest ? 2.6 : 1.8,
        z: isLatest ? 5 : 2,
      };
    }),
  ] : [
    { name: labels[0], color: PERIOD_COLORS[0], width: 2.6, areaStyle: { color: 'rgba(37, 99, 235, 0.07)' }, data: rows.map(row => row[meanKey]) },
    { name: labels[1], color: PERIOD_COLORS[1], width: 2, dashed: true, data: result.baseline.slots.map(row => row[meanKey]) },
  ];
  return axisChart(element, { categories: rows.map(row => timeLabel(row.startSec)), series, metric, zoom: true, tooltipMode: result.mode === 'dayOfWeek' ? 'dayOfWeekSlots' : 'ab' });
}

export function renderProgramTimeline(element, programs, onSelect) {
  const channels = [...new Set(programs.map(row => row.channel))].slice(0, 8);
  const rows = programs.filter(row => channels.includes(row.channel));
  element.style.height = `${Math.max(145, channels.length * 42 + 65)}px`;
  return renderChart(element, {
    grid: { left: channels.length > 1 ? 150 : 30, right: 15, top: 8, bottom: 40 },
    tooltip: { renderMode: 'richText', confine: true, formatter: params => `${params.value[3]}\n${timeLabel(params.value[1])}–${timeLabel(params.value[2])}\nДоля: ${params.value[4] ?? '—'}%` },
    xAxis: { type: 'value', min: 18000, max: 104400, interval: 10800, axisLabel: { formatter: timeLabel, fontSize: 9, color: '#75848d' }, splitLine: { lineStyle: { color: '#edf2f4' } } },
    yAxis: { type: 'category', data: channels, inverse: true, axisLabel: { show: channels.length > 1, fontSize: 9 }, axisTick: { show: false }, axisLine: { show: false } },
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }],
    series: [{ type: 'custom', encode: { x: [1, 2], y: 0 }, data: rows.map(row => [channels.indexOf(row.channel), row.startSec, row.endSec, row.title, row.share, row.rtg, row.id]),
      renderItem(params, api) {
        const start = api.coord([api.value(1), api.value(0)]), end = api.coord([api.value(2), api.value(0)]), height = Math.min(30, api.size([0, 1])[1] * .7);
        const shape = globalThis.echarts.graphic.clipRectByRect({ x: start[0], y: start[1] - height / 2, width: end[0] - start[0], height }, params.coordSys);
        if (!shape) return null;
        const fill = api.value(4) >= 2 ? '#2563eb' : api.value(4) >= 1 ? '#60a5fa' : '#bfdbfe';
        return { type: 'group', children: [{ type: 'rect', shape: { ...shape, r: 3 }, style: { fill, stroke: '#fff', lineWidth: 1 } },
          ...(shape.width > 65 ? [{ type: 'text', style: { x: shape.x + 6, y: shape.y + height / 2, text: api.value(3), fill: api.value(4) >= 1 ? '#fff' : '#1e3a8a', width: shape.width - 12, overflow: 'truncate', fontSize: 9, verticalAlign: 'middle' } }] : [])] };
      } }],
  }, params => onSelect?.(params.value?.[6]));
}

export function renderProgramHistory(element, rows, { activeId = null, onSelect } = {}) {
  return axisChart(element, {
    categories: rows.map(row => `${dateLabel(row.dateISO)} ${timeLabel(row.startSec)}`),
    metric: 'share',
    zoom: rows.length > 15,
    hideLegend: true,
    series: [{
      name: 'Доля выпуска',
      color: '#2563eb',
      width: 2.4,
      showSymbol: true,
      symbolSize: 7,
      areaStyle: { color: 'rgba(37, 99, 235, 0.08)' },
      data: rows.map(row => ({
        value: row.share,
        itemStyle: row.id === activeId ? { color: '#e11d48', borderColor: '#fff', borderWidth: 2 } : undefined,
      })),
    }],
    onClick: params => { if (params.componentType === 'series' && rows[params.dataIndex]) onSelect?.(rows[params.dataIndex].id); },
  });
}
export function disposeCharts() { for (const { chart, observer } of charts.values()) { observer.disconnect(); chart.dispose(); } charts.clear(); }
export function disposeChart(element) {
  const entry = charts.get(element); if (!entry) return;
  entry.observer.disconnect(); entry.chart.dispose(); charts.delete(element);
}
