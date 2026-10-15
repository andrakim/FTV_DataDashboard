import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWorkspaceData, queryWorkspace, groupWorkspace, resolveCohort, coverageRows, QUERY_DEFAULTS } from '../src/analytics/workspaceQuery.js';
import { WORKSPACE_INITIAL, restoreWorkspace, createQueryHistory, validateBackup } from '../src/core/workspace.js';
import { dailyRecord, FTV_CHANNEL as channel } from '../src/core/normalization.js';

function fixture() {
  const dateISO = '2026-10-08', data = { daily_metrics: [{ ...dailyRecord(dateISO), isWorkday: true }, { ...dailyRecord('2026-10-09'), isWorkday: false }, dailyRecord('2026-10-15')], program_logs: [
    { id: 'lead', dateISO, channel, title: 'Lead', startSec: 64800, endSec: 66600, share: 2 },
    { id: 'news', dateISO, channel, title: 'News', startSec: 66600, endSec: 68400, share: 1, rtg: .1, demographics: { unit: 'thousandViewers', total: .9, male: .4, female: .5, segments: { 'M 25-34': .15 } } },
    { id: 'repeat', dateISO, channel, title: 'News', startSec: 46800, endSec: 50400, share: 0, rtg: 0, demographics: { total: 0 } },
    { id: 'friday', dateISO: '2026-10-09', channel, title: 'News', startSec: 66600, endSec: 68400, share: 3 },
    { id: 'navo', dateISO, channel: 'NAVO', title: 'News', startSec: 66600, endSec: 68400, share: 5 },
  ], grid_10min: [{ id: '2026-10-15_81', dateISO: '2026-10-15', slotIndex: 81, channels: { [channel]: { title: 'News', share: 2, rtg: .2 } } }] };
  return { data, ...prepareWorkspaceData(data) };
}

test('workspace selects several programmes, channels and weekdays without combining repeats', () => {
  const { rows } = fixture();
  const result = queryWorkspace(rows, { programmes: ['News', 'Lead'], channels: [channel, 'NAVO'], weekdays: [4, 5] });
  assert.equal(result.length, 6); assert.equal(new Set(result.map(row => row.id)).size, 6);
  assert.equal(queryWorkspace(rows, { programmes: ['News'], programmeMode: 'exclude' }).length, 1);
  assert.equal(queryWorkspace(rows, { audience: '25-34' }).length, 0);
});

test('three time interpretations differ and second-level broadcast boundaries stay exact', () => {
  const { rows } = fixture();
  const q = { from: '2026-10-08', to: '2026-10-08', programmes: ['News'], startSec: 48000, endSec: 49000 };
  assert.equal(queryWorkspace(rows, q).length, 0);
  assert.deepEqual(queryWorkspace(rows, { ...q, timeMode: 'overlaps' }).map(row => row.id), ['repeat']);
  assert.equal(queryWorkspace(rows, { ...q, timeMode: 'contained' }).length, 0);
  assert.equal(queryWorkspace(rows, { startSec: 66601, endSec: 68400, source: 'exact' }).length, 0);
  assert.equal(queryWorkspace(rows, { startSec: 66600, endSec: 68400, source: 'exact' }).length, 2);
});

test('AND/OR conditions distinguish a measured zero from missing people or retention', () => {
  const { rows } = fixture();
  const missing = { field: 'viewers', operator: 'missing' }, zero = { field: 'share', operator: 'eq', value: 0 };
  assert.deepEqual(queryWorkspace(rows, { conditions: [zero] }).map(row => row.id), ['repeat']);
  assert.equal(queryWorkspace(rows, { conditions: [missing, zero], conditionMode: 'all' }).length, 0);
  const any = queryWorkspace(rows, { conditions: [missing, zero], conditionMode: 'any' });
  assert.equal(any.length, 4);
  assert.equal(queryWorkspace(rows, { conditions: [{ field: 'viewers', operator: 'lte', value: 0 }] }).length, 1);
  assert.equal(queryWorkspace(rows, { conditions: [{ field: 'retention', operator: 'between', value: 49, upper: 51 }] })[0].id, 'news');
});

test('labels, date exclusions, workdays and exact/grid sources compose without mutating data', () => {
  const { rows } = fixture(), input = structuredClone(rows), annotations = { news: { label: 'main', note: 'Premiere' } };
  assert.deepEqual(queryWorkspace(rows, { labels: ['main'] }, annotations).map(row => row.id), ['news']);
  assert.equal(queryWorkspace(rows, { source: 'grid', workday: 'unknown' }).length, 1);
  assert.equal(queryWorkspace(rows, { excludedDates: ['2026-10-08'], excludedIds: ['friday'] }).length, 1);
  assert.equal(queryWorkspace(rows, { workday: 'nonworkday' })[0].id, 'friday');
  assert.deepEqual(rows, input);
});

test('gender/age viewers retain source units and can be filtered and compared directly', () => {
  const { rows } = fixture(), news = rows.find(row => row.id === 'news');
  assert.equal(news.viewers, 900); assert.equal(news.maleViewers, 400); assert.equal(news.femaleViewers, 500); assert.equal(news.m2534Viewers, 150);
  assert.equal(rows.find(row => row.id === 'friday').m2534Viewers, null);
  assert.equal(queryWorkspace(rows, { conditions: [{ field: 'm2534Viewers', operator: 'gt', value: 100 }] })[0].id, 'news');
});

test('group statistics preserve source/channel/audience partitions and measured denominators', () => {
  const { rows } = fixture(), selected = rows.filter(row => ['news', 'repeat'].includes(row.id));
  const avg = groupWorkspace(selected, { groupBy: 'title', metric: 'share', statistic: 'mean' })[0];
  assert.equal(avg.value, .5); assert.equal(avg.measured, 2); assert.equal(avg.days, 1);
  const weighted = groupWorkspace(selected, { groupBy: 'title', metric: 'share', statistic: 'weighted' })[0];
  assert.equal(weighted.value, 1 / 3);
  assert.equal(groupWorkspace(selected, { groupBy: 'title', metric: 'viewers', statistic: 'median' })[0].value, 450);
  const all = groupWorkspace(rows.filter(row => row.title === 'News'), { groupBy: 'title', metric: 'share' });
  assert.equal(all.length, 3); assert.ok(all.some(group => group.channel === 'NAVO')); assert.ok(all.some(group => group.source === 'grid_10min'));
});

test('cohort membership is fixed when the current query changes; unavailable IDs are disclosed', () => {
  const { rows, byId } = fixture(), cohort = { ids: ['news', 'repeat', 'missing'] };
  queryWorkspace(rows, { channels: ['NAVO'] });
  const result = resolveCohort(cohort, byId); assert.equal(result.rows.length, 2); assert.equal(result.missing, 1); assert.deepEqual(result.audiences, ['18-54']);
});

test('query history undo/redo is independent and a new branch drops obsolete future states', () => {
  const history = createQueryHistory(), a = structuredClone(QUERY_DEFAULTS), b = { ...a, search: 'News' }, c = { ...a, search: 'Lead' };
  history.record(a); assert.deepEqual(history.undo(b), a); assert.deepEqual(history.redo(a), b);
  history.record(b); assert.deepEqual(history.undo(c), b); history.record(a); assert.equal(history.canRedo, false);
});

test('settings and backup validation reject malformed data before database writes', () => {
  const { data } = fixture(), backup = { format: 'FTV Studio backup', version: 1, data, workspace: structuredClone(WORKSPACE_INITIAL) };
  assert.equal(validateBackup(backup).tab, 'research');
  assert.throws(() => restoreWorkspace({ query: { ...QUERY_DEFAULTS, startSec: 1 } }));
  assert.throws(() => restoreWorkspace({ cohorts: null }));
  assert.throws(() => restoreWorkspace({ query: { ...QUERY_DEFAULTS, conditions: [{ field: 'share', operator: 'lt', value: null }] } }));
  const malformed = structuredClone(backup); malformed.data.program_logs[0].endSec = 1; assert.throws(() => validateBackup(malformed));
  assert.throws(() => validateBackup({ ...backup, version: 999 }));
});

test('coverage makes daily-only history and programme/grid availability distinct', () => {
  const { data } = fixture(), rows = coverageRows(data);
  assert.equal(rows[0].gridSlots, 1); assert.equal(rows[0].exactFTV, 0); assert.equal(rows[0].daily, true);
  assert.equal(rows.at(-1).exactFTV, 3); assert.equal(rows.at(-1).competitors, 1);
});
