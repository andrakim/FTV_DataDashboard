import { FTV_CHANNEL, assertDateISO, normalizeChannel } from '../core/normalization.js';
import { buildProgramCatalog } from './programs.js';
import { createAiringIndex, describeAiring, programmeKey, weekdayOf } from './airingExplorer.js';
import { mean, median, weightedMean } from './comparator.js';

export const QUERY_DEFAULTS = Object.freeze({ audience: '18-54', channels: [FTV_CHANNEL], programmes: [], programmeMode: 'include', search: '',
  from: null, to: null, weekdays: [], startSec: 18000, endSec: 104400, timeMode: 'starts', workday: 'all', source: 'all',
  conditions: [], conditionMode: 'all', excludedIds: [], excludedDates: [], labels: [], sort: 'dateISO', direction: 'desc' });
export const FIELD_LABELS = Object.freeze({ share: 'Доля, %', rtg: 'Рейтинг, %', viewers: 'Средние зрители, чел.', durationMin: 'Длительность, мин',
  retention: 'Удержание входа, %', outRetention: 'Удержание выхода, %', deltaShare: 'Δ доли к входу, п.п.',
  maleViewers: 'Мужчины, чел.', femaleViewers: 'Женщины, чел.', m1824Viewers: 'М 18–24, чел.', m2534Viewers: 'М 25–34, чел.', m3544Viewers: 'М 35–44, чел.', m4554Viewers: 'М 45–54, чел.',
  w1824Viewers: 'Ж 18–24, чел.', w2534Viewers: 'Ж 25–34, чел.', w3544Viewers: 'Ж 35–44, чел.', w4554Viewers: 'Ж 45–54, чел.' });
export const LABELS = Object.freeze({ main: 'Основной', repeat: 'Повтор', special: 'Особый эфир', unmarked: 'Без метки' });
const finite = Number.isFinite;
const text = (value, limit = 1000) => typeof value === 'string' && value.length <= limit;

export function validateQuery(query) {
  if (!['18-54', '25-34'].includes(query.audience)) throw new Error('Неизвестная аудитория');
  for (const key of ['channels', 'programmes', 'excludedIds', 'excludedDates', 'labels']) {
    if (!Array.isArray(query[key]) || query[key].some(value => !text(value)) || new Set(query[key]).size !== query[key].length) throw new Error(`Некорректный список ${key}`);
  }
  if (!Array.isArray(query.weekdays) || query.weekdays.some(value => !Number.isInteger(value) || value < 1 || value > 7) || new Set(query.weekdays).size !== query.weekdays.length) throw new Error('Некорректные дни недели');
  if (!text(query.search)) throw new Error('Некорректный поиск');
  for (const date of [query.from, query.to, ...query.excludedDates]) if (date != null) assertDateISO(date);
  if (query.from && query.to && query.from > query.to) throw new Error('Начало периода позже конца');
  if (![query.startSec, query.endSec].every(finite) || query.startSec < 18000 || query.endSec > 104400 || query.endSec <= query.startSec) throw new Error('Время: 05:00–29:00, конец позже начала');
  for (const [key, values] of Object.entries({ programmeMode: ['include', 'exclude'], timeMode: ['starts', 'overlaps', 'contained'], workday: ['all', 'workday', 'nonworkday', 'unknown'],
    source: ['all', 'exact', 'grid'], conditionMode: ['all', 'any'], sort: ['dateISO', 'startSec', 'title', 'channel', ...Object.keys(FIELD_LABELS)], direction: ['asc', 'desc'] })) {
    if (!values.includes(query[key])) throw new Error(`Некорректный параметр ${key}`);
  }
  if (query.labels.some(value => !(value in LABELS))) throw new Error('Неизвестная метка');
  if (!Array.isArray(query.conditions) || query.conditions.length > 20) throw new Error('Не больше 20 условий');
  for (const condition of query.conditions) {
    if (!Object.hasOwn(FIELD_LABELS, condition.field) || !['lt', 'lte', 'gt', 'gte', 'eq', 'between', 'missing', 'present'].includes(condition.operator)) throw new Error('Неизвестное условие');
    if (!['missing', 'present'].includes(condition.operator) && !finite(condition.value)) throw new Error('Введите число в условии');
    if (condition.operator === 'between' && (!finite(condition.upper) || condition.upper < condition.value)) throw new Error('Неверные границы условия');
  }
  return query;
}

export function prepareWorkspaceData(data) {
  const catalog = buildProgramCatalog(data), index = createAiringIndex(catalog, data), daily = new Map((data.daily_metrics ?? []).map(row => [row.dateISO, row]));
  const rows = catalog.map(program => {
    const context = describeAiring(index, program);
    const demographicValues = { maleViewers: program.demographics?.male, femaleViewers: program.demographics?.female };
    for (const [gender, prefix] of [['M', 'm'], ['W', 'w']]) for (const age of ['18-24', '25-34', '35-44', '45-54']) demographicValues[`${prefix}${age.replace('-', '')}Viewers`] = program.demographics?.segments?.[`${gender} ${age}`];
    const demographicMetrics = Object.fromEntries(Object.entries(demographicValues).map(([key, value]) => [key, Number.isFinite(value) && (!program.demographics?.unit || program.demographics.unit === 'thousandViewers') ? value * 1000 : null]));
    return { ...program, viewers: context.viewers, retention: context.leadInRetention, outRetention: context.leadOutRetention,
      ...demographicMetrics,
      deltaShare: finite(program.share) && finite(context.previous?.share) && program.source === context.previous.source ? program.share - context.previous.share : null,
      previous: context.previous, next: context.next, previousViewers: context.previousViewers, nextViewers: context.nextViewers,
      dayOfWeek: weekdayOf(program.dateISO), isWorkday: daily.get(program.dateISO)?.isWorkday ?? null };
  });
  return { catalog, index, rows, byId: new Map(rows.map(row => [row.id, row])) };
}

function matchesCondition(row, condition) {
  const value = row[condition.field], present = typeof value === 'number' && finite(value);
  if (condition.operator === 'missing') return !present;
  if (condition.operator === 'present') return present;
  if (!present) return false; // Missing values never pass a numeric comparison as zero.
  return ({ lt: () => value < condition.value, lte: () => value <= condition.value, gt: () => value > condition.value,
    gte: () => value >= condition.value, eq: () => value === condition.value, between: () => value >= condition.value && value <= condition.upper })[condition.operator]();
}

export function queryWorkspace(rows, options = {}, annotations = {}) {
  const q = { ...structuredClone(QUERY_DEFAULTS), ...options }; validateQuery(q);
  const channels = new Set(q.channels.map(normalizeChannel)), programmes = new Set(q.programmes.map(programmeKey));
  const ids = new Set(q.excludedIds), dates = new Set(q.excludedDates), search = programmeKey(q.search);
  const result = rows.filter(row => {
    if (row.audience !== q.audience || channels.size && !channels.has(row.channel)) return false;
    if (q.from && row.dateISO < q.from || q.to && row.dateISO > q.to || ids.has(row.id) || dates.has(row.dateISO)) return false;
    if (q.weekdays.length && !q.weekdays.includes(row.dayOfWeek)) return false;
    if (programmes.size && programmes.has(programmeKey(row.title)) !== (q.programmeMode === 'include')) return false;
    if (search && !programmeKey(`${row.title} ${row.channel}`).includes(search)) return false;
    if (q.timeMode === 'starts' && !(row.startSec >= q.startSec && row.startSec < q.endSec)) return false;
    if (q.timeMode === 'overlaps' && !(row.startSec < q.endSec && row.endSec > q.startSec)) return false;
    if (q.timeMode === 'contained' && !(row.startSec >= q.startSec && row.endSec <= q.endSec)) return false;
    if (q.source === 'exact' && row.source !== 'program_logs' || q.source === 'grid' && row.source !== 'grid_10min') return false;
    if (q.workday === 'workday' && row.isWorkday !== true || q.workday === 'nonworkday' && row.isWorkday !== false || q.workday === 'unknown' && row.isWorkday != null) return false;
    const annotation = Object.hasOwn(annotations, row.id) ? annotations[row.id] : null;
    if (q.labels.length && !q.labels.includes(annotation?.label || 'unmarked')) return false;
    if (q.conditions.length && !(q.conditionMode === 'all' ? q.conditions.every(c => matchesCondition(row, c)) : q.conditions.some(c => matchesCondition(row, c)))) return false;
    return true;
  });
  const sign = q.direction === 'asc' ? 1 : -1;
  return result.sort((a, b) => {
    const av = a[q.sort], bv = b[q.sort];
    if (av == null || bv == null) return av == null && bv == null ? a.id.localeCompare(b.id) : av == null ? 1 : -1;
    const delta = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ru');
    return delta * sign || a.dateISO.localeCompare(b.dateISO) || a.startSec - b.startSec || a.id.localeCompare(b.id);
  });
}

export const GROUPS = Object.freeze({ airing: 'Каждый выход', title: 'Программа', channel: 'Канал', date: 'Дата', weekday: 'День недели', hour: 'Час начала', previous: 'Предыдущая программа', label: 'Ручная метка' });
export function groupWorkspace(rows, { groupBy = 'title', metric = 'share', statistic = 'mean', annotations = {} } = {}) {
  if (!Object.hasOwn(GROUPS, groupBy) || !Object.hasOwn(FIELD_LABELS, metric) || !['mean', 'median', 'weighted'].includes(statistic)) throw new Error('Некорректные параметры сводки');
  const groups = new Map();
  for (const row of rows) {
    const label = groupBy === 'airing' ? `${row.dateISO} ${String(Math.floor(row.startSec / 3600)).padStart(2, '0')}:${String(Math.floor(row.startSec % 3600 / 60)).padStart(2, '0')}` :
      groupBy === 'title' ? row.title : groupBy === 'channel' ? row.channel : groupBy === 'date' ? row.dateISO : groupBy === 'weekday' ? String(row.dayOfWeek) :
        groupBy === 'hour' ? `${Math.floor(row.startSec / 3600)}:00` : groupBy === 'previous' ? row.previous?.title ?? 'Нет входа' : LABELS[annotations[row.id]?.label || 'unmarked'];
    // Different channels, audiences and exact/estimated sources must remain identifiable.
    const key = `${row.channel}\0${row.audience}\0${row.source}\0${groupBy === 'airing' ? row.id : label}`;
    if (!groups.has(key)) groups.set(key, { key, label, channel: row.channel, audience: row.audience, source: row.source, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map(group => {
    const values = group.rows.map(row => row[metric]);
    return { ...group, count: group.rows.length, days: new Set(group.rows.map(row => row.dateISO)).size, measured: values.filter(v => typeof v === 'number' && finite(v)).length,
      value: statistic === 'median' ? median(values) : statistic === 'weighted' ? weightedMean(group.rows.map(row => ({ value: row[metric], weight: row.durationMin }))) : mean(values) };
  });
}

export function resolveCohort(cohort, byId) {
  const rows = (cohort?.ids ?? []).map(id => byId.get(id)).filter(Boolean);
  return { rows, missing: (cohort?.ids.length ?? 0) - rows.length, audiences: [...new Set(rows.map(row => row.audience))] };
}

export function coverageRows(data) {
  const dates = new Map();
  for (const key of ['daily_metrics', 'grid_10min', 'program_logs']) for (const row of data[key] ?? []) {
    if (!dates.has(row.dateISO)) dates.set(row.dateISO, { dateISO: row.dateISO, daily: false, gridSlots: 0, exactFTV: 0, competitors: new Set() });
    const item = dates.get(row.dateISO);
    if (key === 'daily_metrics') item.daily = true;
    if (key === 'grid_10min' && row.channels?.[FTV_CHANNEL]) item.gridSlots++;
    if (key === 'program_logs') { if (normalizeChannel(row.channel) === FTV_CHANNEL) item.exactFTV++; else item.competitors.add(normalizeChannel(row.channel)); }
  }
  return [...dates.values()].sort((a, b) => b.dateISO.localeCompare(a.dateISO)).map(row => ({ ...row, competitors: row.competitors.size }));
}
