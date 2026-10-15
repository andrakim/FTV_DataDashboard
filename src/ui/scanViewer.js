import { detectScanGeometry, scanCrop } from './scanGeometry.js';
import { dateLabel, timeLabel, escapeHTML as e, WEEKDAYS, number } from './format.js';
import { timeAtFraction } from '../analytics/trendExplorer.js';
import { FTV_CHANNEL } from '../core/normalization.js';

// Display original pixels. TOP averages never replace the minute curve.
export function createScanViewer(container, { getScan, onOpen, onProgram, onTime, onError }) {
  const geometries = new Map(); let generation = 0, activeFilters, lastRenderKey = '';
  const clearCache = () => { geometries.clear(); lastRenderKey = ''; };
  async function render(days, filters, scale = 'fit') {
    const available = container.clientWidth || 1400;
    const width = scale === 'large' ? 380 : scale === 'larger' ? 480 : Math.max(250, Math.min(350, (available - 26 - Math.max(0, days.length - 1) * 12) / Math.max(1, days.length)));
    const renderKey = JSON.stringify({ dates: days.map(day => day.dateISO), filters, scale, width });
    if (renderKey === lastRenderKey) return;
    lastRenderKey = renderKey; const token = ++generation; activeFilters = filters;
    const bodyHeight = (filters.endSec - filters.startSec) / 15 * (width - 2) / 238;
    container.innerHTML = `<div class="scan-board" data-query="${e(JSON.stringify(filters))}" data-scale="${scale}" style="--scan-width:${width}px;--scan-height:${bodyHeight}px">${days.map(day => `<article class="scan-card" data-scan-date="${day.dateISO}"><div class="scan-card-heading"><div><strong>${WEEKDAYS[day.weekday - 1]}</strong><span>${dateLabel(day.dateISO, true)}</span></div><button class="text-button" data-original="${day.dateISO}" ${day.hasScan ? '' : 'disabled'}>Оригинал ↗</button></div><div class="scan-native-header"></div><div class="scan-body"><div class="scan-placeholder">${day.hasScan ? 'Открываем график…' : 'Нет исходного графика'}${day.hasScan ? '' : '<small>Загрузите ежедневный отчёт за эту дату</small>'}</div><div class="scan-cursor" hidden><span></span></div></div><div class="scan-programmes">${day.matches.length ? day.matches.map(row => `<button data-open-program="${e(row.id)}"><span>${timeLabel(row.startSec)}–${timeLabel(row.endSec)} ${row.approximate ? '≈' : ''}</span><strong>${e(row.title)}</strong><small>Средняя доля программы ${number(row.share)}%</small></button>`).join('') : `<p>${filters.title ? 'В выбранном окне программа не найдена в загруженном расписании.' : 'Расписание за это время не загружено.'}</p>`}</div></article>`).join('')}</div>`;
    if (!days.length) { container.innerHTML = '<div class="empty-panel">Выберите хотя бы один день недели.</div>'; return; }
    for (const day of days) {
      if (token !== generation) return;
      if (!day.hasScan) continue;
      let bitmap;
      try {
        const scan = await getScan(day.dateISO); if (token !== generation) return;
        if (!scan?.blob) throw new Error('График не найден. Повторно загрузите отчёт.');
        bitmap = await createImageBitmap(scan.blob); if (token !== generation) continue;
        let geometry = geometries.get(day.dateISO);
        if (!geometry) {
          const source = document.createElement('canvas'); source.width = bitmap.width; source.height = bitmap.height;
          const ctx = source.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0);
          geometry = detectScanGeometry(ctx.getImageData(0, 0, bitmap.width, bitmap.height)); geometries.set(day.dateISO, geometry); source.width = 0; source.height = 0;
        }
        const card = container.querySelector(`[data-scan-date="${day.dateISO}"]`), body = card.querySelector('.scan-body');
        if (geometry.confidence !== 1) { body.querySelector('.scan-placeholder').innerHTML = '<span>Формат графика не распознан</span><small>Откройте оригинал. Привязка времени недоступна.</small>'; card.dataset.unmapped = 'true'; continue; }
        const crop = scanCrop(geometry, filters), clockWidth = filters.channel === FTV_CHANNEL ? 0 : crop.clockWidth, canvasWidth = crop.width + clockWidth;
        function draw(y, height) {
          const canvas = document.createElement('canvas'); canvas.width = canvasWidth; canvas.height = height;
          const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvasWidth, height);
          if (clockWidth) context.drawImage(bitmap, crop.clockX, y, clockWidth, height, 0, 0, clockWidth, height);
          context.drawImage(bitmap, crop.x, y, crop.width, height, clockWidth, 0, crop.width, height);
          canvas.setAttribute('aria-label', `${filters.channel}, ${dateLabel(day.dateISO)}, ${timeLabel(filters.startSec)}–${timeLabel(filters.endSec)}`); return canvas;
        }
        card.querySelector('.scan-native-header').replaceChildren(draw(crop.headerY, crop.headerHeight));
        body.querySelector('.scan-placeholder').remove(); body.prepend(draw(crop.y, crop.height)); body.style.height = 'auto'; card.dataset.mapped = 'true';
        if (filters.title) for (const row of day.matches) {
          const top = Math.max(0, (row.startSec - filters.startSec) / (filters.endSec - filters.startSec)), bottom = Math.min(1, (row.endSec - filters.startSec) / (filters.endSec - filters.startSec));
          const highlight = document.createElement('div'); highlight.className = 'program-highlight'; highlight.style.top = `${top * 100}%`; highlight.style.height = `${(bottom - top) * 100}%`; body.append(highlight);
        }
      } catch (error) {
        const card = container.querySelector(`[data-scan-date="${day.dateISO}"]`);
        if (token === generation && card) card.querySelector('.scan-placeholder').textContent = error.message;
        if (token === generation) onError?.(error);
      } finally { bitmap?.close(); }
    }
  }
  container.addEventListener('pointermove', event => {
    const body = event.target.closest('.scan-body'); if (!body?.querySelector('canvas')) return;
    const rect = body.getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    container.querySelectorAll('.scan-cursor').forEach(line => { line.hidden = false; line.style.top = `${fraction * 100}%`; line.querySelector('span').textContent = timeLabel(timeAtFraction(activeFilters, fraction)); });
  });
  container.addEventListener('pointerleave', () => container.querySelectorAll('.scan-cursor').forEach(line => { line.hidden = true; }));
  container.addEventListener('click', event => {
    const original = event.target.closest('[data-original]'); if (original) { onOpen(original.dataset.original); return; }
    const programme = event.target.closest('[data-open-program]'); if (programme) { onProgram(programme.dataset.openProgram); return; }
    const body = event.target.closest('.scan-body'); if (!body?.querySelector('canvas')) return;
    const rect = body.getBoundingClientRect(); onTime(body.closest('[data-scan-date]').dataset.scanDate, Math.min(activeFilters.endSec - 1, timeAtFraction(activeFilters, (event.clientY - rect.top) / rect.height)));
  });
  return { render, clearCache, dispose() { generation++; clearCache(); container.replaceChildren(); } };
}



