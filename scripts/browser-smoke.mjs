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
  const openTab = async name => { await page.locator(`[data-module="${name}"]`).click(); await page.locator(`[data-panel="${name}"]`).waitFor({ state: 'visible' }); };
  const download = async selector => { const pending = page.waitForEvent('download'); await page.locator(selector).click(); const file = await pending; return { text: await fs.readFile(await file.path(), 'utf8'), name: file.suggestedFilename() }; };
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('#empty-state').waitFor({ state: 'visible' });
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
  for (const text of ['Удержание входа', 'Удержание выхода', 'Перед программой', 'После программы', 'В это время у конкурентов', 'момент на графике']) assert.ok(detail.includes(text), text);
  assert.ok(await page.locator('#detail-content tbody tr').count() >= 6);
  await page.screenshot({ path: 'test-results/simple-detail.png', fullPage: true }); await page.locator('[data-close="detail-dialog"]').click();
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
  await page.locator('#programme').fill('Fresh news (уз)'); await page.locator('#programme').press('Enter'); await waitMapped(5);
  await openTab('programmes'); await page.waitForFunction(() => document.querySelectorAll('#programmes-table tr[data-program]').length >= 5);
  assert.equal(await page.locator('#view-filters').isVisible(), true); assert.equal(await page.locator('.scan-scroll:visible').count(), 0);
  const programmes = await download('#export-programmes'); assert.ok(programmes.name.endsWith('.csv'));
  for (const date of expectedDates) assert.ok(programmes.text.includes(date)); assert.ok(programmes.text.includes('Fresh news (уз)'));
  await page.screenshot({ path: 'test-results/simple-programmes.png', fullPage: true });
  await openTab('periods'); assert.equal(await page.locator('#view-filters').isVisible(), false);
  for (const mode of ['week', 'season', 'year', 'dayOfWeek']) {
    await page.locator(`[data-period-mode="${mode}"]`).click();
    assert.equal(await page.locator(`[data-period-mode="${mode}"]`).getAttribute('aria-pressed'), 'true');
    assert.ok((await page.locator('[data-period-scope]').innerText()).includes('FTV')); assert.equal(await page.locator('[data-period-chart] canvas').count(), 1);
  }
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
  const before = await counts(); assert.equal(before.media_scans, 5);
  const backup = await download('#backup'), payload = JSON.parse(backup.text);
  assert.deepEqual(Object.keys(payload.data).sort(), ['daily_metrics', 'grid_10min', 'program_logs']);
  assert.deepEqual(payload.simpleView.filters.weekdays, [1, 2, 3, 4, 5]); assert.equal(payload.simpleView.filters.title, 'Fresh news (уз)');
  assert.equal(payload.data.daily_metrics.length, before.daily_metrics);
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
  const saved = await readView(); await page.waitForFunction(() => JSON.parse(localStorage.getItem('FTV_Simple_View_v1')).scale === 'large');
  await page.reload({ waitUntil: 'networkidle' }); await waitMapped(5);
  assert.deepEqual((await readView()).filters, saved.filters); assert.equal((await readView()).scale, 'large'); assert.equal((await readView()).tab, 'trend');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)); assert.deepEqual(errors, []);
  console.log('Simple UI browser checks passed: five real Worker imports, five weekday crops with pixel equality, programme highlights/cursor, detail and competitors, unchanged original image, NAVO clock, missing dates, programme CSV, four comparison modes, weekday profiles, audience restrictions, validated backup/restore, mobile scrolling and persistence.');
} catch (error) {
  if (page) { await page.screenshot({ path: 'test-results/simple-failure.png', fullPage: true }).catch(() => {}); console.error(await page.locator('#status').innerText().catch(() => 'No page')); console.error(errors); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }



