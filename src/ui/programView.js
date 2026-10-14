import { programNeighbors } from '../analytics/programs.js';
import { calculateRetention } from '../analytics/dropDetector.js';
import { escapeHTML as e, number, dateLabel, timeLabel, preciseTimeLabel, METRIC_LABELS, UNITS } from './format.js';
import { renderProgramHistory, disposeChart } from './charts.js';

export function renderKPIs(element, current, baseline, selectedMetric) {
  element.innerHTML = Object.entries(METRIC_LABELS).map(([metric, label]) => {
    const value = current?.daily[metric]?.mean, base = baseline?.daily[metric]?.mean;
    const delta = Number.isFinite(value) && Number.isFinite(base) ? value - base : null;
    const foot = delta == null ? `${current?.daily[metric]?.count ?? 0} дней с данными` :
      `<span class="delta-pill ${delta < 0 ? 'negative' : ''}">${delta > 0 ? '+' : ''}${number(delta, 2)} ${metric === 'atsMin' ? 'мин' : 'п.п.'}</span><span>к периоду B</span>`;
    return `<button data-metric="${metric}" class="kpi ${selectedMetric === metric ? 'active' : ''}" aria-pressed="${selectedMetric === metric}"><span class="kpi-head">${label}<span class="kpi-icon">${metric === 'atsMin' ? '◷' : '%'}</span></span><div class="kpi-value">${number(value, ['reach', 'atsMin'].includes(metric) ? 1 : 2)} <small>${UNITS[metric]}</small></div><div class="kpi-foot">${foot}</div></button>`;
  }).join('');
}

export function renderProgramTable(element, rows, { catalog = false, page = 1, pageSize = 50, painIds = new Set() } = {}) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize)), currentPage = Math.min(page, pages);
  const slice = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const headers = catalog ? ['Программа / канал', 'Выпуски', 'Средняя доля', 'Средний рейтинг', 'Длительность', 'Последний эфир'] : ['Время', 'Программа / канал', 'Доля', 'Рейтинг', 'Длительность', 'Источник'];
  element.innerHTML = `<thead><tr>${headers.map(title => `<th>${title}</th>`).join('')}</tr></thead><tbody>${slice.length ? slice.map(row => {
    const title = `<span class="program-title">${e(row.title)}</span><span class="program-channel">${e(row.channel)}${painIds.has(row.id) ? ' · <span class="delta-negative">провал слота</span>' : ''}</span>`;
    const cells = catalog ? [title, `${row.count} <span class="muted">/ ${row.dayCount} дн.</span>`, number(row.share), number(row.rtg), `${number(row.durationMin, 0)} мин`, dateLabel(row.lastDate, true)] :
      [`${timeLabel(row.startSec)}<span class="program-channel">до ${timeLabel(row.endSec)}</span>`, title, number(row.share), number(row.rtg), `${number(row.durationMin, 0)} мин`, `<span class="badge ${row.approximate ? 'approx' : 'exact'}">${row.approximate ? '≈ 10 минут' : 'Точное время'}</span>`];
    return `<tr data-program="${e(row.id)}" tabindex="0" aria-label="Открыть программу ${e(row.title)}">${cells.map((cell, index) => `<td class="${[2, 3, 4].includes(index) ? 'numeric' : ''}">${cell}</td>`).join('')}</tr>`;
  }).join('') : '<tr><td colspan="6" class="table-empty">Нет программ по выбранным фильтрам. Измените дату, канал или поисковый запрос.</td></tr>'}</tbody>`;
  return { page: currentPage, pages, from: slice.length ? (currentPage - 1) * pageSize + 1 : 0, to: (currentPage - 1) * pageSize + slice.length };
}

export function renderProgramDetail(element, program, catalog, { scopeRows = catalog, drop } = {}) {
  disposeChart(element.querySelector('#program-history-chart'));
  const { previous, next } = programNeighbors(catalog, program);
  const retention = calculateRetention(program.share, previous?.share), leadOut = calculateRetention(next?.share, program.share);
  const history = scopeRows.filter(row => row.channel === program.channel && row.title === program.title).sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.startSec - b.startSec);
  const flow = row => row ? `<strong>${e(row.title)}</strong><span>${timeLabel(row.startSec)}–${timeLabel(row.endSec)}</span><b>${number(row.share)}%</b>` : '<span>Нет соседней программы</span>';
  const demographics = program.demographics;
  const segments = Object.entries(demographics?.segments ?? {}).filter(([, value]) => Number.isFinite(value));
  const max = Math.max(...segments.map(([, value]) => value), 1);
  const boundaryLabel = program.approximate ? timeLabel : preciseTimeLabel;
  element.innerHTML = `<p class="eyebrow">ПРОГРАММА · ${e(program.channel)}</p><h2>${e(program.title)}</h2><span class="badge ${program.approximate ? 'approx' : 'exact'}">${program.approximate ? 'Восстановлено по 10-минутной сетке' : 'Точные границы из отчёта'}</span><p class="detail-meta">${dateLabel(program.dateISO, true)} · ${boundaryLabel(program.startSec)}–${boundaryLabel(program.endSec)} · ${number(program.durationMin, 1)} мин</p>
    <div class="detail-metrics"><div><span>Доля аудитории</span><b>${number(program.share)}%</b></div><div><span>Рейтинг</span><b>${number(program.rtg)}%</b></div><div><span>Удержание входа</span><b>${number(retention, 0)}%</b></div></div>
    ${drop ? `<p class="notice">Зафиксирован провал слота. Изменение доли: ${number(drop.deltaShare)} п.п. ${drop.demographics?.lostViewers000 != null ? `Потеря аудитории: ${number(drop.demographics.lostViewers000)} тыс.` : ''}</p>` : ''}
    <button class="button secondary" data-investigate="${e(program.id)}">Проверить повторяемость по дням недели ↗</button><section class="detail-section"><h3>Связка эфира</h3><div class="program-flow"><div class="flow-box">${flow(previous)}</div><span class="flow-arrow">→</span><div class="flow-box current">${flow(program)}</div><span class="flow-arrow">→</span><div class="flow-box">${flow(next)}</div></div><p class="chart-footnote">Удержание выхода: ${number(leadOut, 0)}%. Соседи учитываются при перерыве до 10 минут.</p></section>
    <section class="detail-section"><h3>Выпуски за выбранный период · ${history.length}</h3><div id="program-history-chart" class="detail-chart"></div><div class="table-scroll"><table><thead><tr><th>Дата и время</th><th>Доля</th><th>Рейтинг</th><th>Границы</th></tr></thead><tbody>${history.slice(-8).reverse().map(row => `<tr data-program="${e(row.id)}" tabindex="0"><td>${dateLabel(row.dateISO, true)} · ${timeLabel(row.startSec)}</td><td class="numeric">${number(row.share)}%</td><td class="numeric">${number(row.rtg)}%</td><td>${row.approximate ? '≈ 10 мин' : 'Посекундные'}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="detail-section"><h3>Кто смотрел программу</h3>${demographics ? `<p class="muted small">${number(demographics.total, 3)} тыс. зрителей · Мужчины ${number(demographics.male, 3)} · Женщины ${number(demographics.female, 3)}</p>${segments.map(([name, value]) => `<div class="demographic-row"><span>${e(name.replace('M ', 'М ').replace('W ', 'Ж '))}</span><div class="demographic-bar"><span style="width:${value / max * 100}%"></span></div><b>${number(value, 3)}</b></div>`).join('')}` : '<p class="muted small">Демография доступна для точных программ FTV отчётного дня. Импортируйте отчёт за эту дату для подробностей.</p>'}</section>
    ${drop?.competitors.length ? `<section class="detail-section"><h3>Рост конкурентов в это время</h3>${drop.competitors.slice(0, 5).map(row => `<p class="small" style="margin:10px 0"><strong>${e(row.channel)} · +${number(row.deltaShare)} п.п.</strong><br><span class="muted">${e(row.programs.join(', '))}</span></p>`).join('')}<p class="chart-footnote">${e(drop.attributionNote)}</p></section>` : ''}`;
  renderProgramHistory(element.querySelector('#program-history-chart'), history);
}
