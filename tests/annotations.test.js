import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotation, validateAnnotations, summarizeAnnotations } from '../src/analytics/annotations.js';
import { fractionAtScale, scaleAtFraction } from '../src/ui/scanGeometry.js';

test('createAnnotation normalizes pins, trend lines, and slices with chronological order and clamped bounds', () => {
  const pin = createAnnotation({ type: 'pin', dateISO: '2026-10-05', timeSec: 65000, scaleValue: 14.36, tag: 'drop', label: 'Резкий спад' });
  assert.equal(pin.type, 'pin');
  assert.equal(pin.scaleValue, 14.4);
  assert.equal(pin.tag, 'drop');

  // Reversed time order is normalized so startSec <= endSec
  const trend = createAnnotation({
    type: 'trend',
    dateISO: '2026-10-05',
    startSec: 70000,
    endSec: 66000,
    startScale: 8.0,
    endScale: 16.0,
  });
  assert.equal(trend.startSec, 66000);
  assert.equal(trend.endSec, 70000);
  assert.equal(trend.startScale, 16.0);
  assert.equal(trend.endScale, 8.0);
});

test('summarizeAnnotations computes cross-day pin trends, trend line slopes, and time-slice share averages', () => {
  const catalog = [
    { id: '1', channel: 'FTV (UZ/RU)', dateISO: '2026-10-05', startSec: 64800, endSec: 68400, title: 'Fresh news', share: 3.2 },
    { id: '2', channel: 'FTV (UZ/RU)', dateISO: '2026-10-06', startSec: 64800, endSec: 68400, title: 'Fresh news', share: 1.8 },
  ];
  const list = validateAnnotations([
    { id: 'p1', type: 'pin', channel: 'FTV (UZ/RU)', dateISO: '2026-10-05', timeSec: 66000, scaleValue: 18.0, tag: 'peak' },
    { id: 'p2', type: 'pin', channel: 'FTV (UZ/RU)', dateISO: '2026-10-06', timeSec: 66000, scaleValue: 9.0, tag: 'drop' },
    { id: 't1', type: 'trend', channel: 'FTV (UZ/RU)', dateISO: '2026-10-05', startSec: 64800, endSec: 68400, startScale: 15.0, endScale: 9.0 },
    { id: 'h1', type: 'hline', channel: 'FTV (UZ/RU)', timeSec: 66000, label: 'Вечерний срез' },
  ]);
  const summary = summarizeAnnotations(list, {
    channel: 'FTV (UZ/RU)',
    dates: ['2026-10-05', '2026-10-06'],
    startSec: 64800,
    endSec: 68400,
    catalog,
  });
  assert.equal(summary.visibleCount, 4);
  assert.equal(summary.pinTrend.direction, 'down');
  assert.equal(summary.pinTrend.deltaScale, -9);
  assert.equal(summary.pinTrend.relativePercent, -50);
  assert.equal(summary.pinTrend.meanScale, 13.5);
  assert.equal(summary.trendLines[0].deltaScale, -6);
  assert.equal(summary.trendLines[0].slopePerHour, -6);
  assert.equal(summary.timeSlices[0].avgShare, 2.5);
});

test('fractionAtScale and scaleAtFraction are consistent across the 0..30 tick range', () => {
  for (const tick of [0, 10, 20, 30]) {
    const pct = fractionAtScale(tick);
    const back = scaleAtFraction(pct / 100);
    assert.equal(back.value, tick);
  }
});
