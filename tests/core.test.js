import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { AnalyticsDB, STORES } from '../src/core/db.js';
import { createStore } from '../src/core/state.js';
import { dailyRecord, dateDimensions, mergeRecord, parseBroadcastTime, parseReportDate, parseNumber } from '../src/core/normalization.js';

test('broadcast clock keeps 26:02:39 on the same report date and normalizes early clock hours', () => {
  assert.equal(parseBroadcastTime('26:02:39').totalSeconds, 93759);
  assert.equal(parseBroadcastTime('02:02:39', { clock: true }).displayTime, '02:02:39 (+1)');
  assert.equal(parseBroadcastTime(26 / 24).totalSeconds, 93600);
  assert.equal(parseBroadcastTime('29:00').totalSeconds, 104400);
  assert.equal(parseBroadcastTime('05:30').daypart, 'earlyMorning');
  for (const bad of ['30:00:00', '19:61', '', -1, '05:00:60']) assert.throws(() => parseBroadcastTime(bad));
});

test('date dimensions use ISO week-year and contiguous winter', () => {
  assert.deepEqual(dateDimensions('2021-01-01'), { year: 2021, month: 1, season: 'winter', seasonYear: 2021, isoWeek: 53, isoWeekYear: 2020, dayOfWeek: 5 });
  assert.equal(dateDimensions('2020-12-31').seasonYear, 2021);
  assert.equal(parseReportDate('Вт 06.10.2026'), '2026-10-06');
  assert.equal(parseReportDate(1), '1900-01-01');
  assert.equal(parseReportDate(61), '1900-03-01');
  assert.equal(parseReportDate(0, { date1904: true }), '1904-01-01');
  assert.throws(() => parseReportDate('31.02.2026'));
  assert.throws(() => parseReportDate(60));
  assert.equal(parseNumber('1,81'), 1.81);
  assert.equal(parseNumber('0,00'), 0);
  assert.equal(parseNumber('N/A'), null);
});

test('state is immutable, validates updates atomically, unsubscribes, and resets', () => {
  const store = createStore(); let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);
  store.setState({ audience: '25-34', dateFrom: '2026-10-01' });
  assert.equal(calls, 1);
  assert.throws(() => store.setState({ mode: 'invalid', dateTo: '2026-09-30' }));
  assert.throws(() => store.setState({ dateFrom: '06.10.2026' }));
  assert.equal(store.getState().mode, 'week');
  assert.equal(store.getState().dateTo, null);
  assert.throws(() => { store.getState().audience = '18-54'; });
  unsubscribe(); store.reset();
  assert.equal(calls, 1); assert.equal(store.getState().audience, '18-54');
});

test('field provenance retains exact data and missing values do not erase zeros', () => {
  const exact = mergeRecord(null, { ftv_18_54: { share: 0, rtg: 0.2 }, competitorsDaily: { NAVO: { share: 2 } } }, { priority: 40, reportDateISO: '2026-10-01' });
  const partial = mergeRecord(null, { ftv_18_54: { share: 5, rtg: null }, competitorsDaily: {} }, { priority: 20, reportDateISO: '2026-10-02' });
  for (const row of [mergeRecord(exact, partial), mergeRecord(partial, exact)]) {
    assert.equal(row.ftv_18_54.share, 0); assert.equal(row.ftv_18_54.rtg, 0.2); assert.equal(row.competitorsDaily.NAVO.share, 2);
  }
});

const makeDB = () => new AnalyticsDB({ name: `FTV-test-${crypto.randomUUID()}`, indexedDB, IDBKeyRange });
function report(dateISO = '2026-10-06') {
  return { reportDateISO: dateISO,
    daily_metrics: [{ ...dailyRecord(dateISO), ftv_18_54: { share: 1.81 }, competitorsDaily: { NAVO: { share: 1.54 } } }],
    grid_10min: [{ id: `${dateISO}_0`, dateISO, slotIndex: 0, channels: { NAVO: { share: 3 } } }],
    program_logs: [{ id: `${dateISO}_FTV_18000`, dateISO, channel: 'FTV (UZ/RU)', startSec: 18000, endSec: 18600 }],
    media_scans: [{ dateISO, blob: new Blob(['scan'], { type: 'image/png' }) }],
  };
}

test('IndexedDB creates four stores, deduplicates dates, merges partial slots and persists Blob', async () => {
  const db = makeDB();
  const connection = await db.open(); assert.deepEqual([...connection.objectStoreNames].sort(), [...STORES].sort());
  await db.importReport(report());
  const repeat = await db.importReport(report()); assert.equal(repeat.daily_metrics.updated, 1);
  const newer = report('2026-10-07');
  newer.daily_metrics = [{ ...dailyRecord('2026-10-06'), ftv_18_54: { share: 2, rtg: 0.1 } }];
  newer.grid_10min = [{ id: '2026-10-06_0', dateISO: '2026-10-06', slotIndex: 0, channels: { 'FTV (UZ/RU)': { share: 2 } } }];
  await db.importReport(newer);
  const day = await db.get('daily_metrics', '2026-10-06');
  assert.equal(day.ftv_18_54.share, 2); assert.equal(day.competitorsDaily.NAVO.share, 1.54);
  assert.equal((await db.get('grid_10min', '2026-10-06_0')).channels.NAVO.share, 3);
  assert.equal(await (await db.get('media_scans', '2026-10-06')).blob.text(), 'scan');
  db.close(); assert.equal((await db.getAll('daily_metrics')).length, 1);
  await db.deleteDate('2026-10-06');
  for (const name of ['daily_metrics', 'grid_10min']) assert.equal((await db.getAll(name)).length, 0);
  await db.clear(); for (const store of STORES) assert.equal((await db.getAll(store)).length, 0);
  db.close();
});

test('IndexedDB import is atomic on clone failure and validates keys before writing', async () => {
  const db = makeDB(); const invalid = report();
  invalid.media_scans[0].bad = () => {};
  await assert.rejects(db.importReport(invalid));
  for (const store of STORES) assert.equal((await db.getAll(store)).length, 0);
  const noKey = report(); delete noKey.grid_10min[0].id;
  await assert.rejects(db.importReport(noKey), /ключ/);
  const wrongDateFormat = report(); wrongDateFormat.daily_metrics[0].dateISO = '06.10.2026';
  await assert.rejects(db.importReport(wrongDateFormat), /YYYY-MM-DD/);
  await db.importReport(report()); await db.importReport(report('2026-10-07'));
  assert.equal((await db.getAll('daily_metrics', { from: '2026-10-07', to: '2026-10-07' })).length, 1);
  assert.equal((await db.getAll('program_logs', { dateISO: '2026-10-06', channel: 'FTV (UZ/RU)' })).length, 1);
  db.close();
});
