import { isAnimated, removeKey, setKey } from '../core/anim';
import { addNode, connect, duplicateNode, getNode, removeNode, sanitize } from '../core/graph';
import { History } from '../core/history';
import { NODE_DEFS } from '../core/nodes';
import { SCENES } from '../core/scenes';
import type { NodeData, Project, Scalar } from '../core/types';
import { Renderer, type ViewOptions } from '../gl/renderer';
import { Sources } from './sources';

/**
 * What changed, so each panel can do the least work:
 *  structure - nodes, wires, selection or the whole project
 *  params    - a parameter value (slider drags land here)
 *  frame     - the playhead moved
 *  view      - viewer or transport state only
 */
export type Change = 'structure' | 'params' | 'frame' | 'view';

const STORAGE_KEY = 'matte.project.v1';

export class App {
  project: Project;
  frame = 1;
  playing = false;
  selected: string | null = null;
  view = { channel: 0, ev: 0, checker: false, wipe: false, wipeX: 0.5 };
  /** Set while a colour parameter is waiting for a click in the viewer. */
  picking: ((rgb: [number, number, number]) => void) | null = null;
  onFrameDrawn: (() => void) | null = null;
  onToast: ((msg: string) => void) | null = null;

  readonly history = new History();
  readonly sources = new Sources(() => this.requestRender());
  readonly renderer: Renderer;

  private subs: ((c: Change) => void)[] = [];
  private dirty = true;
  private last = 0;
  private acc = 0;
  private onEnd: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, initial: Project) {
    this.renderer = new Renderer(canvas);
    this.project = initial;
    this.history.push(JSON.stringify(initial));
    requestAnimationFrame(this.tick);
  }

  // ───────────────────────── Change plumbing ─────────────────────────

  subscribe(fn: (c: Change) => void): void {
    this.subs.push(fn);
  }

  emit(c: Change): void {
    for (const fn of this.subs) fn(c);
  }

  requestRender(): void {
    this.dirty = true;
  }

  toast(msg: string): void {
    this.onToast?.(msg);
  }

  /** Record the current project as an undo step, persist it, and repaint. */
  commit(c: Change = 'structure'): void {
    const snap = JSON.stringify(this.project);
    this.history.push(snap);
    try {
      localStorage.setItem(STORAGE_KEY, snap);
    } catch {
      /* storage full or unavailable: the session still works */
    }
    this.emit(c);
    this.requestRender();
  }

  private restore(snap: string | null): void {
    if (!snap) return;
    this.project = JSON.parse(snap) as Project;
    if (!getNode(this.project, this.selected)) this.selected = null;
    this.frame = Math.min(this.frame, this.project.frames);
    try {
      localStorage.setItem(STORAGE_KEY, snap);
    } catch {
      /* ignore */
    }
    this.emit('structure');
    this.requestRender();
  }

  undo(): void {
    this.restore(this.history.undo());
  }

  redo(): void {
    this.restore(this.history.redo());
  }

  load(p: Project): void {
    this.project = p;
    this.selected = null;
    this.frame = 1;
    this.setPlaying(false);
    this.history.clear();
    this.commit('structure');
  }

  static stored(): Project | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? sanitize(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  static defaultProject(): Project {
    return SCENES[0].build();
  }

  // ───────────────────────── Editing ─────────────────────────

  get selectedNode(): NodeData | undefined {
    return getNode(this.project, this.selected);
  }

  select(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.emit('structure');
  }

  addNode(type: string, x: number, y: number, from?: string | null): NodeData {
    const node = addNode(this.project, type, Math.round(x), Math.round(y));
    if (from && NODE_DEFS[type].inputs.length > 0) connect(this.project, from, node.id, 0);
    if (!this.project.viewA) this.project.viewA = node.id;
    this.selected = node.id;
    this.commit();
    return node;
  }

  deleteSelected(): void {
    if (!this.selected) return;
    removeNode(this.project, this.selected);
    this.selected = null;
    this.commit();
  }

  duplicateSelected(): void {
    if (!this.selected) return;
    const copy = duplicateNode(this.project, this.selected);
    if (copy) this.selected = copy.id;
    this.commit();
  }

  /** Show a node in the viewer: slot A is the main image, slot B is the other side of the wipe. */
  setView(slot: 'A' | 'B', id: string | null): void {
    if (slot === 'A') this.project.viewA = id;
    else {
      this.project.viewB = id;
      if (id) this.view.wipe = true;
    }
    this.commit();
  }

  /**
   * Change a parameter. On an animated parameter this writes a key at the current frame (auto-key).
   * `live` is for mid-drag updates: repaint now, record the undo step when the drag ends.
   */
  setParam(node: NodeData, name: string, value: Scalar | string, live = false): void {
    const cur = node.params[name];
    node.params[name] = isAnimated(cur) && typeof value !== 'string' ? setKey(cur, this.frame, value) : value;
    if (live) {
      this.emit('params');
      this.requestRender();
    } else this.commit('params');
  }

  /** Add a key at the playhead, or remove the one that is already there. */
  toggleKey(node: NodeData, name: string, current: Scalar): void {
    const cur = node.params[name];
    if (isAnimated(cur) && cur.keys.some((k) => k.f === this.frame)) node.params[name] = removeKey(cur, this.frame);
    else node.params[name] = setKey(cur ?? current, this.frame, current);
    this.commit('structure');
  }

  // ───────────────────────── Transport ─────────────────────────

  setFrame(f: number): void {
    const next = Math.min(this.project.frames, Math.max(1, Math.round(f)));
    if (next === this.frame) return;
    this.frame = next;
    if (!this.playing) this.sources.seek((next - 1) / this.project.fps);
    this.emit('frame');
    this.requestRender();
  }

  setPlaying(on: boolean): void {
    if (this.playing === on) return;
    this.playing = on;
    this.acc = 0;
    if (on) this.sources.seek((this.frame - 1) / this.project.fps);
    this.sources.setPlaying(on);
    this.emit('view');
  }

  /** Play the whole range once from frame 1 without dropping frames, then call back. Used by export. */
  playOnce(done: () => void): void {
    this.setPlaying(false);
    this.frame = 1;
    this.emit('frame');
    this.requestRender();
    this.onEnd = done;
    this.setPlaying(true);
  }

  viewOptions(): ViewOptions {
    const v = this.view;
    return { channel: v.channel, ev: v.ev, checker: v.checker, wipe: v.wipe && this.project.viewB ? v.wipeX : null };
  }

  private tick = (now: number): void => {
    if (this.playing) {
      this.acc = Math.min(this.acc + ((now - this.last) / 1000) * this.project.fps, 4);
      if (this.acc >= 1) {
        const step = this.onEnd ? 1 : Math.floor(this.acc);
        this.acc -= Math.floor(this.acc);
        let f = this.frame + step;
        if (f > this.project.frames) {
          if (this.onEnd) {
            const cb = this.onEnd;
            this.onEnd = null;
            f = this.project.frames;
            this.setPlaying(false);
            cb();
          } else f = ((f - 1) % this.project.frames) + 1;
        }
        this.frame = f;
        this.dirty = true;
        this.emit('frame');
      }
    }
    this.last = now;
    if (this.dirty) {
      this.dirty = false;
      this.renderer.render(this.project, this.frame, this.sources, this.viewOptions());
      this.onFrameDrawn?.();
    }
    requestAnimationFrame(this.tick);
  };
}
