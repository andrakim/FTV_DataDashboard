import { detectScanGeometry, scanCrop, scaleAtFraction, fractionAtScale } from './scanGeometry.js';
import { dateLabel, timeLabel, escapeHTML as e, WEEKDAYS, number } from './format.js';
import { timeAtFraction } from '../analytics/trendExplorer.js';
import { ANNOTATION_TAGS } from '../analytics/annotations.js';
import { FTV_CHANNEL } from '../core/normalization.js';

// Display original pixels. TOP averages never replace the minute curve.
const TRIGGER_SHORT = { leadInDrop: 'Обвал на стыке', primeUnderperformance: 'Просадка прайма', midBlockValley: 'Яма в связке' };

export function createScanViewer(container, { getScan, getDailyShare, getDrop, getAnnotations, getTool, onAnnotate, onDeleteAnnotation, onOpen, onProgram, onTime, onError }) {
  const geometries = new Map();
  let generation = 0, activeFilters, activeDays = [], activeScale = 'fit', lastRenderKey = '', resizeFrame = null;
  let showDropPins = true, pendingTrend = null;
  const clearCache = () => { geometries.clear(); lastRenderKey = ''; };

  function scanWidth(count, scale) {
    if (scale === 'large') return 380;
    if (scale === 'larger') return 480;
    const style = getComputedStyle(container), available = container.clientWidth || 1400;
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const gap = count > 5 ? 8 : 12;
    // Allow 7 days (Пн–Вс) to fit side-by-side in a single row without cutting off weekend days.
    const minimum = available < 950 ? 220 : count > 5 ? 125 : 180;
    return Math.floor(Math.max(minimum, Math.min(350, (available - padding - Math.max(0, count - 1) * gap) / Math.max(1, count))));
  }

  function resizeBoard() {
    const board = container.querySelector('.scan-board'); if (!board || !activeFilters) return;
    const width = scanWidth(activeDays.length, activeScale);
    // Canvas dimensions and source pixels stay intact; only display size changes.
    board.style.setProperty('--scan-width', `${width}px`);
    board.style.setProperty('--scan-gap', `${activeDays.length > 5 ? 8 : 12}px`);
    board.style.setProperty('--scan-height', `${(activeFilters.endSec - activeFilters.startSec) / 15 * (width - 2) / 238}px`);
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { resizeFrame = null; resizeBoard(); });
  }) : null;
  resizeObserver?.observe(container);

  function buildAnnotationsHTML(dateISO, filters) {
    const items = getAnnotations?.() ?? [];
    if (!items.length && !pendingTrend) return '';
    const span = filters.endSec - filters.startSec;
    if (span <= 0) return '';
    const yPct = sec => ((sec - filters.startSec) / span) * 100;
    const parts = [];
    const svgLines = [];

    for (const item of items) {
      if (item.channel !== filters.channel) continue;
      if (item.type === 'hline' && item.timeSec >= filters.startSec && item.timeSec <= filters.endSec) {
        const top = yPct(item.timeSec);
        parts.push(`<div class="ann-hline" style="top:${top}%"><span>${timeLabel(item.timeSec)} · ${e(item.label)}<button type="button" data-del-ann="${e(item.id)}" title="Удалить линию">×</button></span></div>`);
      } else if (item.type === 'vline') {
        const left = fractionAtScale(item.scaleValue);
        parts.push(`<div class="ann-vline" style="left:${left}%"><span>Порог ${number(item.scaleValue, 1)}<button type="button" data-del-ann="${e(item.id)}" title="Удалить порог">×</button></span></div>`);
      } else if (item.type === 'pin' && item.dateISO === dateISO && item.timeSec >= filters.startSec && item.timeSec <= filters.endSec) {
        const top = yPct(item.timeSec), left = fractionAtScale(item.scaleValue);
        const tagInfo = ANNOTATION_TAGS[item.tag] ?? ANNOTATION_TAGS.note;
        parts.push(`<div class="ann-pin" style="top:${top}%;left:${left}%;--ann-color:${tagInfo.color}" title="${e(tagInfo.label)} · ${timeLabel(item.timeSec)} · шкала ${number(item.scaleValue, 1)}${item.label ? ` · ${e(item.label)}` : ''}"><i class="ann-pin-dot"></i><span class="ann-pin-tag">${e(tagInfo.label)} <b>${number(item.scaleValue, 1)}</b>${item.label ? ` <em>${e(item.label)}</em>` : ''}<button type="button" data-del-ann="${e(item.id)}" title="Удалить метку">×</button></span></div>`);
      } else if (item.type === 'trend' && item.dateISO === dateISO && item.endSec >= filters.startSec && item.startSec <= filters.endSec) {
        const y1 = Math.max(0, Math.min(100, yPct(item.startSec))), y2 = Math.max(0, Math.min(100, yPct(item.endSec)));
        const x1 = fractionAtScale(item.startScale), x2 = fractionAtScale(item.endScale);
        const delta = Math.round((item.endScale - item.startScale) * 10) / 10;
        const color = delta > 0.2 ? '#16a34a' : delta < -0.2 ? '#e11d48' : '#2563eb';
        const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
        svgLines.push(`<line x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%" stroke="${color}" stroke-width="2.5" stroke-dasharray="5,3" /><circle cx="${x1}%" cy="${y1}%" r="3.5" fill="${color}" /><circle cx="${x2}%" cy="${y2}%" r="4.5" fill="${color}" />`);
        parts.push(`<div class="ann-trend-badge" style="top:${(y1 + y2) / 2}%;left:${(x1 + x2) / 2}%;--ann-color:${color}"><span>${delta >= 0 ? '↗' : '↘'} ${sign}${number(Math.abs(delta), 1)}${item.label ? ` · ${e(item.label)}` : ''}<button type="button" data-del-ann="${e(item.id)}" title="Удалить тренд">×</button></span></div>`);
      }
    }

    if (pendingTrend && pendingTrend.dateISO === dateISO) {
      const y1 = Math.max(0, Math.min(100, yPct(pendingTrend.startSec)));
      const x1 = fractionAtScale(pendingTrend.startScale);
      const y2 = pendingTrend.curSec != null ? Math.max(0, Math.min(100, yPct(pendingTrend.curSec))) : y1;
      const x2 = pendingTrend.curScale != null ? fractionAtScale(pendingTrend.curScale) : x1;
      svgLines.push(`<line x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%" stroke="#2563eb" stroke-width="2" stroke-dasharray="4,4" /><circle cx="${x1}%" cy="${y1}%" r="4" fill="#2563eb" />`);
    }

    const svg = svgLines.length ? `<svg class="ann-svg" preserveAspectRatio="none">${svgLines.join('')}</svg>` : '';
    return svg + parts.join('');
  }

  function refreshAnnotations() {
    if (!activeFilters) return;
    container.querySelectorAll('.scan-card').forEach(card => {
      const layer = card.querySelector('.scan-annotations-layer');
      if (layer) layer.innerHTML = buildAnnotationsHTML(card.dataset.scanDate, activeFilters);
    });
  }

  function setDropPinsVisible(visible) {
    showDropPins = Boolean(visible);
    container.querySelectorAll('.scan-drop-pin').forEach(el => { el.hidden = !showDropPins; });
  }

  function scrollToTime(timeSec) {
    if (!activeFilters) return;
    const fraction = Math.max(0, Math.min(1, (timeSec - activeFilters.startSec) / Math.max(1, activeFilters.endSec - activeFilters.startSec)));
    const body = container.querySelector('.scan-body');
    if (!body) return;
    const targetY = body.offsetTop + body.clientHeight * fraction - container.clientHeight * 0.35;
    container.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
  }

  async function render(days, filters, scale = 'fit') {
    activeDays = days; activeScale = scale;
    const width = scanWidth(days.length, scale);
    const gap = days.length > 5 ? 8 : 12;
    const renderKey = JSON.stringify({ dates: days.map(day => day.dateISO), filters, scale });
    resizeBoard();
    if (renderKey === lastRenderKey) {
      refreshAnnotations();
      return;
    }
    lastRenderKey = renderKey; const token = ++generation; activeFilters = filters;
    const bodyHeight = (filters.endSec - filters.startSec) / 15 * (width - 2) / 238;
    container.innerHTML = `<div class="scan-board" data-query="${e(JSON.stringify(filters))}" data-scale="${scale}" style="--scan-width:${width}px;--scan-gap:${gap}px;--scan-height:${bodyHeight}px">${days.map(day => {
      const dailyShare = getDailyShare?.(day.dateISO, filters.channel);
      const dayDrops = day.matches.filter(row => getDrop?.(row.id)?.triggers?.length);
      const topDropsHTML = `<div class="scan-card-drops ${dayDrops.length ? 'has-drops' : 'no-drops'}" aria-label="Обвалы за день">${dayDrops.length ? `${dayDrops.slice(0, 2).map(row => {
        const drop = getDrop(row.id);
        const ret = Number.isFinite(drop?.leadInRetention) ? ` · ${number(drop.leadInRetention, 0)}%` : '';
        return `<button type="button" class="card-drop-chip" data-open-program="${e(row.id)}" title="${e(row.title)} (${timeLabel(row.startSec)}–${timeLabel(row.endSec)}) — нажмите для деталей">▼ ${timeLabel(row.startSec)} ${e(row.title.slice(0, 14))}${ret}</button>`;
      }).join('')}${dayDrops.length > 2 ? `<span class="card-drop-more">+${dayDrops.length - 2}</span>` : ''}` : `<span class="card-drop-ok">${day.matches.length ? '✓ Без провалов в окне' : 'Нет расписания'}</span>`}</div>`;
      return `<article class="scan-card" data-scan-date="${day.dateISO}"><div class="scan-card-heading"><div><strong>${WEEKDAYS[day.weekday - 1]}${Number.isFinite(dailyShare) ? `<em class="daily-share-pill" title="Среднесуточная доля канала">${number(dailyShare)}%</em>` : ''}</strong><span>${dateLabel(day.dateISO, true)}</span></div><button class="text-button" data-original="${day.dateISO}" ${day.hasScan ? '' : 'disabled'}>Оригинал ↗</button></div>${topDropsHTML}<div class="scan-native-header"></div><div class="scan-body"><div class="scan-placeholder">${day.hasScan ? 'Открываем график…' : 'Нет исходного графика'}${day.hasScan ? '' : '<small>Загрузите ежедневный отчёт за эту дату</small>'}</div><div class="scan-annotations-layer">${buildAnnotationsHTML(day.dateISO, filters)}</div><div class="scan-cursor-x" hidden><span></span></div><div class="scan-cursor" hidden><span></span></div></div><div class="scan-programmes">${day.matches.length ? day.matches.map(row => {
        const drop = getDrop?.(row.id);
        const tierClass = drop?.triggers?.length ? 'is-pain-point' : Number.isFinite(row.share) ? (row.share >= 2 ? 'tier-high' : row.share >= 1 ? 'tier-mid' : 'tier-low') : '';
        const painBadge = drop?.triggers?.length ? ` · <b class="prog-pain-tag">▼ ${e(TRIGGER_SHORT[drop.triggers[0]] ?? 'Провал')}${Number.isFinite(drop.leadInRetention) ? ` (${number(drop.leadInRetention, 0)}%)` : ''}</b>` : '';
        return `<button class="${tierClass}" data-open-program="${e(row.id)}"><span>${timeLabel(row.startSec)}–${timeLabel(row.endSec)} ${row.approximate ? '≈' : ''}</span><strong>${e(row.title)}</strong><small>Средняя доля программы ${number(row.share)}%${painBadge}</small></button>`;
      }).join('') : `<p>${filters.title ? 'В выбранном окне программа не найдена в загруженном расписании.' : 'Расписание за это время не загружено.'}</p>`}</div></article>`;
    }).join('')}</div>`;
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
        for (const row of day.matches) {
          const drop = getDrop?.(row.id);
          if (!drop?.triggers?.length) continue;
          const top = Math.max(0, Math.min(0.97, (Math.max(row.startSec, filters.startSec) - filters.startSec) / (filters.endSec - filters.startSec)));
          const bottom = Math.min(1, Math.max(top + 0.015, (Math.min(row.endSec, filters.endSec) - filters.startSec) / (filters.endSec - filters.startSec)));
          const pin = document.createElement('div');
          pin.className = 'scan-drop-pin';
          pin.hidden = !showDropPins;
          pin.style.top = `${top * 100}%`;
          pin.style.height = `${Math.max(1.5, (bottom - top) * 100)}%`;
          const retText = Number.isFinite(drop.leadInRetention) ? ` · ${number(drop.leadInRetention, 0)}%` : '';
          pin.innerHTML = `<button type="button" class="scan-drop-badge" data-open-program="${e(row.id)}" title="${e(row.title)}: ${e(TRIGGER_SHORT[drop.triggers[0]] ?? 'Провал')}${retText}">▼ ${timeLabel(row.startSec)}${retText}</button>`;
          body.append(pin);
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
    const rect = body.getBoundingClientRect();
    const yFraction = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const xFraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const curSec = timeAtFraction(activeFilters, yFraction);
    const timeText = timeLabel(curSec);
    const { value: scaleVal, leftPercent } = scaleAtFraction(xFraction);
    const scaleText = number(scaleVal, 1);
    container.querySelectorAll('.scan-cursor').forEach(line => {
      line.hidden = false;
      line.style.top = `${yFraction * 100}%`;
      line.querySelector('span').textContent = `${timeText} · ${scaleText}`;
    });
    container.querySelectorAll('.scan-cursor-x').forEach(vline => {
      vline.hidden = false;
      vline.style.left = `${leftPercent}%`;
      vline.querySelector('span').textContent = scaleText;
    });
    if (pendingTrend) {
      pendingTrend.curSec = curSec;
      pendingTrend.curScale = scaleVal;
      refreshAnnotations();
    }
  });

  container.addEventListener('pointerleave', () => {
    container.querySelectorAll('.scan-cursor, .scan-cursor-x').forEach(line => { line.hidden = true; });
  });

  container.addEventListener('click', event => {
    const delBtn = event.target.closest('[data-del-ann]');
    if (delBtn) {
      event.stopPropagation();
      onDeleteAnnotation?.(delBtn.dataset.delAnn);
      return;
    }
    const original = event.target.closest('[data-original]'); if (original) { onOpen(original.dataset.original); return; }
    const programme = event.target.closest('[data-open-program]'); if (programme) { onProgram(programme.dataset.openProgram); return; }
    const body = event.target.closest('.scan-body'); if (!body?.querySelector('canvas')) return;
    const rect = body.getBoundingClientRect();
    const yFraction = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const xFraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const timeSec = Math.min(activeFilters.endSec - 1, timeAtFraction(activeFilters, yFraction));
    const { value: scaleValue } = scaleAtFraction(xFraction);
    const dateISO = body.closest('[data-scan-date]').dataset.scanDate;
    const tool = getTool?.() ?? 'inspect';

    if (tool === 'trend') {
      if (!pendingTrend || pendingTrend.dateISO !== dateISO) {
        pendingTrend = { dateISO, startSec: timeSec, startScale: scaleValue, curSec: timeSec, curScale: scaleValue };
        refreshAnnotations();
      } else {
        const finished = { type: 'trend', channel: activeFilters.channel, dateISO, startSec: pendingTrend.startSec, endSec: timeSec, startScale: pendingTrend.startScale, endScale: scaleValue };
        pendingTrend = null;
        onAnnotate?.(finished);
      }
      return;
    }
    pendingTrend = null;
    if (tool === 'pin' || tool === 'hline' || tool === 'vline') {
      onAnnotate?.({ type: tool, channel: activeFilters.channel, dateISO, timeSec, scaleValue });
      return;
    }
    onTime(dateISO, timeSec);
  });

  return {
    render,
    clearCache,
    refreshAnnotations,
    setDropPinsVisible,
    scrollToTime,
    cancelPending() { pendingTrend = null; refreshAnnotations(); },
    dispose() { generation++; clearCache(); resizeObserver?.disconnect(); if (resizeFrame != null) cancelAnimationFrame(resizeFrame); container.replaceChildren(); },
  };
}
