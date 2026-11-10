import { describe, expect, it } from 'vitest';
import {
  addNode,
  connect,
  disconnect,
  duplicateNode,
  inputSource,
  newProject,
  removeNode,
  sanitize,
  topoOrder,
  upstream,
  wouldCycle,
} from '../src/core/graph';
import { SCENES } from '../src/core/scenes';

function chain() {
  const p = newProject();
  const a = addNode(p, 'constant', 0, 0);
  const b = addNode(p, 'blur', 0, 0);
  const c = addNode(p, 'grade', 0, 0);
  connect(p, a.id, b.id, 0);
  connect(p, b.id, c.id, 0);
  return { p, a, b, c };
}

describe('graph editing', () => {
  it('assigns unique ids even after deletions', () => {
    const p = newProject();
    const a = addNode(p, 'constant', 0, 0);
    const b = addNode(p, 'constant', 0, 0);
    removeNode(p, a.id);
    const c = addNode(p, 'constant', 0, 0);
    expect(new Set([b.id, c.id]).size).toBe(2);
  });

  it('rejects unknown node types', () => {
    expect(() => addNode(newProject(), 'nope', 0, 0)).toThrow();
  });

  it('connects and reports the source of an input', () => {
    const { p, a, b } = chain();
    expect(inputSource(p, b.id, 0)).toBe(a.id);
    expect(inputSource(p, a.id, 0)).toBeNull();
  });

  it('keeps a single wire per input', () => {
    const { p, b } = chain();
    const other = addNode(p, 'ramp', 0, 0);
    expect(connect(p, other.id, b.id, 0)).toBe(true);
    expect(inputSource(p, b.id, 0)).toBe(other.id);
    expect(p.edges.filter((e) => e.to === b.id)).toHaveLength(1);
  });

  it('lets one output fan out to many inputs', () => {
    const { p, a } = chain();
    const m = addNode(p, 'merge', 0, 0);
    expect(connect(p, a.id, m.id, 0)).toBe(true);
    expect(connect(p, a.id, m.id, 1)).toBe(true);
    expect(p.edges.filter((e) => e.from === a.id)).toHaveLength(3);
  });

  it('refuses wires that would create a cycle', () => {
    const { p, a, b, c } = chain();
    expect(wouldCycle(p, c.id, b.id)).toBe(true);
    expect(connect(p, c.id, b.id, 0)).toBe(false);
    expect(connect(p, b.id, b.id, 0)).toBe(false);
    expect(inputSource(p, b.id, 0)).toBe(a.id);
  });

  it('refuses out-of-range inputs and missing nodes', () => {
    const { p, a, b } = chain();
    expect(connect(p, a.id, b.id, 1)).toBe(false);
    expect(connect(p, a.id, b.id, -1)).toBe(false);
    expect(connect(p, a.id, a.id, 0)).toBe(false);
    expect(connect(p, 'ghost', b.id, 0)).toBe(false);
  });

  it('removes a node together with its wires and viewer slots', () => {
    const { p, a, b, c } = chain();
    p.viewA = b.id;
    removeNode(p, b.id);
    expect(p.edges).toHaveLength(0);
    expect(p.viewA).toBeNull();
    expect(p.nodes.map((n) => n.id)).toEqual([a.id, c.id]);
  });

  it('disconnects a single input', () => {
    const { p, b, c } = chain();
    disconnect(p, c.id, 0);
    expect(inputSource(p, c.id, 0)).toBeNull();
    expect(inputSource(p, b.id, 0)).not.toBeNull();
  });

  it('computes the upstream set', () => {
    const { p, a, b, c } = chain();
    expect(upstream(p, c.id)).toEqual(new Set([a.id, b.id]));
    expect(upstream(p, a.id).size).toBe(0);
  });

  it('orders nodes so dependencies come first', () => {
    for (const scene of SCENES) {
      const p = scene.build();
      const order = topoOrder(p);
      expect(order).toHaveLength(p.nodes.length);
      const pos = new Map(order.map((id, i) => [id, i]));
      for (const e of p.edges) expect(pos.get(e.from)!).toBeLessThan(pos.get(e.to)!);
    }
  });

  it('duplicates a node with its parameters and input wires', () => {
    const { p, a, b } = chain();
    b.params.radius = 33;
    const copy = duplicateNode(p, b.id)!;
    expect(copy.id).not.toBe(b.id);
    expect(copy.params).toEqual({ radius: 33 });
    expect(copy.params).not.toBe(b.params);
    expect(inputSource(p, copy.id, 0)).toBe(a.id);
  });
});

describe('loading untrusted projects', () => {
  it('round-trips every example scene unchanged', () => {
    for (const scene of SCENES) {
      const p = scene.build();
      expect(sanitize(JSON.parse(JSON.stringify(p)))).toEqual(p);
    }
  });

  it('throws on things that are not projects', () => {
    expect(() => sanitize(null)).toThrow();
    expect(() => sanitize('hello')).toThrow();
    expect(() => sanitize({ nodes: 'x' })).toThrow();
  });

  it('drops unknown nodes, bad parameters, dangling wires and cycles', () => {
    const p = sanitize({
      width: 99999,
      fps: 'fast',
      nodes: [
        { id: 'a', type: 'constant', x: 1, y: 2, params: { alpha: 'opaque', color: [1, 0, 0], bogus: 5 } },
        { id: 'b', type: 'blur', params: { radius: { keys: [{ f: 9, v: 4 }, { f: 2, v: 1, ease: 'hold' }, { f: 'x' }] } } },
        { id: 'c', type: 'virus' },
        { id: 'a', type: 'ramp' },
        { id: 'd', type: 'grade' },
      ],
      edges: [
        { from: 'a', to: 'b', input: 0 },
        { from: 'b', to: 'd', input: 0 },
        { from: 'd', to: 'b', input: 0 },
        { from: 'c', to: 'b', input: 0 },
        { from: 'a', to: 'b', input: 7 },
        null,
      ],
      viewA: 'c',
      viewB: 'd',
    });
    expect(p.width).toBe(4096);
    expect(p.fps).toBe(24);
    expect(p.nodes.map((n) => n.id)).toEqual(['a', 'b', 'd']);
    expect(p.nodes[0].params).toEqual({ color: [1, 0, 0] });
    expect(p.nodes[1].params.radius).toEqual({
      keys: [
        { f: 2, v: 1, ease: 'hold' },
        { f: 9, v: 4, ease: 'smooth' },
      ],
    });
    expect(p.edges).toEqual([
      { from: 'a', to: 'b', input: 0 },
      { from: 'b', to: 'd', input: 0 },
    ]);
    expect(p.viewA).toBeNull();
    expect(p.viewB).toBe('d');
  });
});
