import { FTV_CHANNEL, formatBroadcastTime } from '../core/normalization.js';
import { channelMetrics } from '../analytics/comparator.js';
import { renderChart } from './charts.js';

export const SHARE_TIERS = Object.freeze([
  { lt: 0.5, color: '#f1f5f9' }, { gte: 0.5, lt: 1, color: '#dbeafe' },
  { gte: 1, lt: 1.5, color: '#93c5fd' }, { gte: 1.5, lt: 2, color: '#60a5fa' },
  { gte: 2, lt: 3, color: '#3b82f6' }, { gte: 3, lt: 5, color: '#2563eb' },
  { gte: 5, lt: 8, color: '#1d4ed8' }, { gte: 8, color: '#172554' },
]);

export function renderGrid(element, rows, { audience = '18-54' } = {}) {
  const channels = [...new Set(rows.flatMap(row => Object.keys(row.channels ?? {})))].sort((a, b) => a === FTV_CHANNEL ? -1 : b === FTV_CHANNEL ? 1 : a.localeCompare(b));
  const data = rows.flatMap(row => channels.flatMap((channel, index) => {
    const metric = channelMetrics(row, channel, audience);
    return metric && Number.isFinite(metric.share) ? [[row.slotIndex, index, metric.share, metric.title]] : [];
  }));
  return renderChart(element, {
    tooltip: { renderMode: 'richText', formatter: params => `${channels[params.value[1]]}\n${params.value[3]}\nShare: ${params.value[2]}%` },
    grid: { left: 160, right: 20, top: 20, bottom: 90 },
    xAxis: { type: 'category', data: Array.from({ length: 144 }, (_, i) => formatBroadcastTime(18000 + i * 600).slice(0, 5)), splitArea: { show: true } },
    yAxis: { type: 'category', data: channels, inverse: true },
    visualMap: { type: 'piecewise', dimension: 2, pieces: SHARE_TIERS, orient: 'horizontal', left: 'center', bottom: 0 },
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }, { type: 'slider', xAxisIndex: 0, bottom: 42 }],
    series: [{ type: 'heatmap', data, emphasis: { itemStyle: { borderColor: '#f59e0b', borderWidth: 2 } } }],
  });
}

const triggerLabels = { leadInDrop: 'Обвал на стыке', primeUnderperformance: 'Просадка прайма', midBlockValley: 'Яма внутри связки' };
const number = value => Number.isFinite(value) ? value.toFixed(2) : 'нет данных';

export function renderPainPoints(element, drops) {
  element.replaceChildren();
  if (!drops.length) { const text = document.createElement('p'); text.textContent = 'В выбранном периоде провалы не обнаружены.'; element.append(text); return; }
  for (const drop of drops) {
    const card = document.createElement('article');
    const heading = document.createElement('h3');
    heading.textContent = `${drop.program.dateISO} · ${formatBroadcastTime(drop.program.startSec)} · ${drop.program.title}`;
    card.append(heading);
    const lines = [drop.triggers.map(trigger => triggerLabels[trigger]).join(' · '),
      `Доля: ${number(drop.program.share)}%. Удержание входа: ${number(drop.leadInRetention)}%. Удержание выхода: ${number(drop.leadOutRetention)}%.`];
    for (const comp of drop.competitors.slice(0, 3)) lines.push(`${comp.channel}: +${number(comp.deltaShare)} п.п. · ${comp.programs.join(', ')}`);
    if (drop.demographics) lines.push(`Потеря: ${number(drop.demographics.lostViewers000)} тыс. зрителей. ${drop.demographics.leadingLosses.map(row => `${row.segment}: −${number(row.loss000)}`).join('; ')}`);
    lines.push(drop.attributionNote);
    for (const line of lines) { const p = document.createElement('p'); p.textContent = line; card.append(p); }
    element.append(card);
  }
}
