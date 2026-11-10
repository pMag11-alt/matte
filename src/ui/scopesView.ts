import { histogram, vectorscope, waveform } from '../core/scopes';
import { SCOPE_H, SCOPE_W } from '../gl/renderer';
import type { App } from './app';
import { h } from './dom';

const MODES = ['Waveform', 'Parade', 'Vector', 'Histogram'] as const;
type Mode = (typeof MODES)[number];

// Matches the panel's on-screen aspect so the vectorscope stays circular.
const W = 304;
const H = 160;

/** Waveform, RGB parade, vectorscope and histogram of whatever the viewer is showing. */
export class ScopesView {
  private mode: Mode = 'Waveform';
  private canvas = h('canvas', { width: W, height: H, class: 'scope' });
  private ctx = this.canvas.getContext('2d')!;
  private stage = h('canvas', { width: SCOPE_W, height: H });
  private tabs: HTMLButtonElement[];

  constructor(
    private readonly app: App,
    el: HTMLElement,
  ) {
    this.tabs = MODES.map((m) =>
      h('button', {
        class: 'seg',
        onclick: () => {
          this.mode = m;
          this.paintTabs();
          this.update();
        },
      }, m),
    );
    el.append(h('div', { class: 'panel-title' }, 'Scopes', h('div', { class: 'segs' }, ...this.tabs)), this.canvas);
    this.paintTabs();
  }

  private paintTabs(): void {
    this.tabs.forEach((t, i) => t.classList.toggle('on', MODES[i] === this.mode));
  }

  update(): void {
    const px = this.app.renderer.readScope();
    const ctx = this.ctx;
    ctx.fillStyle = '#0b0b0d';
    ctx.fillRect(0, 0, W, H);

    if (this.mode === 'Waveform' || this.mode === 'Parade') {
      // One scope column per source column (no gaps), then scaled up to the panel width.
      const img = waveform(px, SCOPE_W, SCOPE_H, SCOPE_W, H, this.mode === 'Parade');
      this.stage.getContext('2d')!.putImageData(new ImageData(img as ImageDataArray, SCOPE_W, H), 0, 0);
      ctx.drawImage(this.stage, 0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.lineWidth = 1;
      for (const level of [0, 25, 50, 75, 100]) {
        const y = Math.round((1 - level / 100) * (H - 1)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.fillText(String(level), 2, Math.min(H - 2, Math.max(8, y - 2)));
      }
    } else if (this.mode === 'Vector') {
      const size = H;
      const img = vectorscope(px, size);
      const ox = (W - size) / 2;
      ctx.putImageData(new ImageData(img as ImageDataArray, size, size), ox, 0);
      const cx = W / 2;
      const cy = H / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      for (const r of [0.25, 0.5]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * (size - 1), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - size / 2, cy);
      ctx.lineTo(cx + size / 2, cy);
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, H);
      ctx.stroke();
      // Skin-tone line: where faces should fall regardless of complexion.
      const a = (123 * Math.PI) / 180;
      ctx.strokeStyle = 'rgba(255,190,120,0.55)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * size * 0.5, cy - Math.sin(a) * size * 0.5);
      ctx.stroke();
    } else {
      const hist = histogram(px);
      const draw = (bins: Uint32Array, color: string) => {
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let i = 0; i < 256; i++) ctx.lineTo(i, H - Math.min(1, bins[i] / hist.peak) * (H - 6));
        ctx.lineTo(255, H);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      ctx.globalCompositeOperation = 'lighter';
      draw(hist.r, 'rgba(235,70,70,0.75)');
      draw(hist.g, 'rgba(70,215,100,0.75)');
      draw(hist.b, 'rgba(80,130,255,0.75)');
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}
