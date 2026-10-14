import { db } from './core/db.js';
import { state } from './core/state.js';
import { parseExcelFile } from './parser/excelParser.js';
import { comparePeriods } from './analytics/comparator.js';
import { detectSlotDrops } from './analytics/dropDetector.js';
import { renderComparison, disposeCharts } from './ui/charts.js';
import { renderGrid, renderPainPoints } from './ui/gridView.js';

const $ = id => document.getElementById(id);
let data = { daily_metrics: [], grid_10min: [], program_logs: [] }, scanURL = null;
const periods = new Map();
const seasons = { winter: 'Зима', spring: 'Весна', summer: 'Лето', autumn: 'Осень' };

function errorMessage(error) { state.setState({ error: error.message ?? String(error), busy: false }); }

function fillPeriods() {
  const current = state.getState();
  periods.clear();
  for (const row of data.daily_metrics) {
    if (current.mode === 'week') periods.set(`${row.isoWeekYear}-W${String(row.isoWeek).padStart(2, '0')}`, { isoWeekYear: row.isoWeekYear, isoWeek: row.isoWeek });
    if (current.mode === 'season') periods.set(`${row.seasonYear} · ${seasons[row.season]}`, { seasonYear: row.seasonYear, season: row.season });
    if (current.mode === 'year') periods.set(String(row.year), { year: row.year });
  }
  const seasonOrder = ['winter', 'spring', 'summer', 'autumn'];
  const keys = [...periods.keys()].sort((a, b) => current.mode === 'season'
    ? (periods.get(b).seasonYear * 4 + seasonOrder.indexOf(periods.get(b).season)) - (periods.get(a).seasonYear * 4 + seasonOrder.indexOf(periods.get(a).season))
    : b.localeCompare(a));
  for (const id of ['period-a', 'period-b']) {
    const previous = $(id).value;
    $(id).replaceChildren(...keys.map(key => new Option(key, key)));
    if (keys.includes(previous)) $(id).value = previous;
    else $(id).value = keys[id === 'period-b' ? Math.min(1, keys.length - 1) : 0] ?? '';
  }
  $('weekday-label').hidden = current.mode !== 'dayOfWeek';
  $('period-a-label').hidden = $('period-b-label').hidden = current.mode === 'dayOfWeek';
  state.setState({ periodA: periods.get($('period-a').value) ?? null, periodB: periods.get($('period-b').value) ?? null });
}

async function reload() {
  data = await db.loadData();
  const dates = [...new Set(data.grid_10min.map(row => row.dateISO))].sort().reverse();
  $('grid-date').replaceChildren(...dates.map(date => new Option(date, date)));
  fillPeriods();
  state.setState({ selectedDate: dates.includes(state.getState().selectedDate) ? state.getState().selectedDate : dates[0] ?? null, revision: state.getState().revision + 1 });
}

function render() {
  const s = state.getState();
  $('mode').value = s.mode; $('audience').value = s.audience;
  $('date-from').value = s.dateFrom ?? ''; $('date-to').value = s.dateTo ?? '';
  $('workdays').checked = s.excludeNonWorkdays; $('weekday').value = String(s.selectedDayOfWeek);
  $('files').disabled = s.busy;
  $('status').className = s.error ? 'error' : 'muted';
  $('status').textContent = s.error ?? (s.busy ? `Импорт: ${s.importProgress?.completed ?? 0} / ${s.importProgress?.total ?? 0}` : `В базе: ${data.daily_metrics.length} дней, ${data.grid_10min.length} слотов, ${data.program_logs.length} программ.`);
  if (!data.daily_metrics.length) { $('summary').textContent = 'Загрузите один или несколько Excel-отчётов для сравнения.'; return; }
  const options = { audience: s.audience, from: s.dateFrom, to: s.dateTo, excludeNonWorkdays: s.excludeNonWorkdays, dayOfWeek: s.selectedDayOfWeek };
  // Day-of-week filtering applies only in its own mode.
  if (s.mode !== 'dayOfWeek') delete options.dayOfWeek;
  try {
    const result = comparePeriods(data, { ...options, mode: s.mode, periodA: s.periodA, periodB: s.periodB });
    renderComparison($('comparison-chart'), result);
    const summary = s.mode === 'dayOfWeek' ? result.summary : result.current;
    const share = summary.daily.share.mean;
    $('summary').textContent = `${summary.dayCount} дней · Средняя доля: ${Number.isFinite(share) ? share.toFixed(2) + '%' : 'нет данных'} · ${summary.gridDayCount} дней с сеткой для ${s.audience}.`;
  } catch (error) { $('summary').textContent = error.message; }
  $('grid-date').value = s.selectedDate ?? '';
  const gridRows = data.grid_10min.filter(row => row.dateISO === s.selectedDate);
  renderGrid($('grid-chart'), gridRows, options);
  $('grid-note').textContent = s.audience === '25-34' ? 'В отчётах сетка доступна для 18–54. Для 25–34 доступны дневные метрики.' : 'Доли программ распределены по десятиминутным слотам. Пустые слоты означают отсутствие данных.';
  const drops = detectSlotDrops(data, options);
  $('drops-note').textContent = s.audience === '25-34' ? 'Посекундные показатели программ для аудитории 25–34 в исходных листах отсутствуют.' : `Найдено провалов: ${drops.length}. Показано: ${Math.min(30, drops.length)}.`;
  renderPainPoints($('pain-points'), drops.slice(0, 30));
  $('scan-image').hidden = true;
  if (scanURL) { URL.revokeObjectURL(scanURL); scanURL = null; }
}

$('files').addEventListener('change', async event => {
  const files = [...event.target.files];
  if (!files.length || state.getState().busy) return;
  state.setState({ busy: true, error: null, importProgress: { completed: 0, total: files.length } });
  const warnings = [];
  try {
    for (let i = 0; i < files.length; i++) {
      try {
        const report = await parseExcelFile(files[i]);
        await db.importReport(report);
        warnings.push(...report.warnings.map(warning => `${files[i].name}: ${warning}`));
      } catch (error) { warnings.push(`${files[i].name}: импорт не выполнен — ${error.message}`); }
      state.setState({ importProgress: { completed: i + 1, total: files.length } });
    }
    $('warning-list').replaceChildren(...warnings.map(warning => { const li = document.createElement('li'); li.textContent = warning; return li; }));
    $('warnings').hidden = warnings.length === 0;
    await reload();
    state.setState({ busy: false, importProgress: null });
  } catch (error) { errorMessage(error); }
  finally { event.target.value = ''; }
});

for (const [id, field, transform] of [
  ['audience', 'audience', value => value], ['date-from', 'dateFrom', value => value || null],
  ['date-to', 'dateTo', value => value || null], ['weekday', 'selectedDayOfWeek', Number], ['grid-date', 'selectedDate', value => value || null],
]) $(id).addEventListener('change', event => {
  try { state.setState({ [field]: transform(event.target.value), error: null }); } catch (error) { errorMessage(error); }
});
$('mode').addEventListener('change', event => { state.setState({ mode: event.target.value }); fillPeriods(); render(); });
$('workdays').addEventListener('change', event => state.setState({ excludeNonWorkdays: event.target.checked }));
for (const id of ['period-a', 'period-b']) $(id).addEventListener('change', () => state.setState({ periodA: periods.get($('period-a').value) ?? null, periodB: periods.get($('period-b').value) ?? null }));
$('show-scan').addEventListener('click', async () => {
  try {
    const scan = await db.get('media_scans', state.getState().selectedDate);
    if (!scan) { $('grid-note').textContent = 'Для этой даты оригинальный скан ещё не импортирован.'; return; }
    if (scanURL) URL.revokeObjectURL(scanURL);
    scanURL = URL.createObjectURL(scan.blob);
    $('scan-image').src = scanURL; $('scan-image').hidden = false;
  } catch (error) { errorMessage(error); }
});
state.subscribe(render);
window.addEventListener('pagehide', () => { disposeCharts(); db.close(); if (scanURL) URL.revokeObjectURL(scanURL); });
await reload().catch(errorMessage);
