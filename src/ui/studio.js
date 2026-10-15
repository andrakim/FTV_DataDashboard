import { COLUMNS } from '../core/workspace.js';
import { FIELD_LABELS, LABELS } from '../analytics/workspaceQuery.js';
import { describeAiring } from '../analytics/airingExplorer.js';
import { measureWindow } from '../analytics/intervals.js';
import { renderChart } from './charts.js';
import { escapeHTML as e, number, dateLabel, timeLabel, preciseTimeLabel, WEEKDAYS } from './format.js';

export const sourceName = source => source === 'grid_10min' ? '≈ Сетка' : 'TOP';
export const people = value => Number.isFinite(value) ? number(value, 0) : '—';
export const metricFormat = (value, metric) => metric === 'viewers' || metric.endsWith('Viewers') ? people(value) : number(value, metric === 'durationMin' || metric.includes('etention') ? 1 : 2);
export const groupLabel = (group, dimension) => dimension === 'weekday' ? WEEKDAYS[Number(group.label) - 1] : dimension === 'date' ? dateLabel(group.label, true) : group.label;
export const pill = row => `<span class="badge ${row.source === 'grid_10min' ? 'approx' : 'exact'}">${sourceName(row.source)}</span>`;

export function cellValue(row, key, annotations = {}, html = true) {
  const text = value => html ? e(value) : value ?? '';
  if (key === 'dateISO') return html ? `${dateLabel(row.dateISO)}<span class="sub">${WEEKDAYS[row.dayOfWeek - 1]}</span>` : row.dateISO;
  if (key === 'startSec') return html ? `${timeLabel(row.startSec)}<span class="sub">до ${timeLabel(row.endSec)}</span>` : preciseTimeLabel(row.startSec);
  if (key === 'title') return html ? `<span class="cell-title" title="${e(row.title)}">${e(row.title)}</span>` : row.title;
  if (key === 'previous' || key === 'next') return row[key] ? html ? `<span class="cell-title" style="font-weight:500;font-size:9px" title="${e(row[key].title)}">${e(row[key].title)}</span><span class="sub">${timeLabel(row[key].startSec)} · ${number(row[key].share)}%</span>` : `${row[key].title} | Share=${row[key].share ?? ''}` : html ? '—' : '';
  if (key === 'source') return html ? pill(row) : row.source;
  if (key === 'label') return text(LABELS[annotations[row.id]?.label || 'unmarked']);
  if (key === 'note') return text(annotations[row.id]?.note || '');
  if (Object.hasOwn(FIELD_LABELS, key)) return html ? metricFormat(row[key], key) : row[key] ?? '';
  return text(row[key]);
}

export function renderRecords(element, rows, workspace, { pageSize = 50 } = {}) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize)), page = Math.min(workspace.page, pages), slice = rows.slice((page - 1) * pageSize, page * pageSize), selected = new Set(workspace.selectedIds);
  const scroll = element.parentElement, left = scroll.scrollLeft, top = scroll.scrollTop, focus = element.contains(document.activeElement) ? document.activeElement.id : null;
  const checked = slice.length && slice.every(row => selected.has(row.id));
  element.innerHTML = `<thead><tr><th><input id="select-page" type="checkbox" ${checked ? 'checked' : ''} aria-label="Отметить страницу"></th>${workspace.columns.map(key => `<th>${COLUMNS[key]}</th>`).join('')}</tr></thead><tbody>${slice.length ? slice.map(row => `<tr data-row="${e(row.id)}" tabindex="0" aria-label="${e(row.title)} ${row.dateISO} ${timeLabel(row.startSec)}" class="${workspace.focusedId === row.id ? 'focused' : ''} ${selected.has(row.id) ? 'selected' : ''}"><td><input id="select-${e(row.id)}" type="checkbox" data-select-row="${e(row.id)}" ${selected.has(row.id) ? 'checked' : ''} aria-label="Отметить ${e(row.title)} ${row.dateISO} ${timeLabel(row.startSec)}"></td>${workspace.columns.map(key => `<td class="${Object.hasOwn(FIELD_LABELS, key) ? 'numeric' : ''}">${cellValue(row, key, workspace.annotations)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${workspace.columns.length + 1}" class="empty">${workspace.query.audience === '25-34' ? 'Программные измерения 25–34 отсутствуют в этих отчётах. Дневные показатели доступны в сравнении периодов.' : 'Нет записей по этим условиям. Расширьте время или снимите часть фильтров.'}</td></tr>`}</tbody>`;
  scroll.scrollLeft = left; scroll.scrollTop = top;
  if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
  return { page, pages, slice, total: rows.length, from: slice.length ? (page - 1) * pageSize + 1 : 0, to: (page - 1) * pageSize + slice.length };
}

export function pagination(element, result, action = 'page') {
  element.innerHTML = `<span>${result.from ?? 0}–${result.to ?? 0} из ${result.total}</span><div><button class="icon-button" data-${action}="${result.page - 1}" ${result.page <= 1 ? 'disabled' : ''} aria-label="Предыдущая страница">←</button><span>${result.page} / ${result.pages}</span><button class="icon-button" data-${action}="${result.page + 1}" ${result.page >= result.pages ? 'disabled' : ''} aria-label="Следующая страница">→</button></div>`;
}

export function recordsCSV(rows, workspace) {
  return [['Аудитория', workspace.query.audience, 'Окно', preciseTimeLabel(workspace.query.startSec), preciseTimeLabel(workspace.query.endSec), 'Режим окна', workspace.query.timeMode],
    ['ID', ...workspace.columns.map(key => COLUMNS[key]), 'Конец', 'Источник'], ...rows.map(row => [row.id, ...workspace.columns.map(key => cellValue(row, key, workspace.annotations, false)), preciseTimeLabel(row.endSec), row.source])];
}

export function renderTimeline(element, rows, workspace, onFocus) {
  const pageSize = 100, pages = Math.max(1, Math.ceil(rows.length / pageSize)), page = Math.min(workspace.page, pages), slice = rows.slice((page - 1) * pageSize, page * pageSize);
  const lanes = [...new Set(slice.map(row => `${row.dateISO}\0${row.channel}`))].sort();
  element.style.height = `${Math.max(350, Math.min(780, lanes.length * 30 + 100))}px`;
  const selected = new Set(workspace.selectedIds);
  renderChart(element, {
    tooltip: { renderMode: 'richText', confine: true, formatter: params => `${params.value[3]}\n${params.value[6]}\n${timeLabel(params.value[1])}–${timeLabel(params.value[2])}\nДоля ${number(params.value[4])}% · ${sourceName(params.value[7])}` },
    grid: { left: slice.some(row => row.channel !== slice[0]?.channel) ? 150 : 75, right: 20, top: 20, bottom: 65 },
    xAxis: { type: 'value', min: workspace.query.startSec, max: Math.max(workspace.query.endSec, ...slice.map(row => row.endSec)), axisLabel: { formatter: timeLabel, fontSize: 9 }, splitLine: { lineStyle: { color: '#edf1f7' } } },
    yAxis: { type: 'category', inverse: true, data: lanes.map(key => { const [date, channel] = key.split('\0'); return `${dateLabel(date)}${slice.some(row => row.channel !== slice[0]?.channel) ? ` ${channel}` : ''}`; }), axisLabel: { fontSize: 8 }, axisTick: { show: false }, axisLine: { show: false } },
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }, { type: 'slider', bottom: 8, height: 18, xAxisIndex: 0 }],
    series: [{ type: 'custom', encode: { x: [1, 2], y: 0 }, data: slice.map(row => ({ value: [lanes.indexOf(`${row.dateISO}\0${row.channel}`), row.startSec, row.endSec, row.title, row.share, row.id, row.channel, row.source], itemStyle: { color: row.id === workspace.focusedId ? '#365fe3' : selected.has(row.id) ? '#6b8fe8' : row.approximate ? '#c7d4ec' : '#87a1d4' } })),
      renderItem(params, api) { const start = api.coord([api.value(1), api.value(0)]), end = api.coord([api.value(2), api.value(0)]), height = Math.min(22, api.size([0, 1])[1] * .7);
        const shape = globalThis.echarts.graphic.clipRectByRect({ x: start[0], y: start[1] - height / 2, width: Math.max(2, end[0] - start[0]), height }, params.coordSys);
        if (!shape) return null;
        return { type: 'group', children: [{ type: 'rect', shape: { ...shape, r: 2 }, style: { fill: api.visual('color'), stroke: '#fff', lineWidth: 1 } }, ...(shape.width > 90 ? [{ type: 'text', style: { x: shape.x + 5, y: shape.y + height / 2, text: api.value(3), fill: '#fff', fontSize: 9, width: shape.width - 10, overflow: 'truncate', verticalAlign: 'middle' } }] : [])] };
      } }],
  }, params => onFocus(params.value?.[5]));
  return { page, pages, slice, total: rows.length, from: slice.length ? (page - 1) * pageSize + 1 : 0, to: (page - 1) * pageSize + slice.length };
}

export function renderGroups(element, table, groups, { metric, groupBy }, onFocus) {
  element.style.height = '365px';
  const displayed = groups.slice(0, 120);
  renderChart(element, {
    color: ['#6284dc', '#d3a17a'], tooltip: { trigger: 'axis', renderMode: 'richText', confine: true }, legend: { bottom: 0 },
    grid: { left: metric === 'viewers' ? 65 : 45, right: 16, top: 30, bottom: 80 },
    xAxis: { type: 'category', data: displayed.map(group => `${groupLabel(group, groupBy)}${new Set(displayed.map(row => row.channel)).size > 1 ? ` · ${group.channel}` : ''}`), axisLabel: { fontSize: 8, rotate: displayed.length > 8 ? 30 : 0 } },
    yAxis: { type: 'value', name: FIELD_LABELS[metric], nameTextStyle: { fontSize: 9 }, splitLine: { lineStyle: { color: '#edf1f7' } } },
    dataZoom: displayed.length > 15 ? [{ type: 'inside' }] : [],
    series: ['program_logs', 'grid_10min'].map(source => ({ name: sourceName(source), type: 'bar', barMaxWidth: 26, data: displayed.map(group => group.source === source ? group.value : null) })),
  }, params => onFocus?.(displayed[params.dataIndex]?.rows[0]?.id));
  table.innerHTML = `<thead><tr><th>Группа</th><th>Канал / источник</th><th>${FIELD_LABELS[metric]}</th><th>Измерения / выходы</th><th>Дни</th></tr></thead><tbody>${groups.length ? groups.map(group => `<tr><td>${e(groupLabel(group, groupBy))}</td><td>${e(group.channel)}<span class="sub">${sourceName(group.source)} · ${group.audience}</span></td><td class="numeric">${metricFormat(group.value, metric)}</td><td>${group.measured} / ${group.count}</td><td>${group.days}</td></tr>`).join('') : '<tr><td class="empty" colspan="5">Нет доступных измерений.</td></tr>'}</tbody>`;
}

export function renderCohorts(element, table, a, b, workspace) {
  const mapA = new Map(a.map(group => [group.key, group])), mapB = new Map(b.map(group => [group.key, group]));
  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])], displayed = keys.slice(0, 100);
  const nameA = workspace.cohorts.A?.name || 'A', nameB = workspace.cohorts.B?.name || 'B';
  renderChart(element, { color: ['#6284dc', '#d3a17a'], tooltip: { trigger: 'axis', renderMode: 'richText', confine: true }, legend: { bottom: 0, type: 'scroll' }, grid: { left: workspace.metric === 'viewers' ? 65 : 45, right: 16, top: 30, bottom: 85 },
    xAxis: { type: 'category', data: displayed.map(key => { const group = mapA.get(key) ?? mapB.get(key); return `${groupLabel(group, workspace.groupBy)} · ${sourceName(group.source)}${new Set([...a, ...b].map(row => row.channel)).size > 1 ? ` ${group.channel}` : ''}`; }), axisLabel: { fontSize: 8, rotate: displayed.length > 6 ? 25 : 0 } },
    yAxis: { type: 'value', name: FIELD_LABELS[workspace.metric], nameTextStyle: { fontSize: 9 }, splitLine: { lineStyle: { color: '#edf1f7' } } },
    series: [{ name: `A · ${nameA}`, type: 'bar', barMaxWidth: 23, data: displayed.map(key => mapA.get(key)?.value ?? null) }, { name: `B · ${nameB}`, type: 'bar', barMaxWidth: 23, data: displayed.map(key => mapB.get(key)?.value ?? null) }],
  });
  table.innerHTML = `<thead><tr><th>Группа / канал</th><th>Источник</th><th>A</th><th>n A</th><th>B</th><th>n B</th><th>Δ A − B</th></tr></thead><tbody>${keys.length ? keys.map(key => {
    const ga = mapA.get(key), gb = mapB.get(key), group = ga ?? gb, delta = ga?.value != null && gb?.value != null ? ga.value - gb.value : null;
    return `<tr><td>${e(groupLabel(group, workspace.groupBy))}<span class="sub">${e(group.channel)} · ${group.audience}</span></td><td>${sourceName(group.source)}</td><td class="numeric">${metricFormat(ga?.value, workspace.metric)}</td><td>${ga?.measured ?? 0}/${ga?.count ?? 0}</td><td class="numeric">${metricFormat(gb?.value, workspace.metric)}</td><td>${gb?.measured ?? 0}/${gb?.count ?? 0}</td><td class="numeric">${metricFormat(delta, workspace.metric)}</td></tr>`;
  }).join('') : '<tr><td class="empty" colspan="7">Закрепите набор A и набор B из выборки или отмеченных выходов.</td></tr>'}</tbody>`;
  return [['Показатель', FIELD_LABELS[workspace.metric], 'Расчёт', workspace.statistic, 'Группировка', workspace.groupBy, 'A', nameA, 'B', nameB], ['Группа', 'Канал', 'Аудитория', 'Источник', 'A', 'Измерения A', 'Выходы A', 'B', 'Измерения B', 'Выходы B'], ...keys.map(key => { const ga = mapA.get(key), gb = mapB.get(key), group = ga ?? gb; return [group.label, group.channel, group.audience, group.source, ga?.value, ga?.measured, ga?.count, gb?.value, gb?.measured, gb?.count]; })];
}

export function renderInspector(element, row, workspace, { inScope, provenance }) {
  const annotation = workspace.annotations[row.id] ?? { label: '', note: '' };
  const flow = (p, direction, viewers) => `<div class="flow-item"><span>${direction}</span>${p ? `<button data-focus="${e(p.id)}">${e(p.title)}</button><small>${timeLabel(p.startSec)}–${timeLabel(p.endSec)} · ${number(p.share)}% · ${people(viewers)} чел.</small>` : '<small>Нет соседней программы с перерывом до 10 минут</small>'}</div>`;
  const segments = Object.entries(row.demographics?.segments ?? {});
  element.innerHTML = `${!inScope ? '<p class="out-of-scope">Этот выход вне текущей выборки.</p>' : ''}<p class="record-channel">${e(row.channel)} · ${row.audience}</p><h3 class="record-title">${e(row.title)}</h3><p class="record-time">${dateLabel(row.dateISO, true)} · ${WEEKDAYS[row.dayOfWeek - 1]}<br>${row.approximate ? timeLabel(row.startSec) : preciseTimeLabel(row.startSec)}–${row.approximate ? timeLabel(row.endSec) : preciseTimeLabel(row.endSec)} · ${number(row.durationMin, 1)} мин</p>${pill(row)}<div class="record-metrics"><div><span>Доля</span><b>${number(row.share)}<small>%</small></b></div><div><span>Средние зрители</span><b>${people(row.viewers)}</b><small> чел.</small></div><div><span>Удержание входа</span><b>${number(row.retention, 0)}<small>%</small></b></div><div><span>Удержание выхода</span><b>${number(row.outRetention, 0)}<small>%</small></b></div></div>${flow(row.previous, 'ДО ПРОГРАММЫ', row.previousViewers)}${flow(row.next, 'ПОСЛЕ ПРОГРАММЫ', row.nextViewers)}<button data-pattern-focus="${e(row.id)}" class="text-button">Проверить повторяемость этого времени ↗</button><div class="annotation-editor"><label>Метка выхода<select id="annotation-label"><option value="">Без метки</option>${Object.entries(LABELS).filter(([key]) => key !== 'unmarked').map(([key, label]) => `<option value="${key}" ${annotation.label === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Заметка<textarea id="annotation-note" maxlength="2000" placeholder="Что нужно учесть при сравнении">${e(annotation.note)}</textarea></label><button id="save-annotation" class="button quiet">Сохранить заметку</button></div><details><summary>Аудитория по полу и возрасту</summary>${segments.length ? segments.map(([name, value]) => `<div class="demographic"><span>${e(name.replace('M ', 'М ').replace('W ', 'Ж '))}</span><b>${people(Number.isFinite(value) ? value * 1000 : null)} чел.</b></div>`).join('') : '<p class="field-note">Демография этого выхода отсутствует. Число зрителей из доли не восстанавливается.</p>'}</details><details><summary>Источник и точность</summary><p class="provenance">${row.approximate ? 'Границы восстановлены по сетке с шагом 10 минут.' : 'Точные границы из TOP. Показатели — средние программы.'}<br>ID: ${e(row.id)}<br>${provenance ? [...new Set(Object.values(provenance).map(item => `${item.sheet || 'источник'} · отчёт ${item.reportDateISO || ''}`))].map(e).join('<br>') : 'Источник: ' + sourceName(row.source)}</p></details>`;
}

export function renderContext(element, competitorsElement, index, row, workspace, startSec, endSec) {
  const channels = [row.channel, ...workspace.competitors.filter(channel => channel !== row.channel)], series = [];
  for (const channel of channels) {
    const key = `${row.dateISO}\0${channel}\0${row.audience}`, exact = index.exact.get(key) ?? [], grid = index.grid.get(key) ?? [];
    const a = measureWindow(exact, startSec, endSec), b = measureWindow(grid, startSec, endSec), useExact = !a.conflictSeconds && (a.coverageFraction >= .9 || a.coverageFraction >= b.coverageFraction);
    const rows = (useExact ? exact : grid).filter(p => p.startSec < endSec && p.endSec > startSec && Number.isFinite(p.share)).sort((a, b) => a.startSec - b.startSec);
    const points = rows.flatMap(p => [[Math.max(startSec, p.startSec), p.share], [Math.min(endSec, p.endSec), p.share], [Math.min(endSec, p.endSec), null]]);
    if (points.length) series.push({ name: `${channel}${useExact ? '' : ' ≈'}`, type: 'line', data: points, showSymbol: false, connectNulls: false, lineStyle: { width: channel === row.channel ? 2.5 : 1.2 }, markArea: channel === row.channel ? { silent: true, itemStyle: { color: '#365fe309' }, data: [[{ xAxis: row.startSec }, { xAxis: row.endSec }]] } : undefined });
  }
  renderChart(element, { tooltip: { trigger: 'axis', renderMode: 'richText', confine: true }, legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 8 }, itemWidth: 10 }, grid: { left: 30, right: 10, top: 15, bottom: 45 }, xAxis: { type: 'value', min: startSec, max: endSec, axisLabel: { formatter: timeLabel, fontSize: 8 } }, yAxis: { type: 'value', axisLabel: { fontSize: 8 }, splitLine: { lineStyle: { color: '#edf1f7' } } }, dataZoom: [{ type: 'inside' }], series });
  const context = describeAiring(index, { ...row, startSec, endSec }, { competitors: workspace.competitors });
  competitorsElement.innerHTML = `<p class="field-note">Конкуренты в окне ${timeLabel(startSec)}–${timeLabel(endSec)}</p>${context.competitors.filter(p => !p.missing).map(p => `<div class="context-competitor"><strong>${e(p.channel)} <b>${number(p.share)}%</b></strong>${p.programmes.map(program => `<p>${e(program.title)}<br>${timeLabel(program.startSec)}–${timeLabel(program.endSec)}</p>`).join('')}<small>${sourceName(p.source)} · покрытие ${number(p.coverageFraction * 100, 0)}%</small></div>`).join('') || '<p class="field-note">Нет данных конкурентов для этого окна.</p>'}`;
}

