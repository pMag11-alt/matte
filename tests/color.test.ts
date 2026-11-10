import { describe, expect, it } from 'vitest';
import { cbcr, despill, fnv1a, hexToRgb, keyAlpha, linearToSrgb, luma, rgbToHex, srgbToLinear, type RGB } from '../src/core/color';
import { History } from '../src/core/history';
import { histogram, vectorscope, waveform } from '../src/core/scopes';

const GREEN: RGB = [0.07, 0.62, 0.18];

describe('transfer functions', () => {
  it('round-trips sRGB through linear', () => {
    for (let i = 0; i <= 255; i++) {
      const c = i / 255;
      expect(linearToSrgb(srgbToLinear(c))).toBeCloseTo(c, 6);
    }
  });

  it('matches known values', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1);
    // 18% grey sits near sRGB 0.46: the reason comps are done in linear and viewed through a curve.
    expect(linearToSrgb(0.18)).toBeCloseTo(0.4614, 3);
  });

  it('weights luma to sum to one', () => {
    expect(luma([1, 1, 1])).toBeCloseTo(1);
    expect(luma([0, 1, 0])).toBeGreaterThan(luma([1, 0, 0]));
  });
});

describe('chroma keyer', () => {
  it('puts neutral colours at the centre of the chroma plane', () => {
    for (const g of [0, 0.3, 1]) {
      const [cb, cr] = cbcr([g, g, g]);
      expect(cb).toBeCloseTo(0);
      expect(cr).toBeCloseTo(0);
    }
  });

  // Defaults of the Chroma Keyer node; the neutral-grey case is what pinned them down.
  it('keys out the screen and keeps the subject', () => {
    expect(keyAlpha(GREEN, GREEN, 0.14, 0.1)).toBe(0);
    expect(keyAlpha([0.86, 0.36, 0.12], GREEN, 0.14, 0.1)).toBe(1);
    expect(keyAlpha([0.8, 0.78, 0.74], GREEN, 0.14, 0.1)).toBe(1);
  });

  it('tolerates an unevenly lit screen', () => {
    const dim: RGB = [GREEN[0] * 0.75, GREEN[1] * 0.75, GREEN[2] * 0.75];
    expect(keyAlpha(dim, GREEN, 0.14, 0.1)).toBe(0);
  });

  it('gives partial alpha in the soft band', () => {
    const edge: RGB = [0.45, 0.6, 0.4];
    const a = keyAlpha(edge, GREEN, 0.05, 0.4);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });

  it('despills only the screen channel, and only when it dominates', () => {
    expect(despill([0.4, 0.9, 0.2], GREEN, 1)).toEqual([0.4, 0.3, 0.2].map((v, i) => (i === 1 ? expect.closeTo(v, 6) : v)));
    expect(despill([0.8, 0.3, 0.6], GREEN, 1)).toEqual([0.8, 0.3, 0.6]);
    expect(despill([0.2, 0.3, 0.9], [0.1, 0.2, 0.9], 1)[2]).toBeCloseTo(0.25);
    expect(despill([0.4, 0.9, 0.2], GREEN, 0)).toEqual([0.4, 0.9, 0.2]);
  });
});

describe('helpers', () => {
  it('converts hex colours both ways', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(rgbToHex([1, 128 / 255, 0])).toBe('#ff8000');
    expect(rgbToHex([2, -1, 0.5])).toBe('#ff0080');
    expect(hexToRgb('nonsense')).toEqual([0, 0, 0]);
  });

  it('hashes deterministically and separates nearby inputs', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('["blur",{"radius":8}]')).not.toBe(fnv1a('["blur",{"radius":9}]'));
  });
});

describe('history', () => {
  it('undoes and redoes', () => {
    const h = new History();
    h.push('a');
    h.push('b');
    h.push('c');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe('b');
    expect(h.canRedo).toBe(true);
  });

  it('drops the redo branch on a new edit and ignores no-op pushes', () => {
    const h = new History();
    h.push('a');
    h.push('b');
    h.push('b');
    h.undo();
    h.push('c');
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeNull();
  });

  it('caps its length', () => {
    const h = new History(3);
    for (const s of ['a', 'b', 'c', 'd', 'e']) h.push(s);
    expect(h.undo()).toBe('d');
    expect(h.undo()).toBe('c');
    expect(h.undo()).toBeNull();
  });
});

describe('scopes', () => {
  // 2x1 image: one pure red pixel, one mid grey pixel.
  const px = new Uint8Array([255, 0, 0, 255, 128, 128, 128, 255]);

  it('bins the histogram per channel', () => {
    const h = histogram(px);
    expect(h.r[255]).toBe(1);
    expect(h.r[128]).toBe(1);
    expect(h.g[0]).toBe(1);
    expect(h.b[128]).toBe(1);
    expect(h.l[128]).toBe(1);
  });

  it('plots waveform levels bottom-up', () => {
    const out = waveform(px, 2, 1, 2, 256, false);
    const lit = (x: number, y: number) => out[(y * 2 + x) * 4 + 1] > 0;
    expect(lit(1, 255 - 128)).toBe(true);
    expect(lit(1, 0)).toBe(false);
    expect(lit(0, 255 - Math.round(0.2126 * 255))).toBe(true);
  });

  it('puts neutrals at the centre of the vectorscope and red up and to the left', () => {
    const size = 101;
    const out = vectorscope(px, size);
    const lit = (x: number, y: number) => out[(y * size + x) * 4] + out[(y * size + x) * 4 + 1] + out[(y * size + x) * 4 + 2] > 0;
    expect(lit(50, 50)).toBe(true);
    const [cb, cr] = cbcr([1, 0, 0]);
    expect(lit(Math.round((0.5 + cb) * 100), Math.round((0.5 - cr) * 100))).toBe(true);
    expect(cb).toBeLessThan(0);
    expect(cr).toBeGreaterThan(0);
  });
});
