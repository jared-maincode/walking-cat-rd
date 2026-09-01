// Pipeline smoke test against the real assets: load -> weld -> subdivide
// -> sim built -> 500 steps. Mirrors the per-model configs in main.js.
// Run: npm run smoke
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { smoothSubdivide, positionWeld } from '../src/subdivide.js';
import { GrayScottSurface } from '../src/sim.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
};

const MODELS = [
  { key: 'cat', file: 'cat.fbx', format: 'fbx', levels: 3, smooth: 1 },
  { key: 'fox', file: 'fox.glb', format: 'gltf', levels: 3, smooth: 1 },
];

for (const m of MODELS) {
  console.log(`\n[${m.key}] public/models/${m.file}`);
  const buffer = readFileSync(new URL(`../public/models/${m.file}`, import.meta.url));
  const src = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  let root;
  if (m.format === 'gltf') {
    const gltf = await new Promise((resolve, reject) =>
      new GLTFLoader().parse(src, '', resolve, reject)
    );
    root = gltf.scene;
  } else {
    root = new FBXLoader().parse(src, '');
  }

  const skinned = root.getObjectByProperty('isSkinnedMesh', true);
  check(`${m.key}: SkinnedMesh present in ${m.file}`, !!skinned);
  if (!skinned) continue;

  let geom = positionWeld(skinned.geometry, 1e-6);
  geom = smoothSubdivide(geom, { levels: m.levels, smoothLevels: m.smooth });
  geom.computeVertexNormals();
  const posAttr = geom.getAttribute('position');
  const idx = geom.getIndex();
  console.log(`  verts=${posAttr.count} tris=${idx.count / 3} skinned=${!!geom.getAttribute('skinWeight')}`);
  check(`${m.key}: skin attributes survived welding + subdivision`, !!geom.getAttribute('skinWeight'));
  check(`${m.key}: pattern resolution (>=10k vertices)`, posAttr.count >= 10000, `got ${posAttr.count}`);

  const sim = new GrayScottSurface(new Float32Array(posAttr.array), idx.array);
  console.log(`  stabilityLimit=${sim.stabilityLimit.toFixed(4)}`);
  check(`${m.key}: stability limit at the Karl Sims value`, Math.abs(sim.stabilityLimit - 1) < 1e-3, `got ${sim.stabilityLimit}`);

  sim.perturb(8, 4);
  const t0 = performance.now();
  for (let s = 0; s < 500; s++) sim.step(1.0, 0.035, 0.065, 1.0, 0.5);
  const ms = (performance.now() - t0) / 500;

  let nan = false;
  let vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < sim.vertexCount; i++) {
    if (Number.isNaN(sim.u[i]) || Number.isNaN(sim.v[i])) nan = true;
    if (sim.v[i] < vmin) vmin = sim.v[i];
    if (sim.v[i] > vmax) vmax = sim.v[i];
  }
  check(`${m.key}: no NaN after 500 steps at dt=1`, !nan);
  check(`${m.key}: pattern contrast develops`, vmax - vmin > 0.1, `range=${(vmax - vmin).toFixed(4)}`);
  console.log(`  v∈[${vmin.toFixed(3)}, ${vmax.toFixed(3)}]  ${ms.toFixed(3)} ms/step`);
  check(`${m.key}: fast enough for 10 substeps/frame`, ms * 10 < 16, `${(ms * 10).toFixed(2)} ms/frame`);
}

process.exit(failures ? 1 : 0);
