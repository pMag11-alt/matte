import { addNode, connect, newProject } from './graph';
import type { Project } from './types';

/** Example projects. They double as fixtures: the tests load each one and check it is well formed. */

function greenscreen(): Project {
  const p = newProject();
  p.name = 'Greenscreen comp';
  p.frames = 96;

  const plate = addNode(p, 'plate', 0, 0);
  const key = addNode(p, 'keyer', 200, 0);
  const move = addNode(p, 'transform', 400, 0, {
    tx: { keys: [{ f: 1, v: 0.75, ease: 'smooth' }, { f: 30, v: -0.2, ease: 'smooth' }] },
    scale: 0.95,
  });
  const sky = addNode(p, 'backdrop', 0, 190);
  const defocus = addNode(p, 'blur', 200, 190, { radius: 5 });
  const wrap = addNode(p, 'lightwrap', 600, 0, { radius: 30, intensity: 0.9 });
  const comp = addNode(p, 'merge', 800, 95);
  const title = addNode(p, 'text', 600, 290, { text: 'matte', size: 0.2, x: 0.7, y: 0.7, weight: 2, tracking: 0 });
  const titleIn = addNode(p, 'merge', 1000, 150, {
    mix: { keys: [{ f: 34, v: 0, ease: 'smooth' }, { f: 52, v: 1, ease: 'smooth' }] },
  });
  const grade = addNode(p, 'grade', 1200, 150, { contrast: 1.08, saturation: 1.1, temp: 0.08 });
  const glow = addNode(p, 'glow', 1400, 150, { threshold: 0.9, radius: 36, intensity: 0.7 });
  const vig = addNode(p, 'vignette', 1600, 150, { amount: 0.5 });
  const grain = addNode(p, 'grain', 1800, 150, { amount: 0.3 });

  connect(p, plate.id, key.id, 0);
  connect(p, key.id, move.id, 0);
  connect(p, sky.id, defocus.id, 0);
  connect(p, move.id, wrap.id, 0);
  connect(p, defocus.id, wrap.id, 1);
  connect(p, defocus.id, comp.id, 0);
  connect(p, wrap.id, comp.id, 1);
  connect(p, comp.id, titleIn.id, 0);
  connect(p, title.id, titleIn.id, 1);
  connect(p, titleIn.id, grade.id, 0);
  connect(p, grade.id, glow.id, 0);
  connect(p, glow.id, vig.id, 0);
  connect(p, vig.id, grain.id, 0);
  p.viewA = grain.id;
  p.viewB = plate.id;
  return p;
}

function titleCard(): Project {
  const p = newProject();
  p.name = 'Glitch title';
  p.frames = 72;

  const ramp = addNode(p, 'ramp', 0, 0, { a: [0.04, 0.02, 0.16], b: [0.85, 0.2, 0.35], angle: 70 });
  const smoke = addNode(p, 'noise', 0, 170, { scale: 3, speed: 0.25, contrast: 2.2 });
  const tex = addNode(p, 'merge', 200, 60, { op: 4, mix: 0.8 });
  const text = addNode(p, 'text', 200, 250, { text: 'CUT TO', size: 0.26, tracking: 0.04 });
  const lay = addNode(p, 'merge', 400, 120);
  const glitch = addNode(p, 'glitch', 600, 120, {
    amount: {
      keys: [
        { f: 1, v: 0.1, ease: 'linear' },
        { f: 30, v: 0.25, ease: 'smooth' },
        { f: 44, v: 1, ease: 'smooth' },
      ],
    },
  });
  const next = addNode(p, 'backdrop', 600, 300, { style: 1 });
  const cut = addNode(p, 'transition', 800, 190, {
    kind: 2,
    softness: 0.15,
    progress: { keys: [{ f: 40, v: 0, ease: 'smooth' }, { f: 62, v: 1, ease: 'smooth' }] },
  });
  const ca = addNode(p, 'chroma', 1000, 190, { amount: 0.008 });
  const grain = addNode(p, 'grain', 1200, 190, { amount: 0.35 });

  connect(p, ramp.id, tex.id, 0);
  connect(p, smoke.id, tex.id, 1);
  connect(p, tex.id, lay.id, 0);
  connect(p, text.id, lay.id, 1);
  connect(p, lay.id, glitch.id, 0);
  connect(p, glitch.id, cut.id, 0);
  connect(p, next.id, cut.id, 1);
  connect(p, cut.id, ca.id, 0);
  connect(p, ca.id, grain.id, 0);
  p.viewA = grain.id;
  return p;
}

function lookDev(): Project {
  const p = newProject();
  p.name = 'Look development';
  p.frames = 120;

  const sky = addNode(p, 'backdrop', 0, 0);
  const iris = addNode(p, 'shape', 0, 170, { w: 0.62, h: 0.42, feather: 0.3 });
  const grade = addNode(p, 'grade', 200, 0, {
    exposure: { keys: [{ f: 1, v: -1.2, ease: 'smooth' }, { f: 60, v: 0.5, ease: 'smooth' }] },
    temp: 0.25,
    contrast: 1.2,
    saturation: 1.25,
  });
  const neutral = addNode(p, 'grade', 200, 170, { saturation: 0.15, exposure: -1.2, temp: -0.4 });
  const split = addNode(p, 'merge', 400, 60);
  const glow = addNode(p, 'glow', 600, 60, { threshold: 1, radius: 48, intensity: 1.1, tint: [1, 0.75, 0.5] });
  const lens = addNode(p, 'distort', 800, 60, { k: 0.12, zoom: 1.12 });
  const ca = addNode(p, 'chroma', 1000, 60, { amount: 0.0015 });
  const film = addNode(p, 'tonemap', 1200, 60);
  const grain = addNode(p, 'grain', 1400, 60);

  connect(p, sky.id, grade.id, 0);
  connect(p, sky.id, neutral.id, 0);
  connect(p, neutral.id, split.id, 0);
  connect(p, grade.id, split.id, 1);
  connect(p, iris.id, split.id, 2);
  connect(p, split.id, glow.id, 0);
  connect(p, glow.id, lens.id, 0);
  connect(p, lens.id, ca.id, 0);
  connect(p, ca.id, film.id, 0);
  connect(p, film.id, grain.id, 0);
  p.viewA = grain.id;
  p.viewB = sky.id;
  return p;
}

export const SCENES: { name: string; build: () => Project }[] = [
  { name: 'Greenscreen comp', build: greenscreen },
  { name: 'Glitch title', build: titleCard },
  { name: 'Look development', build: lookDev },
];
