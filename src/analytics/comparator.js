import { DAYPARTS, FTV_CHANNEL, SLOT_SECONDS, BROADCAST_START, normalizeChannel } from '../core/normalization.js';

export const METRICS = Object.freeze(['share', 'rtg', 'reach', 'atsMin']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function mean(values) {
  const numbers = values.filter(finite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}
export function median(values) {
  const numbers = values.filter(finite).sort((a, b) => a - b);
  const n = numbers.length;
  return n ? n % 2 ? numbers[(n - 1) / 2] : (numbers[n / 2 - 1] + numbers[n / 2]) / 2 : null;
}
export function weightedMean(entries) {
  const valid = entries.filter(({ value, weight }) => finite(value) && finite(weight) && weight > 0);
  const weight = valid.reduce((sum, row) => sum + row.weight, 0);
  return weight ? valid.reduce((sum, row) => sum + row.value * row.weight, 0) / weight : null;
}
export function metricDelta(current, baseline) {
  return {
    current: finite(current) ? current : null, baseline: finite(baseline) ? baseline : null,
    absolute: finite(current) && finite(baseline) ? current - baseline : null,
    relativePercent: finite(current) && finite(baseline) && baseline !== 0 ? (current - baseline) / baseline * 100 : null,
  };
}
export function audienceKey(audience = '18-54') {
  if (!['18-54', '25-34'].includes(audience)) throw new Error(`Неизвестная аудитория: ${audience}`);
  return audience === '18-54' ? 'ftv_18_54' : 'ftv_25_34';
}

export function filterDailyRecords(records, options = {}) {
  const { from, to, excludeNonWorkdays = false } = options;
  if (from && to && from > to) throw new Error('Начало периода позже конца');
  // One observation per date even when the caller supplies overlapping report arrays.
  const unique = new Map(records.map(row => [row.dateISO, row]));
  return [...unique.values()].filter(row => {
    if (from && row.dateISO < from || to && row.dateISO > to) return false;
    if (excludeNonWorkdays && row.isWorkday !== true) return false;
    return ['year', 'month', 'season', 'seasonYear', 'isoWeek', 'isoWeekYear', 'dayOfWeek'].every(key => options[key] == null || row[key] === options[key]);
  }).sort((a, b) => a.dateISO.localeCompare(b.dateISO));
}

export function channelMetrics(slot, channel = FTV_CHANNEL, audience = '18-54') {
  const row = slot.channels?.[normalizeChannel(channel)];
  if (!row) return null;
  if (row.audiences) return row.audiences[audience] ?? null;
  return (row.audience ?? '18-54') === audience ? row : null;
}

function uniqueGrid(rows) {
  const map = new Map();
  for (const row of rows) map.set(`${row.dateISO}_${row.slotIndex}`, row);
  return [...map.values()];
}

export function buildSlotProfile(rows, options = {}) {
  const { channel = FTV_CHANNEL, audience = '18-54' } = options;
  audienceKey(audience);
  const buckets = Array.from({ length: 144 }, () => []);
  for (const row of uniqueGrid(rows)) if (Number.isInteger(row.slotIndex) && row.slotIndex >= 0 && row.slotIndex < 144) {
    const metric = channelMetrics(row, channel, audience);
    if (metric) buckets[row.slotIndex].push({ dateISO: row.dateISO, ...metric });
  }
  return buckets.map((values, slotIndex) => ({
    slotIndex, startSec: BROADCAST_START + slotIndex * SLOT_SECONDS, endSec: BROADCAST_START + (slotIndex + 1) * SLOT_SECONDS,
    meanShare: mean(values.map(row => row.share)), medianShare: median(values.map(row => row.share)),
    meanRtg: mean(values.map(row => row.rtg)), medianRtg: median(values.map(row => row.rtg)),
    shareCount: values.filter(row => finite(row.share)).length, rtgCount: values.filter(row => finite(row.rtg)).length,
  }));
}

export function buildDaypartProfile(rows, options = {}) {
  const { channel = FTV_CHANNEL, audience = '18-54' } = options;
  audienceKey(audience);
  const grid = uniqueGrid(rows);
  return DAYPARTS.map(part => {
    const samples = [];
    for (const row of grid) {
      const startSec = row.startSec ?? BROADCAST_START + row.slotIndex * SLOT_SECONDS;
      const endSec = row.endSec ?? startSec + SLOT_SECONDS;
      const weight = Math.max(0, Math.min(endSec, part.endSec) - Math.max(startSec, part.startSec));
      const metrics = channelMetrics(row, channel, audience);
      if (weight && metrics) samples.push({ ...metrics, weight, dateISO: row.dateISO });
    }
    return { ...part, share: weightedMean(samples.map(row => ({ value: row.share, weight: row.weight }))),
      rtg: weightedMean(samples.map(row => ({ value: row.rtg, weight: row.weight }))),
      count: samples.filter(row => finite(row.share)).length,
      observedDays: new Set(samples.filter(row => finite(row.share)).map(row => row.dateISO)).size };
  });
}

function aggregateRegions(daily, audience) {
  const regions = new Set(daily.flatMap(row => Object.keys(row.regions?.[audience] ?? {})));
  return Object.fromEntries([...regions].map(name => {
    const rows = daily.map(row => row.regions?.[audience]?.[name]).filter(Boolean);
    const keys = new Set(rows.flatMap(row => Object.keys(row)));
    return [name, { count: rows.length, ...Object.fromEntries([...keys].map(key => [key, mean(rows.map(row => row[key]))])) }];
  }));
}

export function aggregatePeriod(data, options = {}) {
  const { audience = '18-54' } = options, key = audienceKey(audience);
  const daily = filterDailyRecords(data.daily_metrics ?? [], options), dates = new Set(daily.map(row => row.dateISO));
  const grid = (data.grid_10min ?? []).filter(row => dates.has(row.dateISO));
  const metrics = Object.fromEntries(METRICS.map(metric => {
    const values = daily.map(row => row[key]?.[metric]);
    return [metric, { mean: mean(values), median: median(values), count: values.filter(finite).length }];
  }));
  const competitorNames = new Set(daily.flatMap(row => Object.keys(row.competitorsDaily ?? {})));
  const competitorsDaily = Object.fromEntries([...competitorNames].map(channel => [channel,
    Object.fromEntries(METRICS.map(metric => [metric, mean(daily.map(row => {
      const values = row.competitorsDaily?.[channel];
      return (values?.audience ?? '18-54') === audience ? values?.[metric] : null;
    }))]))]));
  return {
    dates: [...dates], dayCount: daily.length, audience, daily: metrics, competitorsDaily,
    regions: aggregateRegions(daily, audience), slots: buildSlotProfile(grid, options), dayparts: buildDaypartProfile(grid, options),
    gridDayCount: new Set(grid.filter(row => channelMetrics(row, options.channel, audience)).map(row => row.dateISO)).size,
  };
}

function comparison(current, baseline) {
  return {
    current, baseline,
    daily: Object.fromEntries(METRICS.map(metric => [metric, metricDelta(current.daily[metric].mean, baseline.daily[metric].mean)])),
    slots: current.slots.map((row, i) => ({ slotIndex: i, share: metricDelta(row.meanShare, baseline.slots[i].meanShare), rtg: metricDelta(row.meanRtg, baseline.slots[i].meanRtg) })),
    dayparts: current.dayparts.map((row, i) => ({ id: row.id, share: metricDelta(row.share, baseline.dayparts[i].share), rtg: metricDelta(row.rtg, baseline.dayparts[i].rtg) })),
    regions: Object.fromEntries([...new Set([...Object.keys(current.regions), ...Object.keys(baseline.regions)])].map(name => [name,
      Object.fromEntries([...METRICS, 'contribution', 'rtg000', 'reach000'].map(metric => [metric, metricDelta(current.regions[name]?.[metric], baseline.regions[name]?.[metric])]))])),
  };
}

export function compareWeeks(data, weekA, weekB, options = {}) {
  for (const week of [weekA, weekB]) if (!Number.isInteger(week?.isoWeekYear) || !Number.isInteger(week?.isoWeek) || week.isoWeek < 1 || week.isoWeek > 53) throw new Error('Неделя задаётся как {isoWeekYear, isoWeek: 1..53}');
  const a = { ...options, ...weekA }, b = { ...options, ...weekB };
  return { mode: 'week', ...comparison(aggregatePeriod(data, a), aggregatePeriod(data, b)),
    weekdays: Array.from({ length: 7 }, (_, i) => ({ dayOfWeek: i + 1,
      ...comparison(aggregatePeriod(data, { ...a, dayOfWeek: i + 1 }), aggregatePeriod(data, { ...b, dayOfWeek: i + 1 })) })) };
}

export function analyzeDayOfWeek(data, options = {}) {
  const { dayOfWeek = 4 } = options;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) throw new Error('День недели должен быть от 1 до 7');
  const selector = { ...options, dayOfWeek }, summary = aggregatePeriod(data, selector);
  const dates = new Set(summary.dates);
  const grid = (data.grid_10min ?? []).filter(row => dates.has(row.dateISO));
  const curves = summary.dates.map(dateISO => ({ dateISO,
    slots: buildSlotProfile(grid.filter(row => row.dateISO === dateISO), options).map((row, i) => ({
      ...row, deviationFromMean: metricDelta(row.meanShare, summary.slots[i].meanShare),
      deviationFromMedian: metricDelta(row.meanShare, summary.slots[i].medianShare),
    })) }));
  return { mode: 'dayOfWeek', dayOfWeek, summary, baseline: summary.slots, curves };
}

export function compareSeasons(data, seasonA, seasonB, options = {}) {
  for (const period of [seasonA, seasonB]) {
    if (!['winter', 'spring', 'summer', 'autumn'].includes(period?.season)) throw new Error('Неизвестный сезон');
    if (!Number.isInteger(period.seasonYear) && !Number.isInteger(period.year)) throw new Error('Задайте year или seasonYear сезона');
  }
  const result = comparison(aggregatePeriod(data, { ...options, ...seasonA }), aggregatePeriod(data, { ...options, ...seasonB }));
  return { mode: 'season', ...result, primeTime: result.dayparts.find(row => row.id === 'primeTime') };
}

function reachExposure(summary) {
  const metric = summary.daily.reach;
  return {
    // Distinct accumulated reach cannot be recovered from daily AvRch% alone.
    cumulativeUniqueReach: null,
    sumDailyReachPercent: metric.count ? metric.mean * metric.count : null,
    observedDays: metric.count,
    explanation: 'Сумма ежедневных охватов учитывает повторных зрителей. Уникальный накопленный охват требует данных о пересечении аудитории.',
  };
}

export function compareYears(data, yearA, yearB, options = {}) {
  if (![yearA, yearB].every(year => Number.isInteger(year) && year >= 1900 && year <= 9999)) throw new Error('Некорректные годы');
  const current = aggregatePeriod(data, { ...options, year: yearA }), baseline = aggregatePeriod(data, { ...options, year: yearB });
  // Week alignment follows ISO week-years; annual and monthly means follow calendar years.
  const alignedA = filterDailyRecords(data.daily_metrics ?? [], { ...options, isoWeekYear: yearA });
  const alignedB = filterDailyRecords(data.daily_metrics ?? [], { ...options, isoWeekYear: yearB });
  const key = audienceKey(options.audience);
  const mapA = new Map(alignedA.map(row => [`${row.isoWeek}_${row.dayOfWeek}`, row]));
  const mapB = new Map(alignedB.map(row => [`${row.isoWeek}_${row.dayOfWeek}`, row]));
  const weekAlignment = [...new Set([...mapA.keys(), ...mapB.keys()])].map(id => {
    const a = mapA.get(id), b = mapB.get(id);
    const [isoWeek, dayOfWeek] = id.split('_').map(Number);
    return { isoWeek, dayOfWeek, currentDate: a?.dateISO ?? null, baselineDate: b?.dateISO ?? null,
      metrics: Object.fromEntries(METRICS.map(metric => [metric, metricDelta(a?.[key]?.[metric], b?.[key]?.[metric])])) };
  }).sort((a, b) => a.isoWeek - b.isoWeek || a.dayOfWeek - b.dayOfWeek);
  return { mode: 'year', ...comparison(current, baseline), weekAlignment,
    monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...comparison(
      aggregatePeriod(data, { ...options, year: yearA, month: i + 1 }), aggregatePeriod(data, { ...options, year: yearB, month: i + 1 })) })),
    reachExposure: { current: reachExposure(current), baseline: reachExposure(baseline) } };
}

export function comparePeriods(data, { mode, periodA, periodB, ...options }) {
  if (mode === 'week') return compareWeeks(data, periodA, periodB, options);
  if (mode === 'dayOfWeek') return analyzeDayOfWeek(data, options);
  if (mode === 'season') return compareSeasons(data, periodA, periodB, options);
  if (mode === 'year') return compareYears(data, periodA?.year ?? periodA, periodB?.year ?? periodB, options);
  throw new Error(`Неизвестный режим: ${mode}`);
}
