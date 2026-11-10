import { NODE_DEFS } from '../core/nodes';
import { getNode } from '../core/graph';
import type { App } from './app';
import { fill, h } from './dom';

const CHANNELS = ['RGB', 'R', 'G', 'B', 'A', 'L'];

/** Viewer panel: channel switches, exposure, A/B wipe and a pixel readout around the GL canvas. */
export class Viewer {
  private stage = h('div', { class: 'viewer-stage' });
  private info = h('span', { class: 'readout' });
  private names = h('span', { class: 'view-names' });
  private stats = h('span', { class: 'readout dim' });
  private channelBtns: HTMLButtonElement[];
  private checker: HTMLButtonElement;
  private wipe: HTMLButtonElement;
  private ev: HTMLInputElement;
  private evLabel = h('span', { class: 'readout' }, '0.0');
  private dragging = false;

  constructor(
    private readonly app: App,
    el: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const v = app.view;
    this.channelBtns = CHANNELS.map((c, i) =>
      h('button', {
        class: 'seg',
        title: i === 0 ? 'All channels' : `Show ${c} only (${c} key toggles)`,
        onclick: () => this.setChannel(i),
      }, c),
    );
    this.ev = h('input', {
      type: 'range',
      min: '-4',
      max: '4',
      step: '0.1',
      value: '0',
      class: 'ev',
      title: 'Viewer exposure in stops (display only). Double-click to reset.',
      oninput: () => {
        v.ev = Number(this.ev.value);
        this.changed();
      },
      ondblclick: () => {
        v.ev = 0;
        this.changed();
      },
    });
    this.checker = h('button', {
      class: 'btn small',
      title: 'Show transparency as a checkerboard',
      onclick: () => {
        v.checker = !v.checker;
        this.changed();
      },
    }, 'Checker');
    this.wipe = h('button', {
      class: 'btn small',
      title: 'Split the viewer between node A and node B (W). Drag in the viewer to move the split.',
      onclick: () => this.toggleWipe(),
    }, 'Wipe A|B');

    this.stage.append(canvas);
    el.append(
      h('div', { class: 'viewer-bar' },
        h('div', { class: 'segs' }, ...this.channelBtns),
        h('span', { class: 'bar-label' }, 'EV'), this.ev, this.evLabel,
        this.checker, this.wipe,
        h('span', { class: 'spacer' }),
        this.names,
      ),
      this.stage,
      h('div', { class: 'viewer-foot' }, this.info, h('span', { class: 'spacer' }), this.stats),
    );

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', () => (this.dragging = false));
    canvas.addEventListener('pointerleave', () => (this.info.textContent = ''));
    app.subscribe(() => this.paint());
    this.paint();
  }

  private changed(): void {
    this.app.emit('view');
    this.app.requestRender();
  }

  setChannel(i: number): void {
    this.app.view.channel = this.app.view.channel === i ? 0 : i;
    this.changed();
  }

  toggleWipe(): void {
    const { app } = this;
    if (!app.project.viewB) {
      app.toast('Select a node and press 2 to choose the B side of the wipe.');
      return;
    }
    app.view.wipe = !app.view.wipe;
    this.changed();
  }

  /** Called after each rendered frame. */
  drawn(): void {
    const r = this.app.renderer;
    const p = this.app.project;
    this.stats.textContent = `${p.width}×${p.height} · ${r.float ? '16-bit float linear' : '8-bit'} · ${r.lastDrawn} node${r.lastDrawn === 1 ? '' : 's'} redrawn`;
  }

  private uv(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  private onDown(e: PointerEvent): void {
    const [u, v] = this.uv(e);
    const { app } = this;
    if (app.picking) {
      const done = app.picking;
      app.picking = null;
      done(app.renderer.pick(u, v));
      app.emit('view');
      return;
    }
    if (app.view.wipe && app.project.viewB) {
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      app.view.wipeX = Math.min(1, Math.max(0, u));
      app.requestRender();
    }
  }

  private onMove(e: PointerEvent): void {
    const [u, v] = this.uv(e);
    const { app } = this;
    if (this.dragging) {
      app.view.wipeX = Math.min(1, Math.max(0, u));
      app.requestRender();
    }
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    const [r, g, b] = app.renderer.pick(u, v);
    const x = Math.floor(u * app.project.width);
    const y = Math.floor(v * app.project.height);
    this.info.textContent = `x ${x}  y ${y}   R ${r.toFixed(3)}  G ${g.toFixed(3)}  B ${b.toFixed(3)}`;
  }

  private paint(): void {
    const { app } = this;
    const v = app.view;
    this.channelBtns.forEach((b, i) => b.classList.toggle('on', v.channel === i));
    this.checker.classList.toggle('on', v.checker);
    this.wipe.classList.toggle('on', v.wipe && !!app.project.viewB);
    this.ev.value = String(v.ev);
    this.evLabel.textContent = (v.ev > 0 ? '+' : '') + v.ev.toFixed(1);
    this.stage.classList.toggle('picking', !!app.picking);
    const name = (id: string | null) => {
      const n = getNode(app.project, id);
      return n ? n.label || NODE_DEFS[n.type].label : '—';
    };
    fill(
      this.names,
      h('span', { class: 'badge a' }, 'A'), name(app.project.viewA),
      app.project.viewB ? h('span', { class: 'badge b' }, 'B') : null,
      app.project.viewB ? name(app.project.viewB) : null,
    );
  }
}
