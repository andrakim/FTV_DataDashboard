import { db } from './core/db.js';
import { parseBroadcastTime, FTV_CHANNEL, BROADCAST_START, BROADCAST_END } from './core/normalization.js';
import { state } from './core/state.js';
import { createImportClient } from './core/importClient.js';
import { restoreSimpleView, validateSimpleView } from './core/simpleView.js';
import { validateBackup, restoreWorkspace } from './core/workspace.js';
import { buildProgramCatalog, summarizePrograms } from './analytics/programs.js';
import { createAiringIndex, describeAiring, averageViewers, programmeKey } from './analytics/airingExplorer.js';
import { initialTrendFilters, buildTrendDays, trendProgrammes, shiftDate, programmesAtTime } from './analytics/trendExplorer.js';
import { detectSlotDrops, attributeCompetitors, demographicLoss } from './analytics/dropDetector.js';
import { analyzeRecurrence } from './analytics/recurrence.js';
import { ANNOTATION_TAGS, createAnnotation, validateAnnotations, summarizeAnnotations } from './analytics/annotations.js';
import { createScanViewer } from './ui/scanViewer.js';
import { SCAN_CHANNELS } from './ui/scanGeometry.js';
import { createPeriodModule } from './ui/periodModule.js';
import { renderProgramHistory, disposeChart } from './ui/charts.js';
import { escapeHTML as e, number, dateLabel, timeLabel, preciseTimeLabel, WEEKDAYS, WEEKDAY_NAMES, csvContent } from './ui/format.js';

const TRIGGER_LABELS = {
  leadInDrop: 'Обвал на стыке ≤70%',
  primeUnderperformance: 'Просадка прайма',
  midBlockValley: 'Яма в связке',
};

const TOOL_HINTS = {
  inspect: 'Один момент во всех датах · координаты X (доля) и Y (время) синхронны · клик открывает детали',
  pin: 'Режим меток: кликните в любую точку графика, чтобы поставить метку (X · Y) и рассчитать тенденцию',
  trend: 'Режим линии тренда: кликните начальную и конечную точку на графике для расчёта наклона и динамики',
  hline: 'Режим среза времени: кликните по графику, чтобы провести сквозную горизонтальную линию через все дни',
  vline: 'Режим порога доли: кликните по графику, чтобы отметить целевую вертикальную планку рейтинга/доли',
};

const $ = id => document.getElementById(id), importer = createImportClient();
const dirtyFields = new Set();
let data = { daily_metrics: [], grid_10min: [], program_logs: [] }, scans = new Map(), dailyByDate = new Map(), catalog = [], byId = new Map(), dropsById = new Map(), index = createAiringIndex([], data), days = [];
let programPage = 1, programViewMode = 'airings', cardsPerPage = 5, activeTool = 'inspect', savedZoomWindow = null;
let annotations = [], isFullscreen = false;
let busy = false, renderPending = false, originalURL = null, statusTimer, saveTimer, lastImportedDates = [];

try {
  const savedAnn = localStorage.getItem('FTV_Scan_Annotations_v1');
  if (savedAnn) annotations = validateAnnotations(JSON.parse(savedAnn));
} catch { annotations = []; }

function saveAnnotations() {
  try { localStorage.setItem('FTV_Scan_Annotations_v1', JSON.stringify(annotations)); } catch {}
}

const view = () => state.getState().simpleView, filters = () => view().filters;
const sourceBadge = row => `<span class="badge ${row.approximate ? 'approx' : ''}">${row.approximate ? '≈ Сетка' : 'Точный выход'}</span>`;
const painBadges = row => {
  const drop = dropsById.get(row.id);
  if (!drop?.triggers?.length) return '';
  return drop.triggers.map(t => `<span class="pain-pill" title="Детектор провалов слота">▼ ${e(TRIGGER_LABELS[t] ?? t)}</span>`).join('');
};

const viewer = createScanViewer($('scan-viewer'), {
  getScan: date => scans.get(date),
  getDailyShare: (dateISO, channel) => {
    const row = dailyByDate.get(dateISO);
    if (!row) return null;
    return channel === FTV_CHANNEL ? row.ftv_18_54?.share : (row.competitorsDaily?.[channel]?.audiences?.['18-54']?.share ?? row.competitorsDaily?.[channel]?.share ?? null);
  },
  getDrop: id => dropsById.get(id),
  getAnnotations: () => annotations,
  getTool: () => activeTool,
  onAnnotate: raw => {
    const tag = $('ann-tag')?.value ?? 'note';
    const note = $('ann-note')?.value.trim() ?? '';
    const matches = raw.dateISO && raw.timeSec != null ? programmesAtTime(catalog, raw.dateISO, raw.timeSec, raw.channel) : [];
    const defaultLabel = note || (matches[0]?.title ? matches[0].title.slice(0, 28) : '');
    const created = createAnnotation({ ...raw, tag, label: defaultLabel });
    annotations = [...annotations, created];
    if ($('ann-note')) $('ann-note').value = '';
    saveAnnotations();
    viewer.refreshAnnotations();
    renderAnnotationSummary();
  },
  onDeleteAnnotation: id => {
    annotations = annotations.filter(item => item.id !== id);
    saveAnnotations();
    viewer.refreshAnnotations();
    renderAnnotationSummary();
  },
  onOpen: openOriginal, onProgram: openProgram, onTime: openMoment, onError: error => status(error.message),
});

const periods = createPeriodModule($('period-module'), { onError: error => status(error.message) });
function status(message = '', error = true) { clearTimeout(statusTimer); $('status').hidden = !message; $('status').textContent = message; $('status').classList.toggle('info', !error); if (message && !error) statusTimer = setTimeout(() => { $('status').hidden = true; }, 6000); }
function update(patch) { try { const next = { ...view(), ...patch }; validateSimpleView(next); if (JSON.stringify(next) !== JSON.stringify(view())) state.setState({ simpleView: next }); status(); } catch (error) { status(error.message); } }
function updateFilters(patch) { const next = { ...filters(), ...patch }; programPage = 1; update({ filters: next, page: 1 }); }
function navigate(tab) { if (isFullscreen && tab !== 'trend') setFullscreen(false); update({ tab }); window.history.replaceState(null, '', `#${tab}`); }
function sync(id, value) { if ($(id) && document.activeElement !== $(id) && !dirtyFields.has(id)) $(id).value = value ?? ''; }
function readTime(id) { const text = $(id).value.trim(); if (!/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.test(text)) throw new Error('Задайте время как 18:00 или 18:00:30. После полуночи можно вводить 01:00 или 25:00.'); return parseBroadcastTime(text).totalSeconds; }
function discardDraft() { dirtyFields.clear(); $('filter-pending').hidden = true; }
function applyFilters(patch = {}) { try { const next = { ...filters(), from: $('date-from').value || null, to: $('date-to').value || null, startSec: readTime('time-start'), endSec: readTime('time-end'), title: $('programme').value.trim(), channel: $('channel').value, ...patch }; validateSimpleView({ ...view(), filters: next }); discardDraft(); updateFilters(next); schedule(); return true; } catch (error) { status(error.message); return false; } }
function availableDates() { return [...new Set([...scans.keys(), ...index.dates, ...data.daily_metrics.map(row => row.dateISO)])].sort(); }
function displayedDays() { return view().onlyScans ? days.filter(day => day.hasScan) : days; }
function currentSlice() {
  const shown = displayedDays(), pages = Math.max(1, Math.ceil(shown.length / cardsPerPage)), page = Math.min(view().page, pages);
  return { shown, pages, page, slice: shown.slice((page - 1) * cardsPerPage, page * cardsPerPage) };
}

function setFullscreen(nextState) {
  isFullscreen = Boolean(nextState);
  const panel = $('trend-panel');
  if (!panel) return;
  panel.classList.toggle('is-fullscreen', isFullscreen);
  document.body.classList.toggle('has-fullscreen-trend', isFullscreen);
  document.querySelectorAll('[data-toggle-fullscreen]').forEach(btn => {
    if (!btn.classList.contains('fs-exit-btn')) {
      btn.textContent = isFullscreen ? '✕ Обычный вид' : '⛶ Во весь экран';
    }
  });
  if (isFullscreen && filters().weekdays.length === 7 && cardsPerPage < 7) {
    cardsPerPage = 7;
    if ($('page-size')) $('page-size').value = '7';
  }
  schedule();
}

function setAnnotationTool(tool) {
  activeTool = TOOL_HINTS[tool] ? tool : 'inspect';
  viewer.cancelPending();
  document.querySelectorAll('[data-ann-tool]').forEach(btn => {
    const active = btn.dataset.annTool === activeTool;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  if ($('ann-tag')) $('ann-tag').hidden = activeTool !== 'pin';
  if ($('ann-note')) $('ann-note').hidden = activeTool === 'inspect';
  if ($('board-hint')) $('board-hint').textContent = TOOL_HINTS[activeTool];
  $('scan-viewer')?.setAttribute('data-active-tool', activeTool);
}

function renderDropJumpBar(slice) {
  const bar = $('drop-jump-bar');
  if (!bar) return;
  const dropItems = [];
  for (const day of slice) {
    for (const row of day.matches) {
      const drop = dropsById.get(row.id);
      if (drop?.triggers?.length) dropItems.push({ day, row, drop });
    }
  }
  if (!dropItems.length && !savedZoomWindow) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  const restoreBtn = savedZoomWindow ? `<button type="button" class="chip is-active" data-restore-zoom>↺ Вернуть окно ${timeLabel(savedZoomWindow.startSec)}–${timeLabel(savedZoomWindow.endSec)}</button>` : '';
  bar.innerHTML = `<div class="drop-jump-header"><strong>▼ Обвалы в текущем окне (${dropItems.length})</strong><span>Нажмите, чтобы сразу перейти к минуте обвала на графике без прокрутки вниз или приблизить слот ±30 мин</span>${restoreBtn}</div><div class="drop-jump-list">${dropItems.map(({ day, row, drop }) => {
    const ret = Number.isFinite(drop.leadInRetention) ? `Вход ${number(drop.leadInRetention, 0)}%` : TRIGGER_LABELS[drop.triggers[0]] ?? 'Провал';
    const delta = Number.isFinite(drop.deltaShare) ? ` (${drop.deltaShare > 0 ? '+' : '−'}${number(Math.abs(drop.deltaShare), 1)} п.п.)` : '';
    return `<div class="drop-jump-item"><button type="button" class="drop-jump-main" data-scroll-time="${row.startSec}" title="Прокрутить график к ${timeLabel(row.startSec)}"><b>${WEEKDAYS[day.weekday - 1]} ${dateLabel(day.dateISO)} · ${timeLabel(row.startSec)}</b><span>${e(row.title.slice(0, 26))}</span><em>${e(ret)}${delta}</em></button><button type="button" class="drop-jump-action" data-zoom-drop="${row.startSec},${row.endSec}" title="Приблизить этот слот (±30 мин)">🎯 ±30м</button><button type="button" class="drop-jump-action" data-open-program-jump="${e(row.id)}" title="Открыть подробный разбор программы">Разбор ↗</button></div>`;
  }).join('') || '<span class="sub">В текущем приближении обвалов не найдено.</span>'}</div>`;
}

function renderAnnotationSummary() {
  const box = $('annotation-summary');
  if (!box) return;
  const { slice } = currentSlice();
  const q = filters();
  const summary = summarizeAnnotations(annotations, {
    channel: q.channel,
    dates: slice.map(d => d.dateISO),
    startSec: q.startSec,
    endSec: q.endSec,
    catalog,
  });
  const hasAny = summary.totalForChannel > 0;
  if ($('export-annotations')) $('export-annotations').hidden = !hasAny;
  if ($('clear-annotations')) $('clear-annotations').hidden = !hasAny;
  if (!summary.visibleCount) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const blocks = [];
  if (summary.pinTrend) {
    const pt = summary.pinTrend;
    const sign = pt.deltaScale > 0 ? '+' : pt.deltaScale < 0 ? '−' : '';
    const pctSign = pt.relativePercent > 0 ? '+' : pt.relativePercent < 0 ? '−' : '';
    const dirClass = pt.direction === 'up' ? 'delta-positive' : pt.direction === 'down' ? 'delta-negative' : '';
    const dirLabel = pt.direction === 'up' ? '↗ Рост по меткам' : pt.direction === 'down' ? '↘ Спад по меткам' : '→ Стабильный уровень';
    blocks.push(`<div class="ann-insight-card"><strong>${dirLabel} (${pt.count} меток)</strong><p>С ${dateLabel(pt.first.dateISO)} (${timeLabel(pt.first.timeSec)}, шкала <b>${number(pt.first.scaleValue, 1)}</b>) к ${dateLabel(pt.last.dateISO)} (${timeLabel(pt.last.timeSec)}, шкала <b>${number(pt.last.scaleValue, 1)}</b>): <span class="${dirClass}">${sign}${number(Math.abs(pt.deltaScale), 1)} ед.${pt.relativePercent != null ? ` (${pctSign}${number(Math.abs(pt.relativePercent), 1)}%)` : ''}</span> · Среднее: <b>${number(pt.meanScale, 1)}</b> · Мин: <b>${number(pt.minPin.scaleValue, 1)}</b> (${dateLabel(pt.minPin.dateISO)}) · Пик: <b>${number(pt.maxPin.scaleValue, 1)}</b> (${dateLabel(pt.maxPin.dateISO)})</p></div>`);
  }
  if (summary.trendLines.length) {
    blocks.push(`<div class="ann-insight-card"><strong>📈 Линии тренда (${summary.trendLines.length})</strong><div class="ann-chip-list">${summary.trendLines.map(t => {
      const sign = t.deltaScale > 0 ? '+' : t.deltaScale < 0 ? '−' : '';
      const cls = t.direction === 'up' ? 'delta-positive' : t.direction === 'down' ? 'delta-negative' : '';
      return `<span class="ann-summary-chip"><button type="button" class="text-button" data-scroll-time="${t.startSec}">${dateLabel(t.dateISO)} ${timeLabel(t.startSec)}–${timeLabel(t.endSec)}</button>: <b class="${cls}">${t.direction === 'up' ? '↗' : t.direction === 'down' ? '↘' : '→'} ${sign}${number(Math.abs(t.deltaScale), 1)} ед.</b> (${number(t.durationMin, 0)} мин, ${t.slopePerHour >= 0 ? '+' : '−'}${number(Math.abs(t.slopePerHour), 1)} ед./ч)${t.programme ? ` · <em>${e(t.programme.slice(0, 22))}</em>` : ''}<button type="button" class="ann-chip-del" data-del-ann="${e(t.id)}" title="Удалить">×</button></span>`;
    }).join('')}</div></div>`);
  }
  if (summary.timeSlices.length) {
    blocks.push(`<div class="ann-insight-card"><strong>📏 Срезы времени (${summary.timeSlices.length})</strong><div class="ann-chip-list">${summary.timeSlices.map(s => `<span class="ann-summary-chip"><button type="button" class="text-button" data-scroll-time="${s.timeSec}">${timeLabel(s.timeSec)} (${e(s.label)})</button> · средняя доля программ по дням: <b>${s.avgShare != null ? `${number(s.avgShare)}%` : '—'}</b><button type="button" class="ann-chip-del" data-del-ann="${e(s.id)}" title="Удалить">×</button></span>`).join('')}</div></div>`);
  }
  if (summary.pins.length) {
    blocks.push(`<div class="ann-chip-list">${summary.pins.map(pin => {
      const tagInfo = ANNOTATION_TAGS[pin.tag] ?? ANNOTATION_TAGS.note;
      return `<span class="ann-summary-chip" style="border-left:3px solid ${tagInfo.color}"><button type="button" class="text-button" data-scroll-time="${pin.timeSec}">${dateLabel(pin.dateISO)} ${timeLabel(pin.timeSec)}</button> <b>X=${number(pin.scaleValue, 1)}</b> · ${e(tagInfo.label)}${pin.label ? ` · <em>${e(pin.label)}</em>` : ''}${pin.programmeShare != null ? ` (доля прогр. ${number(pin.programmeShare)}%)` : ''}<button type="button" class="ann-chip-del" data-del-ann="${e(pin.id)}" title="Удалить">×</button></span>`;
    }).join('')}</div>`);
  }
  box.innerHTML = blocks.join('');
}

function programOptions() {
  const signal = $('program-signal')?.value ?? 'all';
  return { search: $('program-search').value, sort: $('program-sort').value, source: $('program-source').value, ...(signal !== 'all' ? { signal } : {}) };
}
function selectedProgrammes() {
  const opts = programOptions();
  let rows = trendProgrammes(days, { search: opts.search, sort: opts.sort === 'retention-asc' ? 'time' : opts.sort, source: opts.source });
  const signal = $('program-signal')?.value ?? 'all';
  if (signal !== 'all') {
    rows = rows.filter(row => {
      const drop = dropsById.get(row.id);
      if (!drop?.triggers?.length) return false;
      return signal === 'pain' ? true : drop.triggers.includes(signal);
    });
  }
  if (opts.sort === 'retention-asc') {
    rows = [...rows].sort((a, b) => {
      const ra = dropsById.get(a.id)?.leadInRetention, rb = dropsById.get(b.id)?.leadInRetention;
      const aFin = Number.isFinite(ra), bFin = Number.isFinite(rb);
      if (aFin !== bFin) return aFin ? -1 : 1;
      if (aFin && ra !== rb) return ra - rb;
      return a.dateISO.localeCompare(b.dateISO) || a.startSec - b.startSec;
    });
  }
  return rows;
}
function resetFilters() {
  $('program-search').value = ''; $('program-sort').value = 'time'; $('program-source').value = 'all';
  if ($('program-signal')) $('program-signal').value = 'all';
  cardsPerPage = 5; if ($('page-size')) $('page-size').value = '5';
  savedZoomWindow = null;
  discardDraft(); update({ onlyScans: false }); updateFilters(initialTrendFilters([...scans.keys()], index.dates));
}
function download(content, name, type = 'text/csv;charset=utf-8') { const url = URL.createObjectURL(new Blob([content], { type })), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function persist() { try { localStorage.setItem('FTV_Simple_View_v1', JSON.stringify(view())); } catch { status('Не удалось сохранить настройки браузера.'); } }

async function reload() {
  const loaded = await Promise.all([db.loadData(), db.getAll('media_scans')]); data = loaded[0]; scans = new Map(loaded[1].map(row => [row.dateISO, row]));
  dailyByDate = new Map(data.daily_metrics.map(row => [row.dateISO, row]));
  catalog = buildProgramCatalog(data); byId = new Map(catalog.map(row => [row.id, row])); index = createAiringIndex(catalog, data);
  dropsById = new Map();
  const approxCatalog = catalog.filter(row => row.approximate);
  for (const channel of SCAN_CHANNELS) {
    for (const drop of detectSlotDrops(data, { channel, includeHealthy: true })) {
      dropsById.set(drop.program.id, drop);
      dropsById.set(`${drop.program.dateISO}_${drop.program.channel}_${drop.program.startSec}`, drop);
    }
    if (approxCatalog.length) {
      for (const drop of detectSlotDrops({ ...data, program_logs: approxCatalog }, { channel, includeHealthy: true })) {
        if (!dropsById.has(drop.program.id)) dropsById.set(drop.program.id, drop);
        const key = `${drop.program.dateISO}_${drop.program.channel}_${drop.program.startSec}`;
        if (!dropsById.has(key)) dropsById.set(key, drop);
      }
    }
  }
  viewer.clearCache();
  if (!filters().from || !filters().to) updateFilters(initialTrendFilters([...scans.keys()], index.dates));
  schedule();
}
function renderFilters() {
  const q = filters();
  for (const [id, value] of Object.entries({ 'date-from': q.from, 'date-to': q.to, 'time-start': q.startSec % 60 ? preciseTimeLabel(q.startSec) : timeLabel(q.startSec), 'time-end': q.endSec % 60 ? preciseTimeLabel(q.endSec) : timeLabel(q.endSec), programme: q.title, channel: q.channel, 'fs-channel': q.channel, 'scan-scale': view().scale, 'page-size': String(cardsPerPage) })) sync(id, value);
  $('weekdays').innerHTML = WEEKDAYS.map((name, i) => `<button data-weekday="${i + 1}" class="${q.weekdays.includes(i + 1) ? 'is-active' : ''}" aria-pressed="${q.weekdays.includes(i + 1)}">${name}</button>`).join('');
  const names = [...new Set(catalog.filter(row => row.channel === q.channel).map(row => row.title))].sort((a, b) => a.localeCompare(b, 'ru'));
  $('programme-options').replaceChildren(...names.map(title => new Option(title, title)));
  $('only-scans').checked = view().onlyScans;
  $('filter-summary').textContent = `${dateLabel(q.from)} — ${dateLabel(q.to)} · ${timeLabel(q.startSec)}–${timeLabel(q.endSec)} · ${q.channel}`;
  $('clear-programme').hidden = !q.title;
  if ($('full-week-btn')) $('full-week-btn').classList.toggle('is-active', q.weekdays.length === 7 && cardsPerPage === 7);
  document.querySelectorAll('[data-window], [data-fs-window]').forEach(button => { const raw = button.dataset.window || button.dataset.fsWindow; const [start, end] = raw.split(',').map(Number), selected = q.startSec === start && q.endSec === end; button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', selected); });
}
function renderTrend() {
  const q = filters(), { shown, pages, page, slice } = currentSlice(), scanCount = days.filter(day => day.hasScan).length, rows = trendProgrammes(days);
  const painCount = rows.filter(row => dropsById.get(row.id)?.triggers?.length).length;
  $('trend-heading').textContent = q.title || `Тенденция ${q.channel}`;
  $('trend-scope').textContent = `${timeLabel(q.startSec)}–${timeLabel(q.endSec)} · ${q.weekdays.map(day => WEEKDAYS[day - 1]).join(', ') || 'Дни не выбраны'} · ${scanCount} графиков / ${days.length} дат`;
  const pageText = shown.length ? `${dateLabel(slice[0].dateISO)} — ${dateLabel(slice.at(-1).dateISO, true)} · даты ${(page - 1) * cardsPerPage + 1}–${Math.min(page * cardsPerPage, shown.length)} из ${shown.length}` : 'Нет дат по выбранным условиям';
  $('page-description').textContent = pageText;
  if ($('bottom-page-status')) $('bottom-page-status').textContent = pageText;
  $('previous-dates').disabled = page <= 1; $('next-dates').disabled = page >= pages;
  if ($('prev-dates-bottom')) $('prev-dates-bottom').disabled = page <= 1;
  if ($('next-dates-bottom')) $('next-dates-bottom').disabled = page >= pages;
  $('selection-summary').innerHTML = `<div><strong>${days.length}</strong><span>дат в выбранном периоде</span></div><div><strong>${scanCount}<small>/ ${days.length}</small></strong><span>исходных графиков</span></div><div><strong>${rows.length}</strong><span>выходов в этом окне</span></div><div><strong>${rows.filter(row => !row.approximate).length}<small>/ ${rows.length}</small></strong><span>выходов из точного TOP${painCount ? ` · <b class="pain-inline-count">${painCount} с провалом</b>` : ''}</span></div>`;
  $('scan-availability').hidden = !days.length || scanCount === days.length;
  $('scan-availability').innerHTML = `<span>Нет исходного графика за ${days.length - scanCount} из ${days.length} выбранных дат. Нужны ежедневные отчёты.</span><div>${scanCount && !view().onlyScans ? '<button class="text-button" data-show-available>Показать доступные</button>' : ''}<button class="text-button" data-module="data">Проверить данные →</button></div>`;
  renderDropJumpBar(slice);
  renderAnnotationSummary();
  viewer.render(slice, q, view().scale).catch(error => status(error.message));
  if (!shown.length) $('scan-viewer').innerHTML = `<div class="selection-empty"><strong>${!q.weekdays.length ? 'Дни недели не выбраны' : view().onlyScans ? 'В выбранные даты нет исходных графиков' : 'Укажите период для сравнения'}</strong><p>${!q.weekdays.length ? 'Выберите дни кнопками над графиком.' : 'Измените период или добавьте ежедневные отчёты.'}</p><div><button class="button secondary" data-reset-selection>Сбросить фильтры</button>${view().onlyScans ? '<button class="text-button" data-show-missing>Показать даты без графика</button>' : ''}<button class="text-button" data-module="data">Открыть данные →</button></div></div>`;
}
function renderProgrammes() {
  document.querySelectorAll('[data-program-mode]').forEach(btn => {
    const active = btn.dataset.programMode === programViewMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active);
  });
  const rows = selectedProgrammes(), totalAll = trendProgrammes(days).length;
  const painTotal = rows.filter(row => dropsById.get(row.id)?.triggers?.length).length;
  $('export-programmes').disabled = !rows.length;
  $('programmes-scope').textContent = `${rows.length} выходов · ${new Set(rows.map(row => row.dateISO)).size} дней · ${timeLabel(filters().startSec)}–${timeLabel(filters().endSec)} · 18–54${painTotal ? ` · провалов слота: ${painTotal}` : ''}`;

  if (programViewMode === 'summary') {
    const groups = summarizePrograms(rows);
    const sort = $('program-sort').value;
    groups.sort((a, b) => {
      if (sort === 'share-desc' || sort === 'share-asc') {
        const aFin = Number.isFinite(a.share), bFin = Number.isFinite(b.share);
        if (aFin !== bFin) return aFin ? -1 : 1;
        if (aFin && a.share !== b.share) return sort === 'share-desc' ? b.share - a.share : a.share - b.share;
      }
      return b.count - a.count || a.title.localeCompare(b.title, 'ru');
    });
    const pages = Math.max(1, Math.ceil(groups.length / 40)); programPage = Math.min(programPage, pages);
    $('program-result-count').textContent = `${groups.length} программ (${rows.length} выходов)`;
    $('programmes-table').innerHTML = `<thead><tr><th>Программа</th><th>Выходов</th><th>Средняя длит.</th><th>Средневзв. доля</th><th>Средний рейтинг</th><th>Источник / Провалы</th><th></th></tr></thead><tbody>${groups.slice((programPage - 1) * 40, programPage * 40).map(group => {
      const painHits = group.airings.filter(a => dropsById.get(a.id)?.triggers?.length).length;
      return `<tr data-program="${e(group.id)}" tabindex="0"><td><strong>${e(group.title)}</strong><span class="sub">Последний эфир: ${dateLabel(group.lastDate, true)}</span></td><td class="number">${group.count}<span class="sub">${group.dayCount} дн.</span></td><td class="number">${number(group.durationMin, 0)} мин</td><td class="number">${number(group.share)}%</td><td class="number">${number(group.rtg)}%</td><td>${sourceBadge(group.airings[0])}${painHits ? `<span class="pain-pill">▼ Провалов: ${painHits}</span>` : ''}</td><td><button class="text-button" data-filter-title="${e(group.title)}">Все выходы →</button></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty-cell">Нет программ по выбранным условиям.<br><button class="text-button" data-clear-program-search>Очистить поиск</button> · <button class="text-button" data-reset-selection>Сбросить фильтры</button></td></tr>'}</tbody>`;
    $('programmes-pagination').innerHTML = `<span>${groups.length} программ · страница ${programPage} / ${pages}</span><div><button class="button secondary" data-program-page="${programPage - 1}" ${programPage <= 1 ? 'disabled' : ''}>←</button><button class="button secondary" data-program-page="${programPage + 1}" ${programPage >= pages ? 'disabled' : ''}>→</button></div>`;
    return;
  }

  const pages = Math.max(1, Math.ceil(rows.length / 40)); programPage = Math.min(programPage, pages);
  $('program-result-count').textContent = `${rows.length} из ${totalAll} выходов`;
  $('programmes-table').innerHTML = `<thead><tr><th>Дата</th><th>Время</th><th>Программа</th><th>Доля</th><th>Средние зрители</th><th>Источник</th><th></th></tr></thead><tbody>${rows.slice((programPage - 1) * 40, programPage * 40).map(row => {
    const drop = dropsById.get(row.id);
    const retentionSub = Number.isFinite(drop?.leadInRetention) ? `<span class="sub">Вход: ${number(drop.leadInRetention, 0)}%</span>` : '';
    return `<tr data-program="${e(row.id)}" tabindex="0" class="${drop?.triggers?.length ? 'row-pain' : ''}"><td>${dateLabel(row.dateISO, true)}<span class="sub">${WEEKDAYS[new Date(`${row.dateISO}T00:00:00Z`).getUTCDay() === 0 ? 6 : new Date(`${row.dateISO}T00:00:00Z`).getUTCDay() - 1]}</span></td><td class="number">${preciseTimeLabel(row.startSec)}<span class="sub">до ${preciseTimeLabel(row.endSec)}</span></td><td><strong>${e(row.title)}</strong></td><td class="number">${number(row.share)}%</td><td class="number">${number(averageViewers(row), 0)}</td><td>${sourceBadge(row)}${painBadges(row)}${retentionSub}</td><td><button class="text-button" data-program="${e(row.id)}">Подробнее →</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty-cell">Нет выходов по выбранным условиям.<br><button class="text-button" data-clear-program-search>Очистить поиск</button> · <button class="text-button" data-reset-selection>Сбросить фильтры</button></td></tr>'}</tbody>`;
  $('programmes-pagination').innerHTML = `<span>${rows.length} выходов · страница ${programPage} / ${pages}</span><div><button class="button secondary" data-program-page="${programPage - 1}" ${programPage <= 1 ? 'disabled' : ''}>←</button><button class="button secondary" data-program-page="${programPage + 1}" ${programPage >= pages ? 'disabled' : ''}>→</button></div>`;
}
function renderData() {
  $('data-scope').textContent = `${data.daily_metrics.length} дней истории · ${scans.size} исходных графиков · ${data.program_logs.length} точных выходов`;
  const allDates = [...new Set([...index.dates, ...scans.keys()])].sort().reverse(), daily = new Map(data.daily_metrics.map(row => [row.dateISO, row])), gridDates = new Set(data.grid_10min.map(row => row.dateISO)), logDates = new Set(data.program_logs.map(row => row.dateISO));
  if ($('clear-db')) $('clear-db').disabled = !allDates.length;
  $('data-table').innerHTML = `<thead><tr><th>Дата</th><th>Дневные показатели</th><th>Исходный график</th><th>Расписание TOP</th><th>Сетка</th><th></th></tr></thead><tbody>${allDates.map(date => {
    const row = daily.get(date), audiences = [['ftv_18_54', '18–54'], ['ftv_25_34', '25–34']].filter(([key]) => Object.values(row?.[key] ?? {}).some(Number.isFinite)).map(([, label]) => label);
    return `<tr><td>${dateLabel(date, true)}</td><td>${audiences.length ? `<span class="badge">${audiences.join(' · ')}</span>` : '—'}</td><td>${scans.has(date) ? `<button class="text-button" data-original="${date}">Открыть график ↗</button>` : '<span class="sub">Нет — нужен ежедневный отчёт</span>'}</td><td>${logDates.has(date) ? '<span class="badge">Есть</span>' : '—'}</td><td>${gridDates.has(date) ? '<span class="badge approx">Есть ≈</span>' : '—'}</td><td class="data-actions">${scans.has(date) || gridDates.has(date) || logDates.has(date) ? `<button class="text-button" data-view-date="${date}">Смотреть эфир →</button>` : ''}<button class="text-button danger-text" data-delete-date="${date}" title="Удалить данные за эту дату">Удалить ×</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty-cell">Добавьте Excel-отчёты или восстановите резервную копию.</td></tr>'}</tbody>`;
}
function render() {
  const w = view(), hasData = !!(data.daily_metrics.length || scans.size || catalog.length);
  $('empty-state').hidden = hasData || w.tab === 'data'; $('app-content').hidden = !hasData && w.tab !== 'data'; $('dataset-status').textContent = `${scans.size} графиков · ${data.daily_metrics.length} дней истории`;
  document.querySelectorAll('[data-module]').forEach(button => { const selected = button.dataset.module === w.tab; button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', selected); });
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== w.tab; });
  $('view-filters').hidden = !hasData || !['trend', 'programmes'].includes(w.tab);
  $('backup').disabled = !hasData;
  if (!hasData) { if (w.tab === 'data') renderData(); return; }
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

function renderDemographicsBlock(row, previous) {
  const demo = row?.demographics;
  if (!demo || !demo.segments) return '';
  const loss = demographicLoss(previous, row);
  const segEntries = Object.entries(demo.segments).filter(([, v]) => Number.isFinite(v));
  if (!segEntries.length && !Number.isFinite(demo.total)) return '';
  const maxVal = Math.max(0.01, ...segEntries.map(([, v]) => v));
  const lossMap = new Map((loss?.segments ?? []).map(s => [s.segment, s.delta000]));
  return `<div class="demo-panel">
    <div class="demo-header">
      <h3>Демографический профиль (тыс. зрителей)</h3>
      <div class="demo-totals">
        <span>Все 18–54: <strong>${number(demo.total, 2)} тыс.</strong></span>
        ${Number.isFinite(demo.male) ? `<span>Мужчины: <strong>${number(demo.male, 2)} тыс.</strong></span>` : ''}
        ${Number.isFinite(demo.female) ? `<span>Женщины: <strong>${number(demo.female, 2)} тыс.</strong></span>` : ''}
      </div>
    </div>
    ${loss?.leadingLosses?.length ? `<p class="demo-loss-alert">Отток на стыке к предыдущей программе: <strong>−${number(loss.lostViewers000, 2)} тыс.</strong> · основные потери: ${loss.leadingLosses.map(item => `<b>${e(item.segment)} (−${number(item.loss000, 2)} тыс.)</b>`).join(', ')}</p>` : ''}
    <div class="demo-grid">${segEntries.map(([seg, val]) => {
      const pct = Math.min(100, Math.round((val / maxVal) * 100));
      const delta = lossMap.get(seg);
      const deltaText = Number.isFinite(delta) && delta !== 0 ? `<small class="${delta < 0 ? 'delta-negative' : 'delta-positive'}">${delta > 0 ? '+' : '−'}${number(Math.abs(delta), 2)}</small>` : '';
      return `<div class="demo-bar-item"><div class="demo-bar-label"><span>${e(seg)}</span><strong>${number(val, 2)} ${deltaText}</strong></div><div class="demo-bar-track"><div class="demo-bar-fill ${seg.startsWith('W') ? 'is-female' : 'is-male'}" style="width:${pct}%"></div></div></div>`;
    }).join('')}</div>
  </div>`;
}

function openProgram(id, moment) {
  const row = byId.get(id); if (!row) return;
  const oldChart = $('detail-history-chart'); if (oldChart) disposeChart(oldChart);
  const context = describeAiring(index, row, { competitors: SCAN_CHANNELS });
  const drop = dropsById.get(row.id);
  const compAttrs = new Map(attributeCompetitors(row, data, { channel: row.channel, includeNonGrowing: true }).map(item => [item.channel, item]));
  $('detail-title').textContent = row.title;
  const neighbor = (program, label, viewers) => `<div><span>${label}</span><strong>${program ? e(program.title) : 'Нет соседней записи'}</strong><small>${program ? `${timeLabel(program.startSec)}–${timeLabel(program.endSec)} · ${number(program.share)}% · ${number(viewers, 0)} чел.` : 'Измерение отсутствует'}</small></div>`;
  const recurrence = analyzeRecurrence(data, { mode: 'program', title: row.title, channel: row.channel, from: filters().from, to: filters().to, dayOfWeek: new Date(`${row.dateISO}T00:00:00Z`).getUTCDay() || 7, startSec: filters().startSec, endSec: filters().endSec, includeApproximate: false });
  const result = recurrence.groups[0], labels = { systematic: 'Повторяющийся провал', isolated: 'Возможная разовая аномалия', mixed: 'Нерегулярные провалы', noSignal: 'Провал по выбранному правилу не выявлен', insufficient: 'Недостаточно сопоставимых дат: нужно минимум 5' };
  const painBanner = drop?.triggers?.length ? `<div class="pain-banner"><strong>Обнаружен провал слота: ${drop.triggers.map(t => e(TRIGGER_LABELS[t] ?? t)).join(' · ')}</strong><p>Изменение доли к предыдущей программе: <b>${drop.deltaShare != null ? `${drop.deltaShare > 0 ? '+' : '−'}${number(Math.abs(drop.deltaShare))} п.п.` : '—'}</b>${Number.isFinite(drop.daypartBenchmark) ? ` · норма тайм-блока за день: <b>${number(drop.daypartBenchmark)}%</b> (отклонение ${drop.deviationFromDaypart > 0 ? '+' : '−'}${number(Math.abs(drop.deviationFromDaypart))} п.п.)` : ''}</p></div>` : '';
  const historyRows = catalog.filter(item => item.channel === row.channel && item.audience === row.audience && programmeKey(item.title) === programmeKey(row.title) && Number.isFinite(item.share)).sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.startSec - b.startSec);

  $('detail-content').innerHTML = `<p class="detail-meta">${e(row.channel)} · ${dateLabel(row.dateISO, true)} · ${preciseTimeLabel(row.startSec)}–${preciseTimeLabel(row.endSec)}${moment != null ? ` · момент на графике ≈${timeLabel(moment)}` : ''}</p>${sourceBadge(row)}${painBadges(row)}${painBanner}<div class="detail-metrics"><div><span>Средняя доля</span><strong>${number(row.share)}%</strong></div><div><span>Средние зрители</span><strong>${number(context.viewers, 0)}</strong></div><div><span>Удержание входа</span><strong>${number(context.leadInRetention, 0)}%</strong></div><div><span>Удержание выхода</span><strong>${number(context.leadOutRetention, 0)}%</strong></div></div><div class="detail-flow">${neighbor(context.previous, 'Перед программой', context.previousViewers)}${neighbor(context.next, 'После программы', context.nextViewers)}</div>${renderDemographicsBlock(row, context.previous)}${historyRows.length >= 2 ? `<div class="detail-history-section"><h3>Динамика выпусков «${e(row.title)}» (${historyRows.length})</h3><div id="detail-history-chart" class="detail-chart"></div></div>` : ''}<h3>В это время у конкурентов</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>Канал</th><th>Программы</th><th>Доля за окно</th><th>Δ к входу</th></tr></thead><tbody>${context.competitors.map(item => {
    const attr = compAttrs.get(item.channel);
    const deltaCell = Number.isFinite(attr?.deltaShare)
      ? `<span class="${attr.deltaShare > 0 ? 'delta-positive' : attr.deltaShare < 0 ? 'delta-negative' : ''}">${attr.deltaShare > 0 ? '+' : attr.deltaShare < 0 ? '−' : ''}${number(Math.abs(attr.deltaShare))} п.п.${attr.deltaShare > 0.3 ? ' ↑' : ''}</span>`
      : '—';
    return `<tr><td>${e(item.channel)}<span class="sub">${item.source ? `${item.source === 'grid_10min' ? '≈ Сетка' : 'TOP'} · покрытие ${number(item.coverageFraction * 100, 0)}%${item.conflict ? ' · конфликт измерений' : ''}` : 'Нет измерения'}</span></td><td>${item.programmes.map(program => `${timeLabel(program.startSec)}–${timeLabel(program.endSec)} ${e(program.title)}`).join('<br>') || 'Нет расписания'}</td><td class="number">${number(item.share)}%</td><td class="number">${deltaCell}</td></tr>`;
  }).join('')}</tbody></table></div><p class="module-note">Числа — средние за программу/окно, не значения линии в выбранную минуту. «—» — нет измерения. Зрители — средняя аудитория, а не отслеженные переходы людей.</p><div class="detail-actions"><button class="button" data-only-program="${e(id)}">Показать эту программу по дням</button><button class="button secondary" data-same-weekday="${e(id)}">Все ${WEEKDAY_NAMES[(new Date(`${row.dateISO}T00:00:00Z`).getUTCDay() || 7) - 1]}</button></div><details><summary>Повторяется ли падение в этот день недели?</summary><p><strong>${labels[result.classification]}</strong></p><p class="module-note">Провалов к входу: ${result.signalDays} / ${result.eligibleDays} сопоставимых дат. Используются точные выходы в выбранном окне начала и периоде; удержание ≤70% при входной доле ≥1%. Пропуски и неоднозначные выпуски исключены. Это описательное правило.</p></details>`;
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
  if (historyRows.length >= 2 && $('detail-history-chart')) {
    renderProgramHistory($('detail-history-chart'), historyRows, { activeId: row.id, onSelect: nextId => openProgram(nextId) });
  }
}

$('channel').replaceChildren(...SCAN_CHANNELS.map(name => new Option(name, name)));
if ($('fs-channel')) $('fs-channel').replaceChildren(...SCAN_CHANNELS.map(name => new Option(name, name)));
setAnnotationTool('inspect');

document.addEventListener('click', async event => {
  const module = event.target.closest('[data-module]'); if (module) navigate(module.dataset.module);
  if (event.target.closest('[data-upload]')) $('files').click();
  if (event.target.closest('[data-restore]')) $('backup-file').click();
  if (event.target.closest('[data-toggle-fullscreen]')) { setFullscreen(!isFullscreen); return; }
  const toolBtn = event.target.closest('[data-ann-tool]');
  if (toolBtn) { setAnnotationTool(toolBtn.dataset.annTool); return; }
  const scrollTimeBtn = event.target.closest('[data-scroll-time]');
  if (scrollTimeBtn) { viewer.scrollToTime(Number(scrollTimeBtn.dataset.scrollTime)); return; }
  const zoomDropBtn = event.target.closest('[data-zoom-drop]');
  if (zoomDropBtn) {
    const [s, eSec] = zoomDropBtn.dataset.zoomDrop.split(',').map(Number);
    if (!savedZoomWindow) savedZoomWindow = { startSec: filters().startSec, endSec: filters().endSec };
    const startSec = Math.max(BROADCAST_START, Math.floor((s - 1800) / 600) * 600);
    const endSec = Math.min(BROADCAST_END, Math.ceil((eSec + 1800) / 600) * 600);
    applyFilters({ startSec, endSec });
    return;
  }
  if (event.target.closest('[data-restore-zoom]') && savedZoomWindow) {
    const prev = savedZoomWindow;
    savedZoomWindow = null;
    applyFilters(prev);
    return;
  }
  const jumpProgBtn = event.target.closest('[data-open-program-jump]');
  if (jumpProgBtn) { openProgram(jumpProgBtn.dataset.openProgramJump); return; }
  const summaryDelAnn = event.target.closest('#annotation-summary [data-del-ann]');
  if (summaryDelAnn) {
    annotations = annotations.filter(item => item.id !== summaryDelAnn.dataset.delAnn);
    saveAnnotations();
    viewer.refreshAnnotations();
    renderAnnotationSummary();
    return;
  }
  const modeBtn = event.target.closest('[data-program-mode]');
  if (modeBtn) { programViewMode = modeBtn.dataset.programMode; programPage = 1; renderProgrammes(); return; }
  const filterTitleBtn = event.target.closest('[data-filter-title]');
  if (filterTitleBtn) {
    $('program-search').value = filterTitleBtn.dataset.filterTitle;
    programViewMode = 'airings'; programPage = 1; renderProgrammes(); return;
  }
  const deleteDateBtn = event.target.closest('[data-delete-date]');
  if (deleteDateBtn && !busy) {
    const targetDate = deleteDateBtn.dataset.deleteDate;
    try { busy = true; await db.deleteDate(targetDate); await reload(); status(`Данные за ${dateLabel(targetDate, true)} удалены.`, false); }
    catch (error) { status(error.message); }
    finally { busy = false; }
    return;
  }
  const viewDate = event.target.closest('[data-view-date]'); if (viewDate) { discardDraft(); updateFilters({ from: viewDate.dataset.viewDate, to: viewDate.dataset.viewDate, weekdays: [1, 2, 3, 4, 5, 6, 7], title: '' }); navigate('trend'); }
  if (event.target.closest('[data-reset-selection]')) resetFilters();
  if (event.target.closest('[data-clear-program-search]')) { $('program-search').value = ''; $('program-source').value = 'all'; if ($('program-signal')) $('program-signal').value = 'all'; programPage = 1; renderProgrammes(); }
  if (event.target.closest('[data-show-available]')) update({ onlyScans: true, page: 1 });
  if (event.target.closest('[data-show-missing]')) update({ onlyScans: false, page: 1 });
  const datePreset = event.target.closest('[data-date-preset]');
  if (datePreset) { const dates = availableDates(), latest = [...scans.keys()].sort().at(-1) ?? dates.at(-1), all = datePreset.dataset.datePreset === 'all'; if (dates.length) applyFilters({ from: all ? dates[0] : shiftDate(latest, -6), to: all ? dates.at(-1) : latest, ...(all ? { weekdays: [1, 2, 3, 4, 5, 6, 7] } : {}) }); }
  if (event.target.closest('[data-open-imported]') && lastImportedDates.length) { discardDraft(); updateFilters({ from: lastImportedDates[0], to: lastImportedDates.at(-1), weekdays: [1, 2, 3, 4, 5, 6, 7], title: '' }); update({ onlyScans: true, tab: 'trend', page: 1 }); window.history.replaceState(null, '', '#trend'); }
  const close = event.target.closest('[data-close]'); if (close) $(close.dataset.close).close();
  const weekday = event.target.closest('[data-weekday]'); if (weekday) { const day = Number(weekday.dataset.weekday); applyFilters({ weekdays: filters().weekdays.includes(day) ? filters().weekdays.filter(value => value !== day) : [...filters().weekdays, day].sort() }); }
  const preset = event.target.closest('[data-window], [data-fs-window]'); if (preset) { savedZoomWindow = null; const raw = preset.dataset.window || preset.dataset.fsWindow; const [startSec, endSec] = raw.split(',').map(Number); applyFilters({ startSec, endSec }); }
  const week = event.target.closest('[data-shift-week], [data-bottom-shift-week]'); if (week && filters().from && filters().to) { const delta = Number(week.dataset.shiftWeek || week.dataset.bottomShiftWeek); applyFilters({ from: shiftDate(filters().from, delta), to: shiftDate(filters().to, delta) }); }
  const row = event.target.closest('[data-program]'); if (row && !event.target.closest('[data-filter-title]')) openProgram(row.dataset.program);
  const original = event.target.closest('#data-table [data-original]'); if (original) openOriginal(original.dataset.original);
  const single = event.target.closest('[data-only-program]'), same = event.target.closest('[data-same-weekday]');
  if (single || same) { const program = byId.get((single || same).dataset.onlyProgram || same.dataset.sameWeekday); $('detail-dialog').close(); discardDraft(); const dates = [...new Set(catalog.filter(row => row.channel === program.channel).map(row => row.dateISO))].sort(); updateFilters({ title: program.title, channel: program.channel, ...(same ? { from: dates[0], to: dates.at(-1), weekdays: [new Date(`${program.dateISO}T00:00:00Z`).getUTCDay() || 7] } : {}) }); navigate('trend'); }
  const page = event.target.closest('[data-program-page]'); if (page) { programPage = Number(page.dataset.programPage); renderProgrammes(); }
});

document.addEventListener('keydown', event => {
  const row = event.target.closest('tr[data-program]');
  if (row && event.key === 'Enter') { openProgram(row.dataset.program); return; }
  if (event.key === 'Escape') {
    if (activeTool !== 'inspect') { setAnnotationTool('inspect'); return; }
    if (isFullscreen && !$('detail-dialog')?.open && !$('original-dialog')?.open) { setFullscreen(false); return; }
  }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || $('detail-dialog')?.open || $('original-dialog')?.open) return;
  if ((event.key === 'f' || event.key === 'F' || event.key === 'а' || event.key === 'А') && view().tab === 'trend' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    setFullscreen(!isFullscreen);
  }
});

$('upload').addEventListener('click', () => $('files').click()); $('apply-filters').addEventListener('click', () => applyFilters());
if ($('clear-db')) $('clear-db').addEventListener('click', async () => {
  if (busy) return;
  try { busy = true; await db.clear(); await reload(); status('База данных очищена.', false); }
  catch (error) { status(error.message); }
  finally { busy = false; }
});
for (const id of ['time-start', 'time-end', 'programme']) $(id).addEventListener('keydown', event => { if (event.key === 'Enter') applyFilters(); });
for (const id of ['date-from', 'date-to']) $(id).addEventListener('change', () => applyFilters());
$('channel').addEventListener('change', event => { $('programme').value = ''; applyFilters({ channel: event.target.value, title: '' }); });
if ($('fs-channel')) $('fs-channel').addEventListener('change', event => { $('channel').value = event.target.value; $('programme').value = ''; applyFilters({ channel: event.target.value, title: '' }); });
$('programme').addEventListener('change', () => applyFilters());
$('workweek').addEventListener('click', () => applyFilters({ weekdays: [1, 2, 3, 4, 5] }));
$('all-weekdays').addEventListener('click', () => applyFilters({ weekdays: [1, 2, 3, 4, 5, 6, 7] }));
if ($('full-week-btn')) $('full-week-btn').addEventListener('click', () => {
  cardsPerPage = 7;
  if ($('page-size')) $('page-size').value = '7';
  const q = filters();
  let from = q.from, to = q.to;
  if (from && to) {
    const startDay = new Date(`${from}T00:00:00Z`).getUTCDay() || 7;
    const monday = shiftDate(from, -(startDay - 1));
    const sunday = shiftDate(monday, 6);
    if (to < sunday) { from = monday; to = sunday; }
  }
  applyFilters({ from, to, weekdays: [1, 2, 3, 4, 5, 6, 7] });
});
if ($('page-size')) $('page-size').addEventListener('change', event => {
  cardsPerPage = Math.max(1, Number(event.target.value) || 5);
  update({ page: 1 });
  schedule();
});
if ($('show-drop-pins')) $('show-drop-pins').addEventListener('change', event => {
  viewer.setDropPinsVisible(event.target.checked);
});
if ($('clear-annotations')) $('clear-annotations').addEventListener('click', () => {
  const ch = filters().channel;
  annotations = annotations.filter(item => item.channel !== ch);
  saveAnnotations();
  viewer.refreshAnnotations();
  renderAnnotationSummary();
});
if ($('export-annotations')) $('export-annotations').addEventListener('click', () => {
  const ch = filters().channel;
  const rows = annotations.filter(item => item.channel === ch);
  if (!rows.length) return;
  download(csvContent([
    ['Канал', 'Тип', 'Дата', 'Время / Начало', 'Конец', 'Шкала X', 'Шкала X (конец)', 'Категория', 'Комментарий'],
    ...rows.map(r => [
      r.channel,
      r.type,
      r.dateISO ?? 'Все даты',
      r.timeSec != null ? timeLabel(r.timeSec) : r.startSec != null ? timeLabel(r.startSec) : '—',
      r.endSec != null ? timeLabel(r.endSec) : '—',
      r.scaleValue ?? r.startScale ?? '—',
      r.endScale ?? '—',
      r.tag ? (ANNOTATION_TAGS[r.tag]?.label ?? r.tag) : '—',
      r.label ?? '',
    ]),
  ]), 'FTV_annotations.csv');
});
$('clear-programme').addEventListener('click', () => { $('programme').value = ''; dirtyFields.delete('programme'); $('filter-pending').hidden = !dirtyFields.size; updateFilters({ title: '' }); });
$('scan-scale').addEventListener('change', event => update({ scale: event.target.value }));
$('only-scans').addEventListener('change', event => update({ onlyScans: event.target.checked, page: 1 }));
$('reset-filters').addEventListener('click', resetFilters);
$('filter-toggle').addEventListener('click', () => { const collapsed = $('view-filters').classList.toggle('is-collapsed'); $('filter-toggle').setAttribute('aria-expanded', String(!collapsed)); $('filter-toggle').textContent = collapsed ? 'Настроить ↓' : 'Свернуть ↑'; });
for (const id of ['program-search', 'program-sort', 'program-source', 'program-signal']) if ($(id)) $(id).addEventListener(id === 'program-search' ? 'input' : 'change', () => { programPage = 1; renderProgrammes(); });
for (const id of ['time-start', 'time-end', 'programme', 'date-from', 'date-to']) $(id).addEventListener('input', () => { dirtyFields.add(id); $('filter-pending').hidden = false; });

const prevDatePage = () => update({ page: Math.max(1, Math.min(view().page, Math.ceil(displayedDays().length / cardsPerPage)) - 1) });
const nextDatePage = () => update({ page: view().page + 1 });
$('previous-dates').addEventListener('click', prevDatePage);
$('next-dates').addEventListener('click', nextDatePage);
if ($('prev-dates-bottom')) $('prev-dates-bottom').addEventListener('click', prevDatePage);
if ($('next-dates-bottom')) $('next-dates-bottom').addEventListener('click', nextDatePage);
if ($('scroll-top-trend')) $('scroll-top-trend').addEventListener('click', () => {
  $('scan-viewer')?.scrollTo({ top: 0, behavior: 'smooth' });
  ($('view-filters') ?? $('trend-panel'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('export-periods').addEventListener('click', () => { const csv = periods.getCSV(); if (csv) download(csv, 'FTV_periods.csv'); });
$('export-programmes').addEventListener('click', () => {
  if (programViewMode === 'summary') {
    const groups = summarizePrograms(selectedProgrammes());
    download(csvContent([['Параметры', JSON.stringify({ ...filters(), ...programOptions(), viewMode: 'summary' })], ['Канал', 'Программа', 'Выходов', 'Дней', 'Средняя длит. мин', 'Средневзвешенная доля %', 'Средний рейтинг %', 'Последняя дата'], ...groups.map(g => [g.channel, g.title, g.count, g.dayCount, g.durationMin, g.share, g.rtg, g.lastDate])]), 'FTV_programmes_summary.csv');
    return;
  }
  download(csvContent([['Параметры', JSON.stringify({ ...filters(), ...programOptions() })], ['Дата', 'Канал', 'Программа', 'Начало', 'Конец', 'Средняя доля %', 'Средние зрители', 'Источник'], ...selectedProgrammes().map(row => [row.dateISO, row.channel, row.title, preciseTimeLabel(row.startSec), preciseTimeLabel(row.endSec), row.share, averageViewers(row), row.source])]), 'FTV_programmes.csv');
});

async function importFiles(fileList) {
  const files = [...fileList].filter(f => /\.(xlsx|xlsm)$/i.test(f.name));
  if (!files.length || busy) return;
  busy = true; $('upload').disabled = true; $('import-progress').hidden = false; $('import-meter').max = files.length;
  const results = [];
  try {
    for (let i = 0; i < files.length; i++) {
      $('import-meter').value = i; $('import-label').textContent = `${i + 1} / ${files.length} · ${files[i].name}`;
      try { const report = await importer.parse(files[i]); await db.importReport(report); results.push({ name: files[i].name, date: report.reportDateISO, warnings: report.warnings }); } catch (error) { results.push({ name: files[i].name, error: error.message }); }
      $('import-meter').value = i + 1;
    }
    await reload(); const failed = results.filter(row => row.error).length, warnings = results.reduce((sum, row) => sum + (row.warnings?.length ?? 0), 0);
    lastImportedDates = [...new Set(results.filter(row => row.date && !row.error).map(row => row.date))].sort();
    $('import-results').hidden = false; $('import-result-list').innerHTML = results.map(row => `<div class="import-row"><strong>${e(row.name)}</strong><p>${row.error ? e(row.error) : dateLabel(row.date, true)}</p>${row.warnings?.map(text => `<p>${e(text)}</p>`).join('') || ''}</div>`).join('');
    $('import-results').open = !!(failed || warnings);
    $('import-receipt').hidden = false;
    $('import-receipt').innerHTML = `<strong>Загружено ${results.length - failed} из ${results.length} отчётов</strong><p>Предупреждений: ${warnings} · ошибок: ${failed}. Дата взята из содержимого Excel.</p>${lastImportedDates.length ? '<button class="text-button" data-open-imported>Открыть загруженные даты →</button>' : ''}`;
    status(`Загружено ${results.length - failed} из ${results.length} отчётов. Предупреждений: ${warnings}, ошибок: ${failed}.`, failed > 0);
    if (lastImportedDates.length) $('status').insertAdjacentHTML('beforeend', ' <button class="text-button" data-open-imported>Открыть эти даты →</button>');
    $('status').insertAdjacentHTML('beforeend', ' <button class="text-button" data-module="data">Подробности импорта</button>');
    clearTimeout(statusTimer);
  } catch (error) { status(error.message); } finally { busy = false; $('upload').disabled = false; $('import-progress').hidden = true; }
}

$('files').addEventListener('change', async event => {
  await importFiles(event.target.files);
  event.target.value = '';
});
if ($('drop-zone')) {
  $('drop-zone').addEventListener('click', () => $('files').click());
}
document.addEventListener('dragover', event => {
  if (event.dataTransfer?.types?.includes('Files')) {
    event.preventDefault();
    $('drop-zone')?.classList.add('is-dragover');
  }
});
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget) $('drop-zone')?.classList.remove('is-dragover');
});
document.addEventListener('drop', async event => {
  $('drop-zone')?.classList.remove('is-dragover');
  if (event.dataTransfer?.files?.length) {
    event.preventDefault();
    await importFiles(event.dataTransfer.files);
  }
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
