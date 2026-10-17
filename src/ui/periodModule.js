import { comparePeriods, audienceKey, channelMetrics } from '../analytics/comparator.js';
import { dateDimensions } from '../core/normalization.js';
import { renderComparison, disposeChart, DAY_CURVE_COLORS } from './charts.js';
import { escapeHTML as e, dateLabel, number, metricValue, METRIC_LABELS, UNITS, WEEKDAYS, WEEKDAY_NAMES, timeLabel, csvContent } from './format.js';

const MODES = { week: 'Недели', dayOfWeek: 'Дни недели', season: 'Сезоны', year: 'Годы' };
const SEASONS = { winter: 'Зима', spring: 'Весна', summer: 'Лето', autumn: 'Осень' };
const METRICS = ['share', 'rtg', 'reach', 'atsMin'];
const finite = value => typeof value === 'number' && Number.isFinite(value);

function periodChoices(daily, mode) {
  const map = new Map();
  for (const row of daily) {
    const id = mode === 'week' ? `${row.isoWeekYear}-W${row.isoWeek}` : mode === 'season' ? `${row.seasonYear}-${row.season}` : String(row.year);
    const value = mode === 'week' ? { isoWeekYear: row.isoWeekYear, isoWeek: row.isoWeek } : mode === 'season' ? { seasonYear: row.seasonYear, season: row.season } : { year: row.year };
    const order = mode === 'week' ? row.isoWeekYear * 100 + row.isoWeek : mode === 'season' ? row.seasonYear * 4 + Object.keys(SEASONS).indexOf(row.season) : row.year;
    if (!map.has(id)) map.set(id, { id, value, order, dates: [], label: mode === 'week' ? `${row.isoWeekYear} · неделя ${row.isoWeek}` : mode === 'season' ? `${SEASONS[row.season]} ${row.seasonYear}` : String(row.year) });
    map.get(id).dates.push(row.dateISO);
  }
  return [...map.values()].sort((a, b) => b.order - a.order).map(item => {
    const dates = [...new Set(item.dates)].sort();
    return { ...item, label: `${item.label} (${dateLabel(dates[0])} — ${dateLabel(dates.at(-1))})` };
  });
}

function profileStats(summary, metric) {
  const countKey = metric === 'share' ? 'shareCount' : 'rtgCount';
  const counts = summary.slots.map(row => row[countKey]).filter(count => count > 0);
  return { measuredSlots: counts.length, observations: counts.reduce((sum, value) => sum + value, 0), minDays: counts.length ? Math.min(...counts) : 0, maxDays: counts.length ? Math.max(...counts) : 0 };
}

function formatDeltaBadge(delta, digits = 2, unit = 'п.п.') {
  if (!finite(delta)) return '—';
  const rounded = Number(delta.toFixed(digits));
  const cls = rounded > 0 ? 'delta-positive' : rounded < 0 ? 'delta-negative' : '';
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return `<span class="${cls}">${sign}${number(Math.abs(rounded), digits)} ${unit}</span>`;
}

/** Self-contained comparison section. CSV is a ready-to-download UTF-8 string. */
export function createPeriodModule(container, { onError = () => {} } = {}) {
  if (!container?.addEventListener) throw new Error('Не указан контейнер сравнения периодов');
  let data = { daily_metrics: [], grid_10min: [] }, comparison = null, groups = [], chartElement = null, disposed = false;
  const state = { mode: 'week', audience: '18-54', metric: 'share', view: 'daily', dayOfWeek: 4, from: '', to: '', excludeNonWorkdays: false, customCurveDates: null, periods: { week: {}, season: {}, year: {} } };
  const find = name => container.querySelector(`[data-period-${name}]`);

  function renderExtraTables(groups, metric, weekday) {
    const digits = metric === 'atsMin' || metric === 'reach' ? 1 : 2;
    const unit = metric === 'atsMin' ? 'мин' : 'п.п.';
    const compNames = [...new Set(groups.flatMap(g => Object.keys(g.summary.competitorsDaily ?? {})))].filter(name => groups.some(g => finite(g.summary.competitorsDaily?.[name]?.[metric])));
    compNames.sort((a, b) => (groups[0].summary.competitorsDaily?.[b]?.[metric] ?? -1) - (groups[0].summary.competitorsDaily?.[a]?.[metric] ?? -1));
    const regionNames = [...new Set(groups.flatMap(g => Object.keys(g.summary.regions ?? {})))];

    if (!compNames.length && !regionNames.length) return '';

    const compTable = compNames.length ? `<div><h4>Конкуренты · ${METRIC_LABELS[metric]}, ${UNITS[metric]}</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>Канал</th>${groups.map(g => `<th>${e(g.key)}</th>`).join('')}${!weekday ? '<th>Разница A − B</th>' : ''}</tr></thead><tbody>${compNames.map(channel => {
      const valA = groups[0]?.summary.competitorsDaily?.[channel]?.[metric];
      const valB = groups[1]?.summary.competitorsDaily?.[channel]?.[metric];
      const delta = finite(valA) && finite(valB) ? valA - valB : null;
      return `<tr><td><strong>${e(channel)}</strong></td>${groups.map(g => `<td class="number">${number(g.summary.competitorsDaily?.[channel]?.[metric], digits)}</td>`).join('')}${!weekday ? `<td class="number">${formatDeltaBadge(delta, digits, unit)}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div></div>` : '';

    const regionTable = regionNames.length ? `<div><h4>Регионы FTV · ${state.audience}</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>Регион</th>${groups.map(g => `<th>${e(g.key)} (${METRIC_LABELS[metric]})</th><th>Вклад % (${e(g.key)})</th>`).join('')}${!weekday ? '<th>Δ показателя</th>' : ''}</tr></thead><tbody>${regionNames.map(region => {
      const regA = groups[0]?.summary.regions?.[region];
      const regB = groups[1]?.summary.regions?.[region];
      const delta = finite(regA?.[metric]) && finite(regB?.[metric]) ? regA[metric] - regB[metric] : null;
      return `<tr><td><strong>${e(region)}</strong></td>${groups.map(g => `<td class="number">${number(g.summary.regions?.[region]?.[metric], digits)}</td><td class="number">${number(g.summary.regions?.[region]?.contribution, 1)}%</td>`).join('')}${!weekday ? `<td class="number">${formatDeltaBadge(delta, digits, unit)}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div></div>` : '';

    return `<details data-period-extra><summary>Конкуренты и регионы в выбранном периоде</summary><div class="period-extra-grid">${compTable}${regionTable}</div></details>`;
  }

  function render(nextData) {
    if (disposed) return;
    try {
      if (nextData) data = { ...nextData, daily_metrics: (nextData.daily_metrics ?? []).map(row => ({ ...dateDimensions(row.dateISO), ...row })), grid_10min: nextData.grid_10min ?? [] };
      if (chartElement) disposeChart(chartElement);
      comparison = null; groups = [];
      const weekday = state.mode === 'dayOfWeek', choices = weekday ? [] : periodChoices(data.daily_metrics, state.mode);
      const selection = state.periods[state.mode];
      if (!weekday) {
        if (!choices.some(item => item.id === selection.a)) selection.a = choices[0]?.id ?? '';
        if (!choices.some(item => item.id === selection.b)) selection.b = choices[1]?.id ?? choices[0]?.id ?? '';
      }
      const profileAllowed = state.audience === '18-54' && ['share', 'rtg'].includes(state.metric);
      if (!profileAllowed) state.view = 'daily';
      const option = (value, label, selected) => `<option value="${e(value)}"${selected === value ? ' selected' : ''}>${e(label)}</option>`;
      const buttons = (values, field, selected) => Object.entries(values).map(([value, label]) => `<button type="button" class="button secondary${String(selected) === value ? ' is-active' : ''}" data-period-${field}="${value}" aria-pressed="${String(selected) === value}">${label}</button>`).join('');
      container.innerHTML = `<section class="panel">
        <div class="module-controls"><div class="segmented" role="group" aria-label="Режим сравнения">${buttons(MODES, 'mode', state.mode)}</div><label class="checkbox-field"><input type="checkbox" data-period-field="excludeNonWorkdays"${state.excludeNonWorkdays ? ' checked' : ''}>Только рабочие дни</label></div>
        <div class="module-controls">
          ${weekday ? `<label class="field">С даты<input type="date" data-period-field="from" value="${e(state.from)}"></label><label class="field">По дату<input type="date" data-period-field="to" value="${e(state.to)}"></label><div class="field"><span>День недели</span><div class="segmented" role="group" aria-label="День недели">${buttons(Object.fromEntries(WEEKDAYS.map((name, i) => [i + 1, name])), 'weekday', state.dayOfWeek)}</div></div>` : ['a', 'b'].map(key => `<label class="field">Период ${key.toUpperCase()}<select data-period-field="${key}"${!choices.length ? ' disabled' : ''}>${choices.length ? choices.map(item => option(item.id, item.label, selection[key])).join('') : '<option>Нет данных</option>'}</select></label>`).join('')}
          ${weekday ? '' : `<button type="button" class="button secondary" data-period-swap${choices.length < 2 || selection.a === selection.b ? ' disabled' : ''} aria-label="Поменять периоды A и B местами">Поменять A/B</button>`}
          <label class="field">Аудитория<select data-period-field="audience">${['18-54', '25-34'].map(value => option(value, value, state.audience)).join('')}</select></label>
          <label class="field">Показатель<select data-period-field="metric">${METRICS.map(value => option(value, `${METRIC_LABELS[value]}, ${UNITS[value]}`, state.metric)).join('')}</select></label>
        </div>
        <div class="module-controls"><div class="segmented" role="group" aria-label="Представление сравнения">${buttons({ daily: 'Дневные показатели' }, 'view', state.view)}<button type="button" class="button secondary${state.view === 'slots' ? ' is-active' : ''}" data-period-view="slots" aria-pressed="${state.view === 'slots'}"${profileAllowed ? '' : ' disabled'}>Профиль эфира</button><button type="button" class="button secondary${state.view === 'dayparts' ? ' is-active' : ''}" data-period-view="dayparts" aria-pressed="${state.view === 'dayparts'}"${profileAllowed ? '' : ' disabled'}>По тайм-блокам</button></div></div>
        <p class="module-note" data-period-scope></p>
        <div data-period-summary class="module-controls period-summary"></div>
        <div data-period-curves class="curve-picker" hidden></div>
        <div class="chart" data-period-chart role="img" aria-label="График сравнения периодов"></div>
        <p class="module-note" data-period-note></p>
        <div data-period-extra-wrap></div>
        <details data-period-details><summary>Даты и показатели в сравнении</summary><div class="table-wrap" data-period-table></div></details>
      </section>`;
      chartElement = find('chart');
      if (!data.daily_metrics.length) {
        find('scope').textContent = 'Загрузите Excel-отчёты в разделе «Данные». Здесь можно сравнить недели, одинаковые дни недели, сезоны и годы.';
        chartElement.hidden = true; find('details').hidden = true; return;
      }
      const periodA = choices.find(item => item.id === selection?.a), periodB = choices.find(item => item.id === selection?.b);
      const source = weekday ? { ...data, daily_metrics: data.daily_metrics.filter(row => (!state.from || row.dateISO >= state.from) && (!state.to || row.dateISO <= state.to)) } : data;
      comparison = comparePeriods(source, { mode: state.mode, periodA: periodA?.value, periodB: periodB?.value, audience: state.audience, excludeNonWorkdays: state.excludeNonWorkdays, ...(weekday ? { dayOfWeek: state.dayOfWeek } : {}) });
      groups = weekday ? [{ key: 'A', label: `Все ${WEEKDAY_NAMES[state.dayOfWeek - 1]}`, summary: comparison.summary }] : [
        { key: 'A', label: `A · ${periodA.label}`, summary: comparison.current },
        { key: 'B', label: `B · ${periodB.label}`, summary: comparison.baseline },
      ];
      const metric = state.metric, byDate = new Map(data.daily_metrics.map(row => [row.dateISO, row]));
      const scopedDescription = weekday ? `Все ${WEEKDAY_NAMES[state.dayOfWeek - 1]}${state.from ? ` с ${dateLabel(state.from, true)}` : ''}${state.to ? ` по ${dateLabel(state.to, true)}` : ''}` : `${MODES[state.mode]} A и B`;
      find('scope').textContent = `${scopedDescription} · FTV (UZ/RU) · ${state.audience}${state.excludeNonWorkdays ? ' · только рабочие дни' : ''}. ${!profileAllowed ? 'Профиль эфира доступен для доли и рейтинга аудитории 18–54; для выбранного показателя доступны дневные данные.' : 'Сравнение за целые эфирные сутки, 05:00–29:00.'}`;
      find('summary').innerHTML = groups.map(({ label, summary }) => {
        if (state.view === 'daily') {
          const { mean, count } = summary.daily[metric], missing = summary.dayCount - count;
          return `<div><strong>${e(label)}</strong><p>${metricValue(mean, metric)}</p><p>${count} измерений / ${summary.dayCount} загруженных дней${missing ? ` · ${missing} без показателя` : ''}</p></div>`;
        }
        const stats = profileStats(summary, metric);
        return `<div><strong>${e(label)}</strong><p>Сетка: ${summary.gridDayCount} / ${summary.dayCount} дней · ${stats.measuredSlots} / 144 слотов с показателем · ${stats.observations} измерений</p></div>`;
      }).join('');
      if (!weekday && state.view === 'daily') {
        const delta = comparison.daily[metric].absolute, digits = metric === 'atsMin' || metric === 'reach' ? 1 : 2;
        const rounded = finite(delta) ? Number(delta.toFixed(digits)) : null, unit = metric === 'atsMin' ? 'мин' : 'п.п.';
        const label = finite(rounded) ? `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${number(Math.abs(rounded), digits)} ${unit}` : '—';
        find('summary').insertAdjacentHTML('beforeend', `<div class="period-delta" data-period-delta><strong>Разница A − B</strong><p>${label}</p><p>${finite(delta) ? 'Разница дневных средних' : 'Нужны измерения в обоих периодах'}</p></div>`);
      }

      const availableCurves = weekday && state.view === 'slots'
        ? comparison.curves.filter(curve => curve.slots.some(slot => finite(slot[metric === 'share' ? 'meanShare' : 'meanRtg'])))
        : [];
      let curves = [];
      if (availableCurves.length) {
        const availableSet = new Set(availableCurves.map(c => c.dateISO));
        const validCustom = Array.isArray(state.customCurveDates) ? state.customCurveDates.filter(d => availableSet.has(d)) : null;
        const activeDates = validCustom && validCustom.length ? validCustom : availableCurves.slice(-5).map(c => c.dateISO);
        const activeSet = new Set(activeDates);
        curves = availableCurves.filter(c => activeSet.has(c.dateISO));
        const curvePicker = find('curves');
        curvePicker.hidden = false;
        curvePicker.innerHTML = `<span class="curve-picker-label">Даты на графике:</span><div class="curve-chips">${availableCurves.map(c => {
          const idx = curves.findIndex(item => item.dateISO === c.dateISO);
          const active = idx !== -1;
          const color = active ? DAY_CURVE_COLORS[idx % DAY_CURVE_COLORS.length] : '#cbd5e1';
          return `<button type="button" class="chip curve-chip${active ? ' is-active' : ''}" data-period-curve-date="${c.dateISO}" aria-pressed="${active}"><span class="curve-dot" style="background:${color}"></span>${dateLabel(c.dateISO, true)}</button>`;
        }).join('')}</div><div class="curve-presets"><button type="button" class="text-button" data-period-curves-preset="latest5">Последние 5</button><button type="button" class="text-button" data-period-curves-preset="all">Все (${availableCurves.length})</button></div>`;
      }

      const hasMeasurements = groups.some(({ summary }) => state.view === 'daily' ? summary.daily[metric].count > 0 : profileStats(summary, metric).observations > 0);
      if (hasMeasurements) renderComparison(chartElement, comparison, { metric, chartView: state.view, data: source, curveDates: curves.map(curve => curve.dateISO), labels: groups.map(group => group.label) });
      else { chartElement.hidden = true; find('note').textContent = state.view === 'daily' ? 'В выбранных датах нет измерений этого показателя. Пустые значения не считаются нулём.' : 'Для выбранных дат нет доступных слотов с этим показателем. Дневная история может быть загружена без сетки эфира.'; }
      if (hasMeasurements) {
        const same = !weekday && periodA.id === periodB.id ? 'Выбран один и тот же период A и B. Загрузите другой период или измените выбор. ' : '';
        if (state.view === 'daily') find('note').textContent = `${same}Средние рассчитаны только по дням с измерением. В счётчике указаны загруженные дни; незагруженные даты не учитываются. «—» означает отсутствие данных; нулевые значения сохранены.${state.mode === 'year' && metric === 'reach' ? ' Дневной охват не является уникальным накопленным охватом года.' : ''}`;
        else {
          const stats = groups.map(({ key, summary }) => { const count = profileStats(summary, metric); return `${weekday ? '' : `${key}: `}от ${count.minDays} до ${count.maxDays} дней на доступный слот`; }).join('; ');
          find('note').textContent = `${same}Профиль — 10-минутная сетка со средними показателями программ, не поминутный замер. ${stats}.${weekday && state.view === 'slots' ? ` Среднее и медиана — по всем доступным выбранным ${WEEKDAY_NAMES[state.dayOfWeek - 1]}; отдельно показаны ${curves.length} дат с сеткой: ${curves.map(curve => dateLabel(curve.dateISO, true)).join(', ')}.` : ''}`;
        }
      }
      find('extra-wrap').innerHTML = renderExtraTables(groups, metric, weekday);
      const key = audienceKey(state.audience), gridDates = new Set(data.grid_10min.filter(slot => {
        const values = channelMetrics(slot, 'FTV (UZ/RU)', state.audience);
        return finite(values?.share) || finite(values?.rtg);
      }).map(slot => slot.dateISO));
      find('table').innerHTML = `<table class="data-table"><thead><tr><th>Группа</th><th>Дата</th><th>День</th>${METRICS.map(name => `<th>${METRIC_LABELS[name]}, ${UNITS[name]}</th>`).join('')}<th>Данные сетки</th></tr></thead><tbody>${groups.flatMap(group => group.summary.dates.map(date => {
        const row = byDate.get(date), gridAvailable = gridDates.has(date);
        return `<tr><td>${group.key}</td><td>${dateLabel(date, true)}</td><td>${WEEKDAYS[row.dayOfWeek - 1]}</td>${METRICS.map(name => `<td>${number(row[key]?.[name], name === 'atsMin' || name === 'reach' ? 1 : 2)}</td>`).join('')}<td>${gridAvailable ? 'Есть' : 'Нет'}</td></tr>`;
      })).join('') || '<tr><td colspan="8">В выбранном периоде нет дат.</td></tr>'}</tbody></table>`;
    } catch (error) {
      comparison = null; groups = [];
      if (chartElement) { disposeChart(chartElement); chartElement.hidden = true; }
      if (find('note')) find('note').textContent = error.message;
      onError(error);
    }
  }

  function onClick(event) {
    const button = event.target.closest('button');
    if (!button || !container.contains(button) || button.disabled) return;
    if (button.hasAttribute('data-period-swap')) {
      const selection = state.periods[state.mode];
      if (!selection) return;
      [selection.a, selection.b] = [selection.b, selection.a];
    }
    else if (button.dataset.periodMode) { state.mode = button.dataset.periodMode; state.customCurveDates = null; }
    else if (button.dataset.periodWeekday) { state.dayOfWeek = Number(button.dataset.periodWeekday); state.customCurveDates = null; }
    else if (button.dataset.periodView) state.view = button.dataset.periodView;
    else if (button.dataset.periodCurveDate && comparison?.curves) {
      const targetDate = button.dataset.periodCurveDate;
      const meanKey = state.metric === 'share' ? 'meanShare' : 'meanRtg';
      const available = comparison.curves.filter(curve => curve.slots.some(slot => finite(slot[meanKey]))).map(c => c.dateISO);
      const current = Array.isArray(state.customCurveDates) && state.customCurveDates.length ? state.customCurveDates : available.slice(-5);
      const next = current.includes(targetDate) ? current.filter(d => d !== targetDate) : [...current, targetDate].sort();
      if (next.length) state.customCurveDates = next;
    }
    else if (button.dataset.periodCurvesPreset && comparison?.curves) {
      const meanKey = state.metric === 'share' ? 'meanShare' : 'meanRtg';
      const available = comparison.curves.filter(curve => curve.slots.some(slot => finite(slot[meanKey]))).map(c => c.dateISO);
      state.customCurveDates = button.dataset.periodCurvesPreset === 'all' ? available : available.slice(-5);
    }
    else return;
    render();
  }
  function onChange(event) {
    const field = event.target.dataset.periodField;
    if (!field) return;
    if (field === 'excludeNonWorkdays') {
      state.excludeNonWorkdays = Boolean(event.target.checked);
      render();
      return;
    }
    const value = event.target.value;
    if (field === 'a' || field === 'b') state.periods[state.mode][field] = value;
    else {
      if ((field === 'from' && state.to && value > state.to) || (field === 'to' && state.from && value && value < state.from)) {
        event.target.value = state[field]; onError(new Error('Начало периода позже конца')); return;
      }
      state[field] = value;
    }
    render();
  }

  function getCSV() {
    if (!comparison || !groups.some(group => group.summary.dayCount)) return '';
    const rows = [['Режим', MODES[state.mode], 'Канал', 'FTV (UZ/RU)', 'Аудитория', state.audience], ['Представление', state.view === 'slots' ? 'Профиль эфира' : state.view === 'dayparts' ? 'По тайм-блокам' : 'Дневные показатели']];
    if (state.view === 'slots') {
      const meanKey = state.metric === 'share' ? 'meanShare' : 'meanRtg', medianKey = state.metric === 'share' ? 'medianShare' : 'medianRtg', countKey = state.metric === 'share' ? 'shareCount' : 'rtgCount';
      rows.push(['Группа', 'Период', 'Начало слота', 'Конец слота', `Среднее: ${METRIC_LABELS[state.metric]}, ${UNITS[state.metric]}`, 'Медиана', 'Измерений в слоте', 'Дней в периоде', 'Дней с сеткой']);
      for (const group of groups) for (const slot of group.summary.slots) rows.push([group.key, group.label, timeLabel(slot.startSec), timeLabel(slot.endSec), slot[meanKey], slot[medianKey], slot[countKey], group.summary.dayCount, group.summary.gridDayCount]);
      if (state.mode === 'dayOfWeek') {
        const available = comparison.curves.filter(curve => curve.slots.some(slot => finite(slot[meanKey])));
        const activeDates = new Set(Array.isArray(state.customCurveDates) && state.customCurveDates.length ? state.customCurveDates : available.slice(-5).map(curve => curve.dateISO));
        for (const curve of available.filter(item => activeDates.has(item.dateISO))) for (const slot of curve.slots) rows.push(['Дата', curve.dateISO, timeLabel(slot.startSec), timeLabel(slot.endSec), slot[meanKey], slot[medianKey], slot[countKey], 1, 1]);
      }
    } else if (state.view === 'dayparts') {
      rows.push(['Группа', 'Период', 'Тайм-блок', 'Начало', 'Конец', `${METRIC_LABELS[state.metric]}, ${UNITS[state.metric]}`, 'Дней с сеткой']);
      for (const group of groups) for (const part of group.summary.dayparts) rows.push([group.key, group.label, part.label, timeLabel(part.startSec), timeLabel(part.endSec), part[state.metric], part.observedDays]);
    } else {
      const key = audienceKey(state.audience), byDate = new Map(data.daily_metrics.map(row => [row.dateISO, row]));
      rows.push(['Группа', 'Период', 'Дата', 'День недели', ...METRICS.map(metric => `${METRIC_LABELS[metric]}, ${UNITS[metric]}`)]);
      for (const group of groups) for (const date of group.summary.dates) {
        const row = byDate.get(date);
        rows.push([group.key, group.label, date, WEEKDAYS[row.dayOfWeek - 1], ...METRICS.map(metric => row[key]?.[metric])]);
      }
    }
    return csvContent(rows);
  }
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  return { render, getCSV, dispose() { disposed = true; if (chartElement) disposeChart(chartElement); container.removeEventListener('click', onClick); container.removeEventListener('change', onChange); container.replaceChildren(); } };
}
