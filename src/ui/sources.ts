import { rgbToHex } from '../core/color';
import type { NodeData, Project, Resolved } from '../core/types';
import type { SourceFrame, SourceProvider } from '../gl/renderer';

interface FileSource {
  name: string;
  el: HTMLImageElement | HTMLVideoElement;
  ready: boolean;
}

interface TextSource {
  canvas: HTMLCanvasElement;
  key: string;
}

const WEIGHTS = [400, 700, 900];

/** Pixels that come from outside the graph: user files for Read nodes, rasterised type for Text nodes. */
export class Sources implements SourceProvider {
  private files = new Map<string, FileSource>();
  private text = new Map<string, TextSource>();

  constructor(private readonly onChange: () => void) {}

  fileName(nodeId: string): string | null {
    return this.files.get(nodeId)?.name ?? null;
  }

  setFile(nodeId: string, file: File): void {
    const url = URL.createObjectURL(file);
    const done = (src: FileSource) => {
      src.ready = true;
      this.onChange();
    };
    if (file.type.startsWith('video/')) {
      const el = document.createElement('video');
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = 'auto';
      const src: FileSource = { name: file.name, el, ready: false };
      el.addEventListener('loadeddata', () => done(src));
      el.addEventListener('seeked', () => this.onChange());
      el.src = url;
      this.files.set(nodeId, src);
    } else {
      const el = new Image();
      const src: FileSource = { name: file.name, el, ready: false };
      el.addEventListener('load', () => done(src));
      el.src = url;
      this.files.set(nodeId, src);
    }
  }

  private videos(): HTMLVideoElement[] {
    return [...this.files.values()].map((f) => f.el).filter((e): e is HTMLVideoElement => e instanceof HTMLVideoElement);
  }

  /** Park every video on the frame the timeline is showing. */
  seek(seconds: number): void {
    for (const v of this.videos()) {
      if (!Number.isFinite(v.duration) || v.duration <= 0) continue;
      const t = seconds % v.duration;
      if (Math.abs(v.currentTime - t) > 1e-3) v.currentTime = t;
    }
  }

  setPlaying(playing: boolean): void {
    for (const v of this.videos()) {
      if (playing) void v.play().catch(() => {});
      else v.pause();
    }
  }

  get(node: NodeData, params: Record<string, Resolved>, project: Project): SourceFrame | null {
    if (node.type === 'text') return this.drawText(node.id, params, project);
    const f = this.files.get(node.id);
    if (!f || !f.ready) return null;
    if (f.el instanceof HTMLVideoElement) {
      if (f.el.readyState < 2) return null;
      return { image: f.el, width: f.el.videoWidth, height: f.el.videoHeight, version: f.el.currentTime };
    }
    return { image: f.el, width: f.el.naturalWidth, height: f.el.naturalHeight, version: f.name };
  }

  private drawText(id: string, p: Record<string, Resolved>, project: Project): SourceFrame {
    const w = project.width;
    const h = project.height;
    // Opacity is applied in the shader, so fading a title does not re-rasterise it every frame.
    const key = JSON.stringify([p.text, p.size, p.x, p.y, p.color, p.weight, p.tracking, w, h]);
    let t = this.text.get(id);
    if (!t) {
      t = { canvas: document.createElement('canvas'), key: '' };
      this.text.set(id, t);
    }
    if (t.key !== key) {
      t.key = key;
      t.canvas.width = w;
      t.canvas.height = h;
      const ctx = t.canvas.getContext('2d')!;
      ctx.clearRect(0, 0, w, h);
      const size = Number(p.size) * h;
      ctx.font = `${WEIGHTS[Number(p.weight)] ?? 700} ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      (ctx as unknown as { letterSpacing: string }).letterSpacing = `${Number(p.tracking) * size}px`;
      ctx.fillStyle = rgbToHex(p.color as number[]);
      ctx.fillText(String(p.text), Number(p.x) * w, (1 - Number(p.y)) * h);
    }
    return { image: t.canvas, width: w, height: h, version: key };
  }
}
