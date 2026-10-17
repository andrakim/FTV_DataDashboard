import test from 'node:test';
import assert from 'node:assert/strict';
import { TREND_DEFAULTS, validateTrendFilters, shiftDate, initialTrendFilters, buildTrendDays, trendProgrammes, timeAtFraction, programmesAtTime } from '../src/analytics/trendExplorer.js';
import { SIMPLE_VIEW_INITIAL, restoreSimpleView, validateSimpleView } from '../src/core/simpleView.js';
import { FTV_CHANNEL } from '../src/core/normalization.js';

const monday = '2026-10-05', friday = '2026-10-09';
const filters = patch => ({ ...structuredClone(TREND_DEFAULTS), from: monday, to: friday, ...patch });
const airing = (id, dateISO, startSec, endSec, patch = {}) => ({ id, dateISO, startSec, endSec, channel: FTV_CHANNEL, title: 'Fresh News', audience: '18-54', share: 0, rtg: null, ...patch });

test('Monday–Friday includes dates without scans or programmes; each absence remains explicit', () => {
  const catalog = [airing('monday', monday, 64800, 65400), airing('wednesday', '2026-10-07', 65000, 65500)];
  const scans = [monday, '2026-10-08', '2026-10-10'];
  const days = buildTrendDays(catalog, scans, filters({ to: '2026-10-11' }));
  assert.deepEqual(days.map(day => day.dateISO), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  assert.deepEqual(days.map(day => day.weekday), [1, 2, 3, 4, 5]);
  assert.deepEqual(days.map(day => day.hasScan), [true, false, false, true, false]);
  assert.deepEqual(days.map(day => day.matches.length), [1, 0, 1, 0, 0]);
  assert.equal(days[0].matches[0].share, 0);
  assert.equal(days[0].matches[0].rtg, null);
});

test('18–19 window includes a programme that starts before 18 and preserves adjacent boundaries', () => {
  const catalog = [
    airing('ends-at-start', monday, 63000, 64800),
    airing('crosses-start', monday, 64200, 65100),
    airing('inside', monday, 65100, 66000),
    airing('crosses-end', monday, 67800, 69000),
    airing('starts-at-end', monday, 68400, 69000),
  ];
  const before = structuredClone(catalog), [day] = buildTrendDays(catalog, [monday], filters({ to: monday }));
  assert.deepEqual(day.matches.map(row => row.id), ['crosses-start', 'inside', 'crosses-end']);
  assert.equal(day.matches[0].startSec, 64200, 'the true programme boundary is not replaced with the window start');
  assert.equal(day.matches.at(-1).endSec, 69000, 'the true programme boundary is not clipped in the source records');
  assert.deepEqual(catalog, before);
});

test('repeated titles stay as separate airings and a title filter keeps all selected dates', () => {
  const catalog = [
    airing('repeat', monday, 66600, 67200, { title: 'FRESH   NEWS' }),
    airing('other', monday, 65400, 66600, { title: 'Вечерний фильм' }),
    airing('first', monday, 64200, 65400),
    airing('tuesday-other', '2026-10-06', 64800, 68400, { title: 'Другой эфир' }),
    airing('morning-repeat', monday, 46800, 48000),
  ];
  const days = buildTrendDays(catalog, [monday, '2026-10-06'], filters({ title: ' fresh news ' }));
  assert.equal(days.length, 5);
  assert.deepEqual(days[0].programmes.map(row => row.id), ['first', 'other', 'repeat']);
  assert.deepEqual(days[0].matches.map(row => row.id), ['first', 'repeat']);
  assert.equal(days[1].matches.length, 0);
  assert.equal(days[1].programmes[0].title, 'Другой эфир', 'context is retained when the programme does not air');
  assert.deepEqual(trendProgrammes(days).map(row => row.id), ['first', 'repeat']);
});

test('channel and audience cannot leak into the selected programme window', () => {
  const catalog = [
    airing('correct', monday, 64800, 66000),
    airing('competitor', monday, 64800, 66000, { channel: 'NAVO' }),
    airing('other-audience', monday, 64800, 66000, { audience: '25-34' }),
    airing('old-date', '2026-10-04', 64800, 66000),
  ];
  assert.deepEqual(buildTrendDays(catalog, [], filters())[0].matches.map(row => row.id), ['correct']);
  assert.deepEqual(buildTrendDays(catalog, [], filters({ channel: 'NAVO' }))[0].matches.map(row => row.id), ['competitor']);
});

test('no selected weekdays means zero days; uninitialized ranges do not expand to invented dates', () => {
  const catalog = [airing('monday', monday, 64800, 66000)];
  assert.deepEqual(buildTrendDays(catalog, [monday], filters({ weekdays: [] })), []);
  assert.deepEqual(buildTrendDays(catalog, [monday], filters({ from: null })), []);
  assert.deepEqual(buildTrendDays(catalog, [monday], filters({ to: null })), []);
});

test('night intervals keep their broadcast date and 29:00 is an exclusive end', () => {
  const catalog = [
    airing('night', friday, 90000, 93600),
    airing('late', friday, 104100, 104400),
    airing('next-day', '2026-10-10', 90000, 93600),
  ];
  const days = buildTrendDays(catalog, [friday], filters({ startSec: 90000, endSec: 104400 }));
  assert.deepEqual(days.at(-1).matches.map(row => row.id), ['night', 'late']);
  assert.deepEqual(trendProgrammes(days).map(row => row.dateISO), [friday, friday]);
  assert.equal(programmesAtTime(catalog, friday, 104399, FTV_CHANNEL)[0].id, 'late');
  assert.deepEqual(programmesAtTime(catalog, friday, 104400, FTV_CHANNEL), []);
});

test('initial date range uses the latest scan rather than longer daily history', () => {
  const initial = initialTrendFilters(['2026-10-08', monday, '2026-10-08'], ['2026-10-30']);
  assert.equal(initial.from, '2026-10-02');
  assert.equal(initial.to, '2026-10-08');
  assert.deepEqual(initial.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(initial.startSec, 64800); assert.equal(initial.endSec, 68400);
  assert.equal(initialTrendFilters([], ['2026-10-30']).from, '2026-10-24');
  assert.deepEqual(initialTrendFilters([], []), structuredClone(TREND_DEFAULTS));
  initial.weekdays.push(6);
  assert.deepEqual(TREND_DEFAULTS.weekdays, [1, 2, 3, 4, 5]);
});

test('calendar shifts respect leap days and cross-year dates without timezone drift', () => {
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.throws(() => shiftDate('2026-02-30', 1));
});

test('time, dates, weekdays, and bounded date range are validated before querying', () => {
  assert.doesNotThrow(() => validateTrendFilters(filters({ startSec: 18000, endSec: 104400 })));
  for (const patch of [
    { startSec: 17999 }, { endSec: 104401 }, { endSec: 64800 }, { endSec: 64799 },
    { startSec: NaN }, { endSec: Infinity }, { startSec: '18:00' },
    { from: '2026-02-30' }, { from: '2026-10-10', to: monday },
    { weekdays: [0] }, { weekdays: [8] }, { weekdays: [1, 1] }, { weekdays: [1.5] },
    { weekdays: '1,2,3,4,5' }, { title: 'a'.repeat(501) }, { title: null }, { channel: null },
  ]) assert.throws(() => validateTrendFilters(filters(patch)), JSON.stringify(patch));
  assert.throws(() => buildTrendDays([], [], filters({ from: '2000-01-01', to: '2026-10-15' })), /10 лет/);
});

test('partial saved view restores new defaults and preserves the chosen module, date range, and scale', () => {
  const saved = { tab: 'programmes', scale: 'large', page: 3, filters: { from: monday, to: friday, title: 'Fresh News', weekdays: [2, 4], startSec: 63000, endSec: 69000 } };
  const before = structuredClone(saved), restored = restoreSimpleView(saved);
  assert.equal(restored.tab, 'programmes'); assert.equal(restored.scale, 'large'); assert.equal(restored.page, 3);
  assert.equal(restored.filters.channel, FTV_CHANNEL);
  assert.equal(restored.filters.title, 'Fresh News'); assert.equal(restored.filters.from, monday);
  assert.deepEqual(restored.filters.weekdays, [2, 4]);
  assert.equal(restored.filters.startSec, 63000); assert.equal(restored.filters.endSec, 69000);
  assert.deepEqual(saved, before, 'restoring preferences does not change their serialized content');
  assert.deepEqual(restoreSimpleView({ filters: { title: 'Fresh News' } }), { ...structuredClone(SIMPLE_VIEW_INITIAL), filters: { ...structuredClone(TREND_DEFAULTS), title: 'Fresh News' } });
  const first = restoreSimpleView(); first.filters.weekdays.length = 0;
  assert.deepEqual(restoreSimpleView().filters.weekdays, [1, 2, 3, 4, 5], 'default arrays are independent between restorations');
});

test('invalid saved state fails explicitly so the app can recover defaults rather than render corrupt settings', () => {
  for (const patch of [{ tab: 'workspace' }, { scale: 'broken' }, { page: 0 }, { page: 1.5 }, { filters: { startSec: 68400, endSec: 64800 } }, { filters: { weekdays: [4, 4] } }, { filters: { from: 'not-a-date' } }]) {
    assert.throws(() => restoreSimpleView(patch));
  }
  assert.doesNotThrow(() => validateSimpleView(restoreSimpleView({ filters: { weekdays: [] } })));
});

test('pointer fraction maps to the selected broadcast window with clamped ends and second precision', () => {
  const window = filters({ startSec: 64807, endSec: 68409 });
  assert.equal(timeAtFraction(window, -1), 64807);
  assert.equal(timeAtFraction(window, 0), 64807);
  assert.equal(timeAtFraction(window, .5), 66608);
  assert.equal(timeAtFraction(window, 1), 68409);
  assert.equal(timeAtFraction(window, 2), 68409);
  assert.equal(timeAtFraction(filters({ startSec: 90000, endSec: 93600 }), .5), 91800);
});

test('time lookup follows half-open boundaries, preserves competing matches, and respects channel/date/audience', () => {
  const catalog = [
    airing('first', monday, 64800, 65400),
    airing('next', monday, 65400, 66000),
    airing('overlapping', monday, 65300, 65700),
    airing('competitor', monday, 65400, 66000, { channel: 'NAVO' }),
    airing('tomorrow', '2026-10-06', 65400, 66000),
    airing('wrong-audience', monday, 65400, 66000, { audience: '25-34' }),
  ];
  assert.deepEqual(programmesAtTime(catalog, monday, 64800, FTV_CHANNEL).map(row => row.id), ['first']);
  assert.deepEqual(programmesAtTime(catalog, monday, 65400, FTV_CHANNEL).map(row => row.id), ['next', 'overlapping']);
  assert.deepEqual(programmesAtTime(catalog, monday, 65400, 'NAVO').map(row => row.id), ['competitor']);
  assert.deepEqual(programmesAtTime(catalog, monday, 66000, FTV_CHANNEL), []);
  assert.deepEqual(programmesAtTime(catalog, monday, 64799, FTV_CHANNEL), []);
});

test('programme search and sorting preserve repeats, zeros, missing values and source boundaries', () => {
  const exactZero = airing('zero', monday, 64800, 65000, { title: 'Fresh   news', share: 0, approximate: false });
  const exactHigh = airing('high', monday, 65000, 65400, { title: 'FRESH NEWS', share: 8, approximate: false });
  const approximate = airing('grid', friday, 64800, 65400, { title: 'Fresh news', share: 2, approximate: true });
  const missing = airing('missing', monday, 66000, 66400, { title: 'Fresh news', share: null, approximate: false });
  const other = airing('other', monday, 67000, 67400, { title: 'Film', share: 99 });
  const days = [{ matches: [missing, other, exactHigh, exactZero, approximate] }], before = structuredClone(days);
  assert.deepEqual(trendProgrammes(days, { search: '  fresh nEws ', sort: 'share-asc' }).map(row => row.id), ['zero', 'grid', 'high', 'missing']);
  assert.deepEqual(trendProgrammes(days, { search: 'news', sort: 'share-desc', source: 'exact' }).map(row => row.id), ['high', 'zero', 'missing']);
  assert.deepEqual(trendProgrammes(days, { source: 'grid' }).map(row => row.id), ['grid']);
  assert.deepEqual(trendProgrammes(days, { search: 'missing title' }), []);
  assert.deepEqual(days, before);
});

test('available-scan preference restores old settings and rejects malformed backup values', () => {
  assert.equal(restoreSimpleView({ filters: { from: monday, to: friday } }).onlyScans, false);
  assert.equal(restoreSimpleView({ onlyScans: true }).onlyScans, true);
  assert.throws(() => restoreSimpleView({ onlyScans: 'false' }));
});

test('oversized date ranges are rejected before saving settings or restoring a backup', () => {
  assert.throws(() => validateTrendFilters(filters({ from: '2000-01-01', to: '2026-10-15' })), /10 лет/);
  assert.throws(() => restoreSimpleView({ filters: { from: '2000-01-01', to: '2026-10-15' } }), /10 лет/);
});
