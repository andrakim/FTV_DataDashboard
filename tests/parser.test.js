import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import JSZip from 'jszip';
import { parseWorkbook, parseExcelFile, parseProgramCell, unmergeWorksheet } from '../src/parser/excelParser.js';
import { detectSlotDrops } from '../src/analytics/dropDetector.js';
import { AnalyticsDB } from '../src/core/db.js';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const c = v => ({ v, t: typeof v === 'number' ? 'n' : 's' });
const sampleFiles = existsSync('samples') ? readdirSync('samples').filter(name => name.endsWith('.xlsx')) : [];
const hasOctoberSample = sampleFiles.some(name => name.includes('06.10.26'));
const hasFullSampleSet = sampleFiles.length === 23 && hasOctoberSample && sampleFiles.some(name => name.includes('11.11.26'));
function fixture() {
  const Sheets = {
    'СОДЕРЖАНИЕ': { F1: c('06.10.2026') },
    'Сетка_FTV_каналы': { C2: c('Вт 06.10.2026'), C3: c('FTV (UZ/RU)'), D3: c('NAVO'), C4: c('1,81'), C6: c('Title / with slash / N/A / Share=0,00 / Rtg%=0,12'), D6: c('News / Share=2,0 / Rtg%=0,2'), '!merges': [{ s: { r: 5, c: 2 }, e: { r: 7, c: 2 } }], '!ref': 'B2:I149' },
    'FTV_60 дней': { B5: c('06.10.2026'), C5: c('1,81'), D5: c('0,12'), E5: c(18.5), F5: c(9), G5: c('2,88'), H5: c(0.17), I5: c(17.7), J5: c(14), AF5: c('05.10.2026'), AG5: c('рабочий'), AF6: c('06.10.2026'), AG6: c('нерабочий'), '!ref': 'A1:AJ6' },
  };
  return { Sheets, SheetNames: Object.keys(Sheets), Workbook: { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] } };
}

test('unmerge propagates top-left cell across all rows without mutating source', () => {
  const sheet = fixture().Sheets['Сетка_FTV_каналы'];
  const copy = unmergeWorksheet(sheet);
  assert.equal(copy.C8.v, sheet.C6.v); assert.equal(sheet.C8, undefined);
  copy.C6.v = 'changed'; assert.notEqual(copy.C6.v, sheet.C6.v);
  const parsed = parseProgramCell(sheet.C6.v); assert.equal(parsed.title, 'Title / with slash'); assert.equal(parsed.share, 0);
  assert.equal(parseProgramCell('invalid'), null);
});

test('hidden history, comma decimals, merged slots, and independent AF calendar are parsed', () => {
  const parsed = parseWorkbook(fixture());
  assert.equal(parsed.reportDateISO, '2026-10-06');
  assert.equal(parsed.daily_metrics[0].ftv_25_34.share, 2.88);
  assert.equal(parsed.daily_metrics[0].isWorkday, false);
  assert.equal(parsed.grid_10min.length, 144);
  assert.equal(parsed.grid_10min[2].channels['FTV (UZ/RU)'].share, 0);
  assert.equal(parsed.metadata.sheetInventory.at(-1).hidden, 1);
});

test('report date falls back to C2, warns on conflicts and never falls back to filenames', () => {
  const book = fixture(); delete book.Sheets['СОДЕРЖАНИЕ'].F1;
  assert.equal(parseWorkbook(book).reportDateISO, '2026-10-06');
  book.Sheets['СОДЕРЖАНИЕ'].F1 = c('07.10.2026');
  assert.ok(parseWorkbook(book).warnings.some(w => w.includes('Даты не совпадают')));
  delete book.Sheets['СОДЕРЖАНИЕ'].F1; delete book.Sheets['Сетка_FTV_каналы'].C2;
  assert.throws(() => parseWorkbook(book), /дата не найдена/);
});

test('real 06 October report: 60 dates, eight grids, exact night logs, scan and known Fresh news loss', { skip: !hasOctoberSample }, async () => {
  const path = readdirSync('samples').find(name => name.includes('06.10.26'));
  const report = await parseExcelFile(readFileSync(`samples/${path}`), { XLSX, JSZip });
  assert.deepEqual(report.warnings, []);
  assert.equal(report.daily_metrics.length, 60); assert.equal(report.grid_10min.length, 8 * 144);
  assert.equal(report.program_logs.filter(row => row.demographics).length, 17);
  assert.equal(report.metadata.sheetInventory.length, 22);
  assert.ok(report.program_logs.some(row => row.startSec === 93759));
  assert.ok(report.media_scans[0].blob.size > 500000);
  assert.equal(report.daily_metrics.at(-1).regions['18-54']['Ташкент'].share, 1.73);
  const news = detectSlotDrops(report).find(row => row.program.title === 'Fresh news (уз)' && row.program.startSec === 67611);
  assert.equal(news.leadInRetention, 60);
  assert.ok(news.triggers.includes('midBlockValley'));
  assert.ok(Math.abs(news.demographics.lostViewers000 - 0.925) < 1e-10);
  assert.deepEqual(news.demographics.leadingLosses.map(row => row.segment), ['M 35-44', 'W 25-34']);
  assert.ok(news.competitors.length > 0);
});

test('all sample files import without parse warnings; repeat import and reverse overlap preserve records', { timeout: 300000, skip: !hasFullSampleSet }, async () => {
  const db = new AnalyticsDB({ name: `samples-${crypto.randomUUID()}`, indexedDB, IDBKeyRange });
  let wronglyNamed, first;
  const files = readdirSync('samples').filter(name => name.endsWith('.xlsx')).sort();
  for (const name of files) {
    const report = await parseExcelFile(readFileSync(`samples/${name}`), { XLSX, JSZip, preserveAdditionalSheets: false });
    assert.deepEqual(report.warnings, [], name);
    assert.equal(report.daily_metrics.length, 60, name);
    assert.equal(report.grid_10min.length, 8 * 144, name);
    await db.importReport(report);
    first ??= report;
    if (name.includes('11.11.26')) wronglyNamed = report;
  }
  assert.equal(wronglyNamed.reportDateISO, '2026-10-11');
  const before = await db.loadData();
  await db.importReport(first); await db.importReport(wronglyNamed);
  const after = await db.loadData();
  assert.deepEqual(after, before);
  const day = await db.get('daily_metrics', '2026-10-06'); assert.equal(day.ftv_18_54.share, 1.81);
  const slot = await db.get('grid_10min', '2026-10-06_0'); assert.equal(Object.keys(slot.channels).length, 7);
  console.log(`Verified ${files.length} reports: ${after.daily_metrics.length} dates, ${after.grid_10min.length} slots, ${after.program_logs.length} programs.`);
  db.close();
});
