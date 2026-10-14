import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dailyRecord, FTV_CHANNEL } from '../src/core/normalization.js';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project = process.cwd(), root = path.join(project, 'dist');
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve(root, `.${new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const bytes = await fs.readFile(file);
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  await fs.mkdir('test-results', { recursive: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [], workerURLs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => workerURLs.push(worker.url()));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('#empty-state').waitFor({ state: 'visible' });
  await page.evaluate(() => { window.XLSX.read = () => { throw new Error('Parsing must run in the worker'); }; });
  const sample = (await fs.readdir('samples')).find(name => name.includes('06.10.26'));
  await page.locator('#files').setInputFiles(path.join(project, 'samples', sample));
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('60 дней'), { timeout: 45000 });
  await page.waitForFunction(() => document.querySelector('#import-progress').hidden);
  assert.ok(workerURLs.some(url => url.endsWith('importWorker.js')));
  assert.equal(await page.locator('#empty-state').isVisible(), false);
  assert.equal(await page.locator('#overview-kpis button').count(), 4);
  assert.ok(await page.locator('#page-title').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 26));
  await page.screenshot({ path: 'test-results/overview-desktop.png', fullPage: true });
  await page.locator('#navigation [data-view="comparison"]').click();
  for (const mode of ['week', 'season', 'year', 'dayOfWeek']) {
    await page.locator(`#mode-buttons [data-mode="${mode}"]`).click();
    await page.waitForFunction(mode => document.querySelector(`#mode-buttons [data-mode="${mode}"]`).getAttribute('aria-selected') === 'true', mode);
    await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('дней'));
    assert.equal(await page.locator('#comparison-kpis button').count(), 4);
  }
  await page.waitForFunction(() => document.querySelectorAll('#weekday-buttons button').length === 7);
  await page.locator('[data-weekday="1"]').click();
  await page.waitForFunction(() => document.querySelector('#weekday-title').textContent.includes('понедельники'));
  assert.ok(await page.locator('#curve-dates button').count() > 0);
  const available = page.locator('#curve-dates button:not(:disabled)').first();
  if (await available.count()) { await available.click(); await available.click(); }
  await page.screenshot({ path: 'test-results/weekdays-desktop.png', fullPage: true });
  await page.locator('#navigation [data-view="programs"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#program-table tbody tr[data-program]').length === 17);
  await page.locator('#program-search').fill('fresh');
  await page.waitForFunction(() => [...document.querySelectorAll('#program-table .program-title')].every(el => el.textContent.toLowerCase().includes('fresh')) && document.querySelectorAll('#program-table .program-title').length > 0);
  await page.locator('#program-table tr[data-program]').first().click();
  await page.locator('#program-detail').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#program-detail-content').innerText()).includes('Кто смотрел программу'));
  assert.ok((await page.locator('#program-detail-content').innerText()).includes('Связка эфира'));
  await page.screenshot({ path: 'test-results/program-detail.png', fullPage: true });
  await page.locator('#close-program').click();
  await page.locator('#program-detail').waitFor({ state: 'hidden' });
  await page.locator('#program-search').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#program-table tbody tr[data-program]').length === 17);
  await page.locator('#broadcast-date').selectOption('2026-10-05');
  await page.waitForFunction(() => document.querySelector('#program-note').textContent.includes('10 минут'));
  assert.ok(await page.locator('#program-table .badge.approx').count() > 0);
  await page.locator('[data-program-layout="catalog"]').click();
  await page.waitForFunction(() => document.querySelector('#program-count').textContent.includes('программ'));
  await page.locator('#program-sort').selectOption('share');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloadPromise; assert.ok(download.suggestedFilename().endsWith('.csv'));
  await page.screenshot({ path: 'test-results/program-catalog-desktop.png', fullPage: true });
  await page.locator('[data-audience="25-34"]').click();
  await page.waitForFunction(() => document.querySelector('#program-note').textContent.includes('Для 25–34'));
  assert.equal(await page.locator('#program-table tr[data-program]').count(), 0);
  await page.locator('[data-audience="18-54"]').click();
  await page.locator('#navigation [data-view="drops"]').click();
  await page.locator('#broadcast-date').selectOption('2026-10-06');
  await page.waitForFunction(() => document.querySelectorAll('#pain-points article').length > 0);
  await page.locator('#pain-points [data-program]').first().click();
  await page.locator('#program-detail').waitFor({ state: 'visible' });
  await page.locator('#program-detail [data-investigate]').click();
  await page.locator('#recurrence-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#program-detail').isVisible(), false);
  assert.ok((await page.locator('#recurrence-groups').innerText()).includes('Недостаточно наблюдений'));
  await page.locator('#navigation [data-view="grid"]').click();
  await page.locator('#show-scan').click();
  await page.locator('#scan-image').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#scan-image').naturalWidth > 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#navigation [data-view="comparison"]').click();
  await page.locator('#mode-buttons [data-mode="dayOfWeek"]').click();
  await page.locator('[data-weekday="1"]').click();
  await page.screenshot({ path: 'test-results/weekdays-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('60 дней'));
  await page.waitForFunction(() => document.querySelector('#mode-buttons [data-mode="dayOfWeek"]').getAttribute('aria-selected') === 'true');
  assert.ok((await page.locator('#weekday-title').innerText()).includes('понедельники'));

  // Deterministic six-Thursday cohort in this isolated browser profile: one rare low episode.
  const dates = ['2026-09-03', '2026-09-10', '2026-09-17', '2026-09-24', '2026-10-01', '2026-10-08'];
  const fixture = { reportDateISO: dates.at(-1), daily_metrics: dates.map(dateISO => ({ ...dailyRecord(dateISO), isWorkday: true, ftv_18_54: { share: 2 } })),
    program_logs: dates.flatMap((dateISO, i) => [
      { id: `${dateISO}_lead`, dateISO, channel: FTV_CHANNEL, title: 'Lead', startSec: 64200, endSec: 64800, share: 2 },
      { id: `${dateISO}_news`, dateISO, channel: FTV_CHANNEL, title: 'News', startSec: 64800, endSec: 65400, share: i === 5 ? 0.5 : 2 },
      { id: `${dateISO}_after`, dateISO, channel: FTV_CHANNEL, title: 'Return', startSec: 65400, endSec: 66000, share: 2 },
    ]) };
  await page.evaluate(async report => { const { db } = await import('/src/core/db.js'); await db.clear(); await db.importReport(report); }, fixture);
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(`http://127.0.0.1:${server.address().port}/#recurrence`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#recurrence-view').waitFor({ state: 'visible' });
  await page.locator('#recurrence-title').fill('News');
  await page.locator('#recurrence-start').fill('18:00'); await page.locator('#recurrence-end').fill('18:10');
  await page.locator('#recurrence-apply').click(); await page.locator('[data-pattern-weekday="4"]').click();
  await page.waitForFunction(() => document.querySelector('#recurrence-groups').textContent.includes('Возможная разовая аномалия'));
  assert.equal(await page.locator('#recurrence-table tbody tr').count(), 6);
  await page.screenshot({ path: 'test-results/recurrence-desktop.png', fullPage: true });
  await page.locator('#recurrence-table details').first().locator('summary').click();
  await page.locator('#recurrence-table [data-program]').first().click(); await page.locator('#program-detail').waitFor({ state: 'visible' });
  await page.locator('#close-program').click();
  await page.locator('[data-recurrence-mode="slot"]').click();
  await page.waitForFunction(() => document.querySelector('#recurrence-title-label').hidden);
  await page.locator('#recurrence-signal').selectOption('baseline');
  await page.waitForFunction(() => document.querySelector('#recurrence-retention').disabled);
  assert.ok((await page.locator('#recurrence-groups').innerText()).includes('Возможная разовая аномалия'));
  await page.locator('#recurrence-approximate').check();
  await page.waitForFunction(() => document.querySelectorAll('.pattern-card').length === 2);
  const recurrenceDownload = page.waitForEvent('download'); await page.locator('#export').click();
  assert.ok((await recurrenceDownload).suggestedFilename().includes('recurrence'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/recurrence-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#recurrence-start').inputValue(), '18:00');
  assert.equal(await page.locator('#recurrence-signal').inputValue(), 'baseline');
  assert.deepEqual(errors, []);
  console.log('UI smoke passed: worker import, existing views, program drill-down, recurrence sources, six-Thursday anomaly, fixed window, thresholds, CSV, mobile and persistence.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: 'test-results/browser-failure.png', fullPage: true }).catch(() => {});
    console.error(await page.evaluate(async () => { const { state } = await import('/src/core/state.js'); const s = state.getState(); return { view: s.view, error: s.error, programQuery: s.programQuery, selectedDate: s.selectedDate, programRows: document.querySelectorAll('#program-table tr[data-program]').length }; }).catch(() => 'Browser unavailable'));
  }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
