import { NODE_DEFS, type ParamDef } from './nodes';
import type { Animated, Ease, NodeData, ParamValue, Project } from './types';

/** Graph operations. All of them are plain functions over a Project so they can be tested without a browser. */

export function newProject(): Project {
  return {
    version: 1,
    name: 'Untitled',
    width: 1280,
    height: 720,
    fps: 24,
    frames: 96,
    nodes: [],
    edges: [],
    viewA: null,
    viewB: null,
  };
}

export function getNode(p: Project, id: string | null): NodeData | undefined {
  return id === null ? undefined : p.nodes.find((n) => n.id === id);
}

export function nextId(p: Project): string {
  let max = 0;
  for (const n of p.nodes) {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

export function addNode(
  p: Project,
  type: string,
  x: number,
  y: number,
  params: Record<string, ParamValue> = {},
): NodeData {
  if (!NODE_DEFS[type]) throw new Error(`Unknown node type: ${type}`);
  const node: NodeData = { id: nextId(p), type, x, y, params: { ...params } };
  p.nodes.push(node);
  return node;
}

export function removeNode(p: Project, id: string): void {
  p.nodes = p.nodes.filter((n) => n.id !== id);
  p.edges = p.edges.filter((e) => e.from !== id && e.to !== id);
  if (p.viewA === id) p.viewA = null;
  if (p.viewB === id) p.viewB = null;
}

export function inputSource(p: Project, id: string, input: number): string | null {
  return p.edges.find((e) => e.to === id && e.input === input)?.from ?? null;
}

/** Every node that `id` depends on, directly or not. */
export function upstream(p: Project, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of p.edges) {
      if (e.to === cur && !seen.has(e.from)) {
        seen.add(e.from);
        stack.push(e.from);
      }
    }
  }
  return seen;
}

/** Would wiring from -> to close a loop? True when `to` already feeds `from`. */
export function wouldCycle(p: Project, from: string, to: string): boolean {
  return from === to || upstream(p, from).has(to);
}

/**
 * Connect the output of `from` to an input of `to`. An input holds one wire, so any existing wire
 * into that slot is replaced. Returns false (and changes nothing) if the wire is invalid.
 */
export function connect(p: Project, from: string, to: string, input: number): boolean {
  const src = getNode(p, from);
  const dst = getNode(p, to);
  if (!src || !dst) return false;
  const slots = NODE_DEFS[dst.type]?.inputs.length ?? 0;
  if (!Number.isInteger(input) || input < 0 || input >= slots) return false;
  if (wouldCycle(p, from, to)) return false;
  p.edges = p.edges.filter((e) => !(e.to === to && e.input === input));
  p.edges.push({ from, to, input });
  return true;
}

export function disconnect(p: Project, to: string, input: number): void {
  p.edges = p.edges.filter((e) => !(e.to === to && e.input === input));
}

/** Kahn's algorithm. Nodes come out with every dependency before its dependants. */
export function topoOrder(p: Project): string[] {
  const indeg = new Map<string, number>(p.nodes.map((n) => [n.id, 0]));
  for (const e of p.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = p.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of p.edges) {
      if (e.from !== id) continue;
      const d = indeg.get(e.to)! - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  return order;
}

export function duplicateNode(p: Project, id: string): NodeData | null {
  const src = getNode(p, id);
  if (!src) return null;
  const copy = addNode(p, src.type, src.x + 30, src.y + 30, structuredClone(src.params));
  if (src.label) copy.label = src.label;
  for (const e of p.edges.filter((e) => e.to === id)) connect(p, e.from, copy.id, e.input);
  return copy;
}

// ───────────────────────── Loading untrusted project files ─────────────────────────

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampInt = (v: unknown, lo: number, hi: number, fallback: number) =>
  num(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

function validScalar(def: ParamDef, v: unknown): boolean {
  if (def.type === 'string') return typeof v === 'string';
  if (def.type === 'color') return Array.isArray(v) && v.length === 3 && v.every(num);
  return num(v);
}

function cleanParam(def: ParamDef, v: unknown): ParamValue | undefined {
  if (validScalar(def, v)) return v as ParamValue;
  if (def.type === 'string' || typeof v !== 'object' || v === null) return undefined;
  const keys = (v as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return undefined;
  const out: Animated = { keys: [] };
  for (const k of keys) {
    if (!k || typeof k !== 'object') continue;
    const { f, v: kv, ease } = k as { f?: unknown; v?: unknown; ease?: unknown };
    if (!num(f) || !validScalar(def, kv)) continue;
    const e: Ease = ease === 'linear' || ease === 'hold' ? ease : 'smooth';
    out.keys.push({ f: Math.round(f), v: kv as number | number[], ease: e });
  }
  if (out.keys.length === 0) return undefined;
  out.keys.sort((a, b) => a.f - b.f);
  return out;
}

/**
 * Rebuild a Project from arbitrary JSON (a file the user opened, or a share link). Unknown node
 * types, malformed parameters, dangling wires and cycles are dropped rather than trusted.
 */
export function sanitize(raw: unknown): Project {
  if (!raw || typeof raw !== 'object') throw new Error('Not a matte project');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.nodes)) throw new Error('Project has no node list');
  const p = newProject();
  if (typeof r.name === 'string') p.name = r.name.slice(0, 80);
  p.width = clampInt(r.width, 16, 4096, p.width);
  p.height = clampInt(r.height, 16, 4096, p.height);
  p.fps = clampInt(r.fps, 1, 120, p.fps);
  p.frames = clampInt(r.frames, 1, 5000, p.frames);

  const ids = new Set<string>();
  for (const n of r.nodes) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    const def = typeof o.type === 'string' ? NODE_DEFS[o.type] : undefined;
    if (!def || typeof o.id !== 'string' || ids.has(o.id)) continue;
    ids.add(o.id);
    const params: Record<string, ParamValue> = {};
    const rawParams = (o.params && typeof o.params === 'object' ? o.params : {}) as Record<string, unknown>;
    for (const d of def.params) {
      const v = cleanParam(d, rawParams[d.name]);
      if (v !== undefined) params[d.name] = v;
    }
    const node: NodeData = { id: o.id, type: def.type, x: num(o.x) ? o.x : 0, y: num(o.y) ? o.y : 0, params };
    if (typeof o.label === 'string' && o.label) node.label = o.label.slice(0, 40);
    p.nodes.push(node);
  }
  if (Array.isArray(r.edges)) {
    for (const e of r.edges) {
      if (!e || typeof e !== 'object') continue;
      const o = e as Record<string, unknown>;
      if (typeof o.from === 'string' && typeof o.to === 'string' && num(o.input)) connect(p, o.from, o.to, o.input);
    }
  }
  if (typeof r.viewA === 'string' && ids.has(r.viewA)) p.viewA = r.viewA;
  if (typeof r.viewB === 'string' && ids.has(r.viewB)) p.viewB = r.viewB;
  return p;
}
