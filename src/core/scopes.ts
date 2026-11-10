/** Video scopes computed from an RGBA8 readback of the viewer (display-referred, 0..255). */

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  peak: number;
}

export function histogram(px: Uint8Array): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    r[px[i]]++;
    g[px[i + 1]]++;
    b[px[i + 2]]++;
    l[Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])]++;
  }
  let peak = 1;
  // Ignore the end bins so one clipped region does not flatten the rest of the graph.
  for (let i = 1; i < 255; i++) peak = Math.max(peak, r[i], g[i], b[i]);
  return { r, g, b, l, peak };
}

const glow = (count: number) => 255 * (1 - Math.exp(-count / 5));

/**
 * Waveform monitor: x is image column, y is level. `parade` splits R, G and B side by side.
 * Returns an RGBA image of outW x outH.
 */
export function waveform(
  px: Uint8Array,
  w: number,
  h: number,
  outW: number,
  outH: number,
  parade: boolean,
): Uint8ClampedArray {
  const counts = new Float32Array(outW * outH * 3);
  const panel = Math.floor(outW / 3);
  const row = (v: number) => outH - 1 - Math.round((v / 255) * (outH - 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (parade) {
        const cx = Math.min(panel - 1, Math.floor((x / w) * panel));
        for (let c = 0; c < 3; c++) counts[(row(px[i + c]) * outW + cx + c * panel) * 3 + c]++;
      } else {
        const cx = Math.min(outW - 1, Math.floor((x / w) * outW));
        const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        const o = (row(lum) * outW + cx) * 3;
        counts[o]++;
        counts[o + 1]++;
        counts[o + 2]++;
      }
    }
  }
  const out = new Uint8ClampedArray(outW * outH * 4);
  const scale = parade ? 3 : 1;
  for (let i = 0; i < outW * outH; i++) {
    const r = glow(counts[i * 3] * scale);
    const g = glow(counts[i * 3 + 1] * scale);
    const b = glow(counts[i * 3 + 2] * scale);
    if (parade) {
      out[i * 4] = r + 0.25 * (g + b);
      out[i * 4 + 1] = g + 0.25 * (r + b);
      out[i * 4 + 2] = b + 0.25 * (r + g);
    } else {
      out[i * 4] = 0.55 * r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = 0.65 * b;
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Vectorscope: plots every pixel's chroma (Cb right, Cr up). Returns a size x size RGBA image. */
export function vectorscope(px: Uint8Array, size: number): Uint8ClampedArray {
  const counts = new Float32Array(size * size);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255;
    const g = px[i + 1] / 255;
    const b = px[i + 2] / 255;
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
    const x = Math.min(size - 1, Math.max(0, Math.round((0.5 + cb) * (size - 1))));
    const y = Math.min(size - 1, Math.max(0, Math.round((0.5 - cr) * (size - 1))));
    counts[y * size + x]++;
  }
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const k = glow(counts[i]) / 255;
      const cb = x / (size - 1) - 0.5;
      const cr = 0.5 - y / (size - 1);
      // Tint each bin with the colour it represents, at a fixed mid luma.
      const Y = 0.6;
      out[i * 4] = 255 * k * (Y + 1.402 * cr);
      out[i * 4 + 1] = 255 * k * (Y - 0.344136 * cb - 0.714136 * cr);
      out[i * 4 + 2] = 255 * k * (Y + 1.772 * cb);
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}
