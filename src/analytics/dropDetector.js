import { DAYPARTS, FTV_CHANNEL, normalizeChannel, BROADCAST_START, BROADCAST_END, SLOT_SECONDS } from '../core/normalization.js';
import { buildDaypartProfile, channelMetrics, audienceKey, weightedMean } from './comparator.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const overlap = (start, end, row) => Math.max(0, Math.min(end, row.endSec) - Math.max(start, row.startSec));

export function calculateRetention(currentShare, previousShare) {
  return finite(currentShare) && finite(previousShare) && previousShare > 0 ? currentShare / previousShare * 100 : null;
}

export function demographicLoss(previous, current) {
  const a = previous?.demographics, b = current?.demographics;
  if (!a || !b) return null;
  const totalDelta000 = finite(a.total) && finite(b.total) ? b.total - a.total : null;
  const segments = Object.keys({ ...a.segments, ...b.segments }).flatMap(segment => {
    const before = a.segments?.[segment], after = b.segments?.[segment];
    return finite(before) && finite(after) ? [{ segment, previous000: before, current000: after, delta000: after - before, loss000: Math.max(0, before - after) }] : [];
  }).sort((a, b) => b.loss000 - a.loss000 || a.segment.localeCompare(b.segment));
  return { unit: 'thousandViewers', totalDelta000, lostViewers000: totalDelta000 == null ? null : Math.max(0, -totalDelta000),
    segments, leadingLosses: segments.filter(row => row.loss000 > 0).slice(0, 2) };
}

function windowShare(rows, startSec, endSec) {
  // Sweep disjoint intervals: duplicate or overlapping program rows must not double-count time.
  const relevant = rows.filter(row => overlap(startSec, endSec, row) > 0 && finite(row.share));
  const points = [...new Set([startSec, endSec, ...relevant.flatMap(row => [Math.max(startSec, row.startSec), Math.min(endSec, row.endSec)])])].sort((a, b) => a - b);
  const samples = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    const row = relevant.filter(row => row.startSec <= start && row.endSec >= end).sort((a, b) => b.startSec - a.startSec)[0];
    if (row) samples.push({ value: row.share, weight: end - start });
  }
  return { share: weightedMean(samples), coverageSeconds: samples.reduce((sum, row) => sum + row.weight, 0),
    programs: [...new Set(relevant.map(row => row.title).filter(Boolean))] };
}

export function attributeCompetitors(program, data, { audience = '18-54', channel = FTV_CHANNEL } = {}) {
  audienceKey(audience);
  const ftv = normalizeChannel(channel), dateISO = program.dateISO;
  const currentStart = program.startSec, currentEnd = program.endSec;
  // Previous ten-minute slot anchored to 05:00; a boundary inside a slot uses its preceding complete slot.
  const previousEnd = BROADCAST_START + Math.floor((currentStart - BROADCAST_START) / SLOT_SECONDS) * SLOT_SECONDS;
  const previousStart = previousEnd - SLOT_SECONDS;
  if (previousStart < BROADCAST_START) return [];
  const grid = (data.grid_10min ?? []).filter(row => row.dateISO === dateISO).map(row => ({ ...row,
    startSec: row.startSec ?? BROADCAST_START + row.slotIndex * SLOT_SECONDS,
    endSec: row.endSec ?? BROADCAST_START + (row.slotIndex + 1) * SLOT_SECONDS }));
  const logs = (data.program_logs ?? []).filter(row => row.dateISO === dateISO && (row.audience ?? '18-54') === audience);
  const gridByChannel = new Map(), logsByChannel = new Map();
  for (const row of grid) for (const competitor of Object.keys(row.channels ?? {})) {
    const metrics = channelMetrics(row, competitor, audience); if (!metrics) continue;
    const key = normalizeChannel(competitor);
    if (!gridByChannel.has(key)) gridByChannel.set(key, []);
    gridByChannel.get(key).push({ ...row, ...metrics });
  }
  for (const row of logs) {
    const key = normalizeChannel(row.channel);
    if (!logsByChannel.has(key)) logsByChannel.set(key, []);
    logsByChannel.get(key).push(row);
  }
  const channels = new Set([...gridByChannel.keys(), ...logsByChannel.keys()]);
  const candidates = [];
  for (const competitor of channels) {
    if (normalizeChannel(competitor) === ftv) continue;
    const gridRows = gridByChannel.get(competitor) ?? [];
    const programRows = logsByChannel.get(competitor) ?? [];
    // Prefer exact program boundaries. Use a consistent source for both windows.
    const exactBefore = windowShare(programRows, previousStart, previousEnd), exactDuring = windowShare(programRows, currentStart, currentEnd);
    const useLogs = exactBefore.coverageSeconds === SLOT_SECONDS && exactDuring.coverageSeconds >= (currentEnd - currentStart) * 0.9;
    const before = useLogs ? exactBefore : windowShare(gridRows, previousStart, previousEnd);
    const during = useLogs ? exactDuring : windowShare(gridRows, currentStart, currentEnd);
    if (!finite(before.share) || !finite(during.share)) continue;
    const deltaShare = during.share - before.share;
    if (deltaShare <= 0) continue;
    candidates.push({ channel: normalizeChannel(competitor), previousShare: before.share, currentShare: during.share, deltaShare,
      relativePercent: before.share > 0 ? deltaShare / before.share * 100 : null,
      source: useLogs ? 'program_logs' : 'grid_10min',
      coverageFraction: during.coverageSeconds / (currentEnd - currentStart),
      previousCoverageFraction: before.coverageSeconds / SLOT_SECONDS,
      programs: exactDuring.programs.length ? exactDuring.programs : during.programs,
      window: { startSec: currentStart, endSec: currentEnd, previousStartSec: previousStart, previousEndSec: previousEnd },
    });
  }
  return candidates.sort((a, b) => b.deltaShare - a.deltaShare || a.channel.localeCompare(b.channel));
}

export function detectSlotDrops(data, {
  channel = FTV_CHANNEL, audience = '18-54', from, to, excludeNonWorkdays = false,
  retentionThreshold = 70, minimumLeadInShare = 1, primeDailyFraction = 0.65,
  maxGapSec = 600, includeHealthy = false,
} = {}) {
  audienceKey(audience);
  if (![retentionThreshold, minimumLeadInShare, primeDailyFraction, maxGapSec].every(v => finite(v) && v >= 0)) throw new Error('Некорректные пороги детектора');
  if (from && to && from > to) throw new Error('Начало периода позже конца');
  const daily = new Map((data.daily_metrics ?? []).map(row => [row.dateISO, row]));
  const dataByDate = new Map();
  for (const name of ['program_logs', 'grid_10min']) for (const row of data[name] ?? []) {
    if (!dataByDate.has(row.dateISO)) dataByDate.set(row.dateISO, { program_logs: [], grid_10min: [] });
    dataByDate.get(row.dateISO)[name].push(row);
  }
  const unique = new Map();
  for (const row of data.program_logs ?? []) {
    if (normalizeChannel(row.channel) !== normalizeChannel(channel) || (row.audience ?? '18-54') !== audience) continue;
    if (from && row.dateISO < from || to && row.dateISO > to || excludeNonWorkdays && daily.get(row.dateISO)?.isWorkday !== true) continue;
    if (!finite(row.startSec) || !finite(row.endSec) || row.endSec <= row.startSec) continue;
    unique.set(`${row.dateISO}_${row.startSec}`, row);
  }
  const programs = [...unique.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.startSec - b.startSec);
  const results = [];
  const adjacent = (a, b) => a && b && a.dateISO === b.dateISO && b.startSec >= a.endSec && b.startSec - a.endSec <= maxGapSec;
  const benchmarks = new Map();
  for (let i = 0; i < programs.length; i++) {
    const program = programs[i];
    const previous = adjacent(programs[i - 1], program) ? programs[i - 1] : null;
    const next = adjacent(program, programs[i + 1]) ? programs[i + 1] : null;
    const retention = calculateRetention(program.share, previous?.share);
    const leadOutRetention = calculateRetention(next?.share, program.share);
    const dailyShare = daily.get(program.dateISO)?.[audienceKey(audience)]?.share;
    const deltaShare = finite(program.share) && finite(previous?.share) ? program.share - previous.share : null;
    const triggers = [];
    if (retention != null && retention <= retentionThreshold && previous.share >= minimumLeadInShare) triggers.push('leadInDrop');
    const primeOverlap = overlap(18 * 3600, 23 * 3600, program);
    if (primeOverlap > 0 && finite(program.rtg) && finite(previous?.rtg) && program.rtg >= previous.rtg &&
      finite(program.share) && finite(dailyShare) && dailyShare > 0 && program.share < dailyShare * primeDailyFraction) triggers.push('primeUnderperformance');
    if (finite(program.share) && finite(previous?.share) && finite(next?.share) && program.share < previous.share && program.share < next.share) triggers.push('midBlockValley');
    if (!includeHealthy && !triggers.length) continue;
    if (!benchmarks.has(program.dateISO)) {
      const grid = dataByDate.get(program.dateISO)?.grid_10min ?? [];
      const gridParts = buildDaypartProfile(grid, { channel, audience });
      // Exact TOP logs provide a fallback when the day's grid is absent.
      benchmarks.set(program.dateISO, gridParts.map(part => ({ ...part, share: part.share ?? weightedMean(programs.filter(row => row.dateISO === program.dateISO).map(row => ({ value: row.share, weight: overlap(part.startSec, part.endSec, row) }))) })));
    }
    const dayparts = benchmarks.get(program.dateISO);
    const daypartBenchmark = weightedMean(dayparts.map(part => ({ value: part.share, weight: overlap(program.startSec, program.endSec, part) })));
    const part = DAYPARTS.find(part => program.startSec >= part.startSec && program.startSec < part.endSec);
    results.push({ program, previous, next, triggers, isPainPoint: triggers.length > 0,
      leadInRetention: retention, leadOutRetention, deltaShare, dailyShare: dailyShare ?? null,
      daypart: part?.id ?? null, daypartBenchmark,
      deviationFromDaypart: finite(program.share) && finite(daypartBenchmark) ? program.share - daypartBenchmark : null,
      competitors: triggers.length ? attributeCompetitors(program, dataByDate.get(program.dateISO) ?? {}, { channel, audience }) : [],
      demographics: demographicLoss(previous, program),
      // Share changes and demographic differences show co-occurrence, not tracked viewer migration.
      attributionNote: 'Рост конкурента совпадает по времени с провалом; индивидуальный переход зрителей не установлен.',
      broadcastWindow: { startSec: Math.max(BROADCAST_START, program.startSec), endSec: Math.min(BROADCAST_END, program.endSec) },
    });
  }
  return results;
}
