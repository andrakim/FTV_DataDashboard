import { FTV_CHANNEL, BROADCAST_START, BROADCAST_END, SLOT_SECONDS, assertDateISO, normalizeChannel } from '../core/normalization.js';
import { audienceKey, median, mean, channelMetrics } from './comparator.js';
import { buildProgramCatalog, programNeighbors } from './programs.js';
import { calculateRetention, attributeCompetitors, demographicLoss } from './dropDetector.js';
import { measureWindow, finite } from './intervals.js';

export const RECURRENCE_DEFAULTS = Object.freeze({ mode: 'program', title: '', channel: FTV_CHANNEL, audience: '18-54',
  dayOfWeek: 4, startSec: 18 * 3600, endSec: 20 * 3600, includeApproximate: false, signal: 'leadIn',
  retentionThreshold: 70, minimumLeadInShare: 1, baselineDropPercent: 20, minimumCoverage: 0.9, minimumDays: 5 });
const titleKey = title => String(title ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');

function validate(o) {
  audienceKey(o.audience);
  if (!['program', 'slot'].includes(o.mode) || !['leadIn', 'baseline'].includes(o.signal)) throw new Error('Неизвестный режим закономерностей');
  if (!Number.isInteger(o.dayOfWeek) || o.dayOfWeek < 1 || o.dayOfWeek > 7) throw new Error('Выберите день недели');
  if (![o.startSec, o.endSec].every(finite) || o.startSec < BROADCAST_START || o.endSec > BROADCAST_END || o.endSec <= o.startSec) throw new Error('Задайте время от 05:00 до 29:00; конец должен быть позже начала');
  if (![o.retentionThreshold, o.baselineDropPercent].every(v => finite(v) && v > 0 && v <= 100) || !finite(o.minimumLeadInShare) || o.minimumLeadInShare < 0 || !finite(o.minimumCoverage) || o.minimumCoverage <= 0 || o.minimumCoverage > 1 || !Number.isInteger(o.minimumDays) || o.minimumDays < 5) throw new Error('Некорректные пороги закономерностей');
  for (const date of [o.from, o.to]) if (date) assertDateISO(date);
  if (o.from && o.to && o.from > o.to) throw new Error('Начало периода позже конца');
  if (!['all', 'exact', 'grid'].includes(o.source ?? 'all') || !['all', 'workday', 'nonworkday', 'unknown'].includes(o.workday ?? 'all')) throw new Error('Неверный источник или тип дня');
  for (const key of ['excludedIds', 'excludedDates', 'eligibleProgramIds']) if (o[key] != null && (!Array.isArray(o[key]) || o[key].some(value => typeof value !== 'string'))) throw new Error('Неверные исключения');
  (o.excludedDates ?? []).forEach(assertDateISO);
}

function datesInScope(data, o) {
  const available = [...new Set(['daily_metrics', 'grid_10min', 'program_logs'].flatMap(key => (data[key] ?? []).map(row => row.dateISO)))].sort();
  const from = o.from ?? available[0], to = o.to ?? available.at(-1);
  if (!from || !to) return [];
  const result = [], date = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (o.dayOfWeek - (date.getUTCDay() || 7) + 7) % 7);
  while (date <= end) {
    result.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 7);
  }
  return result;
}

function byDate(rows) {
  const map = new Map();
  for (const row of rows) { if (!map.has(row.dateISO)) map.set(row.dateISO, []); map.get(row.dateISO).push(row); }
  return map;
}

function programObservation(rows, o) {
  const allMatches = rows.filter(row => titleKey(row.title) === titleKey(o.title) && row.startSec >= o.startSec && row.startSec < o.endSec);
  const sourced = allMatches.filter(row => (o.includeApproximate || !row.approximate) && (o.source !== 'exact' || !row.approximate) && (o.source !== 'grid' || row.approximate));
  const admitted = sourced.filter(row => !(o.excludedIds ?? []).includes(row.id));
  if (sourced.length && !admitted.length) return { reason: 'excludedProgram' };
  const matches = admitted.filter(row => !o.eligibleProgramIds || o.eligibleProgramIds.includes(row.id));
  if (admitted.length && !matches.length) return { reason: 'labelExcluded' };
  if (!matches.length) return { reason: allMatches.length ? 'approximateExcluded' : 'noProgram' };
  // A date is one observation. Two daily airings must not inflate the sample or be chosen silently.
  if (matches.length > 1) return { reason: 'ambiguous', matchCount: matches.length };
  const program = matches[0];
  if (rows.some(row => row.id !== program.id && row.startSec < program.endSec && row.endSec > program.startSec)) return { reason: 'overlappingLogs' };
  if (!finite(program.share)) return { reason: 'missingMetric' };
  const neighbors = programNeighbors(rows, program);
  const previous = neighbors.previous?.approximate === program.approximate ? neighbors.previous : null;
  const next = neighbors.next?.approximate === program.approximate ? neighbors.next : null;
  return { programId: program.id, title: program.title, startSec: program.startSec, endSec: program.endSec,
    share: program.share, rtg: program.rtg, previousShare: previous?.share ?? null, nextShare: next?.share ?? null,
    previousTitle: previous?.title ?? null, nextTitle: next?.title ?? null, demographics: demographicLoss(previous, program),
    source: program.approximate ? 'grid_10min' : 'program_logs', coverageFraction: 1,
    previousCoverageFraction: previous ? 1 : 0, previousRtg: previous?.rtg ?? null };
}

function slotObservation(logs, grid, o) {
  const previousEnd = BROADCAST_START + Math.floor((o.startSec - BROADCAST_START) / SLOT_SECONDS) * SLOT_SECONDS;
  const beforeStart = previousEnd - SLOT_SECONDS;
  const gridRows = grid.flatMap(slot => {
    const metrics = channelMetrics(slot, o.channel, o.audience);
    return metrics ? [{ ...metrics, startSec: slot.startSec ?? BROADCAST_START + slot.slotIndex * SLOT_SECONDS,
      endSec: slot.endSec ?? BROADCAST_START + (slot.slotIndex + 1) * SLOT_SECONDS }] : [];
  });
  let source = 'program_logs', rows = logs, current = measureWindow(logs, o.startSec, o.endSec);
  if ((current.coverageFraction < o.minimumCoverage || current.conflictSeconds) && o.includeApproximate) {
    source = 'grid_10min'; rows = gridRows; current = measureWindow(rows, o.startSec, o.endSec);
  }
  if (current.conflictSeconds) return { reason: 'overlappingLogs' };
  if (current.coverageFraction < o.minimumCoverage) return { reason: !o.includeApproximate && gridRows.length ? 'approximateExcluded' : 'insufficientCoverage', coverageFraction: current.coverageFraction };
  const before = beforeStart >= BROADCAST_START ? measureWindow(rows, beforeStart, previousEnd) : null;
  const after = o.endSec + SLOT_SECONDS <= BROADCAST_END ? measureWindow(rows, o.endSec, o.endSec + SLOT_SECONDS) : null;
  const valid = result => result && !result.conflictSeconds && result.coverageFraction >= o.minimumCoverage;
  const rating = measureWindow(rows, o.startSec, o.endSec, 'rtg');
  return { title: current.programs.join(' / '), startSec: o.startSec, endSec: o.endSec, share: current.value,
    rtg: valid(rating) ? rating.value : null,
    previousShare: valid(before) ? before.value : null, nextShare: valid(after) ? after.value : null,
    previousTitle: before?.programs.join(' / ') ?? null, nextTitle: after?.programs.join(' / ') ?? null,
    source, coverageFraction: current.coverageFraction, previousCoverageFraction: before?.coverageFraction ?? 0 };
}

// Exploratory cohort: reference uses the other dates of the SAME source, never the tested date.
export function analyzeRecurrence(data, options = {}) {
  const o = { ...RECURRENCE_DEFAULTS, ...options, channel: normalizeChannel(options.channel ?? FTV_CHANNEL) }; validate(o);
  const daily = new Map((data.daily_metrics ?? []).map(row => [row.dateISO, row]));
  const catalog = byDate(buildProgramCatalog(data).filter(row => row.channel === o.channel && row.audience === o.audience));
  const allLogs = byDate(data.program_logs ?? []), grids = byDate(data.grid_10min ?? []);
  const dates = datesInScope(data, o);
  const observations = dates.map(dateISO => {
    if ((o.excludedDates ?? []).includes(dateISO)) return { dateISO, reason: 'excludedDate' };
    if (o.excludeNonWorkdays && daily.get(dateISO)?.isWorkday !== true) return { dateISO, reason: daily.get(dateISO)?.isWorkday === false ? 'nonWorkday' : 'unknownWorkday' };
    const isWorkday = daily.get(dateISO)?.isWorkday;
    if (o.workday === 'workday' && isWorkday !== true || o.workday === 'nonworkday' && isWorkday !== false || o.workday === 'unknown' && isWorkday != null) return { dateISO, reason: 'dayTypeExcluded' };
    const logs = (allLogs.get(dateISO) ?? []).filter(row => normalizeChannel(row.channel) === o.channel && (row.audience ?? '18-54') === o.audience);
    const dayPrograms = catalog.get(dateISO) ?? [];
    if (o.mode === 'slot' && dayPrograms.some(row => (o.excludedIds ?? []).includes(row.id) && row.startSec < o.endSec && row.endSec > o.startSec)) return { dateISO, reason: 'excludedProgram' };
    const observation = o.mode === 'program' ? programObservation(dayPrograms, o) : slotObservation(o.source === 'grid' ? [] : logs, grids.get(dateISO) ?? [], { ...o, includeApproximate: o.source === 'exact' ? false : o.includeApproximate });
    if (observation.reason) return { dateISO, ...observation };
    const retention = calculateRetention(observation.share, observation.previousShare);
    return { dateISO, ...observation, retention, deltaShare: finite(observation.previousShare) ? observation.share - observation.previousShare : null,
      dailyShare: daily.get(dateISO)?.[audienceKey(o.audience)]?.share ?? null,
      leadInDrop: retention == null ? null : observation.previousShare >= o.minimumLeadInShare && retention <= o.retentionThreshold,
      competitors: attributeCompetitors({ dateISO, ...observation }, { program_logs: allLogs.get(dateISO) ?? [], grid_10min: grids.get(dateISO) ?? [] }, { channel: o.channel, audience: o.audience, includeNonGrowing: true, minimumCoverage: o.minimumCoverage }) };
  });
  const valid = observations.filter(row => !row.reason);
  for (const row of valid) {
    const peers = valid.filter(other => other.dateISO !== row.dateISO && other.source === row.source);
    row.referenceCount = peers.length;
    row.baseline = peers.length >= o.minimumDays - 1 ? median(peers.map(other => other.share)) : null;
    row.mad = row.baseline == null ? null : median(peers.map(other => Math.abs(other.share - row.baseline)));
    row.deviation = row.baseline == null ? null : row.share - row.baseline;
    row.deviationPercent = row.baseline > 0 ? row.deviation / row.baseline * 100 : null;
    // Floors prevent MAD=0 or rounding noise from producing dramatic classifications.
    row.anomalyThreshold = row.baseline == null ? null : Math.max(0.25, Math.abs(row.baseline) * o.baselineDropPercent / 100, 3 * 1.4826 * row.mad);
    row.anomaly = row.baseline == null ? null : row.deviation < -row.anomalyThreshold;
    row.signal = o.signal === 'leadIn' ? row.leadInDrop : row.anomaly;
  }
  const groups = ['program_logs', 'grid_10min'].map(source => {
    const rows = valid.filter(row => row.source === source), eligible = rows.filter(row => row.signal != null), signals = eligible.filter(row => row.signal);
    const rate = eligible.length ? signals.length / eligible.length : null;
    const anomalyCount = rows.filter(row => row.anomaly).length;
    const classification = eligible.length < o.minimumDays ? 'insufficient' : rate >= 0.6 ? 'systematic' : signals.length === 0 ? 'noSignal' : rate <= 0.25 && signals.some(row => row.anomaly) ? 'isolated' : 'mixed';
    return { source, observedDays: rows.length, eligibleDays: eligible.length, signalDays: signals.length, rate, anomalyCount,
      classification, medianShare: median(rows.map(row => row.share)), medianRetention: median(rows.map(row => row.retention)) };
  });
  // Full paired denominator includes growth, flat and negative competitor days.
  const competitorNames = new Set(valid.flatMap(row => row.competitors.map(item => item.channel)));
  const competitors = [...competitorNames].flatMap(channel => ['program_logs', 'grid_10min'].flatMap(source => {
    const paired = valid.filter(row => row.source === source && row.signal != null).flatMap(row => {
      const competitor = row.competitors.find(item => item.channel === channel);
      return competitor ? [{ ...competitor, signal: row.signal, dateISO: row.dateISO }] : [];
    });
    if (!paired.length) return [];
    return ['program_logs', 'grid_10min'].flatMap(competitorSource => {
      const comparable = paired.filter(row => row.source === competitorSource); if (!comparable.length) return [];
      const dropDays = comparable.filter(row => row.signal), healthyDays = comparable.filter(row => !row.signal);
      return [{ channel, source, competitorSource, pairedDays: comparable.length, dropDays: dropDays.length, growthOnDropDays: dropDays.filter(row => row.deltaShare > 0).length,
        meanDeltaOnDrop: mean(dropDays.map(row => row.deltaShare)), healthyDays: healthyDays.length, meanDeltaOnHealthy: mean(healthyDays.map(row => row.deltaShare)) }];
    });
  })).sort((a, b) => b.growthOnDropDays - a.growthOnDropDays || (b.meanDeltaOnDrop ?? -Infinity) - (a.meanDeltaOnDrop ?? -Infinity));
  return { options: o, observations, groups, competitors, expectedDays: dates.length, observedDays: valid.length,
    omittedDays: observations.filter(row => row.reason).length };
}
