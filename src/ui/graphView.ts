import { isAnimated } from '../core/anim';
import { connect, disconnect, getNode, inputSource } from '../core/graph';
import { NODE_DEFS, NODE_LIST, type NodeDef } from '../core/nodes';
import type { NodeData } from '../core/types';
import type { App } from './app';
import { h } from './dom';

const NODE_W = 152;
const HEAD_H = 26;
const ROW_H = 18;
const SVG_NS = 'http://www.w3.org/2000/svg';

const nodeHeight = (def: NodeDef) => HEAD_H + Math.max(1, def.inputs.length) * ROW_H + 8;
const outPos = (n: NodeData): [number, number] => [n.x + NODE_W, n.y + HEAD_H / 2];
const inPos = (n: NodeData, i: number): [number, number] => [n.x, n.y + HEAD_H + 4 + ROW_H * i + ROW_H / 2];

function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number; moved: boolean }
  | { kind: 'node'; id: string; dx: number; dy: number; moved: boolean }
  /** `from` set: dragging out of an output, looking for an input. `to` set: the reverse. */
  | { kind: 'wire'; from?: string; to?: { id: string; input: number }; changed: boolean };

/** The node graph editor: DOM nodes over an SVG wire layer, inside a pan/zoom world transform. */
export class GraphView {
  private world = h('div', { class: 'graph-world' });
  private wires = document.createElementNS(SVG_NS, 'svg');
  private wireGroup = document.createElementNS(SVG_NS, 'g');
  private ghost = document.createElementNS(SVG_NS, 'path');
  private nodeLayer = h('div', { class: 'graph-nodes' });
  private menu: HTMLElement | null = null;
  private pan = { x: 60, y: 60 };
  private zoom = 1;
  private drag: Drag | null = null;
  private mouse = { x: 0, y: 0 };
  private lastDown = { id: '', t: 0 };

  constructor(
    private readonly app: App,
    private readonly el: HTMLElement,
  ) {
    this.wires.classList.add('graph-wires');
    this.ghost.classList.add('wire', 'ghost');
    this.wires.append(this.wireGroup, this.ghost);
    this.world.append(this.wires, this.nodeLayer);
    el.append(
      this.world,
      h('div', { class: 'graph-hint' }, 'Tab add node · drag port to wire · double-click to view · 1 / 2 set viewer A / B · F frame all'),
    );
    el.tabIndex = 0;

    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', () => (this.drag = null));
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openMenu(e.clientX, e.clientY);
    });
    app.subscribe((c) => {
      if (c === 'structure') this.render();
    });
    this.render();
  }

  // ───────────────────────── Coordinates ─────────────────────────

  private toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [(clientX - r.left - this.pan.x) / this.zoom, (clientY - r.top - this.pan.y) / this.zoom];
  }

  private applyTransform(): void {
    this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
    this.el.style.backgroundPosition = `${this.pan.x}px ${this.pan.y}px`;
    this.el.style.backgroundSize = `${24 * this.zoom}px ${24 * this.zoom}px`;
  }

  /** Fit the whole graph in view. */
  frameAll(): void {
    const nodes = this.app.project.nodes;
    const r = this.el.getBoundingClientRect();
    if (nodes.length === 0 || r.width === 0) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + NODE_W);
      y1 = Math.max(y1, n.y + nodeHeight(NODE_DEFS[n.type]));
    }
    const pad = 48;
    this.zoom = Math.min(1.25, Math.max(0.3, Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0))));
    this.pan.x = (r.width - (x1 - x0) * this.zoom) / 2 - x0 * this.zoom;
    this.pan.y = (r.height - (y1 - y0) * this.zoom) / 2 - y0 * this.zoom;
    this.applyTransform();
  }

  // ───────────────────────── Rendering ─────────────────────────

  render(): void {
    const { project, selected, renderer } = this.app;
    const byId = new Map(project.nodes.map((n) => [n.id, n]));

    this.wireGroup.replaceChildren();
    for (const e of project.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const path = document.createElementNS(SVG_NS, 'path');
      path.classList.add('wire');
      if (e.from === selected || e.to === selected) path.classList.add('hot');
      const [x1, y1] = outPos(a);
      const [x2, y2] = inPos(b, e.input);
      path.setAttribute('d', wirePath(x1, y1, x2, y2));
      this.wireGroup.append(path);
    }

    this.nodeLayer.replaceChildren();
    for (const n of project.nodes) {
      const def = NODE_DEFS[n.type];
      const animated = Object.values(n.params).some((v) => isAnimated(v));
      const badges = [
        project.viewA === n.id && h('span', { class: 'badge a', title: 'Viewer A' }, 'A'),
        project.viewB === n.id && h('span', { class: 'badge b', title: 'Viewer B (wipe)' }, 'B'),
        animated && h('span', { class: 'badge k', title: 'Has keyframes' }, '◆'),
      ];
      const el = h(
        'div',
        {
          class: `node cat-${def.category.toLowerCase()}${n.id === selected ? ' selected' : ''}${renderer.errors.has(n.type) ? ' error' : ''}`,
          'data-id': n.id,
          title: renderer.errors.get(n.type) ?? def.help,
          style: `left:${n.x}px;top:${n.y}px;width:${NODE_W}px;height:${nodeHeight(def)}px`,
        },
        h('div', { class: 'node-head' }, h('span', { class: 'node-title' }, n.label || def.label), ...badges),
        ...def.inputs.map((name, i) =>
          h(
            'div',
            { class: 'node-row', style: `top:${HEAD_H + 4 + ROW_H * i}px` },
            h('span', {
              class: `port in${inputSource(project, n.id, i) ? ' wired' : ''}`,
              'data-id': n.id,
              'data-input': String(i),
            }),
            name,
          ),
        ),
        def.inputs.length === 0 && h('div', { class: 'node-row muted', style: `top:${HEAD_H + 4}px` }, def.category.toLowerCase()),
        h('span', { class: 'port out', 'data-id': n.id, style: `top:${HEAD_H / 2 - 6}px` }),
      );
      this.nodeLayer.append(el);
    }
    this.applyTransform();
  }

  // ───────────────────────── Pointer interaction ─────────────────────────

  private onDown(e: PointerEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('.add-menu')) return;
    this.closeMenu();
    this.el.focus({ preventScroll: true });
    const port = t.closest<HTMLElement>('.port');
    const nodeEl = t.closest<HTMLElement>('.node');
    const { project } = this.app;

    if (e.button === 0 && port) {
      const id = port.dataset.id!;
      if (port.classList.contains('out')) this.drag = { kind: 'wire', from: id, changed: false };
      else {
        const input = Number(port.dataset.input);
        const src = inputSource(project, id, input);
        if (src) {
          // Grabbing a wired input picks the wire up by its far end, so it can be re-routed or dropped.
          disconnect(project, id, input);
          this.drag = { kind: 'wire', from: src, changed: true };
          this.render();
        } else this.drag = { kind: 'wire', to: { id, input }, changed: false };
      }
    } else if (e.button === 0 && nodeEl) {
      const id = nodeEl.dataset.id!;
      const node = getNode(project, id)!;
      const now = performance.now();
      if (this.lastDown.id === id && now - this.lastDown.t < 350) {
        this.app.setView('A', id);
        this.lastDown.t = 0;
        return;
      }
      this.lastDown = { id, t: now };
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      this.drag = { kind: 'node', id, dx: wx - node.x, dy: wy - node.y, moved: false };
      this.app.select(id);
    } else if (e.button !== 2) {
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: this.pan.x, py: this.pan.y, moved: false };
    } else return;
    this.el.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    this.mouse = { x: e.clientX, y: e.clientY };
    const d = this.drag;
    if (!d) return;
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    if (d.kind === 'pan') {
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      this.pan.x = d.px + e.clientX - d.sx;
      this.pan.y = d.py + e.clientY - d.sy;
      this.applyTransform();
    } else if (d.kind === 'node') {
      const node = getNode(this.app.project, d.id);
      if (!node) return;
      const nx = Math.round(wx - d.dx);
      const ny = Math.round(wy - d.dy);
      if (nx !== node.x || ny !== node.y) {
        node.x = nx;
        node.y = ny;
        d.moved = true;
        this.render();
      }
    } else {
      let path: string;
      if (d.from) {
        const n = getNode(this.app.project, d.from)!;
        const [x, y] = outPos(n);
        path = wirePath(x, y, wx, wy);
      } else {
        const n = getNode(this.app.project, d.to!.id)!;
        const [x, y] = inPos(n, d.to!.input);
        path = wirePath(wx, wy, x, y);
      }
      this.ghost.setAttribute('d', path);
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);

    if (d.kind === 'pan') {
      if (!d.moved) this.app.select(null);
      return;
    }
    if (d.kind === 'node') {
      if (d.moved) this.app.commit();
      return;
    }

    this.ghost.setAttribute('d', '');
    const { project } = this.app;
    const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const port = hit?.closest<HTMLElement>('.port');
    const nodeEl = hit?.closest<HTMLElement>('.node');
    let attempted = false;
    let ok = false;

    if (d.from) {
      if (port?.classList.contains('in')) {
        attempted = true;
        ok = connect(project, d.from, port.dataset.id!, Number(port.dataset.input));
      } else if (nodeEl && nodeEl.dataset.id !== d.from) {
        const id = nodeEl.dataset.id!;
        const slots = NODE_DEFS[getNode(project, id)!.type].inputs.length;
        if (slots > 0) {
          let free = 0;
          for (let i = 0; i < slots; i++) {
            if (!inputSource(project, id, i)) {
              free = i;
              break;
            }
          }
          attempted = true;
          ok = connect(project, d.from, id, free);
        }
      } else if (!nodeEl && !d.changed) {
        // Dropped on empty canvas: offer to create the next node already wired up.
        this.openMenu(e.clientX, e.clientY, d.from);
        return;
      }
    } else if (d.to) {
      const srcId = port?.classList.contains('out') ? port.dataset.id! : nodeEl?.dataset.id;
      if (srcId && srcId !== d.to.id) {
        attempted = true;
        ok = connect(project, srcId, d.to.id, d.to.input);
      }
    }

    if (attempted && !ok) this.app.toast('That wire would create a loop.');
    if (ok || d.changed) this.app.commit();
    else this.render();
  }

  private onWheel(e: WheelEvent): void {
    if ((e.target as HTMLElement).closest('.add-menu')) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const next = Math.min(2, Math.max(0.25, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    // Keep the point under the cursor fixed while zooming.
    this.pan.x = mx - ((mx - this.pan.x) / this.zoom) * next;
    this.pan.y = my - ((my - this.pan.y) / this.zoom) * next;
    this.zoom = next;
    this.applyTransform();
  }

  // ───────────────────────── Add-node menu ─────────────────────────

  /** Open the searchable node menu at the pointer (Tab), optionally wiring the new node from `from`. */
  openMenuAtPointer(): void {
    const r = this.el.getBoundingClientRect();
    const inside = this.mouse.x >= r.left && this.mouse.x <= r.right && this.mouse.y >= r.top && this.mouse.y <= r.bottom;
    const sel = this.app.selectedNode;
    if (sel) {
      // With a node selected, behave like a compositor: the new node goes downstream of it.
      const x = r.left + this.pan.x + (sel.x + NODE_W + 50) * this.zoom;
      const y = r.top + this.pan.y + sel.y * this.zoom;
      this.openMenu(x, y, sel.id, [sel.x + NODE_W + 48, sel.y + 84]);
    } else if (inside) this.openMenu(this.mouse.x, this.mouse.y);
    else this.openMenu(r.left + r.width / 2 - 110, r.top + 40);
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private openMenu(clientX: number, clientY: number, from?: string, at?: [number, number]): void {
    this.closeMenu();
    const r = this.el.getBoundingClientRect();
    // The menu is clamped to stay on screen, so the new node's position is tracked separately.
    const [wx, wy] = at ?? this.toWorld(clientX, clientY);
    const list = h('div', { class: 'add-list' });
    const input = h('input', { class: 'add-search', placeholder: 'Search nodes…', spellcheck: false });
    let matches: NodeDef[] = [];
    let active = 0;

    const pick = (def: NodeDef | undefined) => {
      if (!def) return;
      this.closeMenu();
      this.app.addNode(def.type, wx, wy - HEAD_H / 2, from);
      this.el.focus({ preventScroll: true });
    };
    const fill = () => {
      const q = input.value.trim().toLowerCase();
      matches = NODE_LIST.filter((d) => !q || d.label.toLowerCase().includes(q) || d.category.toLowerCase().includes(q));
      active = Math.min(active, Math.max(0, matches.length - 1));
      list.replaceChildren();
      let cat = '';
      matches.forEach((d, i) => {
        if (d.category !== cat) {
          cat = d.category;
          list.append(h('div', { class: 'add-cat' }, cat));
        }
        const item = h(
          'div',
          { class: `add-item cat-${d.category.toLowerCase()}${i === active ? ' active' : ''}`, title: d.help, onclick: () => pick(d) },
          h('i', {}),
          d.label,
        );
        list.append(item);
        if (i === active) queueMicrotask(() => item.scrollIntoView({ block: 'nearest' }));
      });
      if (matches.length === 0) list.append(h('div', { class: 'add-cat' }, 'No matching nodes'));
    };
    input.addEventListener('input', () => {
      active = 0;
      fill();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length);
        fill();
      } else if (e.key === 'Enter') pick(matches[active]);
      else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        this.closeMenu();
        this.el.focus({ preventScroll: true });
      }
    });

    const left = Math.min(Math.max(8, clientX - r.left), Math.max(8, r.width - 232));
    const top = Math.min(Math.max(8, clientY - r.top), Math.max(8, r.height - 308));
    this.menu = h('div', { class: 'add-menu', style: `left:${left}px;top:${top}px` }, input, list);
    this.el.append(this.menu);
    fill();
    input.focus();
  }
}
