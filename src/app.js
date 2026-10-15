import { db } from './core/db.js';
import { state } from './core/state.js';
import { createImportClient } from './core/importClient.js';
import { restoreSimpleView, validateSimpleView } from './core/simpleView.js';
import { validateBackup, restoreWorkspace } from './core/workspace.js';
import { buildProgramCatalog } from './analytics/programs.js';
import { createAiringIndex, describeAiring, averageViewers } from './analytics/airingExplorer.js';
import { initialTrendFilters, buildTrendDays, trendProgrammes, shiftDate, programmesAtTime } from './analytics/trendExplorer.js';
import { analyzeRecurrence } from './analytics/recurrence.js';
import { createScanViewer } from './ui/scanViewer.js';
import { SCAN_CHANNELS } from './ui/scanGeometry.js';
import { createPeriodModule } from './ui/periodModule.js';
import { escapeHTML as e, number, dateLabel, timeLabel, preciseTimeLabel, WEEKDAYS, WEEKDAY_NAMES, csvContent } from './ui/format.js';

const $ = id => document.getElementById(id), importer = createImportClient();
let data = { daily_metrics: [], grid_10min: [], program_logs: [] }, scans = new Map(), catalog = [], byId = new Map(), index = createAiringIndex([], data), days = [];
let programPage = 1, busy = false, renderPending = false, originalURL = null, statusTimer, saveTimer;
const view = () => state.getState().simpleView, filters = () => view().filters;
const sourceBadge = row => `<span class="badge ${row.approximate ? 'approx' : ''}">${row.approximate ? '≈ Сетка' : 'Точный выход'}</span>`;
const viewer = createScanViewer($('scan-viewer'), { getScan: date => scans.get(date), onOpen: openOriginal, onProgram: openProgram, onTime: openMoment, onError: error => status(error.message) });
const periods = createPeriodModule($('period-module'), { onError: error => status(error.message) });
function status(message = '', error = true) { clearTimeout(statusTimer); $('status').hidden = !message; $('status').textContent = message; $('status').classList.toggle('info', !error); if (message && !error) statusTimer = setTimeout(() => { $('status').hidden = true; }, 6000); }
function update(patch) { try { const next = { ...view(), ...patch }; validateSimpleView(next); if (JSON.stringify(next) !== JSON.stringify(view())) state.setState({ simpleView: next }); status(); } catch (error) { status(error.message); } }
function updateFilters(patch) { const next = { ...filters(), ...patch }; programPage = 1; update({ filters: next, page: 1 }); }
function navigate(tab) { update({ tab }); window.history.replaceState(null, '', `#${tab}`); }
function sync(id, value) { if (document.activeElement !== $(id)) $(id).value = value ?? ''; }
function readTime(id) { const match = $(id).value.trim().match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/); if (!match) throw new Error('Задайте время как 18:00 или 18:00:30. Эфирные часы: 05:00–29:00.'); return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0); }
function applyFilters() { try { updateFilters({ from: $('date-from').value || null, to: $('date-to').value || null, startSec: readTime('time-start'), endSec: readTime('time-end'), title: $('programme').value.trim(), channel: $('channel').value }); } catch (error) { status(error.message); } }
function download(content, name, type = 'text/csv;charset=utf-8') { const url = URL.createObjectURL(new Blob([content], { type })), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function persist() { try { localStorage.setItem('FTV_Simple_View_v1', JSON.stringify(view())); } catch { status('Не удалось сохранить настройки браузера.'); } }

async function reload() {
  const loaded = await Promise.all([db.loadData(), db.getAll('media_scans')]); data = loaded[0]; scans = new Map(loaded[1].map(row => [row.dateISO, row]));
  catalog = buildProgramCatalog(data); byId = new Map(catalog.map(row => [row.id, row])); index = createAiringIndex(catalog, data); viewer.clearCache();
  if (!filters().from || !filters().to) updateFilters(initialTrendFilters([...scans.keys()], index.dates));
  schedule();
}
function renderFilters() {
  const q = filters();
  for (const [id, value] of Object.entries({ 'date-from': q.from, 'date-to': q.to, 'time-start': q.startSec % 60 ? preciseTimeLabel(q.startSec) : timeLabel(q.startSec), 'time-end': q.endSec % 60 ? preciseTimeLabel(q.endSec) : timeLabel(q.endSec), programme: q.title, channel: q.channel, 'scan-scale': view().scale })) sync(id, value);
  $('weekdays').innerHTML = WEEKDAYS.map((name, i) => `<button data-weekday="${i + 1}" class="${q.weekdays.includes(i + 1) ? 'is-active' : ''}" aria-pressed="${q.weekdays.includes(i + 1)}">${name}</button>`).join('');
  const names = [...new Set(catalog.filter(row => row.channel === q.channel).map(row => row.title))].sort((a, b) => a.localeCompare(b, 'ru'));
  $('programme-options').replaceChildren(...names.map(title => new Option(title, title)));
}
function renderTrend() {
  const q = filters(), pages = Math.max(1, Math.ceil(days.length / 5)), page = Math.min(view().page, pages), slice = days.slice((page - 1) * 5, page * 5);
  $('trend-heading').textContent = q.title || `Тенденция ${q.channel}`;
  $('trend-scope').textContent = `${timeLabel(q.startSec)}–${timeLabel(q.endSec)} · ${q.weekdays.map(day => WEEKDAYS[day - 1]).join(', ') || 'Дни не выбраны'} · ${days.filter(day => day.hasScan).length} графиков / ${days.length} дат`;
  $('page-description').textContent = days.length ? `${dateLabel(slice[0].dateISO)} — ${dateLabel(slice.at(-1).dateISO, true)} · даты ${(page - 1) * 5 + 1}–${Math.min(page * 5, days.length)} из ${days.length}` : 'Дни не выбраны';
  $('previous-dates').disabled = page <= 1; $('next-dates').disabled = page >= pages;
  viewer.render(slice, q, view().scale).catch(error => status(error.message));
}
function renderProgrammes() {
  const rows = trendProgrammes(days), pages = Math.max(1, Math.ceil(rows.length / 40)); programPage = Math.min(programPage, pages);
  $('programmes-scope').textContent = `${rows.length} выходов · ${new Set(rows.map(row => row.dateISO)).size} дней · ${timeLabel(filters().startSec)}–${timeLabel(filters().endSec)} · 18–54`;
  $('programmes-table').innerHTML = `<thead><tr><th>Дата</th><th>Время</th><th>Программа</th><th>Доля</th><th>Средние зрители</th><th>Источник</th><th></th></tr></thead><tbody>${rows.slice((programPage - 1) * 40, programPage * 40).map(row => `<tr data-program="${e(row.id)}" tabindex="0"><td>${dateLabel(row.dateISO, true)}<span class="sub">${WEEKDAYS[new Date(`${row.dateISO}T00:00:00Z`).getUTCDay() === 0 ? 6 : new Date(`${row.dateISO}T00:00:00Z`).getUTCDay() - 1]}</span></td><td class="number">${preciseTimeLabel(row.startSec)}<span class="sub">до ${preciseTimeLabel(row.endSec)}</span></td><td><strong>${e(row.title)}</strong></td><td class="number">${number(row.share)}%</td><td class="number">${number(averageViewers(row), 0)}</td><td>${sourceBadge(row)}</td><td><button class="text-button" data-program="${e(row.id)}">Подробнее →</button></td></tr>`).join('') || '<tr><td colspan="7">В загруженном расписании нет программ по этим условиям.</td></tr>'}</tbody>`;
  $('programmes-pagination').innerHTML = `<span>${rows.length} выходов · страница ${programPage} / ${pages}</span><div><button class="button secondary" data-program-page="${programPage - 1}" ${programPage <= 1 ? 'disabled' : ''}>←</button><button class="button secondary" data-program-page="${programPage + 1}" ${programPage >= pages ? 'disabled' : ''}>→</button></div>`;
}
function renderData() {
  $('data-scope').textContent = `${data.daily_metrics.length} дней истории · ${scans.size} исходных графиков · ${data.program_logs.length} точных выходов`;
  const allDates = [...new Set([...index.dates, ...scans.keys()])].sort().reverse(), gridDates = new Set(data.grid_10min.map(row => row.dateISO)), logDates = new Set(data.program_logs.map(row => row.dateISO));
  $('data-table').innerHTML = `<thead><tr><th>Дата</th><th>Исходный график</th><th>Расписание TOP</th><th>Сетка</th></tr></thead><tbody>${allDates.map(date => `<tr><td>${dateLabel(date, true)}</td><td>${scans.has(date) ? `<button class="text-button" data-original="${date}">Открыть график ↗</button>` : 'Нет — нужен ежедневный отчёт'}</td><td>${logDates.has(date) ? 'Есть' : '—'}</td><td>${gridDates.has(date) ? 'Есть' : '—'}</td></tr>`).join('')}</tbody>`;
}
function render() {
  const w = view(), hasData = !!(data.daily_metrics.length || scans.size || catalog.length);
  $('empty-state').hidden = hasData; $('app-content').hidden = !hasData; $('dataset-status').textContent = `${scans.size} графиков · ${data.daily_metrics.length} дней истории`;
  document.querySelectorAll('[data-module]').forEach(button => { const selected = button.dataset.module === w.tab; button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', selected); });
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== w.tab; });
  $('view-filters').hidden = !['trend', 'programmes'].includes(w.tab); if (!hasData) return;
  renderFilters(); days = buildTrendDays(catalog, [...scans.keys()], filters());
  ({ trend: renderTrend, programmes: renderProgrammes, periods: () => periods.render(data), data: renderData })[w.tab]();
}
function schedule() { if (renderPending) return; renderPending = true; requestAnimationFrame(() => { renderPending = false; try { render(); } catch (error) { console.error(error); status(error.message); } }); }
state.subscribe((next, previous) => { if (next.simpleView !== previous.simpleView) { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 150); schedule(); } });

async function openOriginal(dateISO) {
  try { const scan = scans.get(dateISO); if (!scan?.blob) throw new Error('Загрузите ежедневный отчёт за эту дату.'); if (originalURL) URL.revokeObjectURL(originalURL); originalURL = URL.createObjectURL(scan.blob); $('original-image').src = originalURL; $('original-title').textContent = `Исходный график · ${dateLabel(dateISO, true)}`; $('original-dialog').showModal(); $('original-image').onload = () => { $('original-image').parentElement.scrollTop = Math.max(0, 202 + (filters().startSec - 18000) / 15 - 60); }; } catch (error) { status(error.message); }
}
function openMoment(dateISO, timeSec) {
  const rows = programmesAtTime(catalog, dateISO, timeSec, filters().channel);
  if (rows.length === 1) { openProgram(rows[0].id, timeSec); return; }
  $('detail-title').textContent = `${dateLabel(dateISO, true)} · ${preciseTimeLabel(timeSec)}`;
  $('detail-content').innerHTML = rows.length ? `<p>В расписании пересекаются несколько записей:</p>${rows.map(row => `<p><button class="text-button" data-program="${e(row.id)}">${e(row.title)} · ${preciseTimeLabel(row.startSec)}</button></p>`).join('')}` : '<p>В загруженном расписании нет записи для этого момента. Исходная линия остаётся доступной на графике.</p>';
  $('detail-dialog').showModal();
}
function openProgram(id, moment) {
  const row = byId.get(id); if (!row) return;
  const context = describeAiring(index, row, { competitors: SCAN_CHANNELS });
  $('detail-title').textContent = row.title;
  const neighbor = (program, label, viewers) => `<div><span>${label}</span><strong>${program ? e(program.title) : 'Нет соседней записи'}</strong><small>${program ? `${timeLabel(program.startSec)}–${timeLabel(program.endSec)} · ${number(program.share)}% · ${number(viewers, 0)} чел.` : 'Измерение отсутствует'}</small></div>`;
  const recurrence = analyzeRecurrence(data, { mode: 'program', title: row.title, channel: row.channel, from: filters().from, to: filters().to, dayOfWeek: new Date(`${row.dateISO}T00:00:00Z`).getUTCDay() || 7, startSec: filters().startSec, endSec: filters().endSec, includeApproximate: false });
  const result = recurrence.groups[0], labels = { systematic: 'Повторяющийся провал', isolated: 'Возможная разовая аномалия', mixed: 'Нерегулярные провалы', noSignal: 'Провал по выбранному правилу не выявлен', insufficient: 'Недостаточно сопоставимых дат: нужно минимум 5' };
  $('detail-content').innerHTML = `<p class="detail-meta">${e(row.channel)} · ${dateLabel(row.dateISO, true)} · ${preciseTimeLabel(row.startSec)}–${preciseTimeLabel(row.endSec)}${moment != null ? ` · момент на графике ≈${timeLabel(moment)}` : ''}</p>${sourceBadge(row)}<div class="detail-metrics"><div><span>Средняя доля</span><strong>${number(row.share)}%</strong></div><div><span>Средние зрители</span><strong>${number(context.viewers, 0)}</strong></div><div><span>Удержание входа</span><strong>${number(context.leadInRetention, 0)}%</strong></div><div><span>Удержание выхода</span><strong>${number(context.leadOutRetention, 0)}%</strong></div></div><div class="detail-flow">${neighbor(context.previous, 'Перед программой', context.previousViewers)}${neighbor(context.next, 'После программы', context.nextViewers)}</div><h3>В это время у конкурентов</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>Канал</th><th>Программы</th><th>Доля за окно</th></tr></thead><tbody>${context.competitors.map(item => `<tr><td>${e(item.channel)}</td><td>${item.programmes.map(program => `${timeLabel(program.startSec)}–${timeLabel(program.endSec)} ${e(program.title)}`).join('<br>') || 'Нет расписания'}</td><td>${number(item.share)}%</td></tr>`).join('')}</tbody></table></div><p class="module-note">Числа — средние за программу/окно, не значения линии в выбранную минуту. «—» — нет измерения. Зрители — средняя аудитория, а не отслеженные переходы людей.</p><div class="detail-actions"><button class="button" data-only-program="${e(id)}">Показать эту программу по дням</button><button class="button secondary" data-same-weekday="${e(id)}">Все ${WEEKDAY_NAMES[(new Date(`${row.dateISO}T00:00:00Z`).getUTCDay() || 7) - 1]}</button></div><details><summary>Повторяется ли падение в этот день недели?</summary><p><strong>${labels[result.classification]}</strong></p><p class="module-note">Провалов к входу: ${result.signalDays} / ${result.eligibleDays} сопоставимых дат. Используются точные выходы в выбранном окне начала и периоде; удержание ≤70% при входной доле ≥1%. Пропуски и неоднозначные выпуски исключены. Это описательное правило.</p></details>`;
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
}

$('channel').replaceChildren(...SCAN_CHANNELS.map(name => new Option(name, name)));
document.addEventListener('click', event => {
  const module = event.target.closest('[data-module]'); if (module) navigate(module.dataset.module);
  if (event.target.closest('[data-upload]')) $('files').click();
  const close = event.target.closest('[data-close]'); if (close) $(close.dataset.close).close();
  const weekday = event.target.closest('[data-weekday]'); if (weekday) { const day = Number(weekday.dataset.weekday); updateFilters({ weekdays: filters().weekdays.includes(day) ? filters().weekdays.filter(value => value !== day) : [...filters().weekdays, day].sort() }); }
  const preset = event.target.closest('[data-window]'); if (preset) { const [startSec, endSec] = preset.dataset.window.split(',').map(Number); updateFilters({ startSec, endSec }); }
  const week = event.target.closest('[data-shift-week]'); if (week && filters().from && filters().to) updateFilters({ from: shiftDate(filters().from, Number(week.dataset.shiftWeek)), to: shiftDate(filters().to, Number(week.dataset.shiftWeek)) });
  const row = event.target.closest('[data-program]'); if (row) openProgram(row.dataset.program);
  const original = event.target.closest('#data-table [data-original]'); if (original) openOriginal(original.dataset.original);
  const single = event.target.closest('[data-only-program]'), same = event.target.closest('[data-same-weekday]');
  if (single || same) { const program = byId.get((single || same).dataset.onlyProgram || same.dataset.sameWeekday); $('detail-dialog').close(); updateFilters({ title: program.title, channel: program.channel, ...(same ? { weekdays: [new Date(`${program.dateISO}T00:00:00Z`).getUTCDay() || 7] } : {}) }); navigate('trend'); }
  const page = event.target.closest('[data-program-page]'); if (page) { programPage = Number(page.dataset.programPage); renderProgrammes(); }
});
document.addEventListener('keydown', event => { const row = event.target.closest('tr[data-program]'); if (row && event.key === 'Enter') openProgram(row.dataset.program); });
$('upload').addEventListener('click', () => $('files').click()); $('apply-filters').addEventListener('click', applyFilters);
for (const id of ['time-start', 'time-end', 'programme']) $(id).addEventListener('keydown', event => { if (event.key === 'Enter') applyFilters(); });
for (const id of ['date-from', 'date-to']) $(id).addEventListener('change', applyFilters);
$('channel').addEventListener('change', event => updateFilters({ channel: event.target.value, title: '' }));
$('programme').addEventListener('change', applyFilters);
$('workweek').addEventListener('click', () => updateFilters({ weekdays: [1, 2, 3, 4, 5] })); $('all-weekdays').addEventListener('click', () => updateFilters({ weekdays: [1, 2, 3, 4, 5, 6, 7] }));
$('clear-programme').addEventListener('click', () => { $('programme').value = ''; updateFilters({ title: '' }); });
$('scan-scale').addEventListener('change', event => update({ scale: event.target.value }));
$('previous-dates').addEventListener('click', () => update({ page: Math.max(1, Math.min(view().page, Math.ceil(days.length / 5)) - 1) })); $('next-dates').addEventListener('click', () => update({ page: view().page + 1 }));
$('export-periods').addEventListener('click', () => { const csv = periods.getCSV(); if (csv) download(csv, 'FTV_periods.csv'); });
$('export-programmes').addEventListener('click', () => download(csvContent([['Параметры', JSON.stringify(filters())], ['Дата', 'Канал', 'Программа', 'Начало', 'Конец', 'Средняя доля %', 'Средние зрители', 'Источник'], ...trendProgrammes(days).map(row => [row.dateISO, row.channel, row.title, preciseTimeLabel(row.startSec), preciseTimeLabel(row.endSec), row.share, averageViewers(row), row.source])]), 'FTV_programmes.csv'));
$('files').addEventListener('change', async event => {
  const files = [...event.target.files]; if (!files.length || busy) return;
  busy = true; $('upload').disabled = true; $('import-progress').hidden = false; $('import-meter').max = files.length;
  const results = [];
  try {
    for (let i = 0; i < files.length; i++) {
      $('import-meter').value = i; $('import-label').textContent = `${i + 1} / ${files.length} · ${files[i].name}`;
      try { const report = await importer.parse(files[i]); await db.importReport(report); results.push({ name: files[i].name, date: report.reportDateISO, warnings: report.warnings }); } catch (error) { results.push({ name: files[i].name, error: error.message }); }
      $('import-meter').value = i + 1;
    }
    await reload(); const failed = results.filter(row => row.error).length;
    $('import-results').hidden = false; $('import-result-list').innerHTML = results.map(row => `<div class="import-row"><strong>${e(row.name)}</strong><p>${row.error ? e(row.error) : dateLabel(row.date, true)}</p>${row.warnings?.map(text => `<p>${e(text)}</p>`).join('') || ''}</div>`).join('');
    status(`Загружено ${results.length - failed} из ${results.length} отчётов.${failed ? ' Подробности в разделе «Данные».' : ''}`, failed > 0);
  } catch (error) { status(error.message); } finally { busy = false; $('upload').disabled = false; $('import-progress').hidden = true; event.target.value = ''; }
});
$('backup').addEventListener('click', () => download(JSON.stringify({ format: 'FTV Studio backup', version: 1, createdAt: new Date().toISOString(), data, workspace: state.getState().workspace, simpleView: view() }), 'FTV_backup.json', 'application/json'));
$('restore').addEventListener('click', () => $('backup-file').click());
$('backup-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file || busy) return;
  try { const payload = JSON.parse(await file.text()), workspace = validateBackup(payload), simpleView = payload.simpleView ? restoreSimpleView(payload.simpleView) : restoreSimpleView({}); busy = true; $('upload').disabled = true; const dates = ['daily_metrics', 'grid_10min', 'program_logs'].flatMap(key => payload.data[key].map(row => row.dateISO)).sort(); if (dates.length) await db.importReport({ reportDateISO: dates.at(-1), ...payload.data }); state.setState({ workspace, simpleView }); await reload(); status('Копия восстановлена. Исходные картинки добавляются повторной загрузкой Excel.', false); } catch (error) { status(error.message); } finally { busy = false; $('upload').disabled = false; event.target.value = ''; }
});
for (const id of ['detail-dialog', 'original-dialog']) $(id).addEventListener('click', event => { if (event.target !== $(id)) return; const rect = $(id).getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $(id).close(); });
try { const saved = localStorage.getItem('FTV_Simple_View_v1'); if (saved) update(restoreSimpleView(JSON.parse(saved))); const old = localStorage.getItem('FTV_Studio_Workspace_v1'); if (old) state.setState({ workspace: restoreWorkspace(JSON.parse(old)) }); } catch { status('Открыты настройки по умолчанию. Загруженные отчёты сохранены.'); }
const initialTab = location.hash.slice(1); if (['trend', 'programmes', 'periods', 'data'].includes(initialTab)) update({ tab: initialTab });
window.addEventListener('hashchange', () => { const tab = location.hash.slice(1); if (['trend', 'programmes', 'periods', 'data'].includes(tab)) update({ tab }); });
window.addEventListener('pagehide', () => { clearTimeout(saveTimer); persist(); viewer.dispose(); periods.dispose(); importer.close(); db.close(); if (originalURL) URL.revokeObjectURL(originalURL); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
await reload().catch(error => status(error.message));

