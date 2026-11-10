import { fnv1a } from '../core/color';
import { NODE_DEFS, NODE_LIST, buildFragment, resolveParams, type NodeDef } from '../core/nodes';
import type { NodeData, Project, Resolved } from '../core/types';

/**
 * WebGL2 graph evaluator.
 *
 * Every node owns a half-float render target. Evaluation is a depth-first pull from the viewed
 * node; each node is fingerprinted from its type, its parameters at the current frame and the
 * fingerprints of its inputs, and is only re-rendered when that fingerprint changes. Dragging a
 * slider near the end of a long chain therefore redraws one or two nodes, not the whole graph.
 */

export interface ViewOptions {
  /** 0 RGB, 1 R, 2 G, 3 B, 4 A, 5 luma */
  channel: number;
  /** Viewer exposure in stops. Display only; it never touches the comp. */
  ev: number;
  checker: boolean;
  /** Split position 0..1 for the A/B wipe, or null when the wipe is off. */
  wipe: number | null;
}

export interface SourceFrame {
  image: TexImageSource;
  width: number;
  height: number;
  /** Changes whenever the pixels do (a video's current time, a text node's settings). */
  version: string | number;
}

export interface SourceProvider {
  get(node: NodeData, params: Record<string, Resolved>, project: Project): SourceFrame | null;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  hash: string;
}

interface Program {
  prog: WebGLProgram;
  locs: Map<string, WebGLUniformLocation | null>;
}

interface SourceTexture {
  tex: WebGLTexture;
  width: number;
  height: number;
  version: string | number;
}

interface Ctx {
  project: Project;
  frame: number;
  sources: SourceProvider;
  byId: Map<string, NodeData>;
  wires: Map<string, string>;
  done: Map<string, Target | null>;
  visiting: Set<string>;
}

const VERT = `#version 300 es
out vec2 v_uv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const VIEW_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_color;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform vec2 u_res;
uniform float u_hasB, u_wipe, u_channel, u_ev, u_checker;
vec3 toSRGB(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main(){
  vec4 a = texture(u_a, v_uv);
  vec4 b = texture(u_b, v_uv);
  vec4 c = (u_hasB > 0.5 && v_uv.x > u_wipe) ? b : a;
  c.rgb *= exp2(u_ev);
  vec3 o;
  if(u_channel < 0.5){
    vec3 bg = vec3(0.0);
    if(u_checker > 0.5){ vec2 g = floor(v_uv * u_res / 16.0); bg = vec3(mod(g.x + g.y, 2.0) < 0.5 ? 0.03 : 0.07); }
    o = toSRGB(c.rgb + bg * (1.0 - clamp(c.a, 0.0, 1.0)));
  }
  else if(u_channel < 1.5) o = toSRGB(c.rrr);
  else if(u_channel < 2.5) o = toSRGB(c.ggg);
  else if(u_channel < 3.5) o = toSRGB(c.bbb);
  else if(u_channel < 4.5) o = vec3(c.a);
  else o = toSRGB(vec3(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722))));
  if(u_hasB > 0.5 && abs(v_uv.x - u_wipe) * u_res.x < 1.0) o = vec3(1.0, 0.72, 0.2);
  o_color = vec4(o, 1.0);
}`;

export const SCOPE_W = 256;
export const SCOPE_H = 144;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  /** True when the pipeline is RGBA16F; false means the GPU only gave us 8-bit targets. */
  readonly float: boolean;
  /** Shader compile errors by node type, shown on the offending nodes. */
  readonly errors = new Map<string, string>();
  /** How many nodes the last render actually had to redraw. */
  lastDrawn = 0;

  private width = 0;
  private height = 0;
  private programs = new Map<string, Program | null>();
  private targets = new Map<string, Target>();
  private scratch: Target[] = [];
  private sourceTex = new Map<string, SourceTexture>();
  private blank: WebGLTexture;
  private view: Program;
  private scope: Target;
  private scopePixels = new Uint8Array(SCOPE_W * SCOPE_H * 4);
  private vs: WebGLShader;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.float = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.bindVertexArray(gl.createVertexArray());
    gl.disable(gl.BLEND);
    this.vs = this.compile(gl.VERTEX_SHADER, VERT);
    this.blank = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    // Without a non-mipmap filter the texture is incomplete and would sample as opaque black.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.view = this.link(VIEW_FRAG);
    this.scope = this.makeTarget(SCOPE_W, SCOPE_H, false);
  }

  // ───────────────────────── GL plumbing ─────────────────────────

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? 'unknown error';
      gl.deleteShader(sh);
      throw new Error(log.trim());
    }
    return sh;
  }

  private link(frag: string): Program {
    const gl = this.gl;
    const fs = this.compile(gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, this.vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? 'link failed';
      gl.deleteProgram(prog);
      throw new Error(log.trim());
    }
    return { prog, locs: new Map() };
  }

  private loc(p: Program, name: string): WebGLUniformLocation | null {
    let l = p.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(p.prog, name);
      p.locs.set(name, l);
    }
    return l;
  }

  private program(def: NodeDef): Program | null {
    let p = this.programs.get(def.type);
    if (p === undefined) {
      try {
        p = this.link(buildFragment(def));
        this.errors.delete(def.type);
      } catch (e) {
        p = null;
        this.errors.set(def.type, (e as Error).message);
        console.error(`[matte] shader for "${def.type}" failed to compile:\n${(e as Error).message}`);
      }
      this.programs.set(def.type, p);
    }
    return p;
  }

  /** Compile every node's shader up front. Returns the failures (empty when all is well). */
  compileAll(): Record<string, string> {
    for (const def of NODE_LIST) this.program(def);
    return Object.fromEntries(this.errors);
  }

  private makeTarget(w: number, h: number, float: boolean): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, hash: '' };
  }

  private freeTarget(t: Target): void {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  private resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of this.targets.values()) this.freeTarget(t);
    for (const t of this.scratch) this.freeTarget(t);
    this.targets.clear();
    this.scratch = [this.makeTarget(w, h, this.float), this.makeTarget(w, h, this.float)];
  }

  private target(id: string): Target {
    let t = this.targets.get(id);
    if (!t) {
      t = this.makeTarget(this.width, this.height, this.float);
      this.targets.set(id, t);
    }
    return t;
  }

  private bind(unit: number, tex: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  // ───────────────────────── External sources ─────────────────────────

  private uploadSource(id: string, frame: SourceFrame | null): SourceTexture | null {
    const gl = this.gl;
    if (!frame) return null;
    let s = this.sourceTex.get(id);
    if (!s) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      s = { tex, width: 0, height: 0, version: '' };
      this.sourceTex.set(id, s);
    }
    if (s.version !== frame.version || s.width !== frame.width || s.height !== frame.height) {
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.image);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      s.version = frame.version;
      s.width = frame.width;
      s.height = frame.height;
    }
    return s;
  }

  // ───────────────────────── Evaluation ─────────────────────────

  private evalNode(id: string, c: Ctx): Target | null {
    if (c.done.has(id)) return c.done.get(id)!;
    const node = c.byId.get(id);
    const def = node && NODE_DEFS[node.type];
    if (!node || !def || c.visiting.has(id)) return null;

    c.visiting.add(id);
    const inputs = def.inputs.map((_, i) => {
      const from = c.wires.get(`${id}:${i}`);
      return from ? this.evalNode(from, c) : null;
    });
    c.visiting.delete(id);

    const params = resolveParams(node, def, c.frame);
    const src = def.source ? this.uploadSource(id, c.sources.get(node, params, c.project)) : null;
    const hash = fnv1a(
      JSON.stringify([
        node.type,
        params,
        inputs.map((t) => (t ? t.hash : 0)),
        def.animated ? c.frame : 0,
        src ? [src.version, src.width, src.height] : 0,
      ]),
    );

    const out = this.target(id);
    if (out.hash !== hash) {
      const prog = this.program(def);
      if (!prog) {
        c.done.set(id, null);
        return null;
      }
      this.draw(def, prog, out, inputs, params, src, c);
      out.hash = hash;
      this.lastDrawn++;
    }
    c.done.set(id, out);
    return out;
  }

  private draw(
    def: NodeDef,
    p: Program,
    out: Target,
    inputs: (Target | null)[],
    params: Record<string, Resolved>,
    src: SourceTexture | null,
    c: Ctx,
  ): void {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.viewport(0, 0, this.width, this.height);
    gl.uniform2f(this.loc(p, 'u_res'), this.width, this.height);
    gl.uniform1f(this.loc(p, 'u_time'), (c.frame - 1) / c.project.fps);
    gl.uniform1f(this.loc(p, 'u_frame'), c.frame);
    for (let i = 0; i < 3; i++) {
      this.bind(i, inputs[i]?.tex ?? this.blank);
      gl.uniform1i(this.loc(p, `u_in${i}`), i);
      gl.uniform1f(this.loc(p, `u_has${i}`), inputs[i] ? 1 : 0);
    }
    this.bind(4, src?.tex ?? this.blank);
    gl.uniform1i(this.loc(p, 'u_src'), 4);
    gl.uniform2f(this.loc(p, 'u_srcSize'), src?.width ?? 0, src?.height ?? 0);
    gl.uniform1i(this.loc(p, 'u_prev'), 3);

    for (const d of def.params) {
      const l = this.loc(p, `u_${d.name}`);
      const v = params[d.name];
      if (!l || typeof v === 'string') continue;
      if (Array.isArray(v)) gl.uniform3f(l, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
      else gl.uniform1f(l, v);
    }

    const passes = def.passes ?? 1;
    for (let pass = 0; pass < passes; pass++) {
      // Intermediate passes ping-pong between two scratch targets; only the last one lands in `out`.
      const dst = pass === passes - 1 ? out : this.scratch[pass % 2];
      this.bind(3, pass > 0 ? this.scratch[(pass - 1) % 2].tex : this.blank);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.uniform1i(this.loc(p, 'u_pass'), pass);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  private present(a: Target | null, b: Target | null, v: ViewOptions, fbo: WebGLFramebuffer | null, w: number, h: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    if (!a) {
      gl.clearColor(0.02, 0.02, 0.025, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const p = this.view;
    gl.useProgram(p.prog);
    this.bind(0, a.tex);
    this.bind(1, b?.tex ?? this.blank);
    gl.uniform1i(this.loc(p, 'u_a'), 0);
    gl.uniform1i(this.loc(p, 'u_b'), 1);
    gl.uniform2f(this.loc(p, 'u_res'), w, h);
    gl.uniform1f(this.loc(p, 'u_hasB'), b && v.wipe !== null ? 1 : 0);
    gl.uniform1f(this.loc(p, 'u_wipe'), v.wipe ?? 2);
    gl.uniform1f(this.loc(p, 'u_channel'), v.channel);
    gl.uniform1f(this.loc(p, 'u_ev'), v.ev);
    gl.uniform1f(this.loc(p, 'u_checker'), v.checker ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Evaluate the graph at `frame` and present the viewed node(s) to the canvas. */
  render(project: Project, frame: number, sources: SourceProvider, view: ViewOptions): void {
    this.resize(project.width, project.height);
    this.lastDrawn = 0;
    const c: Ctx = {
      project,
      frame,
      sources,
      byId: new Map(project.nodes.map((n) => [n.id, n])),
      wires: new Map(project.edges.map((e) => [`${e.to}:${e.input}`, e.from])),
      done: new Map(),
      visiting: new Set(),
    };
    const a = project.viewA ? this.evalNode(project.viewA, c) : null;
    const b = project.viewB && view.wipe !== null ? this.evalNode(project.viewB, c) : null;
    this.present(a, b, view, null, this.width, this.height);
    // A small display-referred copy for the scopes; reading back the full float frame would stall.
    this.present(a, null, { ...view, channel: 0, checker: false, wipe: null }, this.scope.fbo, SCOPE_W, SCOPE_H);

    for (const [id, t] of this.targets) {
      if (!c.byId.has(id)) {
        this.freeTarget(t);
        this.targets.delete(id);
      }
    }
    for (const [id, s] of this.sourceTex) {
      if (!c.byId.has(id)) {
        this.gl.deleteTexture(s.tex);
        this.sourceTex.delete(id);
      }
    }
  }

  /** RGBA8 pixels of the last presented frame at SCOPE_W x SCOPE_H, bottom row first. */
  readScope(): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scope.fbo);
    gl.readPixels(0, 0, SCOPE_W, SCOPE_H, gl.RGBA, gl.UNSIGNED_BYTE, this.scopePixels);
    return this.scopePixels;
  }

  /** Displayed colour at a viewer position (u, v in 0..1, origin top-left), as sRGB 0..1. */
  pick(u: number, v: number): [number, number, number] {
    const gl = this.gl;
    const px = new Uint8Array(4);
    const x = Math.min(this.width - 1, Math.max(0, Math.floor(u * this.width)));
    const y = Math.min(this.height - 1, Math.max(0, Math.floor((1 - v) * this.height)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0] / 255, px[1] / 255, px[2] / 255];
  }
}
