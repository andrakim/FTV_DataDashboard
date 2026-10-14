import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgramCatalog, filterPrograms, summarizePrograms, programNeighbors, programAtSlot } from '../src/analytics/programs.js';
import { csvContent } from '../src/ui/format.js';

const dateISO = '2026-10-06', channel = 'FTV (UZ/RU)';
const slot = (slotIndex, title, share, extra = {}) => ({ dateISO, slotIndex, startSec: 18000 + slotIndex * 600, endSec: 18600 + slotIndex * 600, channels: { [channel]: { title, share, rtg: .1, ...extra } } });

test('program catalog prefers exact logs, restores missing days from grid, and preserves repeat airings and gaps', () => {
  const log = { id: 'exact', dateISO, channel, title: 'Exact', startSec: 18001, endSec: 19201, share: 2, rtg: .2, demographics: { total: 1 } };
  const data = { program_logs: [log, log], grid_10min: [slot(0, 'Grid', 1), ...[slot(0, 'News', 0), slot(1, 'News', 2), slot(2, 'Other', 1), slot(4, 'News', 4)].map(row => ({ ...row, dateISO: '2026-10-05' }))] };
  const copy = structuredClone(data), rows = buildProgramCatalog(data);
  assert.deepEqual(data, copy);
  assert.equal(rows.filter(row => row.dateISO === dateISO).length, 1);
  assert.equal(rows.find(row => row.id === 'exact').startSec, 18001);
  const gridNews = rows.filter(row => row.approximate && row.title === 'News');
  assert.equal(gridNews.length, 2); assert.equal(gridNews[0].durationMin, 20); assert.equal(gridNews[0].share, 1);
  assert.equal(gridNews[1].startSec, 20400);
  assert.equal(rows.length, 4);
});

test('program filters respect audience, workdays, date, case-insensitive search and daypart overlap', () => {
  const rows = buildProgramCatalog({ program_logs: [{ id: 'a', dateISO, channel, title: 'Fresh NEWS', startSec: 68000, endSec: 69000, share: 2 }, { id: 'b', dateISO: '2026-10-05', channel: 'NAVO', title: 'Other', startSec: 20000, endSec: 21000 }] });
  assert.equal(filterPrograms(rows, { query: 'fresh', channel, daypart: 'primeTime' }).length, 1);
  assert.equal(filterPrograms(rows, { query: 'news', audience: '25-34' }).length, 0);
  assert.equal(filterPrograms(rows, { from: '2026-10-06', dateISO }).length, 1);
  assert.equal(filterPrograms(rows, { excludeNonWorkdays: true, workdays: new Map([[dateISO, false], ['2026-10-05', true]]) }).length, 1);
});

test('program summaries use duration weights and keep identical titles on different channels separate', () => {
  const rows = [{ id: 'a', dateISO, channel, title: 'News', share: 0, rtg: .1, durationMin: 10, startSec: 18000 }, { id: 'b', dateISO: '2026-10-05', channel, title: 'News', share: 4, rtg: .2, durationMin: 30, startSec: 18000, approximate: true }, { id: 'c', dateISO, channel: 'NAVO', title: 'News', share: 10, durationMin: 10, startSec: 18000 }];
  const summary = summarizePrograms(rows);
  assert.equal(summary.length, 2); assert.equal(summary[0].share, 3); assert.equal(summary[0].count, 2); assert.equal(summary[0].dayCount, 2);
  assert.equal(summary[0].id, 'a'); assert.equal(summary[0].approximateCount, 1);
});

test('program drill-down finds correct broadcast slot and does not connect across gaps or dates', () => {
  const rows = [{ id: 'a', dateISO, channel, startSec: 18000, endSec: 18600 }, { id: 'b', dateISO, channel, startSec: 18620, endSec: 19200 }, { id: 'c', dateISO, channel, startSec: 21000, endSec: 22000 }, { id: 'd', dateISO: '2026-10-05', channel, startSec: 19000, endSec: 19500 }];
  assert.equal(programNeighbors(rows, rows[1]).previous.id, 'a'); assert.equal(programNeighbors(rows, rows[1]).next, null);
  assert.equal(programAtSlot(rows, dateISO, channel, 18600).id, 'b');
  assert.equal(programAtSlot(rows, dateISO, 'NAVO', 18600), null);
});

test('CSV export preserves Russian, escapes quotes and prevents title formulas', () => {
  const csv = csvContent([['Дата', 'Программа'], [dateISO, 'News "live"'], [dateISO, '=SUM(A1)']]);
  assert.ok(csv.startsWith('\ufeff')); assert.ok(csv.includes('"News ""live"""')); assert.ok(csv.includes("'=SUM(A1)"));
});
