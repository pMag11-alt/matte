import type { Animated, Ease, Key, ParamValue, Resolved, Scalar } from './types';

export function isAnimated(v: ParamValue | undefined): v is Animated {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lerp(a: Scalar, b: Scalar, t: number): Scalar {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  const av = a as number[];
  const bv = b as number[];
  return av.map((x, i) => x + ((bv[i] ?? x) - x) * t);
}

function shape(t: number, ease: Ease): number {
  if (ease === 'hold') return 0;
  if (ease === 'smooth') return t * t * (3 - 2 * t);
  return t;
}

/** Value of a parameter at a frame. Constant before the first key and after the last. */
export function evaluate(v: ParamValue, frame: number): Resolved {
  if (!isAnimated(v)) return v;
  const keys = v.keys;
  if (keys.length === 0) return 0;
  if (frame <= keys[0].f) return keys[0].v;
  const last = keys[keys.length - 1];
  if (frame >= last.f) return last.v;
  // Binary search for the segment containing `frame`.
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].f <= frame) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  return lerp(a.v, b.v, shape((frame - a.f) / (b.f - a.f), a.ease));
}

/** Insert or overwrite a key. Returns a new Animated; the input is not mutated. */
export function setKey(v: ParamValue, frame: number, value: Scalar, ease: Ease = 'smooth'): Animated {
  const keys: Key[] = isAnimated(v) ? v.keys.map((k) => ({ ...k })) : [];
  const existing = keys.find((k) => k.f === frame);
  if (existing) existing.v = value;
  else keys.push({ f: frame, v: value, ease });
  keys.sort((a, b) => a.f - b.f);
  return { keys };
}

/** Remove the key at `frame`. Removing the last key collapses the parameter back to a constant. */
export function removeKey(v: Animated, frame: number): ParamValue {
  const keys = v.keys.filter((k) => k.f !== frame);
  if (keys.length === v.keys.length) return v;
  if (keys.length === 0) return v.keys[0].v;
  return { keys };
}

export function hasKeyAt(v: ParamValue | undefined, frame: number): boolean {
  return isAnimated(v) && v.keys.some((k) => k.f === frame);
}

export function keyFrames(v: ParamValue | undefined): number[] {
  return isAnimated(v) ? v.keys.map((k) => k.f) : [];
}
