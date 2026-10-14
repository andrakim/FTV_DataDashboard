import { db } from './core/db.js';
import { state } from './core/state.js';
import { createImportClient } from './core/importClient.js';
import { DAYPARTS, FTV_CHANNEL } from './core/normalization.js';
import { aggregatePeriod, comparePeriods, filterDailyRecords, audienceKey, mean } from './analytics/comparator.js';
import { detectSlotDrops } from './analytics/dropDetector.js';
import { buildProgramCatalog, filterPrograms, summarizePrograms, programAtSlot } from './analytics/programs.js';
import { analyzeRecurrence } from './analytics/recurrence.js';
import { renderRecurrence } from './ui/recurrenceView.js';
import { createAiringIndex, filterAirings, describeAiring, airingCalendarDays, programmeKey, weekdayOf } from './analytics/airingExplorer.js';
import { renderAiringBrowser, renderAiringComparison, airingsCSV } from './ui/airingView.js';
import { renderDailyTrend, renderComparison, renderProgramTimeline, disposeCharts, disposeChart } from './ui/charts.js';
import { renderGrid, renderPainPoints } from './ui/gridView.js';
import { renderKPIs, renderProgramTable, renderProgramDetail } from './ui/programView.js';
import { escapeHTML as e, number, dateLabel, timeLabel, WEEKDAYS, WEEKDAY_NAMES, METRIC_LABELS, UNITS, csvContent } from './ui/format.js';

const $ = id => document.getElementById(id);
const importer = createImportClient();
let data = { daily_metrics: [], grid_10min: [], program_logs: [] }, catalog = [], workdays = new Map(), catalogById = new Map();
let airingIndex, visibleAirings = [], comparisonExportRows = [];
let scanURL = null, scanKey = '', detailKey = '', pendingRender = false, exportRows = [], dropsLimit = 20;
const cache = new Map();
const seasons = { winter: 'Зима', spring: 'Весна', summer: 'Лето', autumn: 'Осень' };
const preferenceFields = ['view', 'mode', 'audience', 'metric', 'chartView', 'selectedDayOfWeek', 'programLayout', 'programChannel', 'periodA', 'periodB'];
preferenceFields.push('recurrenceMode', 'recurrenceTitle', 'recurrenceChannel', 'recurrenceStart', 'recurrenceEnd', 'recurrenceApproximate', 'recurrenceSignal', 'recurrenceRetention', 'recurrenceBaselineDrop');
preferenceFields.push('programTitle', 'programStart', 'programEnd', 'programWeekday', 'programApproximate', 'programMissingDays', 'programCompetitors');
const pageCopy = {
  overview: ['Обзор', 'Эфир в цифрах', 'Общая картина аудитории и точки для дальнейшего анализа.'],
  comparison: ['Сравнение периодов', 'Сравнивайте сопоставимый эфир', 'Недели, дни недели, сезоны и годы — с понятной базой сравнения.'],
  programs: ['Программы', 'Все выходы одной программы', 'Выберите программу и свои часы. Просматривайте эфир, затем отмечайте выходы для сравнения.'],
  grid: ['Сетка вещания', 'Весь эфир на одной карте', 'Доля аудитории FTV и конкурентов в каждом десятиминутном слоте.'],
  drops: ['Провалы слотов', 'Где теряем аудиторию', 'Слабые стыки программ и одновременный рост конкурентов.'],
  recurrence: ['Закономерности', 'Устойчивая проблема или аномалия?', 'Сравнивайте одну программу или одно время по одинаковым дням недели.'],
};
const options = s => ({ audience: s.audience, from: s.dateFrom, to: s.dateTo, excludeNonWorkdays: s.excludeNonWorkdays });
function memo(key, compute) { if (!cache.has(key)) { if (cache.size >= 20) cache.delete(cache.keys().next().value); cache.set(key, compute()); } return cache.get(key); }
const scopeKey = s => JSON.stringify([s.revision, s.audience, s.dateFrom, s.dateTo, s.excludeNonWorkdays]);
const scopedDaily = s => memo(`daily:${scopeKey(s)}`, () => filterDailyRecords(data.daily_metrics, options(s)));
const summary = s => memo(`summary:${scopeKey(s)}`, () => aggregatePeriod(data, options(s)));
const dropsFor = s => memo(`drops:${scopeKey(s)}`, () => detectSlotDrops(data, options(s)));
const scopedPrograms = s => filterPrograms(catalog, { ...options(s), workdays });
function set(patch) { try { state.setState({ error: null, ...patch }); } catch (error) { state.setState({ error: error.message }); } }
function periodId(mode, row) { return !row ? '' : mode === 'week' ? `${row.isoWeekYear}-W${row.isoWeek}` : mode === 'season' ? `${row.seasonYear}-${row.season}` : String(row.year); }
function periodChoices(mode) {
  const map = new Map();
  for (const row of data.daily_metrics) {
    const value = mode === 'week' ? { isoWeekYear: row.isoWeekYear, isoWeek: row.isoWeek } : mode === 'season' ? { seasonYear: row.seasonYear, season: row.season } : { year: row.year };
    const label = mode === 'week' ? `Неделя ${row.isoWeek} · ${row.isoWeekYear}` : mode === 'season' ? `${seasons[row.season]} · ${row.seasonYear}` : String(row.year);
    map.set(periodId(mode, row), { value, label, order: mode === 'week' ? row.isoWeekYear * 100 + row.isoWeek : mode === 'season' ? row.seasonYear * 4 + ['winter', 'spring', 'summer', 'autumn'].indexOf(row.season) : row.year });
  }
  return [...map.entries()].sort((a, b) => b[1].order - a[1].order);
}
function choosePeriods(mode, s = state.getState()) {
  const list = periodChoices(mode), values = new Map(list);
  return { periodA: values.get(periodId(mode, s.periodA))?.value ?? list[0]?.[1].value ?? null,
    periodB: values.get(periodId(mode, s.periodB))?.value ?? list[1]?.[1].value ?? list[0]?.[1].value ?? null };
}
function availableCurveDates(s) {
  const dates = new Set(scopedDaily(s).filter(row => row.dayOfWeek === s.selectedDayOfWeek).map(row => row.dateISO));
  return [...new Set(data.grid_10min.filter(row => dates.has(row.dateISO) && row.channels?.[FTV_CHANNEL]).map(row => row.dateISO))].sort();
}
function updateScope(patch) {
  try {
  const next = { ...state.getState(), ...patch }, days = filterDailyRecords(data.daily_metrics, options(next));
  const dates = new Set(days.map(row => row.dateISO));
  const selectedDate = dates.has(next.selectedDate) ? next.selectedDate : catalog.find(row => dates.has(row.dateISO))?.dateISO ?? days.at(-1)?.dateISO ?? null;
  set({ ...patch, selectedDate, programPage: 1, selectedProgramId: null, ...(patch.audience ? { programSelectedIds: [], programCompareOpen: false } : {}), curveDates: availableCurveDates(next).slice(-6) });
  } catch (error) { set({ error: error.message }); }
}
function chooseMode(mode) {
  const s = state.getState();
  set({ mode, ...choosePeriods(mode), chartView: mode === 'dayOfWeek' && s.audience === '18-54' && ['share', 'rtg'].includes(s.metric) ? 'slots' : 'daily', curveDates: availableCurveDates(s).slice(-6) });
}
function navigate(view, patch = {}) { set({ view, selectedProgramId: null, ...patch }); history.replaceState(null, '', `#${view}`); }
function openDate(dateISO) { if (dateISO) navigate('programs', { selectedDate: dateISO, programLayout: 'schedule', programPage: 1, programQuery: '' }); }
function browseProgram(programId) {
  const program = catalogById.get(programId); if (!program) return;
  navigate('programs', { programLayout: 'calendar', programTitle: program.title, programChannel: program.channel,
    programStart: 18000, programEnd: 104400, programWeekday: 0, programPage: 1, programSelectedIds: [], programCompareOpen: false });
}
function investigate(programId) {
  const program = catalogById.get(programId); if (!program) return;
  const dayOfWeek = new Date(`${program.dateISO}T00:00:00Z`).getUTCDay() || 7;
  navigate('recurrence', { recurrenceMode: 'program', recurrenceTitle: program.title, recurrenceChannel: program.channel,
    recurrenceStart: Math.max(18000, Math.floor(program.startSec / 600) * 600 - 1800),
    recurrenceEnd: Math.min(104400, Math.ceil(program.startSec / 600) * 600 + 1800), selectedDayOfWeek: dayOfWeek });
}

async function reload() {
  data = await db.loadData(); catalog = buildProgramCatalog(data); catalogById = new Map(catalog.map(row => [row.id, row]));
  airingIndex = createAiringIndex(catalog, data);
  workdays = new Map(data.daily_metrics.map(row => [row.dateISO, row.isWorkday])); cache.clear();
  const dates = new Set(data.daily_metrics.map(row => row.dateISO));
  const channels = [...new Set(catalog.map(row => row.channel))].sort((a, b) => a === FTV_CHANNEL ? -1 : b === FTV_CHANNEL ? 1 : a.localeCompare(b));
  $('program-channel').replaceChildren(new Option('Все каналы', 'all'), ...channels.map(channel => new Option(channel, channel)));
  $('airing-channel').replaceChildren(...channels.map(channel => new Option(channel, channel)));
  $('recurrence-channel').replaceChildren(...channels.map(channel => new Option(channel, channel)));
  const s = state.getState();
  set({ ...choosePeriods(s.mode), revision: s.revision + 1,
    programTitle: s.programTitle || catalog.find(row => row.channel === s.programChannel && row.title.toLowerCase().includes('fresh news'))?.title || catalog.find(row => row.channel === s.programChannel)?.title || '',
    programSelectedIds: s.programSelectedIds.filter(id => catalogById.has(id)),
    recurrenceTitle: s.recurrenceTitle || catalog.find(row => row.channel === s.recurrenceChannel && row.title.toLowerCase().includes('fresh news'))?.title || catalog.find(row => row.channel === s.recurrenceChannel)?.title || '',
    selectedDate: dates.has(s.selectedDate) ? s.selectedDate : catalog[0]?.dateISO ?? data.daily_metrics.at(-1)?.dateISO ?? null,
    programPage: 1, programChannel: channels.includes(s.programChannel) || s.programChannel === 'all' ? s.programChannel : channels[0] ?? FTV_CHANNEL });
}

function renderStatus() {
  const s = state.getState();
  $('status').className = `status-line${s.error ? ' error' : ''}`;
  $('status').textContent = s.error ?? (s.busy ? `Импортируем ${s.importProgress?.name ?? 'отчёты'}…` : data.daily_metrics.length ? `В базе ${data.daily_metrics.length} дней · ${data.grid_10min.length} слотов · ${data.program_logs.length} точных записей программ` : 'Файлы обрабатываются в браузере. История сохраняется автоматически.');
  $('files').disabled = s.busy;
  document.querySelectorAll('[data-upload]').forEach(button => { button.disabled = s.busy; });
  $('import-progress').hidden = !s.busy;
  $('import-progress-count').textContent = `${s.importProgress?.completed ?? 0} / ${s.importProgress?.total ?? 0}`;
  $('import-meter').max = s.importProgress?.total ?? 1; $('import-meter').value = s.importProgress?.completed ?? 0;
}
function syncButtons(selector, attribute, value) {
  document.querySelectorAll(selector).forEach(button => { const active = button.dataset[attribute] === String(value); button.classList.toggle('active', active); button.setAttribute(button.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-pressed', String(active)); });
}
function renderShell(s) {
  renderStatus();
  const [label, title, description] = pageCopy[s.view];
  $('breadcrumb-view').textContent = label; $('page-title').textContent = title; $('page-description').textContent = description;
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === s.view); if (button.dataset.view === s.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== s.view; });
  $('empty-state').hidden = data.daily_metrics.length > 0; $('data-content').hidden = !data.daily_metrics.length;
  $('export').disabled = !data.daily_metrics.length || s.busy;
  $('data-range').textContent = data.daily_metrics.length ? `${dateLabel(data.daily_metrics[0].dateISO)} — ${dateLabel(data.daily_metrics.at(-1).dateISO, true)}` : 'Эфирные сутки 05:00–29:00';
  $('sidebar-dataset').textContent = data.daily_metrics.length ? `${data.daily_metrics.length} дней · ${new Set(data.grid_10min.map(row => row.dateISO)).size} дней с сеткой` : 'Загрузите первый отчёт';
  $('nav-program-count').textContent = catalog.filter(row => row.channel === FTV_CHANNEL).length || '';
  syncButtons('[data-audience]', 'audience', s.audience);
  $('date-from').value = s.dateFrom ?? ''; $('date-to').value = s.dateTo ?? ''; $('workdays').checked = s.excludeNonWorkdays;
  syncButtons('[data-range]', 'range', !s.dateFrom && !s.dateTo ? 'all' : 'custom');
  const needDate = ['grid', 'drops'].includes(s.view) || s.view === 'programs' && s.programLayout === 'schedule';
  $('broadcast-toolbar').hidden = !needDate || !data.daily_metrics.length;
  if (needDate) {
    const days = scopedDaily(s).slice().reverse();
    $('broadcast-date').replaceChildren(...days.map(row => new Option(`${WEEKDAYS[row.dayOfWeek - 1]} · ${dateLabel(row.dateISO, true)}`, row.dateISO)));
    $('broadcast-date').value = s.selectedDate ?? '';
    const i = days.findIndex(row => row.dateISO === s.selectedDate);
    $('previous-date').disabled = i < 0 || i >= days.length - 1; $('next-date').disabled = i <= 0;
    const exact = catalog.filter(row => row.dateISO === s.selectedDate && row.channel === FTV_CHANNEL && !row.approximate).length;
    $('broadcast-coverage').textContent = exact ? `${exact} программ FTV с точным временем` : catalog.some(row => row.dateISO === s.selectedDate && row.channel === FTV_CHANNEL) ? 'Программы восстановлены по 10-минутной сетке' : 'Для этого дня есть только общие метрики';
  }
}

function renderOverview(s) {
  const sum = summary(s), days = scopedDaily(s);
  renderKPIs($('overview-kpis'), sum, null, s.metric);
  $('overview-chart-title').textContent = `${METRIC_LABELS[s.metric]} FTV за период`;
  renderDailyTrend($('overview-chart'), days, { audience: s.audience, metric: s.metric, onClick: openDate });
  const dates = new Set(days.map(row => row.dateISO)), gridDays = new Set(data.grid_10min.filter(row => dates.has(row.dateISO) && row.channels?.[FTV_CHANNEL]).map(row => row.dateISO)).size;
  const exactDays = new Set(catalog.filter(row => dates.has(row.dateISO) && row.channel === FTV_CHANNEL && !row.approximate).map(row => row.dateISO)).size;
  $('coverage').innerHTML = [['История аудитории', days.length, 'Дневные показатели FTV'], ['Подробная сетка', gridDays, 'Профиль эфира каждые 10 минут'], ['Точные программы', exactDays, 'Посекундные границы и демография']].map(([label, count, note]) => `<div class="coverage-item"><span>${label}<small>${note}</small></span><b>${count}<small>дней</small></b></div>`).join('') + `<p class="coverage-note">${s.audience === '25-34' ? 'Для 25–34 доступны дневная история и регионы. Подробные программы и сетка в этих отчётах относятся к 18–54.' : 'История охватывает больше дат, чем подробная сетка. Импортируйте отчёты нужных дней, чтобы дополнить программы.'}</p>`;
  const competitorDays = days.filter(row => Object.values(row.competitorsDaily ?? {}).some(metrics => Number.isFinite(metrics.share) && (metrics.audience ?? '18-54') === s.audience));
  const ranking = Object.entries(sum.competitorsDaily).filter(([name, metrics]) => name !== 'OTHER CHANNELS' && Number.isFinite(metrics.share)).map(([name, metrics]) => ({ name, value: metrics.share }));
  const matchingFTVShare = mean(competitorDays.map(row => row[audienceKey(s.audience)]?.share));
  if (Number.isFinite(matchingFTVShare)) ranking.push({ name: FTV_CHANNEL, value: matchingFTVShare });
  ranking.sort((a, b) => b.value - a.value);
  const displayed = ranking.slice(0, 6); if (!displayed.some(row => row.name === FTV_CHANNEL) && ranking.some(row => row.name === FTV_CHANNEL)) displayed.push(ranking.find(row => row.name === FTV_CHANNEL));
  const max = Math.max(ranking[0]?.value ?? 0, 1);
  $('competitor-ranking').innerHTML = (displayed.length ? displayed.map(row => `<div class="rank-item ${row.name === FTV_CHANNEL ? 'ftv' : ''}"><span class="rank-index">${ranking.indexOf(row) + 1}</span><div><div class="rank-name">${e(row.name)}</div><div class="rank-bar"><span style="width:${row.value / max * 100}%"></span></div></div><span class="rank-value">${number(row.value)}%</span></div>`).join('') : '<p class="muted small">Нет данных конкурентов для выбранной аудитории и периода.</p>') + (competitorDays.length ? `<p class="chart-footnote">FTV и конкуренты сопоставлены по дням с данными конкурентов: ${competitorDays.length}.</p>` : '');
  exportRows = dailyCSV(days, s);
}
function dailyCSV(days, s) { const key = audienceKey(s.audience); return [['Дата', 'Аудитория', 'Доля %', 'Рейтинг %', 'Охват %', 'Время просмотра мин'], ...days.map(row => [row.dateISO, s.audience, ...['share', 'rtg', 'reach', 'atsMin'].map(metric => row[key]?.[metric] ?? '')])]; }

function renderComparisonView(s) {
  const choices = periodChoices(s.mode);
  for (const [id, value] of [['period-a', s.periodA], ['period-b', s.periodB]]) { $(id).replaceChildren(...choices.map(([key, row]) => new Option(row.label, key))); $(id).value = periodId(s.mode, value); }
  syncButtons('#mode-buttons [data-mode]', 'mode', s.mode); syncButtons('[data-chart-view]', 'chartView', s.chartView);
  $('weekday-control').hidden = s.mode !== 'dayOfWeek'; $('period-selectors').hidden = s.mode === 'dayOfWeek';
  $('mode-explanation').textContent = { week: 'Сопоставляем понедельник с понедельником и остальные дни недели. Выберите две недели ниже.', dayOfWeek: 'Сравнивайте одинаковые дни недели. Общий период задаётся в фильтрах сверху.', season: 'Сравниваем средние показатели сезонов. Зима включает декабрь предыдущего года.', year: 'Дневная динамика сгруппирована по месяцам; эфирный профиль — по доступной сетке.' }[s.mode];
  const slotAvailable = s.audience === '18-54' && ['share', 'rtg'].includes(s.metric);
  document.querySelectorAll('[data-chart-view]').forEach(button => { button.disabled = button.dataset.chartView !== 'daily' && !slotAvailable; });
  const result = memo(`compare:${scopeKey(s)}:${JSON.stringify([s.mode, s.periodA, s.periodB, s.selectedDayOfWeek])}`, () => comparePeriods(data, { ...options(s), mode: s.mode, periodA: s.periodA, periodB: s.periodB, dayOfWeek: s.mode === 'dayOfWeek' ? s.selectedDayOfWeek : undefined }));
  const current = result.mode === 'dayOfWeek' ? result.summary : result.current;
  renderKPIs($('comparison-kpis'), current, result.baseline?.daily ? result.baseline : null, s.metric);
  const labels = [new Map(choices).get(periodId(s.mode, s.periodA))?.label ?? 'Период A', new Map(choices).get(periodId(s.mode, s.periodB))?.label ?? 'Период B'];
  if (s.mode === 'dayOfWeek') {
    const days = scopedDaily(s), counts = WEEKDAYS.map((_, i) => days.filter(row => row.dayOfWeek === i + 1).length), available = new Set(availableCurveDates(s));
    $('weekday-buttons').innerHTML = WEEKDAYS.map((label, i) => `<button class="weekday-button ${s.selectedDayOfWeek === i + 1 ? 'active' : ''}" data-weekday="${i + 1}" aria-pressed="${s.selectedDayOfWeek === i + 1}" aria-label="Все ${WEEKDAY_NAMES[i]}"><strong>${label}</strong><span>${counts[i]} дат</span></button>`).join('');
    $('weekday-title').textContent = `Все ${WEEKDAY_NAMES[s.selectedDayOfWeek - 1]} · ${current.dayCount} дат`;
    $('weekday-subtitle').textContent = `Дат с сеткой: ${available.size} · до 6 кривых · дневные метрики по всей группе, эфирный профиль по доступной сетке`;
    $('curve-dates').innerHTML = current.dates.map(date => `<button data-curve="${date}" class="date-chip ${s.curveDates.includes(date) ? 'active' : ''}" aria-pressed="${s.curveDates.includes(date)}" ${!available.has(date) || !slotAvailable ? 'disabled' : ''} title="${available.has(date) ? 'Есть подробная сетка' : 'Есть только дневная сводка'}">${available.has(date) ? '<i></i>' : ''}${dateLabel(date)}</button>`).join('');
    $('select-curves').disabled = !available.size || !slotAvailable;
  }
  $('comparison-title').textContent = `${METRIC_LABELS[s.metric]} · ${s.mode === 'dayOfWeek' ? `все ${WEEKDAY_NAMES[s.selectedDayOfWeek - 1]}` : s.chartView === 'slots' ? 'профиль эфира' : s.chartView === 'dayparts' ? 'тайм-блоки' : 'сравнение периодов'}`;
  $('summary').textContent = `${current.dayCount} дней в ${s.mode === 'dayOfWeek' ? 'группе' : 'периоде A'} · ${current.gridDayCount} дней с сеткой${result.current ? ` · ${result.baseline.dayCount} дней в периоде B` : ''}`;
  $('comparison-note').textContent = !slotAvailable ? 'Охват и время просмотра сравниваются по дням. Сетка и точные программы в отчётах доступны для 18–54.' : s.chartView === 'slots' ? 'Доля каждой программы распределена по десятиминутным слотам. Пропуски означают отсутствие измерений.' : s.mode === 'season' ? 'Средние показатели рассчитаны по доступным дням сезона; количество наблюдений указано выше.' : 'Нулевые измерения учтены. Пропуски данных не заменяются нулями.';
  if (s.mode !== 'dayOfWeek' && periodId(s.mode, s.periodA) === periodId(s.mode, s.periodB)) $('comparison-note').textContent = 'Оба периода совпадают. Импортируйте другие отчёты или выберите другую базу сравнения.';
  renderComparison($('comparison-chart'), result, { metric: s.metric, chartView: slotAvailable ? s.chartView : 'daily', data, curveDates: s.curveDates, labels, onDate: openDate });
  const dates = new Set(current.dates), rows = data.daily_metrics.filter(row => dates.has(row.dateISO)), key = audienceKey(s.audience);
  $('comparison-table-title').textContent = s.mode === 'dayOfWeek' ? 'Каждый выбранный день' : 'Дни периода A';
  $('comparison-table').innerHTML = `<thead><tr><th>Дата</th><th>День</th><th>Доля</th><th>Рейтинг</th><th>Охват</th><th>Время просмотра</th><th>Подробности</th></tr></thead><tbody>${rows.length ? rows.map(row => `<tr data-date="${row.dateISO}" tabindex="0"><td>${dateLabel(row.dateISO, true)}</td><td>${WEEKDAYS[row.dayOfWeek - 1]}</td>${['share', 'rtg', 'reach', 'atsMin'].map(metric => `<td class="numeric">${number(row[key]?.[metric], ['reach', 'atsMin'].includes(metric) ? 1 : 2)} ${UNITS[metric]}</td>`).join('')}<td><span class="badge">${catalog.some(program => program.dateISO === row.dateISO && program.channel === FTV_CHANNEL) ? 'Открыть эфир ↗' : 'Только сводка'}</span></td></tr>`).join('') : '<tr><td colspan="7" class="table-empty">Нет данных для выбранного периода. Расширьте фильтр дат.</td></tr>'}</tbody>`;
  exportRows = dailyCSV(rows, s);
}

function renderPrograms(s) {
  syncButtons('[data-program-layout]', 'programLayout', s.programLayout);
  const explorer = ['calendar', 'airings'].includes(s.programLayout);
  $('airing-controls').hidden = !explorer; $('legacy-program-controls').hidden = explorer;
  $('legacy-program-table').hidden = explorer; $('airing-browser').hidden = !explorer;
  if (explorer) { $('program-timeline').hidden = true; renderExplorer(s); return; }
  $('airing-selection').hidden = true; $('airing-comparison').hidden = true;
  if (!searchTimer && document.activeElement !== $('program-search') && $('program-search').value !== s.programQuery) $('program-search').value = s.programQuery;
  $('program-channel').value = s.programChannel; $('program-daypart').value = s.programDaypart; $('program-sort').value = s.programSort;
  const rows = filterPrograms(catalog, { ...options(s), workdays, query: s.programQuery, channel: s.programChannel, daypart: s.programDaypart, dateISO: s.programLayout === 'schedule' ? s.selectedDate : null });
  const grouped = s.programLayout === 'catalog', displayed = grouped ? summarizePrograms(rows) : [...rows];
  displayed.sort(s.programSort === 'share' ? (a, b) => (b.share ?? -Infinity) - (a.share ?? -Infinity) : s.programSort === 'title' ? (a, b) => a.title.localeCompare(b.title, 'ru') : grouped ? (a, b) => b.lastDate.localeCompare(a.lastDate) || a.title.localeCompare(b.title, 'ru') : (a, b) => a.startSec - b.startSec || a.channel.localeCompare(b.channel));
  $('program-count').textContent = `${displayed.length} ${grouped ? 'программ' : 'выпусков'}`;
  $('program-note').textContent = s.audience === '25-34' ? 'Для 25–34 есть дневные показатели. Чтобы посмотреть программы и их аудиторию, выберите 18–54.' : grouped ? 'Средние показатели взвешены по длительности выпусков. Нажмите на программу, чтобы открыть историю.' : rows.some(row => row.approximate) ? 'Границы восстановлены по сетке с шагом 10 минут. Точные времена доступны после импорта ежедневного отчёта.' : 'Нажмите на программу в таблице или на ленте эфира для просмотра показателей и аудитории.';
  $('program-timeline').hidden = grouped || !rows.length;
  if (!grouped && rows.length) renderProgramTimeline($('program-timeline'), rows, id => set({ selectedProgramId: id }));
  const pages = renderProgramTable($('program-table'), displayed, { catalog: grouped, page: s.programPage });
  $('program-pagination').innerHTML = `<span>${pages.from}–${pages.to} из ${displayed.length}</span><div><button class="button secondary" data-page="${pages.page - 1}" ${pages.page <= 1 ? 'disabled' : ''}>←</button><span>Страница ${pages.page} / ${pages.pages}</span><button class="button secondary" data-page="${pages.page + 1}" ${pages.page >= pages.pages ? 'disabled' : ''}>→</button></div>`;
  exportRows = [['Дата', 'Начало', 'Конец', 'Канал', 'Программа', 'Доля %', 'Рейтинг %', 'Длительность мин', 'Источник'], ...rows.map(row => [row.dateISO, timeLabel(row.startSec), timeLabel(row.endSec), row.channel, row.title, row.share, row.rtg, row.durationMin, row.source])];
}

function renderExplorer(s) {
  const channel = s.programChannel === 'all' ? FTV_CHANNEL : s.programChannel;
  const titles = [...new Map(catalog.filter(row => row.channel === channel && row.audience === s.audience).map(row => [programmeKey(row.title), row.title])).values()].sort((a, b) => a.localeCompare(b, 'ru'));
  $('airing-titles').replaceChildren(...titles.map(title => new Option(title, title)));
  for (const [id, value] of [['airing-title', s.programTitle], ['airing-start', timeLabel(s.programStart)], ['airing-end', timeLabel(s.programEnd)]]) if (document.activeElement !== $(id)) $(id).value = value;
  $('airing-channel').value = channel; $('airing-approximate').checked = s.programApproximate; $('airing-missing-days').checked = s.programMissingDays;
  const query = { ...options(s), channel, title: s.programTitle, workdays, startSec: s.programStart, endSec: s.programEnd, dayOfWeek: s.programWeekday, includeApproximate: s.programApproximate };
  const key = `airings:${scopeKey(s)}:${JSON.stringify([channel, s.programTitle, s.programStart, s.programEnd, s.programWeekday, s.programApproximate])}`;
  const rows = memo(key, () => filterAirings(catalog, query)); visibleAirings = rows;
  const family = memo(`family:${scopeKey(s)}:${JSON.stringify([channel, s.programTitle, s.programApproximate])}`, () => filterAirings(catalog, { ...query, startSec: 18000, endSec: 104400, dayOfWeek: 0 }));
  const hours = [...new Set(family.map(row => Math.floor(row.startSec / 3600)))].sort((a, b) => a - b);
  $('airing-time-bands').innerHTML = hours.map(hour => `<button data-airing-hour="${hour}" class="date-chip ${s.programStart === hour * 3600 && s.programEnd === (hour + 1) * 3600 ? 'active' : ''}">${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00 · ${family.filter(row => Math.floor(row.startSec / 3600) === hour).length} выходов</button>`).join('');
  const matchingWindow = memo(`${key}:weekdays`, () => filterAirings(catalog, { ...query, dayOfWeek: 0 }));
  $('airing-weekdays').innerHTML = ['Все дни', ...WEEKDAYS].map((label, i) => `<button data-airing-weekday="${i}" class="${s.programWeekday === i ? 'active' : ''}" aria-pressed="${s.programWeekday === i}">${label}<small>${i === 0 ? matchingWindow.length : matchingWindow.filter(row => weekdayOf(row.dateISO) === i).length}</small></button>`).join('');
  const presets = { all: [18000, 104400], day: [39600, 61200], evening: [64800, 82800], night: [82800, 104400] };
  document.querySelectorAll('[data-airing-window]').forEach(button => button.classList.toggle('active', presets[button.dataset.airingWindow][0] === s.programStart && presets[button.dataset.airingWindow][1] === s.programEnd));
  const competitors = [...new Set(catalog.filter(row => row.channel !== channel && row.audience === s.audience).map(row => row.channel))].sort((a, b) => Number(s.programCompetitors.includes(b)) - Number(s.programCompetitors.includes(a)) || a.localeCompare(b, 'ru'));
  $('airing-competitor-choices').innerHTML = competitors.map(name => `<label><input type="checkbox" data-airing-competitor="${e(name)}" ${s.programCompetitors.includes(name) ? 'checked' : ''}>${e(name)}</label>`).join('');
  const contexts = memo(`${key}:context:${JSON.stringify(s.programCompetitors)}`, () => rows.map(row => describeAiring(airingIndex, row, { competitors: s.programCompetitors })));
  const days = memo(`${key}:days:${s.programMissingDays}`, () => airingCalendarDays(airingIndex, rows, { ...query, showMissing: s.programMissingDays }));
  $('program-count').textContent = `${rows.length} выходов · ${new Set(rows.map(row => row.dateISO)).size} дней`;
  $('program-note').textContent = s.audience === '25-34' ? 'Для 25–34 в этих отчётах нет программных измерений. Выберите 18–54 для просмотра выходов.' : `${s.programTitle || 'Выберите программу'} · начало в ${timeLabel(s.programStart)}–${timeLabel(s.programEnd)} · каждый выход показан отдельно. ≈ означает приблизительные границы, а не признак повтора.`;
  const pages = renderAiringBrowser($('airing-browser'), { contexts, days, layout: s.programLayout, page: s.programPage, selectedIds: s.programSelectedIds, startSec: s.programStart, endSec: s.programEnd });
  $('program-pagination').innerHTML = `<span>${pages.from}–${pages.to} из ${pages.total} ${s.programLayout === 'calendar' ? 'дней' : 'выходов'}</span><div><button class="button secondary" data-page="${pages.page - 1}" ${pages.page <= 1 ? 'disabled' : ''}>←</button><span>${pages.page} / ${pages.pages}</span><button class="button secondary" data-page="${pages.page + 1}" ${pages.page >= pages.pages ? 'disabled' : ''}>→</button></div>`;
  const selected = s.programSelectedIds.map(id => catalogById.get(id)).filter(row => row && row.audience === s.audience && row.channel === channel && programmeKey(row.title) === programmeKey(s.programTitle));
  const hiddenCount = selected.filter(row => !rows.some(item => item.id === row.id)).length;
  $('airing-selection').hidden = !rows.length && !selected.length;
  $('airing-selection').classList.toggle('empty', selected.length === 0);
  $('airing-selection-count').textContent = `Отмечено ${selected.length} выходов${hiddenCount ? ` · ${hiddenCount} скрыты текущими фильтрами` : ''}`;
  $('airing-build-comparison').disabled = selected.length < 2; $('airing-select-visible').disabled = !rows.length;
  $('airing-comparison').hidden = !s.programCompareOpen || selected.length < 2;
  if (!$('airing-comparison').hidden) {
    $('airing-group-by').value = s.programGroupBy; syncButtons('[data-airing-metric]', 'airingMetric', s.programCompareMetric);
    const selectedContexts = selected.map(row => describeAiring(airingIndex, row));
    comparisonExportRows = renderAiringComparison(selectedContexts, { groupBy: s.programGroupBy, metric: s.programCompareMetric });
  } else disposeChart($('airing-comparison-chart'));
  exportRows = airingsCSV(contexts);
}

function renderGridView(s) {
  const rows = data.grid_10min.filter(row => row.dateISO === s.selectedDate);
  const empty = !rows.length || s.audience !== '18-54';
  $('grid-chart').hidden = empty; $('grid-empty').hidden = !empty;
  $('grid-empty').textContent = s.audience !== '18-54' ? 'Подробная сетка доступна для 18–54. Дневные показатели 25–34 находятся в обзоре и сравнениях.' : 'Импортируйте отчёт за этот день для просмотра сетки.';
  $('grid-note').textContent = 'Цвет — доля аудитории. Нажмите на слот, чтобы открыть программу. Прокрутка и масштабирование доступны внутри карты.';
  if (!empty) renderGrid($('grid-chart'), rows, { audience: s.audience, onSelect: (channel, startSec) => { const program = programAtSlot(catalog, s.selectedDate, channel, startSec); if (program) set({ selectedProgramId: program.id }); } });
  const nextScanKey = `${s.selectedDate}:${s.revision}`;
  if (scanKey !== nextScanKey) { $('scan-image').hidden = true; if (scanURL) URL.revokeObjectURL(scanURL); scanURL = null; scanKey = nextScanKey; }
  exportRows = [['Дата', 'Начало', 'Канал', 'Программа', 'Доля %', 'Рейтинг %'], ...(s.audience === '18-54' ? rows : []).flatMap(row => Object.entries(row.channels).map(([channel, metric]) => [row.dateISO, timeLabel(row.startSec), channel, metric.title, metric.share, metric.rtg]))];
}
function renderDrops(s) {
  syncButtons('[data-drop-range]', 'dropRange', s.dropRange);
  const all = dropsFor(s), rows = s.dropRange === 'day' ? all.filter(row => row.program.dateISO === s.selectedDate) : all;
  $('drops-note').textContent = s.audience === '25-34' ? 'Для детектора нужны показатели программ 18–54. Для 25–34 доступны дневные сравнения.' : `Найдено ${rows.length} провалов · удержание ≤70% при доле входа ≥1% · рост конкурента показывает совпадение по времени, а не подтверждённый переход зрителей.`;
  renderPainPoints($('pain-points'), rows.slice(0, dropsLimit));
  $('more-drops').innerHTML = rows.length > dropsLimit ? `<span>Показано ${dropsLimit} из ${rows.length}</span><button class="button secondary" data-more-drops>Показать ещё 20</button>` : '';
  exportRows = [['Дата', 'Программа', 'Начало', 'Доля %', 'Удержание входа %', 'Изменение доли', 'Триггеры'], ...rows.map(row => [row.program.dateISO, row.program.title, timeLabel(row.program.startSec), row.program.share, row.leadInRetention, row.deltaShare, row.triggers.join(', ')])];
}

function renderPatterns(s) {
  syncButtons('[data-recurrence-mode]', 'recurrenceMode', s.recurrenceMode);
  $('recurrence-title-label').hidden = s.recurrenceMode !== 'program';
  $('recurrence-title').value = s.recurrenceTitle; $('recurrence-channel').value = s.recurrenceChannel;
  $('recurrence-start').value = timeLabel(s.recurrenceStart); $('recurrence-end').value = timeLabel(s.recurrenceEnd);
  $('recurrence-signal').value = s.recurrenceSignal; $('recurrence-retention').value = s.recurrenceRetention;
  $('recurrence-baseline-drop').value = s.recurrenceBaselineDrop; $('recurrence-approximate').checked = s.recurrenceApproximate;
  $('recurrence-retention').disabled = s.recurrenceSignal !== 'leadIn';
  $('recurrence-mode-note').textContent = s.recurrenceMode === 'program' ? 'Выберите точное название и окно начала выпуска. Сравним полный выпуск и соседние программы в каждый выбранный день недели.' : 'Сравним один и тот же интервал, даже если передачи менялись. Показатель окна оценён по средним долям пересекающих его программ.';
  const titles = [...new Set(catalog.filter(row => row.channel === s.recurrenceChannel && row.audience === s.audience).map(row => row.title))].sort((a, b) => a.localeCompare(b, 'ru'));
  $('recurrence-titles').replaceChildren(...titles.map(title => new Option(title, title)));
  $('recurrence-weekdays').innerHTML = WEEKDAYS.map((label, i) => `<button class="weekday-button ${s.selectedDayOfWeek === i + 1 ? 'active' : ''}" data-pattern-weekday="${i + 1}" aria-pressed="${s.selectedDayOfWeek === i + 1}" aria-label="Все ${WEEKDAY_NAMES[i]}"><strong>${label}</strong></button>`).join('');
  const query = { ...options(s), mode: s.recurrenceMode, title: s.recurrenceTitle, channel: s.recurrenceChannel, dayOfWeek: s.selectedDayOfWeek,
    startSec: s.recurrenceStart, endSec: s.recurrenceEnd, includeApproximate: s.recurrenceApproximate, signal: s.recurrenceSignal,
    retentionThreshold: s.recurrenceRetention, baselineDropPercent: s.recurrenceBaselineDrop };
  const result = memo(`patterns:${s.revision}:${JSON.stringify(query)}`, () => analyzeRecurrence(data, query));
  exportRows = renderRecurrence(result, { onSelect: row => row.programId ? set({ selectedProgramId: row.programId }) : openDate(row.dateISO) });
}

function renderDetail(s) {
  const dialog = $('program-detail');
  if (!s.selectedProgramId) { if (dialog.open) dialog.close(); disposeChart($('program-history-chart')); detailKey = ''; return; }
  const program = catalogById.get(s.selectedProgramId); if (!program) return;
  const key = `${s.selectedProgramId}:${scopeKey(s)}`; if (detailKey === key) return;
  if (!dialog.open) dialog.showModal();
  const drop = program.channel === FTV_CHANNEL && !program.approximate ? dropsFor(s).find(row => row.program.id === program.id) : null;
  renderProgramDetail($('program-detail-content'), program, catalog, { scopeRows: scopedPrograms(s), drop });
  detailKey = key;
}
function render() {
  const s = state.getState(); renderShell(s);
  if (data.daily_metrics.length) ({ overview: renderOverview, comparison: renderComparisonView, programs: renderPrograms, grid: renderGridView, drops: renderDrops, recurrence: renderPatterns })[s.view](s);
  renderDetail(s);
}
function scheduleRender() { if (pendingRender) return; pendingRender = true; requestAnimationFrame(() => { pendingRender = false; try { render(); } catch (error) { console.error(error); $('status').textContent = error.message; $('status').className = 'status-line error'; } }); }
state.subscribe((next, previous) => {
  const changed = Object.keys(next).filter(key => next[key] !== previous[key]);
  if (changed.some(key => preferenceFields.includes(key))) {
    try { localStorage.setItem('FTV_Analytics_Preferences', JSON.stringify({ schemaVersion: 2, ...Object.fromEntries(preferenceFields.map(key => [key, next[key]])) })); } catch {}
  }
  if (next.busy && changed.every(key => ['busy', 'error', 'importProgress'].includes(key))) renderStatus(); else scheduleRender();
});

document.addEventListener('click', event => {
  const button = event.target.closest('button, tr[data-program], tr[data-family], tr[data-date], .brand'); if (!button || button.disabled) return;
  const d = button.dataset, s = state.getState();
  if (button.classList.contains('brand')) { event.preventDefault(); navigate('programs'); }
  else if ('upload' in d) $('files').click();
  else if (d.view) navigate(d.view);
  else if (d.go) { if (d.mode) chooseMode(d.mode); navigate(d.go); }
  else if (d.mode) chooseMode(d.mode);
  else if (d.audience) updateScope({ audience: d.audience, chartView: d.audience === '25-34' ? 'daily' : s.chartView });
  else if (d.range) {
    const latest = data.daily_metrics.at(-1)?.dateISO; if (!latest) return;
    const start = new Date(`${latest}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - Number(d.range) + 1);
    updateScope(d.range === 'all' ? { dateFrom: null, dateTo: null } : { dateFrom: start.toISOString().slice(0, 10), dateTo: latest });
  } else if (d.metric) set({ metric: d.metric, chartView: ['reach', 'atsMin'].includes(d.metric) ? 'daily' : s.chartView });
  else if (d.weekday) { const next = { ...s, selectedDayOfWeek: Number(d.weekday) }; set({ selectedDayOfWeek: next.selectedDayOfWeek, curveDates: availableCurveDates(next).slice(-6) }); }
  else if (d.curve) set({ curveDates: s.curveDates.includes(d.curve) ? s.curveDates.filter(date => date !== d.curve) : [...s.curveDates, d.curve].slice(-6), chartView: 'slots' });
  else if (d.chartView) set({ chartView: d.chartView });
  else if (d.programLayout) set({ programLayout: d.programLayout, programPage: 1, ...(s.programChannel === 'all' && ['calendar', 'airings'].includes(d.programLayout) ? { programChannel: FTV_CHANNEL } : {}) });
  else if (d.family) browseProgram(d.family);
  else if (d.airingWindow) { const range = { all: [18000, 104400], day: [39600, 61200], evening: [64800, 82800], night: [82800, 104400] }[d.airingWindow]; set({ programStart: range[0], programEnd: range[1], programPage: 1 }); }
  else if (d.airingHour) set({ programStart: Number(d.airingHour) * 3600, programEnd: (Number(d.airingHour) + 1) * 3600, programPage: 1 });
  else if (d.airingWeekday) set({ programWeekday: Number(d.airingWeekday), programPage: 1 });
  else if (d.airingMetric) set({ programCompareMetric: d.airingMetric });
  else if (d.airingFocus) { const card = document.getElementById(`airing-card-${d.airingFocus}`); card?.scrollIntoView({ block: 'center', behavior: 'smooth' }); card?.focus({ preventScroll: true }); }
  else if (d.investigate) investigate(d.investigate);
  else if (d.recurrenceMode) set({ recurrenceMode: d.recurrenceMode });
  else if (d.patternWeekday) set({ selectedDayOfWeek: Number(d.patternWeekday) });
  else if (d.page) set({ programPage: Number(d.page) });
  else if (d.program) set({ selectedProgramId: d.program });
  else if (d.date) openDate(d.date);
  else if (d.dropRange) { dropsLimit = 20; set({ dropRange: d.dropRange }); }
  else if ('moreDrops' in d) { dropsLimit += 20; scheduleRender(); }
});
document.addEventListener('keydown', event => {
  if (event.target.matches('tr[data-program], tr[data-family], tr[data-date]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.click(); }
  if (event.target.matches('.weekday-button, .segmented button') && ['ArrowRight', 'ArrowLeft'].includes(event.key)) {
    const buttons = [...event.target.parentElement.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(event.target), next = buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    event.preventDefault(); next.focus(); next.click();
  }
});
for (const [id, field, transform] of [['date-from', 'dateFrom', value => value || null], ['date-to', 'dateTo', value => value || null]]) $(id).addEventListener('change', event => updateScope({ [field]: transform(event.target.value) }));
$('workdays').addEventListener('change', event => updateScope({ excludeNonWorkdays: event.target.checked }));
for (const id of ['period-a', 'period-b']) $(id).addEventListener('change', () => { const list = new Map(periodChoices(state.getState().mode)); set({ periodA: list.get($('period-a').value)?.value ?? null, periodB: list.get($('period-b').value)?.value ?? null }); });
$('swap-periods').addEventListener('click', () => { const s = state.getState(); set({ periodA: s.periodB, periodB: s.periodA }); });
$('select-curves').addEventListener('click', () => set({ curveDates: availableCurveDates(state.getState()).slice(-6), chartView: 'slots' }));
$('broadcast-date').addEventListener('change', event => set({ selectedDate: event.target.value, programPage: 1, selectedProgramId: null }));
for (const [id, offset] of [['previous-date', 1], ['next-date', -1]]) $(id).addEventListener('click', () => { const dates = scopedDaily(state.getState()).map(row => row.dateISO).reverse(), index = dates.indexOf(state.getState().selectedDate); if (dates[index + offset]) set({ selectedDate: dates[index + offset], programPage: 1 }); });
let searchTimer = null;
$('program-search').addEventListener('input', event => { clearTimeout(searchTimer); const query = event.target.value; searchTimer = setTimeout(() => { searchTimer = null; set({ programQuery: query, programPage: 1 }); }, 160); });
for (const [id, key] of [['program-channel', 'programChannel'], ['program-daypart', 'programDaypart'], ['program-sort', 'programSort']]) $(id).addEventListener('change', event => set({ [key]: event.target.value, programPage: 1 }));
$('program-daypart').append(...DAYPARTS.map(part => new Option(part.label, part.id)));
function applyAiringFields() {
  try {
    const s = state.getState(), title = $('airing-title').value.trim(), changed = programmeKey(title) !== programmeKey(s.programTitle);
    set({ programTitle: title, programStart: readPatternTime('airing-start'), programEnd: readPatternTime('airing-end'), programPage: 1,
      ...(changed ? { programSelectedIds: [], programCompareOpen: false } : {}) });
  } catch (error) { set({ error: error.message }); }
}
$('airing-apply').addEventListener('click', applyAiringFields);
for (const id of ['airing-title', 'airing-start', 'airing-end']) $(id).addEventListener('keydown', event => { if (event.key === 'Enter') applyAiringFields(); });
$('airing-channel').addEventListener('change', event => set({ programChannel: event.target.value, programTitle: catalog.find(row => row.channel === event.target.value && row.title.toLowerCase().includes('fresh news'))?.title || catalog.find(row => row.channel === event.target.value)?.title || '', programSelectedIds: [], programCompareOpen: false, programPage: 1 }));
for (const [id, field] of [['airing-approximate', 'programApproximate'], ['airing-missing-days', 'programMissingDays']]) $(id).addEventListener('change', event => set({ [field]: event.target.checked, programPage: 1 }));
document.addEventListener('change', event => {
  const s = state.getState(), d = event.target.dataset;
  if (d.airingSelect) set({ programSelectedIds: event.target.checked ? [...new Set([...s.programSelectedIds, d.airingSelect])] : s.programSelectedIds.filter(id => id !== d.airingSelect), programCompareOpen: false });
  if (d.airingCompetitor) set({ programCompetitors: event.target.checked ? [...new Set([...s.programCompetitors, d.airingCompetitor])] : s.programCompetitors.filter(name => name !== d.airingCompetitor) });
});
$('airing-select-visible').addEventListener('click', () => set({ programSelectedIds: [...new Set([...state.getState().programSelectedIds, ...visibleAirings.map(row => row.id)])], programCompareOpen: false }));
$('airing-clear-selection').addEventListener('click', () => set({ programSelectedIds: [], programCompareOpen: false }));
$('airing-build-comparison').addEventListener('click', () => { set({ programCompareOpen: true }); requestAnimationFrame(() => $('airing-comparison').scrollIntoView({ block: 'start', behavior: 'smooth' })); });
$('airing-close-comparison').addEventListener('click', () => set({ programCompareOpen: false }));
$('airing-group-by').addEventListener('change', event => set({ programGroupBy: event.target.value }));
$('airing-export-comparison').addEventListener('click', () => downloadCSV(comparisonExportRows, 'FTV_selected_airings.csv'));
function readPatternTime(id) {
  const match = $(id).value.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) throw new Error('Время указывается как ЧЧ:ММ (05:00–29:00)');
  return Number(match[1]) * 3600 + Number(match[2]) * 60;
}
function applyPatternFields() {
  try { set({ recurrenceTitle: $('recurrence-title').value.trim(), recurrenceStart: readPatternTime('recurrence-start'), recurrenceEnd: readPatternTime('recurrence-end') }); }
  catch (error) { set({ error: error.message }); }
}
$('recurrence-apply').addEventListener('click', applyPatternFields);
for (const id of ['recurrence-title', 'recurrence-start', 'recurrence-end']) $(id).addEventListener('keydown', event => { if (event.key === 'Enter') applyPatternFields(); });
$('recurrence-channel').addEventListener('change', event => set({ recurrenceChannel: event.target.value, recurrenceTitle: catalog.find(row => row.channel === event.target.value)?.title ?? '' }));
$('recurrence-signal').addEventListener('change', event => set({ recurrenceSignal: event.target.value }));
$('recurrence-approximate').addEventListener('change', event => set({ recurrenceApproximate: event.target.checked }));
for (const [id, key] of [['recurrence-retention', 'recurrenceRetention'], ['recurrence-baseline-drop', 'recurrenceBaselineDrop']]) $(id).addEventListener('change', event => set({ [key]: Number(event.target.value) }));
$('close-program').addEventListener('click', () => set({ selectedProgramId: null }));
$('program-detail').addEventListener('close', () => { if (state.getState().selectedProgramId) set({ selectedProgramId: null }); });
$('help').addEventListener('click', () => $('help-dialog').showModal()); $('close-help').addEventListener('click', () => $('help-dialog').close());
for (const id of ['program-detail', 'help-dialog']) $(id).addEventListener('click', event => {
  const dialog = $(id), rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});

$('files').addEventListener('change', async event => {
  const files = [...event.target.files]; if (!files.length || state.getState().busy) return;
  set({ busy: true, importProgress: { completed: 0, total: files.length, name: files[0].name } });
  const results = [];
  try {
    for (let i = 0; i < files.length; i++) {
      set({ importProgress: { completed: i, total: files.length, name: files[i].name } });
      try {
        const report = await importer.parse(files[i]), stats = await db.importReport(report);
        results.push({ name: files[i].name, reportDateISO: report.reportDateISO, daily: report.daily_metrics.length, grid: report.grid_10min.length, logs: report.program_logs.length, warnings: report.warnings, stats });
      } catch (error) { results.push({ name: files[i].name, error: error.message }); }
      set({ importProgress: { completed: i + 1, total: files.length, name: files[i].name } });
    }
    await reload();
    const failed = results.filter(row => row.error).length;
    $('import-result').hidden = false;
    $('import-result-summary').textContent = `Импортировано ${results.length - failed} из ${results.length} файлов${failed ? ` · ошибок: ${failed}` : ''}`;
    $('import-result-list').innerHTML = results.map(row => `<div class="import-file ${row.error ? 'error' : ''}"><strong>${e(row.name)}</strong>${row.error ? `<p>${e(row.error)}</p>` : `<p>Дата отчёта ${dateLabel(row.reportDateISO, true)} · ${row.daily} дней · ${row.grid} слотов · ${row.logs} программ</p><p>Добавлено ${row.stats.daily_metrics.inserted} дней, дополнено ${row.stats.daily_metrics.updated}. Повторные даты объединены.</p>${row.warnings.length ? `<details><summary>Замечания: ${row.warnings.length}</summary>${row.warnings.map(warning => `<p>${e(warning)}</p>`).join('')}</details>` : ''}`}</div>`).join('');
    set({ busy: false, importProgress: null, error: failed === results.length ? 'Файлы не импортированы. Откройте результаты импорта.' : null });
  } catch (error) { set({ busy: false, importProgress: null, error: error.message }); }
  finally { event.target.value = ''; }
});
$('show-scan').addEventListener('click', async () => {
  const selectedDate = state.getState().selectedDate;
  try {
    const scan = await db.get('media_scans', selectedDate);
    if (state.getState().selectedDate !== selectedDate) return;
    if (!scan) { $('grid-note').textContent = 'Оригинальный скан появится после импорта отчёта за эту дату.'; return; }
    if (scanURL) URL.revokeObjectURL(scanURL); scanURL = URL.createObjectURL(scan.blob);
    $('scan-image').src = scanURL; $('scan-image').hidden = false;
  } catch (error) { set({ error: error.message }); }
});
function downloadCSV(rows, filename) {
  const url = URL.createObjectURL(new Blob([csvContent(rows)], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a');
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').addEventListener('click', () => downloadCSV(exportRows, `FTV_${state.getState().view}_${state.getState().audience}.csv`));
try {
  const saved = JSON.parse(localStorage.getItem('FTV_Analytics_Preferences') ?? '{}');
  state.setState(Object.fromEntries(preferenceFields.filter(key => key in saved && (saved.schemaVersion === 2 || !['view', 'programLayout'].includes(key))).map(key => [key, saved[key]])));
} catch {} // Corrupt or unavailable local preferences must not prevent database access.
const initialView = location.hash.slice(1); if (pageCopy[initialView]) set({ view: initialView });
window.addEventListener('pagehide', () => { importer.close(); disposeCharts(); db.close(); if (scanURL) URL.revokeObjectURL(scanURL); });
window.addEventListener('pageshow', event => { if (event.persisted) reload().catch(error => set({ error: error.message })); });
await reload().catch(error => set({ error: error.message })); scheduleRender();
