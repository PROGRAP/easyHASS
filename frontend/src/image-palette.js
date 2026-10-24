/** Small, deterministic image analysis; no DOM, network or room-specific colors. */
export const FALLBACK_PALETTE = Object.freeze({ base: '82 78 73', shade: '49 46 43' });

const linear = Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
});
const luminance = rgb => .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
const byte = value => Math.max(0, Math.min(255, Math.round(value)));

function cssRgb(rgb) {
  return rgb.map(value => byte(255 * (value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055))).join(' ');
}

/**
 * Return opaque CSS RGB triplets from straight-alpha RGBA8 ImageData.
 * The caller supplies a small raster of the actual visible photo crop (e.g. 64×40).
 * Every pixel contributes its area × alpha to the arithmetic mean in linear RGB.
 * Black, white, saturated accents and subtle tones all count equally per visible
 * pixel. There is no clustering, color selection, highlight or saturation filter.
 * Scaling all linear RGB channels equally preserves hue. Base targets luminance ≤ .17
 * (white contrast > 4.5:1, including byte rounding); shade is darker. Transparent
 * CSS use or other layers can alter the final contrast and belong to the caller.
 * Invalid, empty or completely transparent data returns FALLBACK_PALETTE.
 */
export function averageImagePalette(rgba, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return FALLBACK_PALETTE;
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels * 4) || !rgba || rgba.length < pixels * 4) return FALLBACK_PALETTE;

  const sum = [0, 0, 0];
  let visibleArea = 0;
  for (let offset = 0; offset < pixels * 4; offset += 4) {
    const values = [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
    if (!values.every(Number.isFinite)) continue;
    const [r, g, b, alpha] = values.map(byte);
    if (!alpha) continue;
    const weight = alpha / 255;
    visibleArea += weight;
    sum[0] += linear[r] * weight;
    sum[1] += linear[g] * weight;
    sum[2] += linear[b] * weight;
  }
  if (!visibleArea) return FALLBACK_PALETTE;
  const rgb = sum.map(value => value / visibleArea);
  const brightness = luminance(rgb);
  const scale = brightness > .17 ? .17 / brightness : 1;
  const base = rgb.map(value => value * scale);
  return { base: cssRgb(base), shade: cssRgb(base.map(value => value * .45)) };
}

/** Centered source rectangle for Canvas drawImage's CSS object-fit: cover crop.
 * Invalid/zero dimensions return a zero rectangle; callers must skip drawImage.
 */
export function coverCrop(naturalW, naturalH, boxW, boxH) {
  if (![naturalW, naturalH, boxW, boxH].every(value => Number.isFinite(value) && value > 0)) return { sx: 0, sy: 0, sw: 0, sh: 0 };
  const scale = Math.max(boxW / naturalW, boxH / naturalH);
  const sw = Math.min(naturalW, boxW / scale), sh = Math.min(naturalH, boxH / scale);
  return { sx: (naturalW - sw) / 2, sy: (naturalH - sh) / 2, sw, sh };
}
