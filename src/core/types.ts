/** Project data model. Everything here is plain JSON so a project can be saved, shared and undone by value. */

export type Ease = 'linear' | 'smooth' | 'hold';

/** A float, or a fixed-size vector (colours are [r, g, b] in 0..1). */
export type Scalar = number | number[];

export interface Key {
  /** Frame number, 1-based. */
  f: number;
  v: Scalar;
  /** How to travel from this key to the next one. */
  ease: Ease;
}

export interface Animated {
  keys: Key[];
}

export type ParamValue = number | number[] | string | Animated;

/** A parameter after keyframes have been evaluated at a frame. */
export type Resolved = number | number[] | string;

export interface NodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  label?: string;
  params: Record<string, ParamValue>;
}

/** Output of `from` feeds input slot `input` of `to`. */
export interface Edge {
  from: string;
  to: string;
  input: number;
}

export interface Project {
  version: 1;
  name: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  nodes: NodeData[];
  edges: Edge[];
  /** Node shown in the viewer, and the one it is wiped against. */
  viewA: string | null;
  viewB: string | null;
}
