import { audienceKey } from '../analytics/comparator.js';
import { dateLabel, METRIC_LABELS, UNITS, WEEKDAYS, timeLabel } from './format.js';

const charts = new Map();
const colors = ['#087e83', '#798ccb', '#d0975b', '#a87ca7', '#88b286', '#829dab', '#b98c83', '#bbb174'];
export function renderChart(element, option, onClick) {
  if (!globalThis.echarts) { element.textContent = 'Графики недоступны: проверьте подключение к интернету.'; return null; }
  let entry = charts.get(element);
  if (!entry) {
    element.textContent = '';
    const chart = globalThis.echarts.init(element);
    const observer = new ResizeObserver(() => { if (element.clientWidth) chart.resize(); });
    observer.observe(element); entry = { chart, observer }; charts.set(element, entry);
  }
  entry.chart.setOption({ animation: false, color: colors, textStyle: { fontFamily: 'Manrope, sans-serif', fontSize: 10 }, ...option }, { notMerge: true });
  entry.chart.off('click'); if (onClick) entry.chart.on('click', onClick);
  entry.chart.resize();
  return entry.chart;
}

function axisChart(element, { categories, series, metric = 'share', zoom = false, bar = false, onClick }) {
  return renderChart(element, {
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
    legend: { type: 'scroll', bottom: zoom ? 42 : 0, itemWidth: 12, textStyle: { color: '#75848d', fontSize: 10 } },
    grid: { left: 48, right: 18, top: 28, bottom: zoom ? 95 : 45 },
    xAxis: { type: 'category', data: categories, boundaryGap: bar, axisLine: { lineStyle: { color: '#dce5e9' } }, axisTick: { show: false }, axisLabel: { color: '#75848d', fontSize: 10 } },
    yAxis: { type: 'value', name: `${METRIC_LABELS[metric]}, ${UNITS[metric]}`, nameTextStyle: { color: '#75848d', fontSize: 9 }, splitLine: { lineStyle: { color: '#edf2f4', type: 'dashed' } }, axisLabel: { color: '#75848d', fontSize: 9 } },
    dataZoom: zoom ? [{ type: 'inside' }, { type: 'slider', bottom: 0, height: 20, borderColor: '#e2e9ed' }] : [],
    series: series.map((row, i) => ({ type: bar ? 'bar' : 'line', ...row, data: row.data, connectNulls: false,
      showSymbol: categories.length < 20, symbolSize: 5, barMaxWidth: 30,
      lineStyle: { width: row.width ?? (i === 0 ? 2.5 : 1.5), type: row.dashed ? 'dashed' : 'solid', opacity: row.opacity ?? 1 },
      itemStyle: bar ? { borderRadius: [3, 3, 0, 0] } : undefined })),
  }, onClick);
}

export function renderDailyTrend(element, daily, { audience = '18-54', metric = 'share', onClick } = {}) {
  const key = audienceKey(audience);
  return axisChart(element, { categories: daily.map(row => dateLabel(row.dateISO)), metric, zoom: daily.length > 31,
    series: [{ name: 'FTV (UZ/RU)', data: daily.map(row => row[key]?.[metric] ?? null), areaStyle: { color: '#087e8310' } }],
    onClick: params => { if (params.componentType === 'series') onClick?.(daily[params.dataIndex]?.dateISO); } });
}

export function renderComparison(element, result, { metric = 'share', chartView = 'daily', data, curveDates = [], labels = ['Период A', 'Период B'], onDate } = {}) {
  const key = audienceKey(result.mode === 'dayOfWeek' ? result.summary.audience : result.current.audience);
  if (chartView === 'daily') {
    if (result.mode === 'dayOfWeek') {
      const rows = result.summary.dates.map(date => data.daily_metrics.find(row => row.dateISO === date));
      return axisChart(element, { categories: rows.map(row => dateLabel(row.dateISO)), metric, bar: true,
        series: [{ name: 'Показатель дня', data: rows.map(row => row[key]?.[metric] ?? null) }, { name: 'Среднее по выбранным дням', type: 'line', dashed: true, data: rows.map(() => result.summary.daily[metric].mean) }],
        onClick: params => { if (params.componentType === 'series') onDate?.(rows[params.dataIndex]?.dateISO); } });
    }
    if (result.mode === 'week') return axisChart(element, { categories: WEEKDAYS, metric,
      series: ['current', 'baseline'].map((key, i) => ({ name: labels[i], data: result.weekdays.map(row => row[key].daily[metric].mean) })) });
    if (result.mode === 'year') return axisChart(element, { categories: ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'], metric,
      series: ['current', 'baseline'].map((key, i) => ({ name: labels[i], data: result.monthly.map(row => row[key].daily[metric].mean) })) });
    return axisChart(element, { categories: labels, metric, bar: true, series: [{ name: METRIC_LABELS[metric], data: [result.current.daily[metric].mean, result.baseline.daily[metric].mean] }] });
  }
  if (chartView === 'dayparts') {
    const current = result.mode === 'dayOfWeek' ? result.summary.dayparts : result.current.dayparts;
    return axisChart(element, { categories: current.map(row => row.label), metric, bar: true,
      series: [{ name: result.mode === 'dayOfWeek' ? 'Средний профиль' : labels[0], data: current.map(row => row[metric]) },
        ...(result.mode === 'dayOfWeek' ? [] : [{ name: labels[1], data: result.baseline.dayparts.map(row => row[metric]) }])] });
  }
  const rows = result.mode === 'dayOfWeek' ? result.baseline : result.current.slots;
  const meanKey = metric === 'share' ? 'meanShare' : 'meanRtg', medianKey = metric === 'share' ? 'medianShare' : 'medianRtg';
  const series = result.mode === 'dayOfWeek' ? [
    { name: 'Среднее по доступной сетке', data: rows.map(row => row[meanKey]), width: 3 },
    { name: 'Медиана', data: rows.map(row => row[medianKey]), dashed: true },
    ...result.curves.filter(curve => curveDates.includes(curve.dateISO)).map(curve => ({ name: dateLabel(curve.dateISO, true), data: curve.slots.map(row => row[meanKey]), width: 1.5 })),
  ] : [{ name: labels[0], data: rows.map(row => row[meanKey]) }, { name: labels[1], data: result.baseline.slots.map(row => row[meanKey]) }];
  return axisChart(element, { categories: rows.map(row => timeLabel(row.startSec)), series, metric, zoom: true });
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
        const fill = api.value(4) >= 2 ? '#087e83' : api.value(4) >= 1 ? '#62a7a8' : '#bdd7d8';
        return { type: 'group', children: [{ type: 'rect', shape: { ...shape, r: 3 }, style: { fill, stroke: '#fff', lineWidth: 1 } },
          ...(shape.width > 65 ? [{ type: 'text', style: { x: shape.x + 6, y: shape.y + height / 2, text: api.value(3), fill: api.value(4) >= 1 ? '#fff' : '#31585c', width: shape.width - 12, overflow: 'truncate', fontSize: 9, verticalAlign: 'middle' } }] : [])] };
      } }],
  }, params => onSelect?.(params.value?.[6]));
}

export function renderProgramHistory(element, rows) {
  return axisChart(element, { categories: rows.map(row => `${dateLabel(row.dateISO)} ${timeLabel(row.startSec)}`), metric: 'share', series: [{ name: 'Доля выпусков', data: rows.map(row => row.share) }] });
}
export function disposeCharts() { for (const { chart, observer } of charts.values()) { observer.disconnect(); chart.dispose(); } charts.clear(); }
export function disposeChart(element) {
  const entry = charts.get(element); if (!entry) return;
  entry.observer.disconnect(); entry.chart.dispose(); charts.delete(element);
}
