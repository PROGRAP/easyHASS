import test from 'node:test';
import assert from 'node:assert/strict';
import { averageImagePalette, coverCrop, FALLBACK_PALETTE } from '../frontend/src/image-palette.js';

const pixels = (...patches) => new Uint8ClampedArray(patches.flatMap(([count, rgba]) => Array.from({ length: count }, () => rgba).flat()));
const channels = value => value.split(' ').map(Number);
const luminance = value => channels(value).map(byte => {
  const c = byte / 255;
  return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
}).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
const palette = data => averageImagePalette(data, data.length / 4, 1);
const assertReadable = result => {
  for (const value of [result.base, result.shade]) {
    assert.match(value, /^\d+ \d+ \d+$/);
    assert.ok(channels(value).every(channel => channel >= 0 && channel <= 255));
    assert.ok(1.05 / (luminance(value) + .05) >= 4.5, `white contrast: ${value}`);
  }
  assert.ok(luminance(result.shade) <= luminance(result.base));
};

test('beige surfaces and a small green accent contribute proportionally to their area', () => {
  const data = pixels([25, [220, 206, 181, 255]], [25, [196, 177, 147, 255]], [25, [167, 149, 122, 255]], [15, [237, 225, 204, 255]], [10, [25, 160, 45, 255]]);
  const result = palette(data), [r, g, b] = channels(result.base);
  assert.ok(r > g && g > b, `expected warm average: ${result.base}`);
  assertReadable(result);
});

test('a larger blue area has more influence than smaller warm or saturated patches', () => {
  const result = palette(pixels([35, [65, 117, 184, 255]], [35, [117, 154, 208, 255]], [20, [205, 180, 146, 255]], [10, [240, 25, 35, 255]]));
  const [r, g, b] = channels(result.base);
  assert.ok(b > g && b > r, result.base);
  assertReadable(result);
});

test('alpha contributes visible area and fully transparent color cannot contaminate the palette', () => {
  const visible = pixels([20, [65, 105, 160, 255]]);
  assert.deepEqual(palette(pixels([80, [255, 0, 0, 0]], [20, [65, 105, 160, 255]])), palette(visible));
  const weighted = palette(pixels([80, [25, 200, 45, 8]], [20, [190, 170, 145, 255]]));
  const [r, g, b] = channels(weighted.base);
  assert.ok(r > g && g > b, weighted.base);
});

test('black and highlights count as pixels rather than being excluded or downweighted', () => {
  // 10% white + 90% black is linear .1, which encodes to sRGB 89.
  assert.equal(palette(pixels([10, [255, 255, 255, 255]], [90, [0, 0, 0, 255]])).base, '89 89 89');
  assert.equal(palette(pixels([10, [255, 0, 0, 255]], [90, [0, 0, 0, 255]])).base, '89 0 0');
});

test('averaging happens in linear light, not encoded sRGB or a hue angle', () => {
  assert.equal(palette(pixels([1, [0, 40, 80, 255]], [1, [80, 40, 0, 255]])).base, '56 40 56');
  const redSmall = palette(pixels([1, [80, 0, 0, 255]], [3, [0, 0, 80, 255]]));
  const redLarge = palette(pixels([3, [80, 0, 0, 255]], [1, [0, 0, 80, 255]]));
  assert.ok(channels(redSmall.base)[0] < channels(redLarge.base)[0]);
  assert.ok(channels(redSmall.base)[2] > channels(redLarge.base)[2]);
});

test('monochrome pictures stay neutral and all-black/all-white inputs stay finite and readable', () => {
  for (const gray of [0, 3, 90, 180, 255]) {
    const result = palette(pixels([100, [gray, gray, gray, 255]]));
    assert.equal(new Set(channels(result.base)).size, 1);
    assert.equal(new Set(channels(result.shade)).size, 1);
    assertReadable(result);
  }
});

test('solid hue is preserved while bright colors darken for white text', () => {
  for (const color of [[220, 200, 160, 255], [80, 170, 230, 255], [240, 130, 160, 255]]) {
    const result = palette(pixels([100, color]));
    const order = [0, 1, 2].sort((a, b) => color[a] - color[b]);
    const actual = channels(result.base);
    assert.ok(actual[order[0]] < actual[order[1]] && actual[order[1]] < actual[order[2]]);
    assertReadable(result);
  }
});

test('pixel order does not change the average color', () => {
  const patches = [[40, [205, 187, 157, 255]], [35, [155, 137, 112, 255]], [25, [30, 155, 70, 255]]];
  assert.deepEqual(palette(pixels(...patches)), palette(pixels(...patches.toReversed())));
});

test('empty, transparent, malformed or invalid raster data uses the exported warm-neutral fallback', () => {
  assert.ok(Object.isFrozen(FALLBACK_PALETTE));
  assertReadable(FALLBACK_PALETTE);
  for (const args of [[null, 1, 1], [[], 0, 0], [[1, 2, 3], 1, 1], [[NaN, 0, 0, 255], 1, 1], [[0, 0, 0, 0], 1, 1], [[0, 0, 0, 255], -1, 1], [[0, 0, 0, 255], 1.5, 1]]) {
    assert.deepEqual(averageImagePalette(...args), FALLBACK_PALETTE);
  }
});

test('coverCrop centers landscape, portrait and matching aspect ratios', () => {
  assert.deepEqual(coverCrop(1600, 900, 400, 400), { sx: 350, sy: 0, sw: 900, sh: 900 });
  assert.deepEqual(coverCrop(900, 1600, 400, 400), { sx: 0, sy: 350, sw: 900, sh: 900 });
  assert.deepEqual(coverCrop(1600, 900, 800, 450), { sx: 0, sy: 0, sw: 1600, sh: 900 });
  assert.deepEqual(coverCrop(100, 50, 800, 400), { sx: 0, sy: 0, sw: 100, sh: 50 });
});

test('coverCrop keeps source bounds and destination ratio for fractional sizes', () => {
  const crop = coverCrop(1536, 1024, 366, 221.875);
  assert.ok(crop.sx >= 0 && crop.sy >= 0 && crop.sx + crop.sw <= 1536 && crop.sy + crop.sh <= 1024);
  assert.ok(Math.abs(crop.sw / crop.sh - 366 / 221.875) < 1e-10);
  for (const invalid of [0, -1, NaN, Infinity, undefined]) {
    assert.deepEqual(coverCrop(invalid, 100, 50, 50), { sx: 0, sy: 0, sw: 0, sh: 0 });
    assert.deepEqual(coverCrop(100, 100, 50, invalid), { sx: 0, sy: 0, sw: 0, sh: 0 });
  }
});
