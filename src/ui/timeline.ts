import { keyFrames } from '../core/anim';
import type { App } from './app';
import { h } from './dom';

const PAD = 14;

/** Transport controls plus a scrubbable ruler showing the selected node's keyframes. */
export class Timeline {
  private canvas = h('canvas', { class: 'ruler' });
  private play: HTMLButtonElement;
  private frameBox: HTMLInputElement;
  private lengthBox: HTMLInputElement;
  private fpsBox: HTMLSelectElement;
  private scrubbing = false;

  constructor(
    private readonly app: App,
    el: HTMLElement,
  ) {
    const step = (d: number) => () => {
      app.setPlaying(false);
      app.setFrame(app.frame + d);
    };
    this.play = h('button', { class: 'btn play', title: 'Play / pause (Space)', onclick: () => app.setPlaying(!app.playing) }, '▶');
    this.frameBox = h('input', {
      type: 'number',
      class: 'num',
      min: '1',
      title: 'Current frame',
      onchange: () => app.setFrame(Number(this.frameBox.value) || 1),
    });
    this.lengthBox = h('input', {
      type: 'number',
      class: 'num',
      min: '1',
      max: '5000',
      title: 'Length in frames',
      onchange: () => {
        app.project.frames = Math.min(5000, Math.max(1, Math.round(Number(this.lengthBox.value) || 1)));
        app.frame = Math.min(app.frame, app.project.frames);
        app.commit();
      },
    });
    this.fpsBox = h('select', {
      title: 'Frame rate',
      onchange: () => {
        app.project.fps = Number(this.fpsBox.value);
        app.commit();
      },
    }, ...[12, 24, 25, 30, 60].map((f) => h('option', { value: String(f) }, `${f} fps`)));

    el.append(
      h('div', { class: 'transport' },
        h('button', { class: 'btn', title: 'First frame (Home)', onclick: () => app.setFrame(1) }, '⏮'),
        h('button', { class: 'btn', title: 'Previous frame (←)', onclick: step(-1) }, '◀'),
        this.play,
        h('button', { class: 'btn', title: 'Next frame (→)', onclick: step(1) }, '▶'),
        h('span', { class: 'bar-label' }, 'Frame'), this.frameBox,
        h('span', { class: 'bar-label' }, 'of'), this.lengthBox,
        this.fpsBox,
      ),
      this.canvas,
    );

    this.canvas.addEventListener('pointerdown', (e) => {
      this.scrubbing = true;
      this.canvas.setPointerCapture(e.pointerId);
      app.setPlaying(false);
      this.scrub(e);
    });
    this.canvas.addEventListener('pointermove', (e) => this.scrubbing && this.scrub(e));
    this.canvas.addEventListener('pointerup', () => (this.scrubbing = false));
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    app.subscribe(() => this.sync());
    this.sync();
  }

  private scrub(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const t = (e.clientX - r.left - PAD) / Math.max(1, r.width - PAD * 2);
    this.app.setFrame(1 + t * (this.app.project.frames - 1));
  }

  private sync(): void {
    const { app } = this;
    this.play.textContent = app.playing ? '⏸' : '▶';
    this.play.classList.toggle('on', app.playing);
    if (document.activeElement !== this.frameBox) this.frameBox.value = String(app.frame);
    if (document.activeElement !== this.lengthBox) this.lengthBox.value = String(app.project.frames);
    this.fpsBox.value = String(app.project.fps);
    this.draw();
  }

  private draw(): void {
    const { app } = this;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (w === 0) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const frames = app.project.frames;
    const x = (f: number) => PAD + ((f - 1) / Math.max(1, frames - 1)) * (w - PAD * 2);

    // Pick a tick spacing that keeps labels roughly 60px apart.
    const per = (w - PAD * 2) / Math.max(1, frames - 1);
    const major = [1, 2, 5, 10, 20, 24, 50, 100, 200, 500, 1000].find((s) => s * per >= 56) ?? 1000;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    for (let f = 1; f <= frames; f++) {
      const isMajor = f === 1 || f % major === 0;
      if (!isMajor && per < 4) continue;
      ctx.fillStyle = isMajor ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
      ctx.fillRect(Math.round(x(f)), isMajor ? 14 : 20, 1, isMajor ? hgt - 14 : hgt - 20);
      if (isMajor) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillText(String(f), x(f) + 3, 2);
      }
    }

    const node = app.selectedNode;
    if (node) {
      const keys = new Set<number>();
      for (const v of Object.values(node.params)) for (const f of keyFrames(v)) keys.add(f);
      ctx.fillStyle = '#ffb347';
      for (const f of keys) {
        const kx = x(f);
        const ky = hgt - 11;
        ctx.beginPath();
        ctx.moveTo(kx, ky - 5);
        ctx.lineTo(kx + 5, ky);
        ctx.lineTo(kx, ky + 5);
        ctx.lineTo(kx - 5, ky);
        ctx.closePath();
        ctx.fill();
      }
    }

    const px = Math.round(x(app.frame));
    ctx.fillStyle = '#ff5a4d';
    ctx.fillRect(px - 0.5, 0, 2, hgt);
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px + 0.5, 8);
    ctx.closePath();
    ctx.fill();
  }
}
