/**
 * CPU reference for the colour maths the shaders use. The GLSL in nodes.ts mirrors these
 * functions line for line; having them here makes the maths unit-testable and feeds the scopes.
 */

export type RGB = [number, number, number];

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  const x = Math.max(c, 0);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Rec. 709 luma weights. */
export function luma(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Chroma plane (Cb, Cr) of full-range BT.601 YCbCr, each in -0.5..0.5. */
export function cbcr(c: RGB): [number, number] {
  return [
    -0.168736 * c[0] - 0.331264 * c[1] + 0.5 * c[2],
    0.5 * c[0] - 0.418688 * c[1] - 0.081312 * c[2],
  ];
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Chroma key: alpha from the distance between a pixel and the key colour in the CbCr plane.
 * Working in chroma only makes the key far less sensitive to uneven screen lighting than an RGB distance.
 */
export function keyAlpha(pixel: RGB, key: RGB, tolerance: number, softness: number): number {
  const p = cbcr(pixel);
  const k = cbcr(key);
  const d = Math.hypot(p[0] - k[0], p[1] - k[1]);
  return smoothstep(tolerance, tolerance + softness + 1e-4, d);
}

/** Spill suppression: clamp the screen's dominant channel to the average of the other two. */
export function despill(c: RGB, key: RGB, amount: number): RGB {
  const out: RGB = [c[0], c[1], c[2]];
  if (key[1] >= key[2]) {
    const limit = (c[0] + c[2]) * 0.5;
    out[1] = c[1] + (Math.min(c[1], limit) - c[1]) * amount;
  } else {
    const limit = (c[0] + c[1]) * 0.5;
    out[2] = c[2] + (Math.min(c[2], limit) - c[2]) * amount;
  }
  return out;
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: number[]): string {
  const to = (x: number) =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}

/** 32-bit FNV-1a, used to fingerprint a node's inputs so unchanged nodes are not re-rendered. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
