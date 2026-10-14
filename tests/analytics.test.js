import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyRecord, FTV_CHANNEL } from '../src/core/normalization.js';
import { analyzeDayOfWeek, aggregatePeriod, compareWeeks, compareSeasons, compareYears, metricDelta } from '../src/analytics/comparator.js';
import { calculateRetention, detectSlotDrops, attributeCompetitors } from '../src/analytics/dropDetector.js';

const day = (dateISO, share, isWorkday = true) => ({ ...dailyRecord(dateISO), isWorkday, ftv_18_54: { share, rtg: share / 10, reach: 20, atsMin: 10 }, ftv_25_34: { share: share * 2 } });
const slot = (dateISO, slotIndex, share, extras = {}) => ({ id: `${dateISO}_${slotIndex}`, dateISO, slotIndex, startSec: 18000 + slotIndex * 600, endSec: 18600 + slotIndex * 600, channels: { [FTV_CHANNEL]: { share, rtg: share / 10, audience: '18-54' }, ...extras } });

test('Thursday baseline uses valid zeros, mean/median, weekday and workday filters', () => {
  const dates = ['2026-10-01', '2026-10-08', '2026-10-15'];
  const data = { daily_metrics: dates.map((d, i) => day(d, [0, 2, 10][i], i !== 2)).concat(day('2026-10-02', 999)), grid_10min: dates.map((d, i) => slot(d, 0, [0, 2, 10][i])) };
  const result = analyzeDayOfWeek(data, { dayOfWeek: 4, month: 10, year: 2026 });
  assert.equal(result.baseline[0].meanShare, 4); assert.equal(result.baseline[0].medianShare, 2);
  assert.equal(result.baseline[1].meanShare, null); assert.equal(result.curves.length, 3);
  assert.equal(analyzeDayOfWeek(data, { dayOfWeek: 4, excludeNonWorkdays: true }).baseline[0].meanShare, 1);
  const younger = analyzeDayOfWeek(data, { dayOfWeek: 4, audience: '25-34' });
  assert.equal(younger.summary.daily.share.mean, 8); assert.equal(younger.baseline[0].meanShare, null);
});

test('week comparison keeps years separate and aligns weekdays and dayparts', () => {
  const data = { daily_metrics: [day('2026-10-01', 2), day('2026-10-08', 4)], grid_10min: [slot('2026-10-01', 84, 2), slot('2026-10-08', 84, 4)] };
  const result = compareWeeks(data, { isoWeekYear: 2026, isoWeek: 41 }, { isoWeekYear: 2026, isoWeek: 40 });
  assert.equal(result.daily.share.absolute, 2); assert.equal(result.daily.share.relativePercent, 100);
  assert.equal(result.weekdays[3].current.dayCount, 1);
  assert.equal(result.dayparts.find(p => p.id === 'primeTime').share.absolute, 2);
  assert.throws(() => compareWeeks(data, { isoWeek: 41 }, { isoWeek: 40 }));
});

test('season uses contiguous December-February winter and compares regional contribution', () => {
  const rows = [day('2025-12-01', 1), day('2026-01-01', 3), day('2026-02-01', 5), day('2026-03-01', 9)];
  for (const row of rows) row.regions = { '18-54': { Ташкент: { contribution: row.ftv_18_54.share / 10 } } };
  const result = compareSeasons({ daily_metrics: rows }, { season: 'winter', seasonYear: 2026 }, { season: 'spring', seasonYear: 2026 });
  assert.equal(result.current.dayCount, 3); assert.equal(result.current.daily.share.mean, 3);
  assert.ok(Math.abs(result.regions.Ташкент.contribution.absolute + 0.6) < 1e-10);
});

test('years align ISO weekday across New Year, provide 12 months, and do not invent unique reach', () => {
  const result = compareYears({ daily_metrics: [day('2020-01-02', 1), day('2020-12-31', 2), day('2021-01-01', 3), day('2021-01-07', 5)] }, 2021, 2020);
  assert.equal(result.monthly.length, 12);
  const firstThursday = result.weekAlignment.find(row => row.isoWeek === 1 && row.dayOfWeek === 4);
  assert.equal(firstThursday.currentDate, '2021-01-07'); assert.equal(firstThursday.baselineDate, '2020-01-02');
  assert.equal(firstThursday.metrics.share.absolute, 4);
  assert.equal(result.reachExposure.current.cumulativeUniqueReach, null);
  assert.equal(result.reachExposure.current.sumDailyReachPercent, 40);
  assert.equal(result.current.daily.share.mean, 4);
  assert.equal(metricDelta(2, 0).relativePercent, null);
});

test('empty periods keep missing metrics null and never substitute zeros', () => {
  const result = aggregatePeriod({ daily_metrics: [], grid_10min: [] });
  assert.equal(result.daily.share.mean, null); assert.equal(result.slots.length, 144);
  assert.equal(result.slots[143].endSec, 104400); assert.equal(result.dayCount, 0);
});

function programs(dateISO = '2026-10-06') {
  return [
    { dateISO, channel: FTV_CHANNEL, title: 'Lead', startSec: 64800, endSec: 65400, share: 2, rtg: 0.2 },
    { dateISO, channel: FTV_CHANNEL, title: 'Valley', startSec: 65400, endSec: 66000, share: 1.2, rtg: 0.2 },
    { dateISO, channel: FTV_CHANNEL, title: 'Return', startSec: 66000, endSec: 66600, share: 1.6, rtg: 0.3 },
  ];
}

test('detector fires A/B/C, computes lead-out and does not compare across dates', () => {
  const logs = programs();
  const data = { daily_metrics: [day('2026-10-06', 2)], program_logs: [...logs].reverse() };
  const valley = detectSlotDrops(data).find(row => row.program.title === 'Valley');
  assert.deepEqual(valley.triggers, ['leadInDrop', 'primeUnderperformance', 'midBlockValley']);
  assert.equal(valley.leadInRetention, 60); assert.ok(Math.abs(valley.leadOutRetention - 133.33333333333334) < 1e-10);
  assert.equal(calculateRetention(1, 0), null);
  assert.equal(detectSlotDrops({ program_logs: [logs[0], { ...logs[1], dateISO: '2026-10-07' }] }).length, 0);
  assert.equal(detectSlotDrops(data, { audience: '25-34' }).length, 0);
});

test('inclusive 70% retention, low lead-in safeguard, strict prime 65%, stable rating and valley bounds', () => {
  let logs = programs(); logs[1].share = 1.4;
  assert.ok(detectSlotDrops({ program_logs: logs }).find(row => row.program.title === 'Valley').triggers.includes('leadInDrop'));
  logs = programs(); logs[0].share = 0.9; logs[1].share = 0.3; logs.pop();
  assert.equal(detectSlotDrops({ program_logs: logs }).length, 0);
  logs = programs(); logs[1].share = 1.3;
  let drops = detectSlotDrops({ daily_metrics: [day('2026-10-06', 2)], program_logs: logs });
  assert.ok(!drops.find(row => row.program.title === 'Valley').triggers.includes('primeUnderperformance'));
  logs[1].share = 1.2; logs[1].rtg = 0.19;
  drops = detectSlotDrops({ daily_metrics: [day('2026-10-06', 2)], program_logs: logs });
  assert.ok(!drops.find(row => row.program.title === 'Valley').triggers.includes('primeUnderperformance'));
});

test('competitor ranking prefers exact overlap, respects gaps and falls back to ten-minute grid', () => {
  const program = programs()[1];
  const data = { program_logs: [
    { dateISO: program.dateISO, channel: 'NAVO', title: 'Before', startSec: 64800, endSec: 65400, share: 1 },
    { dateISO: program.dateISO, channel: 'NAVO', title: 'After A', startSec: 65400, endSec: 65700, share: 3 },
    { dateISO: program.dateISO, channel: 'NAVO', title: 'After B', startSec: 65700, endSec: 66000, share: 5 },
  ], grid_10min: [slot(program.dateISO, 78, 2, { NAVO: { share: 20 }, SEVIMLI: { share: 2 } }), slot(program.dateISO, 79, 1.2, { NAVO: { share: 20 }, SEVIMLI: { share: 3 } })] };
  const result = attributeCompetitors(program, data);
  assert.equal(result[0].channel, 'NAVO'); assert.equal(result[0].deltaShare, 3);
  assert.equal(result[0].source, 'program_logs'); assert.equal(result[1].source, 'grid_10min');
  assert.equal(result[1].deltaShare, 1);
  assert.deepEqual(result[0].programs, ['After A', 'After B']);
  assert.equal(attributeCompetitors({ ...program, startSec: 18000, endSec: 18600 }, data).length, 0);
});
