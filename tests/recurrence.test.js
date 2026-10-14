import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRecurrence } from '../src/analytics/recurrence.js';
import { measureWindow } from '../src/analytics/intervals.js';
import { attributeCompetitors } from '../src/analytics/dropDetector.js';
import { buildProgramCatalog } from '../src/analytics/programs.js';
import { dailyRecord, FTV_CHANNEL as channel } from '../src/core/normalization.js';

const dates = ['2026-09-03', '2026-09-10', '2026-09-17', '2026-09-24', '2026-10-01', '2026-10-08'];
function fixture(shares = [1, 1, 1, 1, 1, 1]) {
  return { daily_metrics: dates.map(dateISO => ({ ...dailyRecord(dateISO), isWorkday: true, ftv_18_54: { share: 2 } })),
    program_logs: dates.flatMap((dateISO, i) => [
      { dateISO, channel, title: 'Lead', startSec: 64200, endSec: 64800, share: 2 },
      { dateISO, channel, title: 'News', startSec: 64800, endSec: 65400, share: shares[i], rtg: 0.2 },
      { dateISO, channel, title: 'After', startSec: 65400, endSec: 66000, share: 2 },
      { dateISO, channel: 'NAVO', title: 'Before', startSec: 64200, endSec: 64800, share: 1 },
      { dateISO, channel: 'NAVO', title: 'During', startSec: 64800, endSec: 65400, share: i % 2 ? 0 : 2 },
    ]), grid_10min: [] };
}
const options = { title: 'News', dayOfWeek: 4, startSec: 64800, endSec: 65400 };

test('recurrence counts dates once, reports systematic lead-in drops with explicit paired competitor denominator', () => {
  const data = fixture(); data.program_logs.push({ ...data.program_logs[1] });
  const copy = structuredClone(data), result = analyzeRecurrence(data, options), exact = result.groups[0];
  assert.deepEqual(data, copy);
  assert.equal(exact.classification, 'systematic'); assert.equal(exact.signalDays, 6); assert.equal(exact.eligibleDays, 6);
  assert.equal(result.competitors[0].growthOnDropDays, 3); assert.equal(result.competitors[0].dropDays, 6);
  assert.equal(result.competitors[0].meanDeltaOnDrop, 0);
});

test('leave-one-out median identifies a rare low episode; MAD zero uses a nonzero noise floor', () => {
  const result = analyzeRecurrence(fixture([2, 2, 2, 2, 2, 0.5]), options), last = result.observations.at(-1);
  assert.equal(last.baseline, 2); assert.equal(last.referenceCount, 5); assert.equal(last.mad, 0);
  assert.equal(last.anomalyThreshold, 0.4); assert.equal(last.anomaly, true);
  assert.equal(result.groups[0].classification, 'isolated');
  assert.equal(result.competitors[0].dropDays, 1); assert.equal(result.competitors[0].healthyDays, 5);
  const rounded = analyzeRecurrence(fixture([1.4, 1.4, 1.4, 1.4, 1.4, 1.3]), options);
  assert.equal(rounded.observations.at(-1).anomaly, false);
});

test('baseline never tests against itself and small sample does not become an anomaly or a pattern', () => {
  const data = fixture(); data.program_logs = data.program_logs.filter(row => dates.indexOf(row.dateISO) < 4);
  const result = analyzeRecurrence(data, { ...options, signal: 'baseline' });
  assert.equal(result.groups[0].classification, 'insufficient'); assert.equal(result.groups[0].eligibleDays, 0);
  assert.equal(result.observations[0].baseline, null); assert.equal(result.observations[4].reason, 'noProgram');
});

test('missing, ambiguous, excluded holiday and unknown workday are separate from healthy days', () => {
  const data = fixture(); data.daily_metrics[0].isWorkday = false; data.daily_metrics[1].isWorkday = null;
  data.program_logs.push({ dateISO: dates[2], channel, title: 'News', startSec: 65400, endSec: 66000, share: 1 });
  data.program_logs = data.program_logs.filter(row => row.dateISO !== dates[3]);
  const result = analyzeRecurrence(data, { ...options, endSec: 66000, excludeNonWorkdays: true });
  assert.deepEqual(result.observations.slice(0, 4).map(row => row.reason), ['nonWorkday', 'unknownWorkday', 'ambiguous', 'noProgram']);
  assert.equal(result.groups[0].eligibleDays, 2); assert.equal(result.groups[0].classification, 'insufficient');
});

test('exact and approximate days have independent baselines and frequencies; audience is never substituted', () => {
  const data = fixture(); data.program_logs = data.program_logs.filter(row => dates.indexOf(row.dateISO) < 3);
  data.grid_10min = dates.slice(3).flatMap(dateISO => [77, 78].map(slotIndex => ({ dateISO, slotIndex, channels: { [channel]: { title: slotIndex === 78 ? 'News' : 'Lead', share: slotIndex === 78 ? 1 : 2 } } })));
  const exact = analyzeRecurrence(data, options); assert.equal(exact.observedDays, 3);
  const mixed = analyzeRecurrence(data, { ...options, includeApproximate: true });
  assert.equal(mixed.observedDays, 6); assert.deepEqual(mixed.groups.map(row => row.eligibleDays), [3, 3]);
  assert.ok(mixed.observations.every(row => row.baseline === null));
  assert.equal(analyzeRecurrence(data, { ...options, audience: '25-34', includeApproximate: true }).observedDays, 0);
});

test('fixed window weights partial programme overlap, rejects insufficient coverage and separates night dates', () => {
  const data = fixture();
  data.program_logs = [{ dateISO: dates[0], channel, title: 'A', startSec: 93000, endSec: 93600, share: 2 },
    { dateISO: dates[0], channel, title: 'B', startSec: 93600, endSec: 93900, share: 0 },
    { dateISO: dates[0], channel, title: 'C', startSec: 93900, endSec: 94800, share: 4 }];
  const result = analyzeRecurrence(data, { ...options, mode: 'slot', startSec: 93600, endSec: 94800 });
  assert.equal(result.observations[0].share, 3); assert.equal(result.observations[0].retention, 150);
  assert.equal(result.observations[1].reason, 'insufficientCoverage');
  const partial = analyzeRecurrence(data, { ...options, mode: 'slot', startSec: 93600, endSec: 96000 });
  assert.equal(partial.observations[0].reason, 'insufficientCoverage');
});

test('overlapping conflicts and sparse competitor windows cannot manufacture a spike', () => {
  const rows = [{ startSec: 18000, endSec: 18600, title: 'A', share: 1 }, { startSec: 18300, endSec: 18600, title: 'B', share: 5 }];
  const measure = measureWindow(rows, 18000, 18600); assert.equal(measure.conflictSeconds, 300); assert.equal(measure.coverageFraction, .5);
  const program = { dateISO: dates[0], startSec: 19200, endSec: 20400 };
  const grid = [1, 2].map(slotIndex => ({ dateISO: dates[0], slotIndex, channels: { NAVO: { share: slotIndex } } }));
  assert.equal(attributeCompetitors(program, { grid_10min: grid }).length, 0);
});

test('partial exact day keeps uncovered grid programmes and separates audience neighbors', () => {
  const rows = buildProgramCatalog({ program_logs: [{ dateISO: dates[0], channel, title: 'Exact', startSec: 18000, endSec: 18600 }],
    grid_10min: [{ dateISO: dates[0], slotIndex: 1, channels: { [channel]: { title: 'Later', share: 2 } } }] });
  assert.equal(rows.length, 2); assert.equal(rows.find(row => row.title === 'Later').approximate, true);
});

test('disabled approximate airings cannot make an exact episode ambiguous', () => {
  const data = fixture();
  data.grid_10min.push({ dateISO: dates[0], slotIndex: 80, channels: { [channel]: { title: 'News', share: 1 } } });
  const result = analyzeRecurrence(data, { ...options, endSec: 67000 });
  assert.equal(result.observations[0].reason, undefined);
  assert.equal(analyzeRecurrence(data, { ...options, endSec: 67000, includeApproximate: true }).observations[0].reason, 'ambiguous');
});

test('invalid intervals and thresholds fail explicitly', () => {
  assert.throws(() => analyzeRecurrence(fixture(), { ...options, endSec: 5000 }));
  assert.throws(() => analyzeRecurrence(fixture(), { ...options, retentionThreshold: -1 }));
  assert.throws(() => analyzeRecurrence(fixture(), { ...options, minimumDays: 1 }));
});
