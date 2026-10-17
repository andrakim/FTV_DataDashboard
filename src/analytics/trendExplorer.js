import { assertDateISO, BROADCAST_START, BROADCAST_END, FTV_CHANNEL } from '../core/normalization.js';
import { programmeKey, weekdayOf } from './airingExplorer.js';

export const TREND_DEFAULTS = Object.freeze({ from: null, to: null, weekdays: [1, 2, 3, 4, 5], startSec: 64800, endSec: 68400, channel: FTV_CHANNEL, title: '' });
export function validateTrendFilters(filters) {
  for (const date of [filters.from, filters.to]) if (date != null) assertDateISO(date);
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('Дата начала должна быть раньше даты окончания.');
  if (filters.from && filters.to && (Date.parse(filters.to) - Date.parse(filters.from)) / 86400000 > 3660) throw new Error('Выберите период не больше 10 лет.');
  if (!Array.isArray(filters.weekdays) || filters.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(filters.weekdays).size !== filters.weekdays.length) throw new Error('Выберите дни недели.');
  if (![filters.startSec, filters.endSec].every(Number.isFinite) || filters.startSec < BROADCAST_START || filters.endSec > BROADCAST_END || filters.endSec <= filters.startSec) throw new Error('Время: 05:00–29:00. Конец должен быть позже начала.');
  if (typeof filters.channel !== 'string' || typeof filters.title !== 'string' || filters.title.length > 500) throw new Error('Неверная программа или канал.');
  return filters;
}
export function shiftDate(dateISO, count) { assertDateISO(dateISO); return new Date(Date.parse(`${dateISO}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10); }
export function initialTrendFilters(scanDates, fallbackDates = []) {
  const dates = [...new Set(scanDates.length ? scanDates : fallbackDates)].sort(), latest = dates.at(-1);
  return { ...structuredClone(TREND_DEFAULTS), from: latest ? shiftDate(latest, -6) : null, to: latest ?? null };
}
export function buildTrendDays(catalog, scanDates, options) {
  const filters = { ...structuredClone(TREND_DEFAULTS), ...options }; validateTrendFilters(filters);
  if (!filters.from || !filters.to) return [];
  const dayCount = (Date.parse(filters.to) - Date.parse(filters.from)) / 86400000;
  const scans = new Set(scanDates), byDate = new Map();
  for (const row of catalog) {
    if (row.channel !== filters.channel || row.audience !== '18-54' || row.dateISO < filters.from || row.dateISO > filters.to) continue;
    if (!(row.startSec < filters.endSec && row.endSec > filters.startSec)) continue;
    if (!byDate.has(row.dateISO)) byDate.set(row.dateISO, []);
    byDate.get(row.dateISO).push(row);
  }
  const result = [];
  for (let offset = 0; offset <= dayCount; offset++) {
    const dateISO = shiftDate(filters.from, offset), weekday = weekdayOf(dateISO);
    if (!filters.weekdays.includes(weekday)) continue;
    const programmes = (byDate.get(dateISO) ?? []).sort((a, b) => a.startSec - b.startSec);
    const matches = filters.title ? programmes.filter(row => programmeKey(row.title) === programmeKey(filters.title)) : programmes;
    result.push({ dateISO, weekday, hasScan: scans.has(dateISO), programmes, matches });
  }
  return result;
}
export function trendProgrammes(days, { search = '', sort = 'time', source = 'all' } = {}) {
  const query = programmeKey(search);
  return days.flatMap(day => day.matches).filter(row => (!query || programmeKey(row.title).includes(query)) && (source === 'all' || (source === 'grid' ? row.approximate : !row.approximate))).sort((a, b) => {
    if (sort === 'share-desc' || sort === 'share-asc') {
      const aMeasured = Number.isFinite(a.share), bMeasured = Number.isFinite(b.share);
      if (aMeasured !== bMeasured) return aMeasured ? -1 : 1;
      if (aMeasured && a.share !== b.share) return sort === 'share-desc' ? b.share - a.share : a.share - b.share;
    }
    return a.dateISO.localeCompare(b.dateISO) || a.startSec - b.startSec || a.title.localeCompare(b.title, 'ru');
  });
}
export function timeAtFraction(filters, fraction) { return Math.round(filters.startSec + Math.max(0, Math.min(1, fraction)) * (filters.endSec - filters.startSec)); }
export function programmesAtTime(catalog, dateISO, timeSec, channel) {
  return catalog.filter(row => row.dateISO === dateISO && row.channel === channel && row.audience === '18-54' && row.startSec <= timeSec && row.endSec > timeSec);
}
