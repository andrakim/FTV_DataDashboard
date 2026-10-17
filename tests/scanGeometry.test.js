import test from 'node:test';
import assert from 'node:assert/strict';
import { SCAN_CHANNELS, detectScanGeometry, scanCrop, scaleAtFraction } from '../src/ui/scanGeometry.js';

function sourceFrame(height = 6037) {
  const width = 1530, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const top = height - 5835, bottom = height - 75;
  const point = (x, y, gray = 0) => { const index = (y * width + x) * 4; data[index] = data[index + 1] = data[index + 2] = gray; };
  for (let panel = 0; panel < 7; panel++) {
    const left = 37 + panel * 210, right = left + 200;
    for (let y = top; y <= bottom; y++) { point(left, y); point(right, y); }
    for (let x = left; x <= right; x++) { point(x, top); point(x, bottom); }
  }
  return { width, height, data, point, top, bottom };
}

test('scan recognises both real report header heights without shifting the clock', () => {
  for (const height of [6036, 6037]) {
    const fixture = sourceFrame(height), geometry = detectScanGeometry(fixture);
    assert.equal(geometry.confidence, 1); assert.equal(geometry.top, height - 5835); assert.equal(geometry.bottom, height - 75);
    assert.equal(geometry.bottom - geometry.top, 5760); assert.equal(geometry.pixelsPerSecond, 1 / 15);
    assert.deepEqual(geometry.panels.map(panel => panel.channel), SCAN_CHANNELS);
    assert.deepEqual(geometry.panels[6], { channel: 'KINOTEATR (UZ/RU)', left: 1297, right: 1497 });
  }
});

test('scan refuses blank, cropped, unsupported or damaged frames', () => {
  assert.equal(detectScanGeometry(null).confidence, 0);
  assert.equal(detectScanGeometry({ width: 100, height: 100, data: new Uint8ClampedArray(40000) }).confidence, 0);
  const fixture = sourceFrame();
  for (let y = fixture.top; y <= fixture.bottom; y++) fixture.point(667, y, 255);
  assert.equal(detectScanGeometry(fixture).confidence, 0);
  fixture.data.fill(255); assert.equal(detectScanGeometry(fixture).confidence, 0);
});

test('channel and time cropping retain the original axis and independent Share header', () => {
  const geometry = detectScanGeometry(sourceFrame());
  const crop = scanCrop(geometry, { startSec: 18 * 3600, endSec: 19 * 3600 });
  assert.equal(crop.x, 0); assert.equal(crop.width, 238); assert.equal(crop.y, 3322); assert.equal(crop.height, 240);
  assert.equal(crop.headerY, 140); assert.equal(crop.headerHeight, 62); assert.equal(crop.plotLeft, 37);
  const competitor = scanCrop(geometry, { channel: 'SEVIMLI TV', startSec: 18 * 3600, endSec: 19 * 3600 });
  assert.equal(competitor.x, 667); assert.equal(competitor.width, 201); assert.equal(competitor.clockWidth, 37);
  assert.equal(competitor.headerX, competitor.x); assert.equal(competitor.headerWidth, competitor.width);
  assert.equal(scanCrop(geometry, { channel: 'all' }).width, 1530);
});

test('night times stay on the source broadcast date and context is clipped to the day', () => {
  const geometry = detectScanGeometry(sourceFrame());
  const late = scanCrop(geometry, { startSec: 28 * 3600, endSec: 29 * 3600, contextSeconds: 600 });
  assert.equal(late.startSec, 27 * 3600 + 50 * 60); assert.equal(late.endSec, 29 * 3600);
  assert.equal(late.y + late.height, geometry.bottom); assert.equal(late.selectedBottom, late.height);
  assert.equal(scanCrop(geometry, { startSec: 18000, endSec: 18001, contextSeconds: 600 }).startSec, 18000);
});

test('source pixels round outward for seconds and unconfirmed clocks never crop', () => {
  const geometry = detectScanGeometry(sourceFrame());
  const crop = scanCrop(geometry, { startSec: 64801, endSec: 64816 });
  assert.equal(crop.height, 2); assert.ok(crop.selectedTop > 0); assert.ok(crop.selectedBottom < 2);
  assert.throws(() => scanCrop({ ...geometry, confidence: 0 }), /не подтверждена/);
  for (const options of [{ startSec: 0 }, { endSec: 104401 }, { startSec: 70000, endSec: 60000 }, { contextSeconds: -1 }, { startSec: NaN }, { channel: 'OTHER CHANNELS' }]) assert.throws(() => scanCrop(geometry, options));
});

test('scaleAtFraction maps horizontal pointer coordinates to exact 0, 10, 20, 30 header ticks', () => {
  assert.equal(scaleAtFraction(0).value, 0);
  assert.equal(scaleAtFraction(37 / 238).value, 0);
  assert.equal(scaleAtFraction((37 + 57) / 238).value, 10);
  assert.equal(scaleAtFraction((37 + 114) / 238).value, 20);
  assert.equal(scaleAtFraction((37 + 171) / 238).value, 30);
  assert.equal(scaleAtFraction(1).value, 35.1);
});

