import { describe, expect, it } from 'vitest';
import { NODE_DEFS, NODE_LIST, PRELUDE, RESERVED, buildFragment, resolveParams } from '../src/core/nodes';
import { SCENES } from '../src/core/scenes';

/** Static checks on the shader library. They catch the mistakes a GLSL compiler would, without a GPU. */

const declared = (src: string) => new Set([...src.matchAll(/uniform\s+\w+\s+(u_\w+)\s*;/g)].map((m) => m[1]));
const used = (src: string) => new Set([...src.matchAll(/\bu_\w+\b/g)].map((m) => m[0]));

describe('node library', () => {
  it('has unique types and every category populated', () => {
    expect(new Set(NODE_LIST.map((d) => d.type)).size).toBe(NODE_LIST.length);
    for (const cat of ['Source', 'Color', 'Matte', 'Filter', 'Transform', 'Merge']) {
      expect(NODE_LIST.some((d) => d.category === cat)).toBe(true);
    }
  });

  it.each(NODE_LIST.map((d) => [d.type, d] as const))('%s is well formed', (_type, def) => {
    expect(def.help.length).toBeGreaterThan(5);
    expect(def.inputs.length).toBeLessThanOrEqual(3);
    expect(def.frag).toMatch(/vec4\s+run\s*\(\s*vec2\s+uv\s*\)/);
    expect(new Set(def.params.map((p) => p.name)).size).toBe(def.params.length);

    for (const p of def.params) {
      expect(RESERVED).not.toContain(p.name);
      if (p.type === 'float') {
        expect(p.min).toBeLessThan(p.max);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
        expect(p.step).toBeGreaterThan(0);
      }
      if (p.type === 'enum') {
        expect(p.options.length).toBeGreaterThan(1);
        expect(p.default).toBeLessThan(p.options.length);
      }
    }
  });

  it.each(NODE_LIST.map((d) => [d.type, d] as const))('%s only uses uniforms that exist', (_type, def) => {
    const src = buildFragment(def);
    const have = declared(src);
    for (const u of used(def.frag)) expect(have, `${u} is not declared`).toContain(u);
    // Every shader parameter should do something (text settings are consumed on the 2D canvas instead).
    if (!def.source) {
      for (const p of def.params) {
        if (p.type !== 'string') expect(used(def.frag), `u_${p.name} is never read`).toContain(`u_${p.name}`);
      }
    }
  });

  it.each(NODE_LIST.map((d) => [d.type, d] as const))('%s reads only the inputs it declares', (_type, def) => {
    for (let i = 0; i < 3; i++) {
      if (i >= def.inputs.length) expect(def.frag).not.toMatch(new RegExp(`u_in${i}\\b`));
      else expect(def.frag).toMatch(new RegExp(`u_in${i}\\b`));
    }
    if ((def.passes ?? 1) > 1) expect(def.frag).toMatch(/u_prev/);
    else expect(def.frag).not.toMatch(/u_prev|u_pass/);
    expect(/u_src\b/.test(def.frag)).toBe(!!def.source);
  });

  it('never relies on implicit int to float conversion in literals passed to float helpers', () => {
    // GLSL ES has no implicit conversions; "smoothstep(0, 1, x)" is a compile error.
    for (const def of NODE_LIST) {
      expect(def.frag, def.type).not.toMatch(/\b(smoothstep|mix|clamp|step|pow|max|min)\(\s*\d+\s*,/);
    }
  });

  it('builds a complete shader', () => {
    const src = buildFragment(NODE_DEFS.grade);
    expect(src.startsWith('#version 300 es')).toBe(true);
    expect(src).toContain(PRELUDE);
    expect(src).toContain('uniform float u_exposure;');
    expect(src).toContain('uniform vec3 u_gain;');
    expect(src).toMatch(/void main\(\)/);
  });

  it('resolves parameters with defaults and keyframes', () => {
    const def = NODE_DEFS.blur;
    expect(resolveParams({ id: 'n1', type: 'blur', x: 0, y: 0, params: {} }, def, 1)).toEqual({ radius: 8 });
    const animated = { id: 'n1', type: 'blur', x: 0, y: 0, params: { radius: { keys: [{ f: 1, v: 0, ease: 'linear' as const }, { f: 11, v: 50, ease: 'linear' as const }] } } };
    expect(resolveParams(animated, def, 6)).toEqual({ radius: 25 });
  });
});

describe('example scenes', () => {
  it.each(SCENES.map((s) => [s.name, s] as const))('%s is valid', (_name, scene) => {
    const p = scene.build();
    expect(p.viewA).not.toBeNull();
    const ids = new Set(p.nodes.map((n) => n.id));
    for (const n of p.nodes) {
      const def = NODE_DEFS[n.type];
      expect(def).toBeDefined();
      for (const name of Object.keys(n.params)) expect(def.params.map((d) => d.name)).toContain(name);
    }
    for (const e of p.edges) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    }
  });
});
