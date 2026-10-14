import { summarizeSelectedAirings, weekdayOf } from '../analytics/airingExplorer.js';
import { renderChart } from './charts.js';
import { escapeHTML as e, number, dateLabel, timeLabel, preciseTimeLabel, WEEKDAYS } from './format.js';

const people = value => Number.isFinite(value) ? `${number(value, 0)} чел.` : 'Зрители: нет данных';
const boundary = program => program.approximate ? timeLabel : preciseTimeLabel;
const sourceLabel = source => source === 'grid_10min' ? '≈ сетка' : 'точные программы';
const pct = value => Number.isFinite(value) ? `${number(value)}%` : '—';
function neighbor(program, viewers, direction) {
  return `<div class="airing-flow ${direction}"><span class="airing-flow-label">${direction === 'before' ? 'ВХОД · ДО ПРОГРАММЫ' : 'ВЫХОД · ПОСЛЕ ПРОГРАММЫ'}</span>${program ? `<strong>${e(program.title)}</strong><span>${timeLabel(program.startSec)}–${timeLabel(program.endSec)} · доля ${pct(program.share)}</span><span>${people(viewers)}${program.approximate ? ' · ≈ сетка' : ''}</span>` : '<span>Нет соседней программы с перерывом до 10 минут</span>'}</div>`;
}
function concurrent(context) {
  const observed = context.competitors.filter(row => !row.missing), missing = context.competitors.filter(row => row.missing);
  if (!observed.length) return '<p class="small muted">Нет данных конкурентов за этот интервал. Их добавит ежедневный отчёт за эту дату.</p>';
  return `<div class="airing-concurrent">${observed.map(row => `<div class="airing-competitor"><strong>${e(row.channel)}</strong><span>${row.programmes.map(p => `${e(p.title)} (${timeLabel(p.startSec)}–${timeLabel(p.endSec)})`).join(' → ')}</span><span class="airing-competitor-metric">Доля окна: ${pct(row.share)} · ${row.viewers == null ? `рейтинг ${pct(row.rtg)}` : people(row.viewers)}</span><small>${sourceLabel(row.source)} · покрытие ${number(row.coverageFraction * 100, 0)}%${row.conflict ? ' · конфликт границ' : ''}</small></div>`).join('')}</div>${missing.length ? `<p class="chart-footnote">Нет данных: ${missing.map(row => e(row.channel)).join(', ')}.</p>` : ''}`;
}
function current(context) {
  const p = context.program;
  return `<div class="airing-current"><strong>${e(p.title)}</strong><div class="airing-current-metrics"><b>${people(context.viewers)}</b><span>Доля ${pct(p.share)} · рейтинг ${pct(p.rtg)}</span></div><span>Удержание: вход ${pct(context.leadInRetention)} · выход ${pct(context.leadOutRetention)}</span>${context.viewersDelta == null ? '' : `<span>Δ средней аудитории к входу: ${context.viewersDelta > 0 ? '+' : ''}${number(context.viewersDelta, 0)} чел.</span>`}</div>`;
}
function checkbox(context, selected) {
  const p = context.program;
  return `<label class="airing-select"><input id="airing-select-${e(p.id)}" type="checkbox" data-airing-select="${e(p.id)}" ${selected.has(p.id) ? 'checked' : ''} aria-label="Отметить ${e(p.title)} ${p.dateISO} ${timeLabel(p.startSec)}"><span>${boundary(p)(p.startSec)}–${boundary(p)(p.endSec)}</span></label>`;
}
function card(context, selected) {
  const p = context.program;
  return `<article id="airing-card-${e(p.id)}" class="airing-card ${selected.has(p.id) ? 'is-selected' : ''}" tabindex="-1"><div class="airing-card-heading">${checkbox(context, selected)}<span class="badge ${p.approximate ? 'approx' : 'exact'}">${p.approximate ? '≈ 10 минут' : 'Точное время'}</span><button data-program="${e(p.id)}" class="text-button">Подробности ↗</button></div><div class="airing-flow-grid">${neighbor(context.previous, context.previousViewers, 'before')}${current(context)}${neighbor(context.next, context.nextViewers, 'after')}</div>${context.competitors.length ? `<p class="airing-concurrent-label">В ЭТО ВРЕМЯ НА ДРУГИХ КАНАЛАХ</p>${concurrent(context)}` : ''}</article>`;
}

export function renderAiringBrowser(element, { contexts, days, layout, page = 1, selectedIds = [], startSec = 18000, endSec = 104400 }) {
  const selected = new Set(selectedIds), byId = new Map(contexts.map(row => [row.program.id, row]));
  const pageSize = layout === 'calendar' ? 7 : 25, items = layout === 'calendar' ? days : contexts;
  const pages = Math.max(1, Math.ceil(items.length / pageSize)), currentPage = Math.min(page, pages), slice = items.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const scrollLeft = element.querySelector('.airing-calendar-scroll')?.scrollLeft ?? 0, focusId = element.contains(document.activeElement) ? document.activeElement.id : null;
  if (!items.length) {
    element.innerHTML = '<div class="inline-empty">Нет подходящих выходов. Выберите название программы, расширьте часы начала или период. Данные 25–34 по отдельным программам в этих отчётах отсутствуют.</div>';
  } else if (layout === 'calendar') {
    const axisStart = startSec, axisEnd = Math.max(endSec, ...slice.flatMap(day => day.airings.map(p => p.endSec)));
    const span = axisEnd - axisStart, step = span <= 7200 ? 1800 : span <= 21600 ? 3600 : 10800;
    const ticks = []; for (let sec = axisStart; sec <= axisEnd; sec += step) ticks.push(sec);
    if (ticks.at(-1) !== axisEnd) ticks.push(axisEnd);
    const left = sec => (sec - axisStart) / span * 100;
    element.innerHTML = `<div class="airing-calendar-scroll"><div class="airing-calendar"><div class="airing-axis"><span>Эфирный день</span><div>${ticks.map(sec => `<span style="left:${left(sec)}%">${timeLabel(sec)}</span>`).join('')}</div></div>${slice.map(day => `<div class="airing-day"><div class="airing-day-date"><b>${dateLabel(day.dateISO, true)}</b><span>${WEEKDAYS[weekdayOf(day.dateISO) - 1]} · ${day.airings.length} выходов</span></div><div class="airing-day-track"><div class="airing-window" style="left:0;width:${(endSec - startSec) / span * 100}%"></div>${day.airings.map(p => `<button class="airing-marker ${selected.has(p.id) ? 'selected' : ''} ${p.approximate ? 'approximate' : ''}" data-airing-focus="${e(p.id)}" style="left:${left(p.startSec)}%;width:${(p.endSec - p.startSec) / span * 100}%" aria-label="${e(p.title)} ${timeLabel(p.startSec)}–${timeLabel(p.endSec)}"><span>${timeLabel(p.startSec)}</span></button>`).join('')}</div></div>`).join('')}</div></div><p class="chart-footnote">${timeLabel(axisStart)}–${timeLabel(axisEnd)} · Нажмите выход на ленте для перехода к его контексту. На узком экране лента прокручивается вправо.</p><div class="airing-days-context">${slice.map(day => `<section class="airing-day-context"><h3>${dateLabel(day.dateISO, true)} · ${WEEKDAYS[weekdayOf(day.dateISO) - 1]}</h3>${day.airings.length ? day.airings.map(p => card(byId.get(p.id), selected)).join('') : `<p class="muted small">${{ noMatch: 'В подробном эфире нет выхода по этим фильтрам.', partialDay: 'Эфир заполнен частично; отсутствие выхода не подтверждено.', noData: 'Нет подробных данных эфира.' }[day.missingReason]}</p>`}</section>`).join('')}</div>`;
    element.querySelector('.airing-calendar-scroll').scrollLeft = scrollLeft;
  } else {
    element.innerHTML = `<div class="table-scroll"><table class="airing-wide-table"><thead><tr><th>Дата / выход</th><th>Программа и зрители</th><th>Вход</th><th>Выход</th><th>Конкуренты в это время</th></tr></thead><tbody>${slice.map(context => `<tr class="${selected.has(context.program.id) ? 'is-selected' : ''}"><td>${dateLabel(context.program.dateISO, true)} · ${WEEKDAYS[weekdayOf(context.program.dateISO) - 1]}${checkbox(context, selected)}<span class="program-channel">${sourceLabel(context.program.source)}</span><button data-program="${e(context.program.id)}" class="text-button">Подробности ↗</button></td><td>${current(context)}</td><td>${neighbor(context.previous, context.previousViewers, 'before')}</td><td>${neighbor(context.next, context.nextViewers, 'after')}</td><td>${concurrent(context)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  return { page: currentPage, pages, total: items.length, from: slice.length ? (currentPage - 1) * pageSize + 1 : 0, to: (currentPage - 1) * pageSize + slice.length };
}

export function renderAiringComparison(contexts, { groupBy, metric }) {
  const $ = id => document.getElementById(id), groups = summarizeSelectedAirings(contexts, { groupBy });
  const label = group => groupBy === 'weekday' ? WEEKDAYS[Number(group.label) - 1] : group.label;
  $('airing-comparison-scope').textContent = `${contexts.length} отмеченных выходов · ${new Set(contexts.map(row => row.program.dateISO)).size} дней · ${contexts[0]?.program.title ?? ''}. В сравнении участвуют все отмеченные выходы, включая скрытые текущими фильтрами.`;
  $('airing-comparison-table').innerHTML = `<thead><tr>${['Группа / источник', 'Выходы / дни', 'Доля', 'Рейтинг', 'Средние зрители', 'Удержание входа'].map(text => `<th>${text}</th>`).join('')}</tr></thead><tbody>${groups.map(group => `<tr><td>${e(label(group))}<span class="program-channel">${sourceLabel(group.source)}</span></td><td>${group.count} / ${group.dates}</td><td class="numeric">${pct(group.share)}</td><td class="numeric">${pct(group.rtg)}</td><td class="numeric">${people(group.viewers)}<span class="program-channel">${group.viewerCount} выходов с измерением</span></td><td class="numeric">${pct(group.retention)}<span class="program-channel">${group.retentionCount} выходов с входом</span></td></tr>`).join('')}</tbody>`;
  const unit = metric === 'viewers' ? 'Средние зрители, чел.' : metric === 'retention' ? 'Удержание входа, %' : 'Доля, %';
  renderChart($('airing-comparison-chart'), {
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true }, legend: { bottom: 0 }, grid: { left: metric === 'viewers' ? 70 : 48, right: 20, top: 35, bottom: 80 },
    xAxis: { type: 'category', data: groups.map(label), axisLabel: { fontSize: 9, rotate: groups.length > 6 ? 25 : 0 } }, yAxis: { type: 'value', name: unit, nameTextStyle: { fontSize: 10 } },
    series: ['program_logs', 'grid_10min'].map(source => ({ name: sourceLabel(source), type: 'bar', barMaxWidth: 28, data: groups.map(group => group.source === source ? group[metric] : null) })),
  });
  return [['Группировка', groupBy, 'Программа', contexts[0]?.program.title, 'Канал', contexts[0]?.program.channel], ['Группа', 'Источник', 'Выходы', 'Дни', 'Доля %', 'Рейтинг %', 'Средние зрители чел.', 'Измерения зрителей', 'Удержание входа %', 'Измерения удержания'], ...groups.map(group => [label(group), group.source, group.count, group.dates, group.share, group.rtg, group.viewers, group.viewerCount, group.retention, group.retentionCount])];
}

export function airingsCSV(contexts) {
  return [['Дата', 'Канал', 'Программа', 'Начало', 'Конец', 'Источник', 'Доля %', 'Рейтинг %', 'Средние зрители чел.', 'Предыдущая программа', 'Доля входа %', 'Зрители входа чел.', 'Следующая программа', 'Доля выхода %', 'Зрители выхода чел.', 'Удержание входа %', 'Удержание выхода %', 'Конкуренты в окне'], ...contexts.map(row => {
    const p = row.program;
    return [p.dateISO, p.channel, p.title, boundary(p)(p.startSec), boundary(p)(p.endSec), p.source, p.share, p.rtg, row.viewers, row.previous?.title, row.previous?.share, row.previousViewers, row.next?.title, row.next?.share, row.nextViewers, row.leadInRetention, row.leadOutRetention,
      row.competitors.map(item => `${item.channel}: ${item.missing ? 'нет данных' : [...new Set(item.programmes.map(p => p.title))].join(' / ')}; Share=${item.share ?? ''}; Source=${item.source ?? ''}; Coverage=${item.coverageFraction}`).join(' | ')];
  })];
}
