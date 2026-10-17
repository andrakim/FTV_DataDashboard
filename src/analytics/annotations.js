import { BROADCAST_START, BROADCAST_END, FTV_CHANNEL, normalizeChannel } from '../core/normalization.js';
import { programmesAtTime } from './trendExplorer.js';

export const ANNOTATION_TAGS = Object.freeze({
  drop: { id: 'drop', label: '▼ Провал', color: '#e11d48' },
  peak: { id: 'peak', label: '▲ Пик', color: '#16a34a' },
  hold: { id: 'hold', label: '✓ Удержание', color: '#2563eb' },
  ad: { id: 'ad', label: '⏸ Стык / Реклама', color: '#d97706' },
  note: { id: 'note', label: '📌 Заметка', color: '#7c3aed' },
});

const clampTime = sec => Math.max(BROADCAST_START, Math.min(BROADCAST_END, Math.round(Number(sec) || BROADCAST_START)));
const clampScale = val => Math.max(0, Math.min(35.1, Math.round((Number(val) || 0) * 10) / 10));

export function createAnnotation(raw = {}) {
  const type = ['pin', 'hline', 'vline', 'trend'].includes(raw.type) ? raw.type : 'pin';
  const channel = normalizeChannel(raw.channel || FTV_CHANNEL);
  const id = String(raw.id || `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const label = String(raw.label ?? '').trim().slice(0, 120);
  if (type === 'hline') {
    return { id, type, channel, timeSec: clampTime(raw.timeSec), label: label || 'Срез времени' };
  }
  if (type === 'vline') {
    return { id, type, channel, scaleValue: clampScale(raw.scaleValue), label: label || 'Целевой порог' };
  }
  if (type === 'trend') {
    const t1 = clampTime(raw.startSec), t2 = clampTime(raw.endSec);
    const s1 = clampScale(raw.startScale), s2 = clampScale(raw.endScale);
    const forward = t1 <= t2;
    return {
      id,
      type,
      channel,
      dateISO: String(raw.dateISO || ''),
      startSec: forward ? t1 : t2,
      endSec: forward ? t2 : t1,
      startScale: forward ? s1 : s2,
      endScale: forward ? s2 : s1,
      label,
    };
  }
  const tag = ANNOTATION_TAGS[raw.tag] ? raw.tag : 'note';
  return {
    id,
    type: 'pin',
    channel,
    dateISO: String(raw.dateISO || ''),
    timeSec: clampTime(raw.timeSec),
    scaleValue: clampScale(raw.scaleValue),
    tag,
    label,
  };
}

export function validateAnnotations(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(item => item && typeof item === 'object').map(createAnnotation);
}

export function summarizeAnnotations(annotations = [], { channel = FTV_CHANNEL, dates = [], startSec = BROADCAST_START, endSec = BROADCAST_END, catalog = [] } = {}) {
  const normChannel = normalizeChannel(channel);
  const normalizedCatalog = catalog.map(row => (row.audience ? row : { ...row, audience: '18-54' }));
  const dateSet = new Set(dates);
  const channelItems = validateAnnotations(annotations).filter(item => item.channel === normChannel);
  const visible = channelItems.filter(item => {
    if (item.type === 'hline') return item.timeSec >= startSec && item.timeSec <= endSec;
    if (item.type === 'vline') return true;
    if (dateSet.size && item.dateISO && !dateSet.has(item.dateISO)) return false;
    if (item.type === 'pin') return item.timeSec >= startSec && item.timeSec <= endSec;
    if (item.type === 'trend') return item.endSec >= startSec && item.startSec <= endSec;
    return true;
  });

  const pins = visible
    .filter(item => item.type === 'pin')
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.timeSec - b.timeSec)
    .map(pin => {
      const matches = programmesAtTime(normalizedCatalog, pin.dateISO, pin.timeSec, normChannel);
      return { ...pin, programme: matches[0]?.title ?? null, programmeShare: matches[0]?.share ?? null };
    });

  let pinTrend = null;
  if (pins.length >= 2) {
    const first = pins[0], last = pins.at(-1);
    const deltaScale = Math.round((last.scaleValue - first.scaleValue) * 10) / 10;
    const relativePercent = first.scaleValue > 0 ? Math.round((deltaScale / first.scaleValue) * 1000) / 10 : null;
    const meanScale = Math.round((pins.reduce((sum, p) => sum + p.scaleValue, 0) / pins.length) * 10) / 10;
    const sortedByScale = [...pins].sort((a, b) => a.scaleValue - b.scaleValue);
    pinTrend = {
      count: pins.length,
      first,
      last,
      deltaScale,
      relativePercent,
      meanScale,
      minPin: sortedByScale[0],
      maxPin: sortedByScale.at(-1),
      direction: deltaScale > 0.3 ? 'up' : deltaScale < -0.3 ? 'down' : 'flat',
    };
  }

  const trendLines = visible
    .filter(item => item.type === 'trend')
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.startSec - b.startSec)
    .map(line => {
      const durationMin = Math.round(((line.endSec - line.startSec) / 60) * 10) / 10;
      const deltaScale = Math.round((line.endScale - line.startScale) * 10) / 10;
      const slopePerHour = durationMin > 0 ? Math.round((deltaScale / (durationMin / 60)) * 10) / 10 : 0;
      const midSec = Math.round((line.startSec + line.endSec) / 2);
      const matches = programmesAtTime(normalizedCatalog, line.dateISO, midSec, normChannel);
      return {
        ...line,
        durationMin,
        deltaScale,
        slopePerHour,
        direction: deltaScale > 0.2 ? 'up' : deltaScale < -0.2 ? 'down' : 'flat',
        programme: matches[0]?.title ?? null,
      };
    });

  const timeSlices = visible
    .filter(item => item.type === 'hline')
    .sort((a, b) => a.timeSec - b.timeSec)
    .map(slice => {
      const dayMatches = dates.map(dateISO => {
        const matches = programmesAtTime(normalizedCatalog, dateISO, slice.timeSec, normChannel);
        return { dateISO, programme: matches[0]?.title ?? null, share: matches[0]?.share ?? null };
      });
      const measured = dayMatches.filter(d => Number.isFinite(d.share));
      const avgShare = measured.length ? Math.round((measured.reduce((s, d) => s + d.share, 0) / measured.length) * 100) / 100 : null;
      return { ...slice, dayMatches, avgShare };
    });

  const thresholds = visible.filter(item => item.type === 'vline').sort((a, b) => a.scaleValue - b.scaleValue);

  return {
    totalForChannel: channelItems.length,
    visibleCount: visible.length,
    pins,
    pinTrend,
    trendLines,
    timeSlices,
    thresholds,
  };
}
