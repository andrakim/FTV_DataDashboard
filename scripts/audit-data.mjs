// Independent cell-to-record controls against local source workbooks; publishes no source data.
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { parseWorkbook } from '../src/parser/excelParser.js';
import { mergeRecord, FTV_CHANNEL } from '../src/core/normalization.js';
import { analyzeRecurrence } from '../src/analytics/recurrence.js';

const root = fileURLToPath(new URL('..', import.meta.url)), folder = path.resolve(process.argv[2] ?? path.join(root, 'samples'));
const names = existsSync(folder) ? readdirSync(folder).filter(name => /\.xlsx$/i.test(name)).sort() : [];
if (!names.length) throw new Error('Для аудита нужны исходные .xlsx в samples/ или путь: node scripts/audit-data.mjs <папка>');
const numeric = value => value == null || value === '' ? null : Number(String(value).replace(',', '.'));
const iso = value => {
  const match = String(value).match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  if (typeof value === 'number') return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10);
  throw new Error(`Unsupported audit date: ${value}`);
};
const seconds = value => {
  let result = typeof value === 'number' ? Math.round(value * 86400) : String(value).split(':').reduce((sum, item) => sum * 60 + Number(item), 0);
  if (result < 18000) result += 86400; return result;
};
let controls = 0;
function equal(actual, expected, context) {
  controls++;
  if (typeof expected === 'number') assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-8, `${context}: ${actual} != ${expected}`);
  else assert.equal(actual, expected, context);
}
const reports = [];
for (const name of names) {
  const workbook = XLSX.read(readFileSync(path.join(folder, name)), { type: 'buffer', cellDates: false });
  const report = parseWorkbook(workbook, { preserveAdditionalSheets: false });
  assert.deepEqual(report.warnings, [], name);
  equal(report.reportDateISO, iso(workbook.Sheets['СОДЕРЖАНИЕ'].F1.v), `${name}: report date`);
  const history = workbook.Sheets['FTV_60 дней'], daily = new Map(report.daily_metrics.map(row => [row.dateISO, row]));
  for (let row = 5; row <= 64; row++) {
    const date = iso(history[`B${row}`].v), record = daily.get(date);
    const expectedDay = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    equal(record.dayOfWeek, expectedDay, `${name}:${date}: weekday`);
    for (const [key, cols] of [['ftv_18_54', 'CDEF'], ['ftv_25_34', 'GHIJ']]) {
      for (const [index, metric] of ['share', 'rtg', 'reach', 'atsMin'].entries()) equal(record[key][metric], numeric(history[`${cols[index]}${row}`]?.v), `${name}: ${cols[index]}${row}`);
    }
  }
  const sheet = workbook.Sheets.TOP_FTV, endRow = XLSX.utils.decode_range(sheet['!ref']).e.r + 1;
  for (let row = 4; row <= endRow; row++) {
    if (!sheet[`A${row}`]) continue;
    const date = iso(sheet[`A${row}`].v), start = seconds(sheet[`B${row}`].v);
    const log = report.program_logs.find(item => item.channel === FTV_CHANNEL && item.dateISO === date && item.startSec === start);
    assert.ok(log, `${name}: missing TOP_FTV row ${row}`);
    equal(log.endSec, seconds(sheet[`C${row}`].v), `${name}: end`);
    equal(log.title, sheet[`E${row}`].v.trim(), `${name}: title`);
    equal(log.rtg, numeric(sheet[`F${row}`].v), `${name}: rating`);
    equal(log.share, numeric(sheet[`G${row}`].v), `${name}: share`);
  }
  const demographics = workbook.Sheets['Аудитория'];
  for (let row = 4; row <= XLSX.utils.decode_range(demographics['!ref']).e.r + 1; row++) {
    if (!demographics[`C${row}`]) continue;
    const date = iso(demographics[`C${row}`].v), start = seconds(demographics[`D${row}`].v);
    const log = report.program_logs.find(item => item.channel === FTV_CHANNEL && item.dateISO === date && item.startSec === start);
    equal(log.demographics.total, numeric(demographics[`E${row}`]?.v), `${name}: demographic total`);
    equal(log.demographics.male, numeric(demographics[`F${row}`]?.v), `${name}: male`);
    equal(log.demographics.female, numeric(demographics[`K${row}`]?.v), `${name}: female`);
    for (const [gender, cols] of [['M', 'GHIJ'], ['W', 'LMNO']]) for (const [i, age] of ['18-24', '25-34', '35-44', '45-54'].entries()) equal(log.demographics.segments[`${gender} ${age}`], numeric(demographics[`${cols[i]}${row}`]?.v), `${name}: ${gender} ${age}`);
  }
  for (const [sheetName, weekly] of [['Сетка_FTV_неделя', true], ['Сетка_FTV_каналы', false]]) {
    const gridSheet = workbook.Sheets[sheetName];
    for (let c = 2; c <= (weekly ? 9 : 8); c++) for (let r = 5; r <= 148; r++) {
      // Read the original merge anchor directly, without invoking the parser's unmerger.
      const range = (gridSheet['!merges'] ?? []).find(m => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c);
      const anchor = range?.s ?? { r, c }, text = gridSheet[XLSX.utils.encode_cell(anchor)]?.v;
      if (!text) continue;
      const dateISO = iso(weekly ? gridSheet[XLSX.utils.encode_cell({ r: 2, c })].v : gridSheet.C2.v);
      // Daily grid wins over its weekly copy; control each source only where it is authoritative.
      if (weekly && dateISO === report.reportDateISO) continue;
      const originalChannel = weekly ? FTV_CHANNEL : gridSheet[XLSX.utils.encode_cell({ r: 2, c })].v;
      const normalizedChannel = originalChannel.replace(/[`’‘ʼʻ]/g, "'").trim().replace(/\s+/g, ' ');
      const metric = report.grid_10min.find(item => item.dateISO === dateISO && item.slotIndex === r - 5)?.channels[normalizedChannel];
      assert.ok(metric, `${name}: missing grid ${dateISO} ${r} ${normalizedChannel}`);
      equal(metric.share, numeric(String(text).match(/Share=([\d.,]+)/)?.[1]), `${name}: grid share`);
      equal(metric.rtg, numeric(String(text).match(/Rtg%=([\d.,]+)/)?.[1]), `${name}: grid rating`);
    }
  }
  reports.push(report);
  console.log(`Audited ${name}: ${report.reportDateISO}`);
}
function mergeReports(items) {
  const maps = Object.fromEntries(['daily_metrics', 'grid_10min', 'program_logs'].map(key => [key, new Map()]));
  for (const report of items) for (const [key, map] of Object.entries(maps)) for (const row of report[key]) map.set(row.id ?? row.dateISO, mergeRecord(map.get(row.id ?? row.dateISO), row));
  return Object.fromEntries(Object.entries(maps).map(([key, map]) => [key, [...map.values()].sort((a, b) => (a.id ?? a.dateISO).localeCompare(b.id ?? b.dateISO))]));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(key => key !== '_fieldSources').sort().map(key => [key, canonical(value[key])]));
  return value;
}
const merged = mergeReports(reports), reverse = mergeReports([...reports].reverse());
const digest = data => createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex');
equal(digest(merged), digest(reverse), 'Forward/reverse import order');
const recurrence = analyzeRecurrence(merged, { title: 'Fresh news (уз)', dayOfWeek: 4, startSec: 18 * 3600, endSec: 20 * 3600 });
const summary = { files: names.length, cellControls: controls, records: Object.fromEntries(Object.entries(merged).map(([key, rows]) => [key, rows.length])), reverseImportEqual: true,
  thursdayExample: { expectedDays: recurrence.expectedDays, observedDays: recurrence.observedDays, exact: recurrence.groups[0] } };
mkdirSync(path.join(root, 'test-results'), { recursive: true });
writeFileSync(path.join(root, 'test-results', 'data-audit.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
