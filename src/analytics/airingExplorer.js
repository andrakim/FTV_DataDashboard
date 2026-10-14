import { BROADCAST_START, BROADCAST_END, SLOT_SECONDS, normalizeChannel, assertDateISO } from '../core/normalization.js';
import { mean, channelMetrics } from './comparator.js';
import { calculateRetention } from './dropDetector.js';
import { finite, measureWindow, overlapSeconds } from './intervals.js';

export const programmeKey = title => String(title ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
export const weekdayOf = date => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
export function averageViewers(program) {
  const demographics = program?.demographics;
  return demographics && (!demographics.unit || demographics.unit === 'thousandViewers') && finite(demographics.total) && demographics.total >= 0 ? demographics.total * 1000 : null;
}
const dayKey = (date, channel, audience) => `${date}\0${normalizeChannel(channel)}\0${audience}`;
const add = (map, key, row) => { if (!map.has(key)) map.set(key, []); map.get(key).push(row); };

// Build once per database revision; browsing does not rescan 68 channels for every airing.
export function createAiringIndex(catalog, data) {
  const programmes = new Map(), exact = new Map(), grid = new Map(), positions = new Map();
  for (const row of catalog) add(programmes, dayKey(row.dateISO, row.channel, row.audience), row);
  for (const rows of programmes.values()) {
    rows.sort((a, b) => a.startSec - b.startSec);
    rows.forEach((row, i) => positions.set(row.id, { rows, i }));
  }
  for (const row of data.program_logs ?? []) add(exact, dayKey(row.dateISO, row.channel, row.audience ?? '18-54'), { ...row, viewers: averageViewers(row) });
  for (const slot of data.grid_10min ?? []) for (const channel of Object.keys(slot.channels ?? {})) for (const audience of ['18-54', '25-34']) {
    const metrics = channelMetrics(slot, channel, audience); if (!metrics) continue;
    const startSec = slot.startSec ?? BROADCAST_START + slot.slotIndex * SLOT_SECONDS;
    add(grid, dayKey(slot.dateISO, channel, audience), { ...metrics, startSec, endSec: slot.endSec ?? startSec + SLOT_SECONDS });
  }
  return { programmes, exact, grid, positions, workdays: new Map((data.daily_metrics ?? []).map(row => [row.dateISO, row.isWorkday])),
    dates: [...new Set(['daily_metrics', 'grid_10min', 'program_logs'].flatMap(key => (data[key] ?? []).map(row => row.dateISO)))].sort() };
}

export function filterAirings(catalog, { title, channel, audience = '18-54', from, to, dayOfWeek = 0,
  startSec = BROADCAST_START, endSec = BROADCAST_END, includeApproximate = true, excludeNonWorkdays = false, workdays = new Map() } = {}) {
  if (![startSec, endSec].every(finite) || startSec < BROADCAST_START || endSec > BROADCAST_END || endSec <= startSec) throw new Error('Некорректное окно начала программы');
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 7) throw new Error('Некорректный день недели');
  for (const date of [from, to]) if (date) assertDateISO(date);
  if (from && to && from > to) throw new Error('Начало периода позже конца');
  return catalog.filter(row => programmeKey(row.title) === programmeKey(title) && (!channel || row.channel === normalizeChannel(channel)) &&
    row.audience === audience && (!from || row.dateISO >= from) && (!to || row.dateISO <= to) &&
    (!dayOfWeek || weekdayOf(row.dateISO) === dayOfWeek) && row.startSec >= startSec && row.startSec < endSec &&
    (includeApproximate || !row.approximate) && (!excludeNonWorkdays || workdays.get(row.dateISO) === true))
    .sort((a, b) => b.dateISO.localeCompare(a.dateISO) || a.startSec - b.startSec);
}

function concurrentChannel(index, program, channel) {
  const key = dayKey(program.dateISO, channel, program.audience), exact = index.exact.get(key) ?? [], grid = index.grid.get(key) ?? [];
  const a = measureWindow(exact, program.startSec, program.endSec), b = measureWindow(grid, program.startSec, program.endSec);
  const useExact = !a.conflictSeconds && (a.coverageFraction >= .9 || a.coverageFraction >= b.coverageFraction);
  const rows = useExact ? exact : grid, measured = useExact ? a : b;
  const relevant = rows.filter(row => overlapSeconds(program.startSec, program.endSec, row) > 0);
  if (!relevant.length) return { channel, missing: true, programmes: [], share: null, rtg: null, viewers: null, coverageFraction: 0 };
  const rating = measureWindow(rows, program.startSec, program.endSec, 'rtg'), viewers = measureWindow(rows, program.startSec, program.endSec, 'viewers');
  const complete = value => !value.conflictSeconds && value.coverageFraction >= .9;
  const programmes = [];
  for (const row of [...relevant].sort((a, b) => a.startSec - b.startSec)) {
    const last = programmes.at(-1);
    if (last?.title === row.title && last.startSec === row.startSec && last.endSec === row.endSec) continue;
    if (!useExact && last?.title === row.title && last.share === row.share && last.rtg === row.rtg && last.endSec === row.startSec) last.endSec = row.endSec;
    else programmes.push({ title: row.title, startSec: row.startSec, endSec: row.endSec, share: row.share ?? null, rtg: row.rtg ?? null });
  }
  return { channel, missing: false, source: useExact ? 'program_logs' : 'grid_10min', coverageFraction: measured.coverageFraction,
    share: complete(measured) ? measured.value : null, rtg: complete(rating) ? rating.value : null, viewers: complete(viewers) ? viewers.value : null,
    programmes,
    conflict: measured.conflictSeconds > 0 };
}

export function describeAiring(index, program, { competitors = [] } = {}) {
  const position = index.positions.get(program.id);
  const adjacent = (a, b) => a && b && b.startSec >= a.endSec && b.startSec - a.endSec <= SLOT_SECONDS;
  const before = position?.rows[position.i - 1], after = position?.rows[position.i + 1];
  const previous = adjacent(before, program) ? before : null, next = adjacent(program, after) ? after : null;
  const sameBefore = previous && previous.source === program.source, sameAfter = next && next.source === program.source;
  const viewers = averageViewers(program), previousViewers = averageViewers(previous), nextViewers = averageViewers(next);
  return { program, previous, next, viewers, previousViewers, nextViewers,
    leadInRetention: sameBefore ? calculateRetention(program.share, previous.share) : null,
    leadOutRetention: sameAfter ? calculateRetention(next.share, program.share) : null,
    viewersDelta: finite(viewers) && finite(previousViewers) ? viewers - previousViewers : null,
    competitors: [...new Set(competitors.map(normalizeChannel))].filter(channel => channel !== program.channel).map(channel => concurrentChannel(index, program, channel)) };
}

export function airingCalendarDays(index, airings, { from, to, channel, audience = '18-54', dayOfWeek = 0, showMissing = false, excludeNonWorkdays = false } = {}) {
  const map = new Map(); airings.forEach(row => add(map, row.dateISO, row));
  if (showMissing) {
    const first = from ?? index.dates[0], last = to ?? index.dates.at(-1);
    if (first && last) {
      const date = new Date(`${first}T00:00:00Z`), end = new Date(`${last}T00:00:00Z`);
      while (date <= end) {
        const key = date.toISOString().slice(0, 10);
        if ((!dayOfWeek || weekdayOf(key) === dayOfWeek) && (!excludeNonWorkdays || index.workdays.get(key) === true) && !map.has(key)) map.set(key, []);
        date.setUTCDate(date.getUTCDate() + 1);
      }
    }
  }
  return [...map].sort(([a], [b]) => b.localeCompare(a)).map(([dateISO, rows]) => {
    const key = dayKey(dateISO, channel, audience);
    const coverage = Math.max(measureWindow(index.exact.get(key) ?? [], BROADCAST_START, BROADCAST_END).coverageFraction,
      measureWindow(index.grid.get(key) ?? [], BROADCAST_START, BROADCAST_END).coverageFraction);
    return { dateISO, airings: rows, missingReason: rows.length ? null : coverage >= .9 ? 'noMatch' : coverage > 0 ? 'partialDay' : 'noData' };
  });
}

// Descriptive summaries are created only from explicitly selected airings. Sources remain separate.
export function summarizeSelectedAirings(contexts, { groupBy = 'airing' } = {}) {
  if (!['airing', 'hour', 'weekday', 'leadIn'].includes(groupBy)) throw new Error('Неизвестная группировка выходов');
  const groups = new Map();
  for (const context of contexts) {
    const p = context.program;
    const group = groupBy === 'airing' ? p.id : groupBy === 'hour' ? String(Math.floor(p.startSec / 3600)) : groupBy === 'weekday' ? String(weekdayOf(p.dateISO)) : context.previous?.title ?? 'Нет входа';
    add(groups, `${p.channel}\0${p.audience}\0${p.source}\0${group}`, context);
  }
  return [...groups.values()].map(rows => {
    const p = rows[0].program;
    return { source: p.source, channel: p.channel, audience: p.audience, count: rows.length, dates: new Set(rows.map(row => row.program.dateISO)).size,
      label: groupBy === 'airing' ? `${p.dateISO} ${Math.floor(p.startSec / 3600)}:${String(Math.floor(p.startSec % 3600 / 60)).padStart(2, '0')}` :
        groupBy === 'hour' ? `${Math.floor(p.startSec / 3600)}:00–${Math.floor(p.startSec / 3600) + 1}:00` : groupBy === 'weekday' ? String(weekdayOf(p.dateISO)) : rows[0].previous?.title ?? 'Нет входа',
      share: mean(rows.map(row => row.program.share)), rtg: mean(rows.map(row => row.program.rtg)),
      viewers: mean(rows.map(row => row.viewers)), viewerCount: rows.filter(row => finite(row.viewers)).length,
      retention: mean(rows.map(row => row.leadInRetention)), retentionCount: rows.filter(row => finite(row.leadInRetention)).length, rows };
  });
}
