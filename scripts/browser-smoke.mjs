import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve('dist');
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const name = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!name.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const bytes = await fs.readFile(name);
    res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
const errors = [], workers = [], expectedDates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];

try {
  await fs.mkdir('test-results', { recursive: true });
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1050 } }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('worker', worker => workers.push(worker.url()));
  const readView = () => page.evaluate(async () => (await import('/src/core/state.js')).state.getState().simpleView);
  const counts = () => page.evaluate(async () => { const { db } = await import('/src/core/db.js'); return Object.fromEntries(await Promise.all(['daily_metrics', 'grid_10min', 'program_logs', 'media_scans'].map(async key => [key, (await db.getAll(key)).length]))); });
  const waitMapped = async count => { const current = await readView(); await page.waitForFunction(({count, query, scale}) => { const board = document.querySelector('.scan-board'); return board?.dataset.query === query && board?.dataset.scale === scale && document.querySelectorAll('#scan-viewer [data-mapped="true"]').length === count; }, {count, query: JSON.stringify(current.filters), scale: current.scale}); };
  const openTab = async name => { await page.locator(`.module-tabs [data-module="${name}"]`).click(); await page.locator(`[data-panel="${name}"]`).waitFor({ state: 'visible' }); };
  const download = async selector => { const pending = page.waitForEvent('download'); await page.locator(selector).click(); const file = await pending; return { text: await fs.readFile(await file.path(), 'utf8'), name: file.suggestedFilename() }; };
  const setDates = async (from, to) => { await page.locator('#date-from').fill(from); await page.locator('#date-to').fill(to); await page.locator('#apply-filters').click(); };
  const outerFits = async () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2);
  const tableIds = async () => page.locator('#programmes-table tbody tr[data-program]').evaluateAll(rows => rows.map(row => row.dataset.program));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('#empty-state').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#empty-state [data-restore]').isVisible(), true);
  const emptyChooser = page.waitForEvent('filechooser'); await page.locator('#empty-state [data-restore]').click(); assert.ok(await emptyChooser);
  await page.screenshot({ path: 'test-results/empty-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await outerFits());
  await page.screenshot({ path: 'test-results/empty-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1050 });
  await openTab('data'); assert.equal(await page.locator('#restore').isEnabled(), true); assert.equal(await page.locator('#backup').isDisabled(), true);
  await page.locator('.module-tabs [data-module="trend"]').click(); await page.locator('#empty-state').waitFor({ state: 'visible' });
  await page.evaluate(() => { window.XLSX.read = () => { throw new Error('Import must use Worker'); }; });
  const names = await fs.readdir('samples');
  const samples = ['05', '06', '07', '08', '09'].map(day => { const name = names.find(name => name.endsWith(`${day}.10.26.xlsx`)); assert.ok(name, `Missing report ${day}.10.26`); return path.resolve('samples', name); });
  await page.locator('#files').setInputFiles(samples);
  await page.waitForFunction(() => document.querySelector('#dataset-status').textContent.startsWith('5 графиков') && document.querySelector('#import-progress').hidden, null, { timeout: 180000 });
  assert.ok(workers.some(url => url.endsWith('importWorker.js'))); assert.equal(await page.locator('#import-result-list .import-row').count(), 5);
  await page.locator('#date-from').fill('2026-10-05'); await page.locator('#date-to').fill('2026-10-09');
  await page.locator('#time-start').fill('18:00'); await page.locator('#time-end').fill('19:00');
  await page.locator('#apply-filters').click(); await page.locator('#workweek').click(); await waitMapped(5);
  assert.deepEqual(await page.locator('.scan-card').evaluateAll(cards => cards.map(card => card.dataset.scanDate)), expectedDates);
  assert.deepEqual((await readView()).filters.weekdays, [1, 2, 3, 4, 5]);
  assert.ok((await page.locator('#trend-scope').innerText()).includes('5 графиков / 5 дат'));
  assert.equal((await readView()).onlyScans, false);
  assert.equal(await page.locator('#filter-toggle').isVisible(), false, 'Desktop keeps all filters directly available');
  const importedDateBounds = await page.evaluate(async () => { const { db } = await import('/src/core/db.js'); const records = await Promise.all(['daily_metrics', 'grid_10min', 'program_logs', 'media_scans'].map(store => db.getAll(store))); const dates = records.flat().map(row => row.dateISO).sort(); return { from: dates[0], to: dates.at(-1) }; });
  await page.locator('[data-date-preset="all"]').click();
  await page.waitForFunction(({from, to}) => document.querySelector('#date-from').value === from && document.querySelector('#date-to').value === to, importedDateBounds);
  assert.equal((await readView()).filters.from, importedDateBounds.from); assert.equal((await readView()).filters.to, importedDateBounds.to);
  assert.deepEqual((await readView()).filters.weekdays, [1, 2, 3, 4, 5, 6, 7]);
  await page.locator('[data-date-preset="latest"]').click();
  await page.waitForFunction(() => document.querySelector('#date-from').value === '2026-10-03');
  assert.equal((await readView()).filters.to, '2026-10-09');
  await page.locator('#reset-filters').click(); await waitMapped(5);
  assert.deepEqual((await readView()).filters.weekdays, [1, 2, 3, 4, 5]);
  assert.equal((await readView()).filters.from, '2026-10-03'); assert.equal((await readView()).onlyScans, false);
  await setDates('2026-10-05', '2026-10-09'); await waitMapped(5);
  await page.locator('#time-start').fill('18:10');
  await page.locator('#scan-scale').selectOption('large'); await waitMapped(5);
  assert.equal(await page.locator('#time-start').inputValue(), '18:10'); assert.equal((await readView()).filters.startSec, 64800);
  await openTab('programmes'); await openTab('trend'); await page.locator('#only-scans').check(); await waitMapped(5);
  assert.equal(await page.locator('#time-start').inputValue(), '18:10'); assert.equal(await page.locator('#filter-pending').isVisible(), true);
  await page.locator('#apply-filters').click(); await waitMapped(5);
  assert.equal((await readView()).filters.startSec, 65400); assert.equal(await page.locator('#filter-pending').isVisible(), false);
  const validBeforeTooLong = (await readView()).filters;
  await page.locator('#date-from').fill('2000-01-01'); await page.locator('#apply-filters').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('не больше 10 лет'));
  assert.deepEqual((await readView()).filters, validBeforeTooLong, 'An excessive date range is rejected before state changes');
  await page.locator('#reset-filters').click(); await waitMapped(5);
  assert.equal(await page.locator('#filter-pending').isVisible(), false); assert.equal(await page.locator('#time-start').inputValue(), '18:00');
  await page.locator('#scan-scale').selectOption('fit'); await setDates('2026-10-05', '2026-10-09'); await waitMapped(5);
  assert.equal(await page.locator('aside, #workspace-grid, #column-options, #profile-controls').count(), 0);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().width > 0).length), 0);

  async function originalPixels(channel) {
    return page.evaluate(async channel => {
      const { db } = await import('/src/core/db.js'), results = [];
      for (const card of document.querySelectorAll('#scan-viewer [data-mapped="true"]')) {
        const scan = await db.get('media_scans', card.dataset.scanDate), bitmap = await createImageBitmap(scan.blob);
        const source = document.createElement('canvas'); source.width = bitmap.width; source.height = bitmap.height;
        const ctx = source.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        // Independently verified source frame: 15 seconds/pixel; 05:00 at h−5835.
        const top = source.height - 5835, sourceY = top + 13 * 240;
        const sections = [[card.querySelector('.scan-body > canvas'), sourceY, 240], [card.querySelector('.scan-native-header canvas'), top - 62, 62]];
        let mismatches = 0, nonWhite = 0;
        for (const [canvas, y, height] of sections) {
          if (canvas.width !== 238 || canvas.height !== height) throw new Error(`Source canvas ${canvas.width}×${canvas.height}`);
          const actual = canvas.getContext('2d').getImageData(0, 0, 238, height).data, expected = ctx.getImageData(0, y, source.width, height).data;
          for (let row = 0; row < height; row++) for (let x = 0; x < 238; x++) for (let c = 0; c < 4; c++) {
            const sx = channel === 'NAVO' ? x < 37 ? x : 247 + x - 37 : x, value = actual[(row * 238 + x) * 4 + c];
            if (value !== expected[(row * source.width + sx) * 4 + c]) mismatches++;
            if (c < 3 && value < 240) nonWhite++;
          }
        }
        results.push({ date: card.dataset.scanDate, sourceY, mismatches, nonWhite }); source.width = 0; source.height = 0;
      }
      return results;
    }, channel);
  }
  const ftv = await originalPixels('FTV'); assert.equal(ftv.length, 5);
  assert.ok(ftv.every(row => row.mismatches === 0 && row.nonWhite > 1000), JSON.stringify(ftv));
  assert.ok(ftv.some(row => row.sourceY === 3322));
  await page.screenshot({ path: 'test-results/simple-trend.png', fullPage: true });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForFunction(() => { const board = document.querySelector('.scan-board'); return parseFloat(board.style.getPropertyValue('--scan-width')) <= 200; });
  assert.ok(await outerFits(), '1100px page must fit outside the scrollable graph');
  assert.ok(await page.locator('#scan-viewer').evaluate(el => el.scrollWidth <= el.clientWidth + 2), 'Fit should fit five dates at 1100px');
  assert.ok((await originalPixels('FTV')).every(row => row.mismatches === 0), 'Resize preserves canvas source pixels');
  await page.screenshot({ path: 'test-results/simple-fit-1100.png', fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.locator('#time-start').fill('01:00'); await page.locator('#time-end').fill('02:00'); await page.locator('#apply-filters').click(); await waitMapped(5);
  assert.equal((await readView()).filters.startSec, 90000); assert.equal((await readView()).filters.endSec, 93600);
  await page.locator('#time-start').blur(); await page.locator('#time-end').blur();
  await page.waitForFunction(() => document.querySelector('#time-start').value === '25:00' && document.querySelector('#time-end').value === '26:00');
  assert.ok((await page.locator('#trend-scope').innerText()).includes('25:00–26:00'));
  await page.locator('[data-window="64800,68400"]').click(); await waitMapped(5);
  await page.locator('#programme').fill('Fresh news (уз)'); await page.locator('#programme').press('Enter'); await page.locator('#apply-filters').click(); await waitMapped(5);
  assert.equal((await readView()).filters.title, 'Fresh news (уз)'); assert.equal(await page.locator('.scan-card').count(), 5);
  assert.ok(await page.locator('.program-highlight').count() >= 5); assert.ok(await page.locator('.scan-programmes [data-open-program]').count() >= 5);
  assert.ok((await page.locator('.scan-programmes').first().innerText()).toLowerCase().includes('fresh news'));
  const canvas = page.locator('.scan-card').first().locator('.scan-body > canvas'); await canvas.hover({ position: { x: 110, y: 80 } });
  const cursors = await page.locator('.scan-cursor').evaluateAll(lines => lines.map(line => ({ hidden: line.hidden, top: line.style.top, time: line.textContent })));
  assert.ok(cursors.every(line => !line.hidden && line.top === cursors[0].top && line.time === cursors[0].time), JSON.stringify(cursors));
  const fraction = await page.evaluate(async () => {
    const { db } = await import('/src/core/db.js'), { buildProgramCatalog } = await import('/src/analytics/programs.js');
    const row = buildProgramCatalog(await db.loadData()).find(row => row.dateISO === '2026-10-05' && row.channel === 'FTV (UZ/RU)' && row.title.toLowerCase() === 'fresh news (уз)' && row.startSec < 68400 && row.endSec > 64800);
    if (!row) throw new Error('Fresh News not found at 18–19');
    return ((Math.max(row.startSec, 64800) + Math.min(row.endSec, 68400)) / 2 - 64800) / 3600;
  });
  const box = await canvas.boundingBox(); await canvas.click({ position: { x: Math.min(120, box.width - 2), y: box.height * fraction } });
  await page.locator('#detail-dialog').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#detail-title').innerText()).toLowerCase().includes('fresh news'));
  const detail = await page.locator('#detail-content').innerText();
  for (const text of ['Удержание входа', 'Удержание выхода', 'Перед программой', 'После программы', 'В это время у конкурентов', 'момент на графике', 'покрытие']) assert.ok(detail.includes(text), text);
  assert.ok(await page.locator('#detail-content tbody tr').count() >= 6);
  await page.screenshot({ path: 'test-results/simple-detail.png', fullPage: true });
  const sameWeekdayScope = await page.evaluate(async () => {
    const { db } = await import('/src/core/db.js'), { buildProgramCatalog } = await import('/src/analytics/programs.js');
    const dates = [...new Set(buildProgramCatalog(await db.loadData()).filter(row => row.channel === 'FTV (UZ/RU)').map(row => row.dateISO))].sort();
    return { from: dates[0], to: dates.at(-1) };
  });
  await page.locator('[data-same-weekday]').click();
  await page.waitForFunction(({from, to}) => document.querySelector('#date-from').value === from && document.querySelector('#date-to').value === to, sameWeekdayScope);
  assert.equal(await page.locator('#detail-dialog').isVisible(), false); assert.equal((await readView()).tab, 'trend');
  assert.deepEqual((await readView()).filters.weekdays, [1]); assert.equal((await readView()).filters.title, 'Fresh news (уз)');
  assert.ok((await readView()).filters.from < '2026-10-05', 'All Mondays expands beyond the initially selected week');
  await setDates('2026-10-05', '2026-10-09'); await page.locator('#workweek').click(); await waitMapped(5);
  await page.locator('.scan-card').first().locator('[data-original]').click(); await page.locator('#original-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#original-image').naturalWidth === 1530);
  assert.equal(await page.evaluate(async () => {
    const { db } = await import('/src/core/db.js'), scan = await db.get('media_scans', '2026-10-05');
    const actual = new Uint8Array(await (await fetch(document.querySelector('#original-image').src)).arrayBuffer()), expected = new Uint8Array(await scan.blob.arrayBuffer());
    return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
  }), true, 'Original image is the exact embedded blob');
  await page.locator('[data-close="original-dialog"]').click();
  await page.locator('#channel').selectOption('NAVO'); await waitMapped(5);
  const navo = await originalPixels('NAVO'); assert.ok(navo.every(row => row.mismatches === 0 && row.nonWhite > 1000), JSON.stringify(navo));
  assert.equal((await readView()).filters.title, ''); await page.locator('#channel').selectOption('FTV (UZ/RU)'); await waitMapped(5);
  await page.locator('[data-shift-week="7"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.scan-card').length === 5 && document.querySelectorAll('.scan-card[data-mapped]').length === 0);
  assert.equal(await page.locator('.scan-placeholder').filter({ hasText: 'Нет исходного графика' }).count(), 5);
  assert.equal((await readView()).filters.from, '2026-10-12'); await page.locator('[data-shift-week="-7"]').click(); await waitMapped(5);
  assert.equal((await readView()).filters.from, '2026-10-05');
  await setDates('2026-10-01', '2026-10-09'); await page.locator('#all-weekdays').click();
  await page.waitForFunction(() => document.querySelectorAll('.scan-card').length === 5 && document.querySelectorAll('.scan-placeholder').length === 4);
  assert.equal(await page.locator('#scan-availability').isVisible(), true);
  assert.ok((await page.locator('#scan-availability').innerText()).includes('4 из 9'));
  await page.locator('[data-show-available]').click(); await waitMapped(5);
  assert.equal((await readView()).onlyScans, true); assert.equal(await page.locator('#only-scans').isChecked(), true);
  assert.deepEqual(await page.locator('.scan-card').evaluateAll(cards => cards.map(card => card.dataset.scanDate)), expectedDates);
  await page.locator('#only-scans').uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.scan-placeholder').length === 4);
  assert.equal((await readView()).onlyScans, false);
  await setDates('2026-10-05', '2026-10-09'); await page.locator('#workweek').click(); await waitMapped(5);
  await page.locator('#programme').fill('Fresh news (уз)'); await page.locator('#programme').press('Enter'); await waitMapped(5);
  await openTab('programmes'); await page.waitForFunction(() => document.querySelectorAll('#programmes-table tr[data-program]').length >= 5);
  assert.equal(await page.locator('#view-filters').isVisible(), true); assert.equal(await page.locator('.scan-scroll:visible').count(), 0);
  await page.locator('#program-search').fill('nEWs');
  assert.equal((await tableIds()).length, 5, 'Programme search accepts a case-insensitive substring');
  await page.locator('#program-sort').selectOption('share-desc');
  const sortedProgrammes = await page.locator('#programmes-table tbody tr[data-program]').evaluateAll(rows => rows.map(row => ({ id: row.dataset.program, share: Number(row.cells[3].textContent.replace('%', '').replace(',', '.')) })));
  assert.ok(sortedProgrammes.every((row, i) => !i || sortedProgrammes[i - 1].share >= row.share), JSON.stringify(sortedProgrammes));
  await page.locator('#program-source').selectOption('exact');
  assert.equal((await tableIds()).length, 5); assert.equal(await page.locator('#programmes-table .badge.approx').count(), 0);
  const programmes = await download('#export-programmes'); assert.ok(programmes.name.endsWith('.csv'));
  for (const date of expectedDates) assert.ok(programmes.text.includes(date)); assert.ok(programmes.text.includes('Fresh news (уз)'));
  assert.ok(programmes.text.includes('share-desc') && programmes.text.includes('nEWs') && programmes.text.includes('exact'));
  assert.equal(programmes.text.trim().split(/\r?\n/).length, 7, 'CSV contains exactly the five filtered rows plus metadata and heading');
  await page.locator('#program-source').selectOption('grid'); assert.equal((await tableIds()).length, 0); assert.equal(await page.locator('#export-programmes').isDisabled(), true);
  await page.locator('#program-source').selectOption('exact');
  await page.screenshot({ path: 'test-results/simple-programmes.png', fullPage: true });
  await openTab('periods'); assert.equal(await page.locator('#view-filters').isVisible(), false);
  for (const mode of ['week', 'season', 'year', 'dayOfWeek']) {
    await page.locator(`[data-period-mode="${mode}"]`).click();
    assert.equal(await page.locator(`[data-period-mode="${mode}"]`).getAttribute('aria-pressed'), 'true');
    assert.ok((await page.locator('[data-period-scope]').innerText()).includes('FTV')); assert.equal(await page.locator('[data-period-chart] canvas').count(), 1);
  }
  await page.locator('[data-period-mode="week"]').click();
  const weeklyDays = await page.locator('[data-period-table] tbody tr').evaluateAll(rows => [...new Set(rows.map(row => row.cells[2].textContent))]);
  assert.ok(weeklyDays.length >= 5 && weeklyDays.includes('Пн') && weeklyDays.includes('Чт'), JSON.stringify(weeklyDays));
  const deltaValue = async () => Number((await page.locator('[data-period-delta] p').first().innerText()).replace('−', '-').replace(',', '.').match(/[+-]?\d+(?:\.\d+)?/)?.[0]);
  const delta = await deltaValue(), a = await page.locator('[data-period-field="a"]').inputValue(), b = await page.locator('[data-period-field="b"]').inputValue();
  assert.ok(Number.isFinite(delta) && delta !== 0, 'Real weekly periods should have a nonzero measured difference');
  await page.locator('[data-period-swap]').click();
  assert.equal(await page.locator('[data-period-field="a"]').inputValue(), b); assert.equal(await page.locator('[data-period-field="b"]').inputValue(), a);
  assert.equal(await deltaValue(), -delta, 'Swapping A/B reverses the displayed absolute difference');
  await page.locator('[data-period-mode="dayOfWeek"]').click();
  await page.locator('[data-period-weekday="4"]').click(); await page.locator('[data-period-view="slots"]').click();
  const profile = await page.evaluate(() => { const option = echarts.getInstanceByDom(document.querySelector('[data-period-chart]')).getOption(); return { names: option.series.map(series => series.name), axis: option.xAxis[0].data }; });
  assert.ok(profile.names.includes('Среднее по доступной сетке') && profile.names.includes('Медиана'));
  assert.ok(profile.names.length >= 3 && profile.names.length <= 7, JSON.stringify(profile.names));
  assert.equal(profile.axis[0], '05:00'); assert.equal(profile.axis.at(-1), '28:50'); assert.ok(profile.names.slice(2).every(name => name.includes('2026')));
  assert.ok((await page.locator('[data-period-note]').innerText()).includes('не поминутный замер'));
  await page.locator('[data-period-details] summary').click(); assert.ok(await page.locator('[data-period-table] tbody tr').count() >= 1);
  assert.ok((await download('#export-periods')).text.includes('Измерений в слоте'));
  await page.screenshot({ path: 'test-results/simple-periods.png', fullPage: true });
  await page.locator('[data-period-field="audience"]').selectOption('25-34'); assert.equal(await page.locator('[data-period-view="slots"]').isDisabled(), true);
  assert.equal(await page.locator('[data-period-view="daily"]').getAttribute('aria-pressed'), 'true'); assert.ok((await page.locator('[data-period-scope]').innerText()).includes('25-34'));
  await openTab('data'); assert.equal(await page.locator('#data-table [data-original]').count(), 5);
  assert.ok((await page.locator('#data-table').innerText()).includes('18–54 · 25–34')); assert.ok(await page.locator('#data-table [data-view-date]').count() >= 5);
  const before = await counts(); assert.equal(before.media_scans, 5);
  const backup = await download('#backup'), payload = JSON.parse(backup.text);
  assert.deepEqual(Object.keys(payload.data).sort(), ['daily_metrics', 'grid_10min', 'program_logs']);
  assert.deepEqual(payload.simpleView.filters.weekdays, [1, 2, 3, 4, 5]); assert.equal(payload.simpleView.filters.title, 'Fresh news (уз)');
  assert.equal(payload.simpleView.onlyScans, false);
  assert.equal(payload.data.daily_metrics.length, before.daily_metrics);
  const restoredContext = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
  try {
    const restoredPage = await restoredContext.newPage(); restoredPage.on('pageerror', error => errors.push(error.message));
    await restoredPage.goto(page.url().split('#')[0], { waitUntil: 'networkidle' });
    await restoredPage.locator('#empty-state').waitFor({ state: 'visible' });
    const choosingBackup = restoredPage.waitForEvent('filechooser'); await restoredPage.locator('#empty-state [data-restore]').click();
    await (await choosingBackup).setFiles({ name: 'FTV_backup.json', mimeType: 'application/json', buffer: Buffer.from(backup.text) });
    await restoredPage.waitForFunction(() => document.querySelector('#status').textContent.includes('Копия восстановлена'), null, { timeout: 60000 });
    const restoredCounts = await restoredPage.evaluate(async () => { const { db } = await import('/src/core/db.js'); return { daily: (await db.getAll('daily_metrics')).length, scans: (await db.getAll('media_scans')).length }; });
    assert.equal(restoredCounts.daily, before.daily_metrics); assert.equal(restoredCounts.scans, 0, 'A numeric backup cannot invent original images');
  } finally { await restoredContext.close(); }

  // Isolated fixtures cover null and zero values, which the real source reports do not guarantee.
  const fixtureContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  try {
    const fixturePage = await fixtureContext.newPage(); fixturePage.on('pageerror', error => errors.push(error.message));
    await fixturePage.goto(page.url().split('#')[0], { waitUntil: 'networkidle' });
    await fixturePage.evaluate(async () => {
      const { db } = await import('/src/core/db.js'), { state } = await import('/src/core/state.js');
      const exact = [['null', null], ['zero', 0], ['ten', 10]].map(([name, share], i) => ({ id: `qa_${name}`, dateISO: '2026-10-05', channel: 'FTV (UZ/RU)', title: `QA test ${name}`, startSec: 64800 + i * 600, endSec: 65400 + i * 600, share, rtg: 0, audience: '18-54' }));
      await db.importReport({ reportDateISO: '2026-10-05', program_logs: exact, grid_10min: [{ id: 'qa_grid', dateISO: '2026-10-05', startSec: 66600, endSec: 67200, slotIndex: 81, channels: { 'FTV (UZ/RU)': { title: 'QA test grid', share: 2, rtg: 0, audience: '18-54' } } }] });
      state.setState({ simpleView: { tab: 'programmes', page: 1, scale: 'fit', onlyScans: false, filters: { from: '2026-10-05', to: '2026-10-05', weekdays: [1], startSec: 64800, endSec: 68400, channel: 'FTV (UZ/RU)', title: '' } } });
    });
    await fixturePage.reload({ waitUntil: 'networkidle' });
    await fixturePage.locator('[data-panel="programmes"]').waitFor({ state: 'visible' });
    await fixturePage.locator('#program-search').fill('tEsT');
    const fixtureTitles = () => fixturePage.locator('#programmes-table tbody tr[data-program]').evaluateAll(rows => rows.map(row => row.cells[2].textContent));
    await fixturePage.locator('#program-sort').selectOption('share-asc');
    assert.deepEqual(await fixtureTitles(), ['QA test zero', 'QA test grid', 'QA test ten', 'QA test null']);
    assert.equal(await fixturePage.locator('#programmes-table tbody tr').first().locator('td').nth(3).innerText(), '0,00%');
    await fixturePage.locator('#program-sort').selectOption('share-desc');
    assert.deepEqual(await fixtureTitles(), ['QA test ten', 'QA test grid', 'QA test zero', 'QA test null']);
    await fixturePage.locator('#program-source').selectOption('grid'); assert.deepEqual(await fixtureTitles(), ['QA test grid']);
    const fixtureDownload = fixturePage.waitForEvent('download'); await fixturePage.locator('#export-programmes').click();
    const gridCSV = await fs.readFile(await (await fixtureDownload).path(), 'utf8');
    assert.ok(gridCSV.includes('QA test grid') && !gridCSV.includes('QA test zero') && !gridCSV.includes('QA test null'));
    assert.equal(gridCSV.trim().split(/\r?\n/).length, 3);
    await fixturePage.locator('#program-source').selectOption('exact'); assert.deepEqual(await fixtureTitles(), ['QA test ten', 'QA test zero', 'QA test null']);
    assert.ok(await fixturePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  } finally { await fixtureContext.close(); }
  await page.locator('#backup-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('не резервная копия'));
  const invalid = structuredClone(payload); invalid.simpleView.filters.endSec = invalid.simpleView.filters.startSec;
  invalid.data.daily_metrics.push({ ...invalid.data.daily_metrics[0], dateISO: '2030-01-01' });
  await page.locator('#backup-file').setInputFiles({ name: 'invalid-view.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Конец должен быть позже начала'));
  assert.deepEqual(await counts(), before, 'Invalid settings must fail before any database write');
  await page.locator('#backup-file').setInputFiles({ name: 'restore.json', mimeType: 'application/json', buffer: Buffer.from(backup.text) });
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Копия восстановлена'), null, { timeout: 60000 });
  assert.deepEqual(await counts(), before, 'Restore deduplicates records and preserves existing scans');
  await openTab('trend'); await waitMapped(5); await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#scan-scale').selectOption('large'); await waitMapped(5);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  assert.ok(await page.locator('#scan-viewer').evaluate(el => el.scrollWidth > el.clientWidth));
  await page.screenshot({ path: 'test-results/simple-mobile.png', fullPage: true });
  assert.equal(await page.locator('#filter-toggle').isVisible(), true); assert.equal(await page.locator('#filter-toggle').getAttribute('aria-expanded'), 'true');
  await page.locator('#filter-toggle').click(); assert.equal(await page.locator('#time-start').isVisible(), false); assert.equal(await page.locator('#filter-toggle').getAttribute('aria-expanded'), 'false');
  assert.ok(await outerFits()); await page.screenshot({ path: 'test-results/simple-mobile-collapsed.png', fullPage: true });
  await page.locator('#filter-toggle').click(); assert.equal(await page.locator('#time-start').isVisible(), true); assert.equal(await page.locator('#filter-toggle').getAttribute('aria-expanded'), 'true');
  const saved = await readView(); await page.waitForFunction(() => JSON.parse(localStorage.getItem('FTV_Simple_View_v1')).scale === 'large');
  await page.reload({ waitUntil: 'networkidle' }); await waitMapped(5);
  assert.deepEqual((await readView()).filters, saved.filters); assert.equal((await readView()).scale, 'large'); assert.equal((await readView()).tab, 'trend');
  assert.ok(await outerFits()); assert.deepEqual(errors, []);
  for (const tab of ['programmes', 'periods', 'data']) { await openTab(tab); assert.ok(await outerFits(), `${tab} must fit the mobile page outside its own scroll containers`); }
  console.log('Simple UI browser checks passed: real Worker imports; original FTV/NAVO pixels; 1100px fit resize; empty-state restoration; date presets/reset; overnight normalization; same-weekday scope; missing dates/only-scans; substring programme search, measured share sorting including null/zero, source filtering and selected-row CSV; weekly weekday coverage and reversible A/B delta; comparison modes/profile; backup validation; mobile tabs, overflow and persistence.');
} catch (error) {
  if (page) { await page.screenshot({ path: 'test-results/simple-failure.png', fullPage: true }).catch(() => {}); console.error(await page.locator('#status').innerText().catch(() => 'No page')); console.error(errors); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }



