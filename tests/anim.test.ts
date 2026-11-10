import { describe, expect, it } from 'vitest';
import { evaluate, hasKeyAt, isAnimated, keyFrames, removeKey, setKey } from '../src/core/anim';
import type { Animated } from '../src/core/types';

const ramp: Animated = {
  keys: [
    { f: 10, v: 0, ease: 'linear' },
    { f: 20, v: 10, ease: 'smooth' },
    { f: 30, v: 20, ease: 'hold' },
    { f: 40, v: 0, ease: 'linear' },
  ],
};

describe('keyframe evaluation', () => {
  it('passes constants through', () => {
    expect(evaluate(3, 99)).toBe(3);
    expect(evaluate('hi', 1)).toBe('hi');
    expect(evaluate([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });

  it('holds the first and last keys outside the animated range', () => {
    expect(evaluate(ramp, 1)).toBe(0);
    expect(evaluate(ramp, 400)).toBe(0);
  });

  it('hits key values exactly', () => {
    for (const k of ramp.keys) expect(evaluate(ramp, k.f)).toBe(k.v);
  });

  it('interpolates linearly', () => {
    expect(evaluate(ramp, 15)).toBeCloseTo(5);
    expect(evaluate(ramp, 12)).toBeCloseTo(2);
  });

  it('eases smooth segments in and out', () => {
    expect(evaluate(ramp, 25)).toBeCloseTo(15);
    // A quarter of the way through a smoothstep is behind the linear position.
    expect(evaluate(ramp, 22.5) as number).toBeLessThan(12.5);
    expect(evaluate(ramp, 27.5) as number).toBeGreaterThan(17.5);
  });

  it('holds until the next key', () => {
    expect(evaluate(ramp, 39)).toBe(20);
  });

  it('interpolates vectors per component', () => {
    const c: Animated = { keys: [{ f: 1, v: [0, 0, 1], ease: 'linear' }, { f: 3, v: [1, 0.5, 0], ease: 'linear' }] };
    expect(evaluate(c, 2)).toEqual([0.5, 0.25, 0.5]);
  });
});

describe('keyframe editing', () => {
  it('turns a constant into an animation', () => {
    const a = setKey(5, 12, 5);
    expect(isAnimated(a)).toBe(true);
    expect(a.keys).toEqual([{ f: 12, v: 5, ease: 'smooth' }]);
  });

  it('keeps keys sorted and overwrites in place', () => {
    let a = setKey(0, 20, 2);
    a = setKey(a, 5, 1);
    a = setKey(a, 20, 9);
    expect(keyFrames(a)).toEqual([5, 20]);
    expect(evaluate(a, 20)).toBe(9);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(ramp);
    setKey(ramp, 15, 99);
    removeKey(ramp, 20);
    expect(JSON.stringify(ramp)).toBe(before);
  });

  it('removes keys and collapses to a constant when the last one goes', () => {
    const a = setKey(setKey(0, 1, 4), 9, 8);
    const one = removeKey(a, 9);
    expect(keyFrames(one)).toEqual([1]);
    expect(removeKey(one as Animated, 1)).toBe(4);
    expect(removeKey(a, 5)).toBe(a);
  });

  it('reports keys at a frame', () => {
    expect(hasKeyAt(ramp, 20)).toBe(true);
    expect(hasKeyAt(ramp, 21)).toBe(false);
    expect(hasKeyAt(7, 1)).toBe(false);
  });
});
