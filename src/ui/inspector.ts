import { evaluate, hasKeyAt, isAnimated } from '../core/anim';
import { hexToRgb, rgbToHex } from '../core/color';
import { NODE_DEFS, type ParamDef } from '../core/nodes';
import type { NodeData, Scalar } from '../core/types';
import type { App } from './app';
import { fill, h } from './dom';

/** Parameter panel for the selected node. Rebuilt on structural changes, synced in place otherwise. */
export class Inspector {
  /** One per control: pull the current value from the model into the DOM. */
  private sync: (() => void)[] = [];

  constructor(
    private readonly app: App,
    private readonly el: HTMLElement,
  ) {
    app.subscribe((c) => {
      if (c === 'structure') this.build();
      else if (c === 'params' || c === 'frame') for (const fn of this.sync) fn();
    });
    this.build();
  }

  private value(node: NodeData, def: ParamDef) {
    const v = node.params[def.name];
    return v === undefined ? def.default : evaluate(v, this.app.frame);
  }

  private build(): void {
    this.sync = [];
    const node = this.app.selectedNode;
    if (!node) {
      this.el.replaceChildren(
        h('div', { class: 'panel-title' }, 'Inspector'),
        h(
          'div',
          { class: 'empty' },
          h('p', {}, 'Select a node to edit it.'),
          h('p', {}, 'Every numeric and colour parameter can be keyframed with the ◆ button; once a parameter has keys, changing it writes a key at the playhead.'),
        ),
      );
      return;
    }
    const def = NODE_DEFS[node.type];
    const label = h('input', {
      class: 'node-label',
      value: node.label ?? '',
      placeholder: def.label,
      spellcheck: false,
      onchange: () => {
        const v = label.value.trim().slice(0, 40);
        if (v) node.label = v;
        else delete node.label;
        this.app.commit();
      },
    });
    const rows = def.params.map((p) => this.row(node, p));
    fill(
      this.el,
      h('div', { class: 'panel-title' }, 'Inspector', h('span', { class: `chip cat-${def.category.toLowerCase()}` }, def.category)),
      label,
      h('p', { class: 'help' }, def.help),
      def.source === 'file' && this.fileRow(node),
      ...rows,
      this.app.renderer.errors.has(node.type) && h('pre', { class: 'shader-error' }, this.app.renderer.errors.get(node.type)!),
    );
  }

  private fileRow(node: NodeData): HTMLElement {
    const name = this.app.sources.fileName(node.id);
    const input = h('input', {
      type: 'file',
      accept: 'image/*,video/*',
      hidden: true,
      onchange: () => {
        const file = input.files?.[0];
        if (!file) return;
        this.app.sources.setFile(node.id, file);
        if (!node.label) node.label = file.name.slice(0, 40);
        this.app.commit();
      },
    });
    return h(
      'div',
      { class: 'row file' },
      h('button', { class: 'btn wide', onclick: () => input.click() }, name ? 'Replace file…' : 'Choose image or video…'),
      input,
      h('span', { class: 'file-name' }, name ?? 'Files stay on this machine; nothing is uploaded.'),
    );
  }

  private keyButton(node: NodeData, def: ParamDef): HTMLElement {
    const btn = h('button', {
      class: 'key',
      title: 'Add or remove a keyframe at the playhead',
      onclick: () => this.app.toggleKey(node, def.name, this.value(node, def) as Scalar),
    }, '◆');
    const paint = () => {
      const v = node.params[def.name];
      btn.classList.toggle('animated', isAnimated(v));
      btn.classList.toggle('on', hasKeyAt(v, this.app.frame));
    };
    this.sync.push(paint);
    paint();
    return btn;
  }

  private row(node: NodeData, def: ParamDef): HTMLElement {
    const app = this.app;
    const name = h('label', {
      title: 'Double-click to reset',
      ondblclick: () => {
        delete node.params[def.name];
        app.commit('structure');
      },
    }, def.label);

    if (def.type === 'float') {
      const fmt = (v: number) => String(Number(v.toFixed(4)));
      const range = h('input', { type: 'range', min: String(def.min), max: String(def.max), step: String(def.step) });
      const box = h('input', { type: 'number', step: String(def.step), class: 'num' });
      range.addEventListener('input', () => {
        box.value = range.value;
        app.setParam(node, def.name, Number(range.value), true);
      });
      range.addEventListener('change', () => app.commit('params'));
      box.addEventListener('change', () => {
        const v = Number(box.value);
        if (Number.isFinite(v)) app.setParam(node, def.name, v);
      });
      const pull = () => {
        const v = this.value(node, def) as number;
        if (document.activeElement !== range) range.value = String(v);
        if (document.activeElement !== box) box.value = fmt(v);
      };
      this.sync.push(pull);
      pull();
      return h('div', { class: 'row' }, name, range, box, this.keyButton(node, def));
    }

    if (def.type === 'color') {
      const input = h('input', { type: 'color' });
      input.addEventListener('input', () => app.setParam(node, def.name, hexToRgb(input.value), true));
      input.addEventListener('change', () => app.commit('params'));
      const pick = h('button', {
        class: 'btn small',
        title: 'Pick this colour from the viewer',
        onclick: () => {
          app.picking = (rgb) => app.setParam(node, def.name, rgb);
          app.emit('view');
          app.toast('Click in the viewer to sample a colour.');
        },
      }, 'Pick');
      const pull = () => {
        if (document.activeElement !== input) input.value = rgbToHex(this.value(node, def) as number[]);
      };
      this.sync.push(pull);
      pull();
      return h('div', { class: 'row' }, name, h('div', { class: 'grow color' }, input, pick), this.keyButton(node, def));
    }

    if (def.type === 'enum') {
      const select = h('select', { onchange: () => app.setParam(node, def.name, Number(select.value)) },
        ...def.options.map((o, i) => h('option', { value: String(i) }, o)));
      const pull = () => (select.value = String(this.value(node, def)));
      this.sync.push(pull);
      pull();
      return h('div', { class: 'row' }, name, h('div', { class: 'grow' }, select));
    }

    if (def.type === 'bool') {
      const box = h('input', { type: 'checkbox', onchange: () => app.setParam(node, def.name, box.checked ? 1 : 0) });
      const pull = () => (box.checked = Number(this.value(node, def)) > 0.5);
      this.sync.push(pull);
      pull();
      return h('div', { class: 'row' }, name, h('div', { class: 'grow' }, box));
    }

    const text = h('input', { type: 'text', class: 'text', spellcheck: false });
    text.addEventListener('input', () => app.setParam(node, def.name, text.value, true));
    text.addEventListener('change', () => app.commit('params'));
    const pull = () => {
      if (document.activeElement !== text) text.value = String(this.value(node, def));
    };
    this.sync.push(pull);
    pull();
    return h('div', { class: 'row' }, name, h('div', { class: 'grow' }, text));
  }
}
