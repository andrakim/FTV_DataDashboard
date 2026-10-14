import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgramCatalog } from '../src/analytics/programs.js';
import { createAiringIndex, filterAirings, describeAiring, averageViewers, airingCalendarDays, summarizeSelectedAirings } from '../src/analytics/airingExplorer.js';
import { FTV_CHANNEL as channel, dailyRecord } from '../src/core/normalization.js';

const dateISO = '2026-10-08';
const log = (id, title, startSec, endSec, share, total, extra = {}) => ({ id, dateISO, channel, title, startSec, endSec, share, rtg: .2,
  ...(total == null ? {} : { demographics: { unit: 'thousandViewers', total } }), ...extra });
function fixture() {
  const data = { daily_metrics: [{ ...dailyRecord(dateISO), isWorkday: true }], program_logs: [
    log('lead', 'Before', 64200, 64800, 2, 1.8), log('news', 'Fresh News', 64800, 66000, 1, .9), log('after', 'After', 66000, 66600, 2, 1.6),
    log('noon', 'Fresh News', 46800, 48000, 3, 2), log('night', 'Fresh News', 93600, 94800, 0, 0),
    log('navo1', 'Film', 64800, 65400, 4, null, { channel: 'NAVO' }), log('navo2', 'Music', 65400, 66000, 2, null, { channel: 'NAVO' }),
  ], grid_10min: [] };
  const catalog = buildProgramCatalog(data);
  return { data, catalog, index: createAiringIndex(catalog, data) };
}

test('programme browsing preserves every repeat on one date; own start window is half-open', () => {
  const { catalog } = fixture();
  assert.equal(filterAirings(catalog, { title: ' fresh   NEWS ', channel }).length, 3);
  assert.deepEqual(filterAirings(catalog, { title: 'Fresh News', channel, startSec: 64800, endSec: 93600 }).map(row => row.id), ['news']);
  const night = filterAirings(catalog, { title: 'Fresh News', channel, startSec: 93600, endSec: 104400, dayOfWeek: 4 });
  assert.equal(night[0].dateISO, dateISO); assert.equal(night[0].share, 0);
  assert.equal(filterAirings(catalog, { title: 'Fresh News', audience: '25-34' }).length, 0);
});

test('visible context uses the full schedule, returns average viewers in people, and retains true zeros', () => {
  const { index, catalog } = fixture(), news = catalog.find(row => row.id === 'news');
  const context = describeAiring(index, news, { competitors: ['NAVO'] });
  assert.equal(context.previous.title, 'Before'); assert.equal(context.next.title, 'After');
  assert.equal(context.viewers, 900); assert.equal(context.previousViewers, 1800); assert.equal(context.nextViewers, 1600);
  assert.equal(context.viewersDelta, -900); assert.equal(context.leadInRetention, 50); assert.equal(context.leadOutRetention, 200);
  assert.equal(averageViewers(catalog.find(row => row.id === 'night')), 0); assert.equal(averageViewers({ share: 10, rtg: 2 }), null);
  assert.equal(averageViewers({ demographics: { unit: 'unknown', total: 3 } }), null);
});

test('concurrent programmes include all overlaps even without a previous slot or a positive competitor spike', () => {
  const { index, catalog } = fixture(), news = catalog.find(row => row.id === 'news');
  const context = describeAiring(index, news, { competitors: ['NAVO', 'SEVIMLI TV'] });
  const navo = context.competitors[0];
  assert.equal(navo.share, 3); assert.equal(navo.source, 'program_logs'); assert.equal(navo.viewers, null);
  assert.deepEqual(navo.programmes.map(row => row.title), ['Film', 'Music']); assert.equal(navo.coverageFraction, 1);
  assert.equal(context.competitors[1].missing, true);
});

test('sparse exact competitor data uses a complete grid consistently, never invents a viewer count', () => {
  const { data, catalog } = fixture(); data.program_logs = data.program_logs.filter(row => row.id !== 'navo2');
  data.grid_10min = [78, 79].map(slotIndex => ({ dateISO, slotIndex, channels: { NAVO: { title: 'Grid film', share: 8, rtg: .5 } } }));
  const index = createAiringIndex(catalog, data), context = describeAiring(index, catalog.find(row => row.id === 'news'), { competitors: ['NAVO'] });
  assert.equal(context.competitors[0].source, 'grid_10min'); assert.equal(context.competitors[0].share, 8); assert.equal(context.competitors[0].viewers, null);
  const partial = describeAiring(createAiringIndex(catalog, { ...data, grid_10min: [] }), catalog.find(row => row.id === 'news'), { competitors: ['NAVO'] });
  assert.equal(partial.competitors[0].share, null); assert.equal(partial.competitors[0].programmes[0].title, 'Film');
});

test('calendar separates missing data, a partial day and an absent matching programme in complete coverage', () => {
  const data = { daily_metrics: ['2026-10-06', '2026-10-07', dateISO].map(date => dailyRecord(date)),
    program_logs: [log('full', 'Other', 18000, 104400, 1, null), log('partial', 'Other', 18000, 18600, 1, null, { dateISO: '2026-10-07' })] };
  const catalog = buildProgramCatalog(data), index = createAiringIndex(catalog, data);
  const days = airingCalendarDays(index, [], { channel, showMissing: true });
  assert.deepEqual(days.map(row => row.missingReason), ['noMatch', 'partialDay', 'noData']);
  assert.equal(airingCalendarDays(index, [], { channel }).length, 0);
});

test('summaries use only selected airings, keep repetitions and sources apart, and disclose missing people counts', () => {
  const { index, catalog } = fixture();
  const contexts = ['news', 'noon', 'night'].map(id => describeAiring(index, catalog.find(row => row.id === id)));
  const input = structuredClone(contexts);
  assert.equal(summarizeSelectedAirings(contexts, { groupBy: 'airing' }).length, 3);
  const group = summarizeSelectedAirings(contexts, { groupBy: 'weekday' })[0];
  assert.equal(group.count, 3); assert.equal(group.dates, 1); assert.equal(group.share, 4 / 3); assert.equal(group.viewerCount, 3);
  assert.equal(group.retentionCount, 1); assert.equal(group.retention, 50);
  contexts.push({ ...contexts[0], program: { ...contexts[0].program, id: 'approx', source: 'grid_10min' }, viewers: null });
  const mixed = summarizeSelectedAirings(contexts, { groupBy: 'weekday' });
  assert.equal(mixed.length, 2); assert.equal(mixed[1].viewerCount, 0);
  assert.deepEqual(contexts.slice(0, 3), input);
});

test('workday and time validation protect browsing filters', () => {
  const { catalog } = fixture();
  assert.equal(filterAirings(catalog, { title: 'Fresh News', excludeNonWorkdays: true, workdays: new Map() }).length, 0);
  assert.throws(() => filterAirings(catalog, { startSec: 64800, endSec: 64000 }));
  assert.throws(() => filterAirings(catalog, { dayOfWeek: 8 }));
});
