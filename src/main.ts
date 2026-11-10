import './style.css';
import { newProject, sanitize } from './core/graph';
import { SCENES } from './core/scenes';
import type { Project } from './core/types';
import { App } from './ui/app';
import { download, h, isTyping } from './ui/dom';
import { GraphView } from './ui/graphView';
import { Inspector } from './ui/inspector';
import { ScopesView } from './ui/scopesView';
import { decodeProject, encodeProject } from './ui/share';
import { Timeline } from './ui/timeline';
import { Viewer } from './ui/viewer';

const RESOLUTIONS: [string, number, number][] = [
  ['960 × 540', 960, 540],
  ['1280 × 720 (HD)', 1280, 720],
  ['1920 × 1080 (Full HD)', 1920, 1080],
  ['1080 × 1080 (square)', 1080, 1080],
  ['1080 × 1920 (vertical)', 1080, 1920],
];

const SHORTCUTS: [string, string][] = [
  ['Tab', 'Add a node (searchable)'],
  ['Double-click node / 1', 'Show node in viewer (A)'],
  ['2', 'Set selected node as wipe side B'],
  ['W', 'Toggle A|B wipe'],
  ['R G B A L', 'Solo a viewer channel'],
  ['Space', 'Play / pause'],
  ['← →', 'Step one frame'],
  ['Home / End', 'First / last frame'],
  ['Delete', 'Delete selected node'],
  ['Ctrl/⌘ D', 'Duplicate selected node'],
  ['Ctrl/⌘ Z, Shift Z', 'Undo, redo'],
  ['Ctrl/⌘ S', 'Save project file'],
  ['F', 'Frame the whole graph'],
  ['Scroll / drag', 'Zoom / pan the graph'],
];

/** True when nothing was restored, so the demo should play itself. */
let firstVisit = false;

async function initialProject(): Promise<Project> {
  const m = /^#p=(.+)$/.exec(location.hash);
  if (m) {
    try {
      const p = sanitize(await decodeProject(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
      return p;
    } catch (e) {
      console.warn('[matte] could not read the shared project in the URL', e);
    }
  }
  const stored = App.stored();
  if (stored) return stored;
  firstVisit = true;
  return App.defaultProject();
}

async function main(): Promise<void> {
  const root = document.getElementById('app')!;
  const canvas = h('canvas', { class: 'gl' });
  const topbar = h('header', { class: 'topbar' });
  const viewerEl = h('section', { class: 'panel viewer' });
  const inspectorEl = h('section', { class: 'panel inspector' });
  const graphEl = h('section', { class: 'panel graph' });
  const scopesEl = h('section', { class: 'panel scopes' });
  const timelineEl = h('section', { class: 'panel timeline' });
  const toastEl = h('div', { class: 'toast' });

  let app: App;
  try {
    app = new App(canvas, await initialProject());
  } catch (e) {
    root.append(h('div', { class: 'fatal' }, h('h1', {}, 'matte needs WebGL2'), h('p', {}, (e as Error).message)));
    return;
  }

  root.append(topbar, viewerEl, inspectorEl, graphEl, scopesEl, timelineEl, toastEl);
  const viewer = new Viewer(app, viewerEl, canvas);
  new Inspector(app, inspectorEl);
  const graph = new GraphView(app, graphEl);
  const scopes = new ScopesView(app, scopesEl);
  new Timeline(app, timelineEl);

  app.onFrameDrawn = () => {
    viewer.drawn();
    scopes.update();
  };
  let toastTimer = 0;
  app.onToast = (msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
  };

  const shaderErrors = app.renderer.compileAll();
  if (Object.keys(shaderErrors).length) app.toast('Some node shaders failed to compile; see the console.');

  // ───────────────────────── Top bar ─────────────────────────

  const nameBox = h('input', {
    class: 'project-name',
    spellcheck: false,
    title: 'Project name',
    onchange: () => {
      app.project.name = nameBox.value.trim().slice(0, 80) || 'Untitled';
      app.commit('view');
    },
  });
  const fileSlug = () => app.project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'matte';

  const loadAndFrame = (p: Project) => {
    app.load(p);
    requestAnimationFrame(() => graph.frameAll());
  };

  const examples = h('select', {
    title: 'Load an example project',
    onchange: () => {
      const scene = SCENES[Number(examples.value)];
      examples.value = '';
      if (scene) loadAndFrame(scene.build());
    },
  }, h('option', { value: '' }, 'Examples…'), ...SCENES.map((s, i) => h('option', { value: String(i) }, s.name)));

  const openInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async () => {
      const file = openInput.files?.[0];
      openInput.value = '';
      if (!file) return;
      try {
        loadAndFrame(sanitize(JSON.parse(await file.text())));
      } catch (e) {
        app.toast(`Could not open that file: ${(e as Error).message}`);
      }
    },
  });

  const save = () =>
    download(new Blob([JSON.stringify(app.project, null, 2)], { type: 'application/json' }), `${fileSlug()}.matte.json`);

  const share = async () => {
    const url = `${location.origin}${location.pathname}#p=${await encodeProject(app.project)}`;
    try {
      await navigator.clipboard.writeText(url);
      app.toast('Share link copied. The whole project is in the URL.');
    } catch {
      prompt('Copy this link:', url);
    }
  };

  const exportPng = () => {
    canvas.toBlob((blob) => {
      if (blob) download(blob, `${fileSlug()}-f${String(app.frame).padStart(4, '0')}.png`);
    }, 'image/png');
  };

  let recording = false;
  const exportVideo = () => {
    if (recording) return;
    if (typeof MediaRecorder === 'undefined') {
      app.toast('This browser cannot record the canvas.');
      return;
    }
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    if (!mime) {
      app.toast('No supported video encoder found.');
      return;
    }
    recording = true;
    videoBtn.textContent = 'Recording…';
    videoBtn.classList.add('on');
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(canvas.captureStream(app.project.fps), { mimeType: mime, videoBitsPerSecond: 16_000_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      recording = false;
      videoBtn.textContent = 'Export video';
      videoBtn.classList.remove('on');
      download(new Blob(chunks, { type: mime }), `${fileSlug()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
    };
    rec.start();
    app.playOnce(() => setTimeout(() => rec.stop(), 120));
  };

  const undoBtn = h('button', { class: 'btn', title: 'Undo (Ctrl/⌘ Z)', onclick: () => app.undo() }, 'Undo');
  const redoBtn = h('button', { class: 'btn', title: 'Redo (Ctrl/⌘ Shift Z)', onclick: () => app.redo() }, 'Redo');
  const videoBtn = h('button', { class: 'btn accent', title: 'Play the range once and record it', onclick: exportVideo }, 'Export video');
  const resBox = h('select', {
    title: 'Project resolution',
    onchange: () => {
      const r = RESOLUTIONS[Number(resBox.value)];
      if (!r) return;
      app.project.width = r[1];
      app.project.height = r[2];
      app.commit();
    },
  }, ...RESOLUTIONS.map((r, i) => h('option', { value: String(i) }, r[0])));

  const help = h('div', { class: 'help-overlay', onclick: () => help.classList.remove('show') },
    h('div', { class: 'help-card' },
      h('h2', {}, 'Keyboard and mouse'),
      h('table', {}, ...SHORTCUTS.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))),
      h('p', {}, 'Images flow left to right. Everything is linear light with premultiplied alpha; the viewer applies the sRGB curve.'),
    ),
  );
  root.append(help);

  topbar.append(
    h('div', { class: 'brand' }, h('span', { class: 'logo' }), 'matte'),
    nameBox,
    examples,
    h('button', { class: 'btn', title: 'Start with an empty graph', onclick: () => loadAndFrame(newProject()) }, 'New'),
    h('button', { class: 'btn', onclick: () => openInput.click() }, 'Open'),
    openInput,
    h('button', { class: 'btn', title: 'Save project as JSON (Ctrl/⌘ S)', onclick: save }, 'Save'),
    h('button', { class: 'btn', title: 'Copy a link that contains the whole project', onclick: share }, 'Share'),
    h('span', { class: 'sep' }),
    undoBtn,
    redoBtn,
    h('span', { class: 'spacer' }),
    resBox,
    h('button', { class: 'btn', title: 'Save the current frame as PNG', onclick: exportPng }, 'Export frame'),
    videoBtn,
    h('button', { class: 'btn round', title: 'Shortcuts', onclick: () => help.classList.add('show') }, '?'),
  );

  const syncTop = () => {
    if (document.activeElement !== nameBox) nameBox.value = app.project.name;
    undoBtn.disabled = !app.history.canUndo;
    redoBtn.disabled = !app.history.canRedo;
    const i = RESOLUTIONS.findIndex((r) => r[1] === app.project.width && r[2] === app.project.height);
    resBox.value = String(i);
    document.title = `${app.project.name} — matte`;
  };
  app.subscribe(syncTop);
  syncTop();

  // ───────────────────────── Keyboard ─────────────────────────

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    if (mod && key === 'z') e.shiftKey ? app.redo() : app.undo();
    else if (mod && key === 'y') app.redo();
    else if (mod && key === 'd') app.duplicateSelected();
    else if (mod && key === 's') save();
    else if (mod || e.altKey) handled = false;
    else if (key === 'Escape') {
      help.classList.remove('show');
      app.picking = null;
      app.emit('view');
    } else if (key === 'Tab') graph.openMenuAtPointer();
    else if (key === ' ') app.setPlaying(!app.playing);
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      app.setPlaying(false);
      app.setFrame(app.frame + (key === 'ArrowRight' ? 1 : -1));
    } else if (key === 'Home') app.setFrame(1);
    else if (key === 'End') app.setFrame(app.project.frames);
    else if (key === 'Delete' || key === 'Backspace') app.deleteSelected();
    else if (key === '1' && app.selected) app.setView('A', app.selected);
    else if (key === '2' && app.selected) app.setView('B', app.selected);
    else if (key === 'w') viewer.toggleWipe();
    else if (key === 'f') graph.frameAll();
    else if (key === '?') help.classList.toggle('show');
    else if ('rgbal'.includes(key) && key.length === 1) viewer.setChannel(' rgbal'.indexOf(key));
    else handled = false;
    if (handled) e.preventDefault();
  });

  // Drop an image or video anywhere to get a Read node for it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (!file) return;
    const maxX = Math.max(0, ...app.project.nodes.map((n) => n.x));
    const node = app.addNode('read', maxX + 200, 0);
    node.label = file.name.slice(0, 40);
    app.sources.setFile(node.id, file);
    app.setView('A', node.id);
  });

  requestAnimationFrame(() => graph.frameAll());
  if (firstVisit) app.setPlaying(true);
  // Exposed for debugging from the console and for the smoke test in the README.
  (window as unknown as { matte: App }).matte = app;
}

void main();
