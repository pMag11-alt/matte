import { evaluate } from './anim';
import type { NodeData, Resolved } from './types';

/**
 * The node library. Each node is a fragment shader plus a typed parameter list.
 *
 * Conventions every shader follows:
 *  - images are linear-light RGBA with premultiplied alpha
 *  - colour parameters arrive as sRGB (what the colour picker shows) and are linearised in the shader
 *  - uv (0,0) is bottom-left; u_res is the project resolution in pixels
 *  - a node defines `vec4 run(vec2 uv)`; multi-pass nodes branch on u_pass and read u_prev
 */

export type Category = 'Source' | 'Color' | 'Matte' | 'Filter' | 'Transform' | 'Merge';

export type ParamDef =
  | { name: string; label: string; type: 'float'; default: number; min: number; max: number; step: number }
  | { name: string; label: string; type: 'color'; default: [number, number, number] }
  | { name: string; label: string; type: 'enum'; default: number; options: string[] }
  | { name: string; label: string; type: 'bool'; default: number }
  | { name: string; label: string; type: 'string'; default: string };

export interface NodeDef {
  type: string;
  label: string;
  category: Category;
  help: string;
  inputs: string[];
  params: ParamDef[];
  frag: string;
  /** Number of render passes (default 1). Pass n reads pass n-1 through u_prev. */
  passes?: number;
  /** Output changes with time even when no parameter does. */
  animated?: boolean;
  /** Node samples an external image through u_src: a user file, or text rasterised on a 2D canvas. */
  source?: 'file' | 'text';
}

const f = (name: string, label: string, def: number, min: number, max: number, step = 0.01): ParamDef => ({
  name,
  label,
  type: 'float',
  default: def,
  min,
  max,
  step,
});
const col = (name: string, label: string, def: [number, number, number]): ParamDef => ({
  name,
  label,
  type: 'color',
  default: def,
});
const en = (name: string, label: string, options: string[], def = 0): ParamDef => ({
  name,
  label,
  type: 'enum',
  default: def,
  options,
});
const bool = (name: string, label: string, def = false): ParamDef => ({
  name,
  label,
  type: 'bool',
  default: def ? 1 : 0,
});
const str = (name: string, label: string, def: string): ParamDef => ({ name, label, type: 'string', default: def });

/** Uniform names the renderer provides itself; parameters may not reuse them. */
export const RESERVED = [
  'res',
  'time',
  'frame',
  'pass',
  'in0',
  'in1',
  'in2',
  'prev',
  'src',
  'srcSize',
  'has0',
  'has1',
  'has2',
];

export const PRELUDE = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 o_color;
uniform vec2 u_res;
uniform float u_time;
uniform float u_frame;
uniform int u_pass;
uniform sampler2D u_in0;
uniform sampler2D u_in1;
uniform sampler2D u_in2;
uniform sampler2D u_prev;
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform float u_has0;
uniform float u_has1;
uniform float u_has2;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSRGB(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 unpm(vec4 c){ return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
vec2 rot(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(p.x * c - p.y * s, p.x * s + p.y * c); }
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for(int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec2 cbcr(vec3 c){ return vec2(dot(c, vec3(-0.168736, -0.331264, 0.5)), dot(c, vec3(0.5, -0.418688, -0.081312))); }
`;

/** Separable 25-tap Gaussian. Taps spread out as sigma grows; bilinear filtering hides the gaps. */
const blurFn = (name: string, sample: string) => `
vec4 ${name}(vec2 uv, vec2 dir, float sigma){
  float stp = max(1.0, sigma * 3.0 / 12.0);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for(int i = -12; i <= 12; i++){
    float x = float(i) * stp;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    vec2 q = uv + dir * x / u_res;
    acc += w * (${sample});
    ws += w;
  }
  return acc / ws;
}`;

const DEFS: NodeDef[] = [
  // ───────────────────────── Sources ─────────────────────────
  {
    type: 'plate',
    label: 'Greenscreen Plate',
    category: 'Source',
    help: 'Procedural test footage: an animated subject in front of an unevenly lit screen, with spill and sensor noise. Something to key without needing a file.',
    inputs: [],
    animated: true,
    params: [
      col('screen', 'Screen', [0.07, 0.62, 0.18]),
      f('uneven', 'Uneven light', 0.6, 0, 1),
      f('spill', 'Spill', 0.6, 0, 1),
      f('noise', 'Sensor noise', 0.4, 0, 1),
    ],
    frag: `
vec4 run(vec2 uv){
  float asp = u_res.x / u_res.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float t = u_time;
  vec3 screen = toLin(u_screen);
  float light = 1.0 - 0.7 * dot(p, p) + 0.25 * (fbm(p * 2.5 + 3.0) - 0.5) + 0.15 * p.y;
  vec3 bg = screen * mix(1.0, light, u_uneven);

  vec2 q = p - vec2(0.04 * sin(t * 0.9), 0.015 * sin(t * 1.7) - 0.04);
  vec2 hq = rot(q - vec2(0.0, 0.02), 0.07 * sin(t * 0.7));
  float head = sdBox(hq - vec2(0.0, 0.16), vec2(0.17, 0.14), 0.06);
  float ears = sdBox(vec2(abs(hq.x) - 0.185, hq.y - 0.16), vec2(0.022, 0.05), 0.012);
  float ant = sdBox(hq - vec2(0.0, 0.34), vec2(0.007, 0.05), 0.003);
  float tip = length(hq - vec2(0.0, 0.40)) - 0.022;
  float neck = sdBox(q - vec2(0.0, -0.02), vec2(0.05, 0.06), 0.01);
  float body = sdBox(q - vec2(0.0, -0.36), vec2(0.29, 0.26), 0.11);
  float d = min(min(min(head, ears), min(ant, tip)), min(neck, body));
  float px = 1.5 / u_res.y;
  float a = smoothstep(px, -px, d);

  float sh = clamp(0.62 + 0.9 * (q.x * 0.5 + q.y * 0.35), 0.25, 1.0);
  vec3 metal = toLin(vec3(0.80, 0.78, 0.74)) * sh;
  vec3 c = metal * 0.7;
  c = mix(c, toLin(vec3(0.86, 0.36, 0.12)) * sh, smoothstep(px, -px, body));
  float panel = sdBox(q - vec2(0.0, -0.30), vec2(0.11, 0.05), 0.02);
  c = mix(c, vec3(0.02, 0.025, 0.03), smoothstep(px, -px, panel));
  float led = length(vec2(mod(q.x + 0.1, 0.04) - 0.02, q.y + 0.30)) - 0.008;
  float ledOn = step(0.5, fract(floor((q.x + 0.1) / 0.04) * 0.37 + floor(t * 3.0) * 0.21));
  c = mix(c, vec3(1.8, 1.2, 0.2) * ledOn, smoothstep(px, -px, led) * step(panel, 0.0) * step(abs(q.x), 0.09));
  c = mix(c, metal, smoothstep(px, -px, min(head, ears)));
  c = mix(c, metal * 0.6, smoothstep(px, -px, ant));
  c = mix(c, vec3(2.2, 0.25, 0.12) * (0.6 + 0.4 * sin(t * 4.0)), smoothstep(px, -px, tip));
  float visor = sdBox(hq - vec2(0.0, 0.17), vec2(0.125, 0.06), 0.05);
  c = mix(c, vec3(0.012, 0.016, 0.03), smoothstep(px, -px, visor));
  float blink = step(0.06, fract(t * 0.31));
  vec2 e = vec2(abs(hq.x) - 0.055, (hq.y - 0.17) / max(blink, 0.12));
  c = mix(c, vec3(0.25, 1.5, 2.0), smoothstep(px, -px, length(e) - 0.024));

  float rim = smoothstep(-0.05, 0.0, d);
  c += screen * (0.45 * rim + 0.03) * u_spill;

  vec3 o = mix(bg, c, a);
  o += (hash21(uv * u_res + fract(t) * 91.7) - 0.5) * 0.03 * u_noise;
  return vec4(max(o, vec3(0.0)), 1.0);
}`,
  },
  {
    type: 'backdrop',
    label: 'Backdrop',
    category: 'Source',
    help: 'Procedural background plates to composite over.',
    inputs: [],
    animated: true,
    params: [en('style', 'Style', ['Sunset city', 'Nebula', 'Studio']), f('speed', 'Speed', 1, 0, 4)],
    frag: `
vec4 run(vec2 uv){
  float asp = u_res.x / u_res.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float t = u_time * u_speed;
  vec3 c;
  if(u_style < 0.5){
    c = mix(toLin(vec3(0.98, 0.52, 0.22)), toLin(vec3(0.13, 0.07, 0.30)), smoothstep(-0.28, 0.5, p.y));
    float sun = length(p - vec2(0.32, -0.08));
    c += toLin(vec3(1.0, 0.78, 0.45)) * (smoothstep(0.125, 0.12, sun) * 1.6 + 0.3 * exp(-sun * 5.0));
    c += 0.05 * fbm(vec2(p.x * 1.5 + t * 0.02, p.y * 6.0)) * smoothstep(0.0, 0.4, p.y);
    for(int i = 0; i < 2; i++){
      float fi = float(i);
      float sc = mix(11.0, 6.0, fi);
      float x = p.x * sc + t * 0.06 * (fi + 1.0) + fi * 7.3;
      float id = floor(x);
      float top = -0.36 + 0.26 * hash21(vec2(id, fi + 3.0)) - 0.10 * fi;
      float m = step(p.y, top) * step(0.06, fract(x));
      vec2 w = vec2(fract(x) * 5.0, p.y * 46.0);
      float lit = step(0.62, hash21(floor(w) + id * 13.0)) * step(0.3, fract(w.x)) * step(0.35, fract(w.y));
      vec3 b = mix(toLin(vec3(0.20, 0.10, 0.22)), vec3(0.008, 0.006, 0.014), fi);
      c = mix(c, b + toLin(vec3(1.0, 0.72, 0.35)) * lit * (0.25 + 0.75 * fi), m);
    }
  } else if(u_style < 1.5){
    vec2 q = p * 1.6 + vec2(t * 0.02, 0.0);
    float n = fbm(q + fbm(q * 1.7 + t * 0.03));
    c = vec3(0.004, 0.005, 0.014);
    c += toLin(vec3(0.55, 0.12, 0.60)) * smoothstep(0.35, 0.85, n) * 1.2;
    c += toLin(vec3(0.10, 0.45, 0.80)) * smoothstep(0.45, 0.95, fbm(q * 1.3 + 9.0)) * 0.9;
    vec2 g = uv * u_res / 3.0;
    float star = step(0.9965, hash21(floor(g)));
    c += vec3(star) * (0.5 + 0.5 * sin(t * 3.0 + hash21(floor(g) + 1.0) * 40.0)) * 1.5;
  } else {
    c = mix(vec3(0.16), vec3(0.008), smoothstep(0.0, 1.0, length(p * vec2(0.9, 1.2)) * 1.25));
    c += 0.02 * smoothstep(0.0, -0.5, p.y);
  }
  return vec4(c, 1.0);
}`,
  },
  {
    type: 'read',
    label: 'Read',
    category: 'Source',
    help: 'An image or video file from disk. Decoded from sRGB to linear and premultiplied on the way in.',
    inputs: [],
    source: 'file',
    params: [en('fit', 'Fit', ['Contain', 'Cover', 'Stretch'])],
    frag: `
vec4 run(vec2 uv){
  vec2 s = u_srcSize;
  if(s.x < 1.0) return vec4(0.0);
  float ra = u_res.x / u_res.y, sa = s.x / s.y;
  vec2 q = uv - 0.5;
  if(u_fit < 0.5){ if(sa > ra) q.y *= sa / ra; else q.x *= ra / sa; }
  else if(u_fit < 1.5){ if(sa > ra) q.x *= ra / sa; else q.y *= sa / ra; }
  q += 0.5;
  if(q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return vec4(0.0);
  vec4 t = texture(u_src, q);
  return vec4(toLin(t.rgb) * t.a, t.a);
}`,
  },
  {
    type: 'text',
    label: 'Text',
    category: 'Source',
    help: 'A line of type for titles and lower thirds.',
    inputs: [],
    source: 'text',
    params: [
      str('text', 'Text', 'TITLE'),
      f('size', 'Size', 0.14, 0.02, 0.6, 0.005),
      f('x', 'X', 0.5, 0, 1, 0.005),
      f('y', 'Y', 0.5, 0, 1, 0.005),
      col('color', 'Colour', [1, 1, 1]),
      en('weight', 'Weight', ['Regular', 'Bold', 'Black'], 2),
      f('tracking', 'Tracking', 0.02, -0.05, 0.6, 0.005),
      f('opacity', 'Opacity', 1, 0, 1),
    ],
    frag: `
vec4 run(vec2 uv){
  vec4 t = texture(u_src, uv);
  return vec4(toLin(t.rgb) * t.a, t.a) * u_opacity;
}`,
  },
  {
    type: 'constant',
    label: 'Constant',
    category: 'Source',
    help: 'A flat colour.',
    inputs: [],
    params: [col('color', 'Colour', [0.5, 0.5, 0.5]), f('alpha', 'Alpha', 1, 0, 1)],
    frag: `vec4 run(vec2 uv){ return vec4(toLin(u_color) * u_alpha, u_alpha); }`,
  },
  {
    type: 'ramp',
    label: 'Ramp',
    category: 'Source',
    help: 'A linear gradient between two colours.',
    inputs: [],
    params: [
      col('a', 'From', [0.05, 0.03, 0.2]),
      col('b', 'To', [0.95, 0.45, 0.15]),
      f('angle', 'Angle', 90, 0, 360, 1),
      f('spread', 'Spread', 1, 0.05, 2),
    ],
    frag: `
vec4 run(vec2 uv){
  float an = radians(u_angle);
  float g = dot(uv - 0.5, vec2(cos(an), sin(an))) / u_spread + 0.5;
  return vec4(mix(toLin(u_a), toLin(u_b), smoothstep(0.0, 1.0, g)), 1.0);
}`,
  },
  {
    type: 'checker',
    label: 'Checkerboard',
    category: 'Source',
    help: 'A checkerboard, handy for checking transforms and distortion.',
    inputs: [],
    params: [
      f('size', 'Square size', 64, 4, 256, 1),
      col('a', 'Colour A', [0.1, 0.1, 0.1]),
      col('b', 'Colour B', [0.5, 0.5, 0.5]),
    ],
    frag: `
vec4 run(vec2 uv){
  vec2 g = floor((uv - 0.5) * u_res / u_size);
  return vec4(toLin(mod(g.x + g.y, 2.0) < 0.5 ? u_a : u_b), 1.0);
}`,
  },
  {
    type: 'noise',
    label: 'Noise',
    category: 'Source',
    help: 'Animated fractal noise. Useful as a texture or as a matte.',
    inputs: [],
    animated: true,
    params: [
      f('scale', 'Scale', 4, 0.5, 40, 0.1),
      f('speed', 'Speed', 0.3, 0, 4),
      f('contrast', 'Contrast', 1.5, 0.2, 6),
    ],
    frag: `
vec4 run(vec2 uv){
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * u_scale;
  float n = fbm(p + vec2(0.0, u_time * u_speed) + fbm(p * 0.7 - u_time * u_speed * 0.5));
  n = clamp((n - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  return vec4(vec3(n * n), 1.0);
}`,
  },
  {
    type: 'shape',
    label: 'Shape',
    category: 'Source',
    help: 'A soft ellipse or rectangle. Feed it to a Mask node as a garbage matte, or to a Merge mask input.',
    inputs: [],
    params: [
      en('kind', 'Shape', ['Ellipse', 'Rectangle']),
      f('cx', 'Centre X', 0.5, 0, 1, 0.005),
      f('cy', 'Centre Y', 0.5, 0, 1, 0.005),
      f('w', 'Width', 0.3, 0.005, 1.5, 0.005),
      f('h', 'Height', 0.3, 0.005, 1.5, 0.005),
      f('rotate', 'Rotate', 0, -180, 180, 1),
      f('feather', 'Feather', 0.02, 0, 0.5, 0.005),
      col('color', 'Colour', [1, 1, 1]),
      bool('invert', 'Invert'),
    ],
    frag: `
vec4 run(vec2 uv){
  vec2 p = uv - vec2(u_cx, u_cy);
  p.x *= u_res.x / u_res.y;
  p = rot(p, -radians(u_rotate));
  float d = u_kind < 0.5 ? (length(p / vec2(u_w, u_h)) - 1.0) * min(u_w, u_h) : sdBox(p, vec2(u_w, u_h), 0.0);
  float fe = max(u_feather, 1.0 / u_res.y);
  float m = 1.0 - smoothstep(-fe, fe, d);
  if(u_invert > 0.5) m = 1.0 - m;
  return vec4(toLin(u_color) * m, m);
}`,
  },

  // ───────────────────────── Colour ─────────────────────────
  {
    type: 'grade',
    label: 'Grade',
    category: 'Color',
    help: 'Exposure, white balance, lift/gain, contrast, gamma and saturation. Works on unpremultiplied colour so edges stay clean.',
    inputs: ['in'],
    params: [
      f('exposure', 'Exposure', 0, -4, 4),
      f('temp', 'Temperature', 0, -1, 1),
      f('tint', 'Tint', 0, -1, 1),
      f('lift', 'Lift', 0, -0.25, 0.25, 0.005),
      col('gain', 'Multiply', [1, 1, 1]),
      f('contrast', 'Contrast', 1, 0.3, 2.5),
      f('gamma', 'Gamma', 1, 0.3, 3),
      f('saturation', 'Saturation', 1, 0, 2.5),
      f('mix', 'Mix', 1, 0, 1),
    ],
    frag: `
vec4 run(vec2 uv){
  vec4 c = texture(u_in0, uv);
  vec3 src = unpm(c);
  vec3 x = src * exp2(u_exposure);
  x *= vec3(1.0 + 0.3 * u_temp, 1.0 - 0.25 * u_tint, 1.0 - 0.3 * u_temp);
  x = x * (u_gain - u_lift) + u_lift;
  x = pow(max(x, 0.0) / 0.18, vec3(u_contrast)) * 0.18;
  x = pow(max(x, 0.0), vec3(1.0 / u_gamma));
  x = max(mix(vec3(luma(x)), x, u_saturation), 0.0);
  return vec4(mix(src, x, u_mix) * c.a, c.a);
}`,
  },
  {
    type: 'tonemap',
    label: 'Tone Map',
    category: 'Color',
    help: 'Filmic (ACES-fitted) curve that rolls scene-linear highlights off into display range instead of clipping them.',
    inputs: ['in'],
    params: [f('exposure', 'Exposure', 0, -4, 4), f('mix', 'Mix', 1, 0, 1)],
    frag: `
vec4 run(vec2 uv){
  vec4 c = texture(u_in0, uv);
  vec3 src = unpm(c);
  vec3 x = src * exp2(u_exposure);
  vec3 y = clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  return vec4(mix(src, y, u_mix) * c.a, c.a);
}`,
  },
  {
    type: 'invert',
    label: 'Invert',
    category: 'Color',
    help: 'Inverts colour, alpha, or both.',
    inputs: ['in'],
    params: [en('channels', 'Channels', ['RGB', 'Alpha', 'RGBA'])],
    frag: `
vec4 run(vec2 uv){
  vec4 c = texture(u_in0, uv);
  vec3 x = unpm(c);
  float a = c.a;
  // Invert in display space so mid grey stays mid grey.
  if(u_channels < 0.5 || u_channels > 1.5) x = toLin(clamp(1.0 - toSRGB(x), 0.0, 1.0));
  if(u_channels > 0.5) a = 1.0 - a;
  return vec4(x * a, a);
}`,
  },

  // ───────────────────────── Matte ─────────────────────────
  {
    type: 'keyer',
    label: 'Chroma Keyer',
    category: 'Matte',
    help: 'Pulls a matte from distance to the screen colour in the CbCr chroma plane, then suppresses spill. Pick the screen colour from the viewer.',
    inputs: ['plate'],
    params: [
      col('key', 'Screen colour', [0.07, 0.62, 0.18]),
      f('tolerance', 'Tolerance', 0.14, 0, 0.6, 0.005),
      f('softness', 'Softness', 0.1, 0, 0.5, 0.005),
      f('clipBlack', 'Clip black', 0, 0, 1),
      f('clipWhite', 'Clip white', 1, 0, 1),
      f('despill', 'Despill', 1, 0, 1),
      en('output', 'Output', ['Premultiplied', 'Matte', 'Despilled plate']),
    ],
    frag: `
vec4 run(vec2 uv){
  vec4 s = texture(u_in0, uv);
  vec3 lin = unpm(s);
  float d = distance(cbcr(toSRGB(lin)), cbcr(u_key));
  float a = smoothstep(u_tolerance, u_tolerance + u_softness + 1e-4, d);
  a = clamp((a - u_clipBlack) / max(u_clipWhite - u_clipBlack, 1e-4), 0.0, 1.0) * s.a;
  vec3 c = lin;
  if(u_key.g >= u_key.b) c.g = mix(c.g, min(c.g, (c.r + c.b) * 0.5), u_despill);
  else c.b = mix(c.b, min(c.b, (c.r + c.g) * 0.5), u_despill);
  if(u_output > 1.5) return vec4(c * s.a, s.a);
  if(u_output > 0.5) return vec4(vec3(a), 1.0);
  return vec4(c * a, a);
}`,
  },
  {
    type: 'matte',
    label: 'Matte Tools',
    category: 'Matte',
    help: 'Refine an alpha channel: choke or expand the edge, then clip the blacks and whites.',
    inputs: ['in'],
    params: [
      f('choke', 'Choke / expand', 0, -12, 12, 0.1),
      f('black', 'Clip black', 0, 0, 1),
      f('white', 'Clip white', 1, 0, 1),
    ],
    frag: `
vec4 run(vec2 uv){
  vec4 c = texture(u_in0, uv);
  float a = c.a;
  float r = abs(u_choke);
  if(r > 0.01){
    for(int i = 0; i < 16; i++){
      float an = 6.2831853 * float(i) / 8.0;
      float rr = i < 8 ? r : r * 0.5;
      float s = texture(u_in0, uv + vec2(cos(an), sin(an)) * rr / u_res).a;
      a = u_choke < 0.0 ? min(a, s) : max(a, s);
    }
  }
  a = clamp((a - u_black) / max(u_white - u_black, 1e-4), 0.0, 1.0);
  return vec4(unpm(c) * a, a);
}`,
  },
  {
    type: 'mask',
    label: 'Mask',
    category: 'Matte',
    help: 'Multiplies the image by a matte taken from the second input.',
    inputs: ['in', 'mask'],
    params: [en('channel', 'Mask from', ['Alpha', 'Luma']), bool('invert', 'Invert')],
    frag: `
vec4 run(vec2 uv){
  vec4 c = texture(u_in0, uv);
  vec4 k = texture(u_in1, uv);
  float m = u_has1 > 0.5 ? (u_channel < 0.5 ? k.a : clamp(luma(k.rgb), 0.0, 1.0)) : 1.0;
  if(u_invert > 0.5) m = 1.0 - m;
  return c * m;
}`,
  },
  {
    type: 'premult',
    label: 'Premult',
    category: 'Matte',
    help: 'Multiply or divide colour by alpha.',
    inputs: ['in'],
    params: [en('op', 'Operation', ['Premultiply', 'Unpremultiply'])],
    frag: `
vec4 run(vec2 uv){
  vec4 c = texture(u_in0, uv);
  return u_op < 0.5 ? vec4(c.rgb * c.a, c.a) : vec4(unpm(c), c.a);
}`,
  },

  // ───────────────────────── Filters ─────────────────────────
  {
    type: 'blur',
    label: 'Blur',
    category: 'Filter',
    help: 'Gaussian blur. Separable, two iterations, four passes.',
    inputs: ['in'],
    passes: 4,
    params: [f('radius', 'Radius', 8, 0, 120, 0.5)],
    frag: `
vec4 smp(vec2 q){ return u_pass == 0 ? texture(u_in0, q) : texture(u_prev, q); }
${blurFn('gauss', 'smp(q)')}
vec4 run(vec2 uv){
  vec2 dir = (u_pass % 2 == 0) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  return gauss(uv, dir, max(u_radius * 0.35, 0.01));
}`,
  },
  {
    type: 'glow',
    label: 'Glow',
    category: 'Filter',
    help: 'Blurs everything brighter than the threshold and adds it back. Needs values above 1.0 to look right, which is why the pipeline is float.',
    inputs: ['in'],
    passes: 5,
    params: [
      f('threshold', 'Threshold', 0.8, 0, 4),
      f('radius', 'Radius', 30, 1, 120, 0.5),
      f('intensity', 'Intensity', 0.8, 0, 4),
      col('tint', 'Tint', [1, 1, 1]),
    ],
    frag: `
vec4 smp(vec2 q){
  if(u_pass == 0){ vec4 c = texture(u_in0, q); return c * smoothstep(u_threshold, u_threshold + 0.4, luma(c.rgb)); }
  return texture(u_prev, q);
}
${blurFn('gauss', 'smp(q)')}
vec4 run(vec2 uv){
  if(u_pass == 4){
    vec4 c = texture(u_in0, uv);
    vec4 g = texture(u_prev, uv) * u_intensity;
    return vec4(c.rgb + g.rgb * u_tint, clamp(c.a + g.a, 0.0, 1.0));
  }
  vec2 dir = (u_pass % 2 == 0) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  return gauss(uv, dir, max(u_radius * 0.35, 0.01));
}`,
  },
  {
    type: 'lightwrap',
    label: 'Light Wrap',
    category: 'Filter',
    help: 'Bleeds blurred background light over the edges of the foreground so a keyed subject sits in the scene instead of on top of it.',
    inputs: ['fg', 'bg'],
    passes: 3,
    params: [f('radius', 'Radius', 24, 1, 120, 0.5), f('intensity', 'Intensity', 0.8, 0, 3)],
    frag: `
vec4 smp(vec2 q){ return u_pass == 0 ? vec4(texture(u_in1, q).rgb, texture(u_in0, q).a) : texture(u_prev, q); }
${blurFn('gauss', 'smp(q)')}
vec4 run(vec2 uv){
  if(u_pass == 2){
    vec4 fg = texture(u_in0, uv);
    vec4 w = texture(u_prev, uv);
    float edge = fg.a * clamp((1.0 - w.a) * 2.0, 0.0, 1.0);
    return vec4(fg.rgb + w.rgb * edge * u_intensity, fg.a);
  }
  return gauss(uv, u_pass == 0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0), max(u_radius * 0.5, 0.01));
}`,
  },
  {
    type: 'sharpen',
    label: 'Sharpen',
    category: 'Filter',
    help: 'Unsharp mask.',
    inputs: ['in'],
    params: [f('amount', 'Amount', 0.6, 0, 3), f('size', 'Size', 1, 0.5, 6, 0.1)],
    frag: `
vec4 run(vec2 uv){
  vec2 px = u_size / u_res;
  vec4 c = texture(u_in0, uv);
  vec4 avg = 0.25 * (texture(u_in0, uv + vec2(px.x, 0.0)) + texture(u_in0, uv - vec2(px.x, 0.0)) + texture(u_in0, uv + vec2(0.0, px.y)) + texture(u_in0, uv - vec2(0.0, px.y)));
  return vec4(max(c.rgb + (c.rgb - avg.rgb) * u_amount, 0.0), c.a);
}`,
  },
  {
    type: 'edge',
    label: 'Edge Detect',
    category: 'Filter',
    help: 'Sobel edges of the luma channel.',
    inputs: ['in'],
    params: [f('strength', 'Strength', 2, 0, 10, 0.1), col('color', 'Colour', [1, 1, 1])],
    frag: `
float L(vec2 uv, vec2 o){ return luma(texture(u_in0, uv + o / u_res).rgb); }
vec4 run(vec2 uv){
  float gx = L(uv, vec2(1.0, 1.0)) + 2.0 * L(uv, vec2(1.0, 0.0)) + L(uv, vec2(1.0, -1.0)) - L(uv, vec2(-1.0, 1.0)) - 2.0 * L(uv, vec2(-1.0, 0.0)) - L(uv, vec2(-1.0, -1.0));
  float gy = L(uv, vec2(1.0, 1.0)) + 2.0 * L(uv, vec2(0.0, 1.0)) + L(uv, vec2(-1.0, 1.0)) - L(uv, vec2(1.0, -1.0)) - 2.0 * L(uv, vec2(0.0, -1.0)) - L(uv, vec2(-1.0, -1.0));
  float g = clamp(length(vec2(gx, gy)) * u_strength, 0.0, 1.0);
  return vec4(toLin(u_color) * g, g);
}`,
  },
  {
    type: 'chroma',
    label: 'Chromatic Aberration',
    category: 'Filter',
    help: 'Splits red and blue radially, the way a cheap lens does towards the edge of frame.',
    inputs: ['in'],
    params: [f('amount', 'Amount', 0.006, 0, 0.05, 0.0005)],
    frag: `
vec4 run(vec2 uv){
  vec2 d = (uv - 0.5) * u_amount * 2.0 * length(uv - 0.5) * 2.0;
  vec4 r = texture(u_in0, uv + d), g = texture(u_in0, uv), b = texture(u_in0, uv - d);
  return vec4(r.r, g.g, b.b, (r.a + g.a + b.a) / 3.0);
}`,
  },
  {
    type: 'distort',
    label: 'Lens Distortion',
    category: 'Filter',
    help: 'Radial barrel (positive) or pincushion (negative) distortion.',
    inputs: ['in'],
    params: [f('k', 'Distortion', 0.15, -0.6, 0.6, 0.005), f('zoom', 'Zoom', 1, 0.5, 2)],
    frag: `
vec4 run(vec2 uv){
  float asp = u_res.x / u_res.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0) / u_zoom;
  p *= 1.0 + u_k * dot(p, p);
  vec2 q = p / vec2(asp, 1.0) + 0.5;
  if(q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return vec4(0.0);
  return texture(u_in0, q);
}`,
  },
  {
    type: 'vignette',
    label: 'Vignette',
    category: 'Filter',
    help: 'Darkens the corners.',
    inputs: ['in'],
    params: [f('amount', 'Amount', 0.6, 0, 1), f('size', 'Size', 0.75, 0.1, 1.5), f('softness', 'Softness', 0.5, 0.01, 1)],
    frag: `
vec4 run(vec2 uv){
  vec4 c = texture(u_in0, uv);
  float r = length((uv - 0.5) * vec2(u_res.x / u_res.y, 1.0));
  float v = 1.0 - smoothstep(u_size - u_softness * 0.5, u_size + u_softness * 0.5, r) * u_amount;
  return vec4(c.rgb * v, c.a);
}`,
  },
  {
    type: 'grain',
    label: 'Film Grain',
    category: 'Filter',
    help: 'Per-frame luminance noise. A little grain over the whole comp ties CG and plate together.',
    inputs: ['in'],
    animated: true,
    params: [f('amount', 'Amount', 0.25, 0, 1), f('size', 'Size', 1.5, 1, 6, 0.1)],
    frag: `
vec4 run(vec2 uv){
  vec4 c = texture(u_in0, uv);
  vec2 g = floor(uv * u_res / u_size);
  float n = hash21(g + mod(u_frame, 97.0) * vec2(13.1, 7.7)) + hash21(g * 1.7 + mod(u_frame, 89.0) * vec2(3.3, 17.9)) - 1.0;
  float l = luma(c.rgb);
  return vec4(max(c.rgb + n * u_amount * 0.22 * sqrt(max(l, 0.0) + 0.02) * c.a, 0.0), c.a);
}`,
  },
  {
    type: 'glitch',
    label: 'Glitch',
    category: 'Filter',
    help: 'Digital breakup: displaced scan blocks, channel split and scanlines. Keyframe the amount to hit a cut.',
    inputs: ['in'],
    animated: true,
    params: [
      f('amount', 'Amount', 0.5, 0, 1),
      f('blocks', 'Blocks', 18, 2, 80, 1),
      f('speed', 'Speed', 1, 0, 4),
      f('scan', 'Scanlines', 0.3, 0, 1),
    ],
    frag: `
vec4 run(vec2 uv){
  float t = floor(u_time * u_speed * 12.0);
  float row = floor(uv.y * u_blocks);
  float n = hash21(vec2(row, t));
  float sh = n > 1.0 - u_amount * 0.6 ? (hash21(vec2(t, row)) - 0.5) * 0.25 * u_amount : 0.0;
  vec2 q = vec2(uv.x + sh, uv.y);
  float ca = u_amount * 0.014 * (0.4 + hash21(vec2(t, 1.0)));
  vec4 c = texture(u_in0, q);
  c.r = texture(u_in0, q + vec2(ca, 0.0)).r;
  c.b = texture(u_in0, q - vec2(ca, 0.0)).b;
  c.rgb *= 1.0 - u_scan * 0.5 * (0.5 + 0.5 * sin(uv.y * u_res.y * 3.14159));
  return c;
}`,
  },

  // ───────────────────────── Transform ─────────────────────────
  {
    type: 'transform',
    label: 'Transform',
    category: 'Transform',
    help: 'Move, rotate and scale about the centre of frame. Translation is in fractions of the frame.',
    inputs: ['in'],
    params: [
      f('tx', 'Translate X', 0, -1.5, 1.5, 0.005),
      f('ty', 'Translate Y', 0, -1.5, 1.5, 0.005),
      f('rotate', 'Rotate', 0, -180, 180, 0.5),
      f('scale', 'Scale', 1, 0.05, 4),
    ],
    frag: `
vec4 run(vec2 uv){
  float asp = u_res.x / u_res.y;
  vec2 q = uv - 0.5 - vec2(u_tx, u_ty);
  q.x *= asp;
  q = rot(q, -radians(u_rotate)) / u_scale;
  q.x /= asp;
  q += 0.5;
  if(q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return vec4(0.0);
  return texture(u_in0, q);
}`,
  },

  // ───────────────────────── Merge ─────────────────────────
  {
    type: 'merge',
    label: 'Merge',
    category: 'Merge',
    help: 'Layers A over B with a Porter-Duff or blend operation. The optional mask limits where the merge applies.',
    inputs: ['B', 'A', 'mask'],
    params: [
      en('op', 'Operation', ['Over', 'Under', 'Plus', 'Screen', 'Multiply', 'Difference', 'Stencil', 'In']),
      f('mix', 'Mix', 1, 0, 1),
    ],
    frag: `
vec4 run(vec2 uv){
  vec4 B = texture(u_in0, uv);
  vec4 A = texture(u_in1, uv);
  vec4 r;
  if(u_op < 0.5) r = A + B * (1.0 - A.a);
  else if(u_op < 1.5) r = B + A * (1.0 - B.a);
  else if(u_op < 2.5) r = A + B;
  else if(u_op < 3.5) r = A + B - A * B;
  else if(u_op < 4.5) r = vec4(A.rgb * B.rgb + A.rgb * (1.0 - B.a) + B.rgb * (1.0 - A.a), A.a + B.a - A.a * B.a);
  else if(u_op < 5.5) r = vec4(abs(A.rgb - B.rgb), max(A.a, B.a));
  else if(u_op < 6.5) r = B * (1.0 - A.a);
  else r = B * A.a;
  float m = u_mix;
  if(u_has2 > 0.5) m *= texture(u_in2, uv).a;
  return mix(B, r, m);
}`,
  },
  {
    type: 'transition',
    label: 'Transition',
    category: 'Merge',
    help: 'An editorial transition from A to B. Keyframe Progress from 0 to 1 across the cut.',
    inputs: ['A', 'B'],
    params: [
      en('kind', 'Type', ['Dissolve', 'Wipe', 'Iris', 'Dip to black']),
      f('progress', 'Progress', 0.5, 0, 1),
      f('softness', 'Softness', 0.1, 0, 1),
      f('angle', 'Wipe angle', 0, 0, 360, 1),
    ],
    frag: `
vec4 run(vec2 uv){
  vec4 A = texture(u_in0, uv);
  vec4 B = texture(u_in1, uv);
  float p = u_progress;
  if(u_kind < 0.5) return mix(A, B, p);
  if(u_kind > 2.5) return p < 0.5 ? vec4(A.rgb * (1.0 - 2.0 * p), A.a) : vec4(B.rgb * (2.0 * p - 1.0), B.a);
  float g;
  if(u_kind < 1.5){
    float an = radians(u_angle);
    vec2 d = vec2(cos(an), sin(an));
    g = dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
  } else {
    vec2 asp = vec2(u_res.x / u_res.y, 1.0);
    g = length((uv - 0.5) * asp) / (0.5 * length(asp));
  }
  float s = u_softness;
  float m = 1.0 - smoothstep(p * (1.0 + s) - s, p * (1.0 + s) + 1e-4, g);
  return mix(A, B, m);
}`,
  },
];

export const NODE_DEFS: Record<string, NodeDef> = Object.fromEntries(DEFS.map((d) => [d.type, d]));
export const NODE_LIST: readonly NodeDef[] = DEFS;

const GLSL_TYPE: Record<ParamDef['type'], string | null> = {
  float: 'float',
  enum: 'float',
  bool: 'float',
  color: 'vec3',
  string: null,
};

/** Assemble the full fragment shader for a node: shared prelude, one uniform per parameter, the node body. */
export function buildFragment(def: NodeDef): string {
  const uniforms = def.params
    .map((p) => (GLSL_TYPE[p.type] ? `uniform ${GLSL_TYPE[p.type]} u_${p.name};\n` : ''))
    .join('');
  return `${PRELUDE}${uniforms}${def.frag}\nvoid main(){ o_color = run(v_uv); }\n`;
}

/** Evaluate every parameter of a node at a frame, falling back to defaults for anything unset. */
export function resolveParams(node: NodeData, def: NodeDef, frame: number): Record<string, Resolved> {
  const out: Record<string, Resolved> = {};
  for (const p of def.params) {
    const v = node.params[p.name];
    out[p.name] = v === undefined ? p.default : evaluate(v, frame);
  }
  return out;
}
