import { FTV_CHANNEL, formatBroadcastTime } from '../core/normalization.js';
import { channelMetrics } from '../analytics/comparator.js';
import { renderChart } from './charts.js';
import { escapeHTML as e, number as fmt, dateLabel, timeLabel } from './format.js';

export const SHARE_TIERS = Object.freeze([
  { lt: 0.5, color: '#f1f5f9' }, { gte: 0.5, lt: 1, color: '#dbeafe' },
  { gte: 1, lt: 1.5, color: '#93c5fd' }, { gte: 1.5, lt: 2, color: '#60a5fa' },
  { gte: 2, lt: 3, color: '#3b82f6' }, { gte: 3, lt: 5, color: '#2563eb' },
  { gte: 5, lt: 8, color: '#1d4ed8' }, { gte: 8, color: '#172554' },
]);

export function renderGrid(element, rows, { audience = '18-54', onSelect } = {}) {
  const channels = [...new Set(rows.flatMap(row => Object.keys(row.channels ?? {})))].sort((a, b) => a === FTV_CHANNEL ? -1 : b === FTV_CHANNEL ? 1 : a.localeCompare(b));
  const data = rows.flatMap(row => channels.flatMap((channel, index) => {
    const metric = channelMetrics(row, channel, audience);
    return metric && Number.isFinite(metric.share) ? [[row.slotIndex, index, metric.share, metric.title]] : [];
  }));
  return renderChart(element, {
    tooltip: { renderMode: 'richText', confine: true, formatter: params => `${channels[params.value[1]]}\n${params.value[3]}\nДоля: ${params.value[2]}%` },
    grid: { left: 160, right: 20, top: 20, bottom: 90 },
    xAxis: { type: 'category', data: Array.from({ length: 144 }, (_, i) => formatBroadcastTime(18000 + i * 600).slice(0, 5)), splitArea: { show: true } },
    yAxis: { type: 'category', data: channels, inverse: true },
    visualMap: { type: 'piecewise', dimension: 2, pieces: SHARE_TIERS, orient: 'horizontal', left: 'center', bottom: 0 },
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }, { type: 'slider', xAxisIndex: 0, bottom: 42 }],
    series: [{ type: 'heatmap', data, emphasis: { itemStyle: { borderColor: '#f59e0b', borderWidth: 2 } } }],
  }, params => { if (params.value) onSelect?.(channels[params.value[1]], 18000 + params.value[0] * 600); });
}

const triggerLabels = { leadInDrop: 'Обвал на стыке', primeUnderperformance: 'Просадка прайма', midBlockValley: 'Яма внутри связки' };
const number = value => Number.isFinite(value) ? value.toFixed(2) : 'нет данных';

export function renderPainPoints(element, drops) {
  element.replaceChildren();
  if (!drops.length) { const text = document.createElement('p'); text.textContent = 'В выбранном периоде провалы не обнаружены.'; element.append(text); return; }
  for (const drop of drops) {
    const card = document.createElement('article'); card.className = 'pain-card';
    card.innerHTML = `<div class="pain-header"><div><p class="pain-time">${dateLabel(drop.program.dateISO, true)} · ${timeLabel(drop.program.startSec)}–${timeLabel(drop.program.endSec)}</p><h3>${e(drop.program.title)}</h3></div></div><div class="pain-tags">${drop.triggers.map(trigger => `<span class="pain-tag">${triggerLabels[trigger]}</span>`).join('')}</div><div class="pain-metrics"><div><span>Доля</span><b>${fmt(drop.program.share)}%</b></div><div><span>Удержание входа</span><b>${fmt(drop.leadInRetention, 0)}%</b></div><div><span>Изменение доли</span><b class="delta-negative">${fmt(drop.deltaShare)}</b></div></div>${drop.competitors.slice(0, 2).map(row => `<p><strong>${e(row.channel)}</strong> · +${fmt(row.deltaShare)} п.п.</p>`).join('')}${drop.demographics ? `<p>Потеря ${fmt(drop.demographics.lostViewers000)} тыс. · ${e(drop.demographics.leadingLosses.map(row => row.segment).join(', '))}</p>` : ''}<button data-program="${e(drop.program.id)}" class="text-button">Открыть программу и причины ↗</button><br><button data-investigate="${e(drop.program.id)}" class="text-button">Повторяется ли провал? ↗</button>`;
    element.append(card);
  }
}
