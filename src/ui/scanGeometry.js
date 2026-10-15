import { BROADCAST_START, BROADCAST_END, FTV_CHANNEL, normalizeChannel } from '../core/normalization.js';

// The source PNG contains seven vertical channels. Pixel widths show Share;
// the vertical axis is the broadcast clock. Nothing here derives ratings from pixels.
export const SCAN_CHANNELS = Object.freeze([
  FTV_CHANNEL, 'NAVO', "ZO'R TV (UZ/RU)", 'SEVIMLI TV', 'MILLIY TV', 'MENING YURTIM', 'KINOTEATR (UZ/RU)',
]);

const FRAME_LEFT = 37, FRAME_WIDTH = 200, FRAME_STEP = 210, CLOCK_WIDTH = 37;
const HEADER_HEIGHT = 62;
const failure = (width, height, reason) => ({ width, height, top: null, bottom: null, panels: [], confidence: 0, reason });

/**
 * Recognise the complete 05:00–29:00 source template verified against the
 * 23 supplied reports. ImageData is a plain { width, height, data } RGBA object.
 * Unknown dimensions, clipped images, or unconfirmed frames deliberately fail.
 * A similarly shaped picture alone never establishes a time calibration.
 */
export function detectScanGeometry(imageData) {
  const { width, height, data } = imageData ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || !data || data.length !== width * height * 4) {
    return failure(width ?? 0, height ?? 0, 'Некорректное изображение');
  }
  if (width !== 1530 || ![6036, 6037].includes(height)) {
    return failure(width, height, 'Формат скана не распознан; требуется просмотр оригинала');
  }
  const dark = (x, y) => {
    const i = (y * width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    return data[i + 3] >= 200 && Math.max(r, g, b) < 160 && Math.max(r, g, b) - Math.min(r, g, b) < 30;
  };
  const panels = SCAN_CHANNELS.map((channel, i) => ({ channel, left: FRAME_LEFT + i * FRAME_STEP, right: FRAME_LEFT + i * FRAME_STEP + FRAME_WIDTH }));
  // Require every original frame, including competitor frames. Sampling avoids
  // a second full-image allocation and takes roughly 20,000 pixel reads.
  for (const panel of panels) for (const x of [panel.left, panel.right]) {
    let hits = 0, samples = 0;
    for (let y = 230; y < height - 150; y += 4) { samples++; if (dark(x, y)) hits++; }
    if (hits / samples < .97) return failure(width, height, 'Рамки каналов не подтверждены');
  }
  const horizontal = y => {
    let hits = 0, samples = 0;
    for (const panel of panels) for (let x = panel.left; x <= panel.right; x += 2) { samples++; if (dark(x, y)) hits++; }
    return hits / samples >= .94;
  };
  // A one-pixel text-header variation changes both y offsets, not the scale.
  const expectedTop = height - 5835, expectedBottom = height - 75;
  const boundary = expected => {
    for (let y = expected - 2; y <= expected + 2; y++) if (horizontal(y)) return y;
    return null;
  };
  const top = boundary(expectedTop), bottom = boundary(expectedBottom);
  if (top == null || bottom == null || bottom - top !== 5760 || top !== expectedTop || bottom !== expectedBottom) {
    return failure(width, height, 'Начало и конец эфирных суток не подтверждены');
  }
  return {
    width, height, top, bottom, panels, confidence: 1, method: 'verified-report-frame',
    startSec: BROADCAST_START, endSec: BROADCAST_END,
    pixelsPerSecond: (bottom - top) / (BROADCAST_END - BROADCAST_START),
    headerY: Math.max(0, top - HEADER_HEIGHT), headerHeight: HEADER_HEIGHT,
    clockX: 0, clockWidth: CLOCK_WIDTH,
  };
}

/**
 * Return source rectangles, never resampled pixels. The channel rectangle keeps
 * its original horizontal Share scale. Render headerX/headerY/headerWidth/
 * headerHeight above it on EVERY date, even when only a late fragment is shown.
 * For a non-FTV channel, clockX/clockWidth can be copied alongside the plot.
 * Fractional times are rounded outward to source pixels (15 seconds per pixel
 * in this template); selectedTop/Bottom preserve the requested overlay bounds.
 */
export function scanCrop(geometry, { channel = FTV_CHANNEL, startSec = BROADCAST_START, endSec = BROADCAST_END, contextSeconds = 0 } = {}) {
  if (!geometry || geometry.confidence !== 1 || !Number.isFinite(geometry.top) || !Number.isFinite(geometry.bottom) || geometry.bottom <= geometry.top) {
    throw new Error('Привязка скана ко времени не подтверждена');
  }
  if (![startSec, endSec, contextSeconds].every(Number.isFinite) || startSec < BROADCAST_START || endSec > BROADCAST_END || startSec >= endSec || contextSeconds < 0) {
    throw new Error('Выберите время в пределах 05:00–29:00');
  }
  const selected = channel === 'all' ? null : geometry.panels?.find(panel => panel.channel === normalizeChannel(channel));
  if (channel !== 'all' && !selected) throw new Error('Канал отсутствует на исходном скане');
  const rangeStart = Math.max(BROADCAST_START, startSec - contextSeconds), rangeEnd = Math.min(BROADCAST_END, endSec + contextSeconds);
  const pixel = sec => geometry.top + (sec - BROADCAST_START) / (BROADCAST_END - BROADCAST_START) * (geometry.bottom - geometry.top);
  const y = Math.floor(pixel(rangeStart)), bottom = Math.min(geometry.height, Math.ceil(pixel(rangeEnd)));
  // FTV includes the source clock at x0; other channels expose that clock as a
  // separate rectangle rather than accidentally showing a previous channel.
  const x = selected ? (selected.channel === FTV_CHANNEL ? 0 : selected.left) : 0;
  const right = selected ? selected.right + 1 : geometry.width;
  const headerY = geometry.headerY ?? Math.max(0, geometry.top - HEADER_HEIGHT);
  return {
    x, y, width: right - x, height: bottom - y,
    headerX: x, headerY, headerWidth: right - x, headerHeight: geometry.top - headerY,
    clockX: geometry.clockX ?? 0, clockWidth: geometry.clockWidth ?? CLOCK_WIDTH,
    startSec: rangeStart, endSec: rangeEnd, requestedStartSec: startSec, requestedEndSec: endSec,
    selectedTop: pixel(startSec) - y, selectedBottom: pixel(endSec) - y,
    plotLeft: selected ? selected.left - x : FRAME_LEFT,
  };
}
