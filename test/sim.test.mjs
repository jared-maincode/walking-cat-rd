// Numerical sanity tests for the reaction–diffusion core. Run: npm test
import * as THREE from 'three';
import { midpointSubdivide, smoothSubdivide, positionWeld } from '../src/subdivide.js';
import { GrayScottSurface } from '../src/sim.js';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

// ---- 1. Subdivision topology: icosahedron V=12, E=30, F=20 -----------------
const ico = new THREE.IcosahedronGeometry(1, 0); // non-indexed
const sub = midpointSubdivide(ico, 2);
const V = sub.getAttribute('position').count;
const F = sub.getIndex().count / 3;
check('subdivision vertex count 12 -> 162', V === 162, `got ${V}`);
check('subdivision triangle count 20 -> 320', F === 320, `got ${F}`);

// ---- 2. Skin attributes survive subdivision with unit total weight --------
const icoSkin = new THREE.IcosahedronGeometry(1, 0);
const nVerts = icoSkin.getAttribute('position').count;
const si = new Uint16Array(nVerts * 4);
const sw = new Float32Array(nVerts * 4);
for (let i = 0; i < nVerts; i++) {
  si[i * 4] = i % 6;
  si[i * 4 + 1] = (i + 1) % 6;
  sw[i * 4] = 0.75;
  sw[i * 4 + 1] = 0.25;
}
icoSkin.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
icoSkin.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
const subSkin = midpointSubdivide(icoSkin, 1);
const w2 = subSkin.getAttribute('skinWeight');
let weightsOk = true;
for (let i = 0; i < w2.count; i++) {
  const s = w2.getX(i) + w2.getY(i) + w2.getZ(i) + w2.getW(i);
  if (Math.abs(s - 1) > 1e-4) weightsOk = false;
}
check('skin weights renormalised after subdivision', weightsOk);

// ---- 2b. Loop smoothing rounds the shape instead of just refining facets ---
// After the same number of levels, the Loop-mask surface of a sphere-ish
// polyhedron has a smaller radius spread than the plain midpoint surface.
const mid3 = midpointSubdivide(new THREE.IcosahedronGeometry(1, 0), 3);
const loop3 = smoothSubdivide(new THREE.IcosahedronGeometry(1, 0), { levels: 3, smoothLevels: 1 });
check(
  'Loop pass keeps vertex count of the same topology',
  loop3.getAttribute('position').count === mid3.getAttribute('position').count,
  `mid=${mid3.getAttribute('position').count} loop=${loop3.getAttribute('position').count}`
);
const spread = (g) => {
  const p = g.getAttribute('position').array;
  let lo = Infinity;
  let hi = 0;
  for (let i = 0; i < p.length; i += 3) {
    const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  return hi - lo;
};
check(
  'Loop mask rounds the icosahedron (smaller radius spread)',
  spread(loop3) < spread(mid3),
  `mid=${spread(mid3).toFixed(4)} loop=${spread(loop3).toFixed(4)}`
);
check(
  'Loop pass keeps skin weights normalised',
  (() => {
    const s = smoothSubdivide(icoSkin, { levels: 1, smoothLevels: 1 }).getAttribute('skinWeight');
    for (let i = 0; i < s.count; i++) {
      if (Math.abs(s.getX(i) + s.getY(i) + s.getZ(i) + s.getW(i) - 1) > 1e-4) return false;
    }
    return true;
  })()
);

// ---- 2c. positionWeld survives interleaved attributes ---------------------
// glTF assets can come with position/skinIndex/skinWeight packed into shared
// strided buffers (the fox GLB does). A raw `array[i * itemSize + c]` copy
// misreads those strides and scrambles values — for skinIndex that meant
// out-of-range bone indices crashing Box3.setFromObject on the CPU skinning
// path. Regression test: weld an interleaved geometry, attributes intact.
{
  const n = 3;
  // Mimic the fox GLB: each attribute lives in its own buffer with a stride
  // larger than its itemSize and a nonzero component offset.
  const posData = new Float32Array(n * 9);
  const idxData = new Uint16Array(n * 18);
  const wgtData = new Float32Array(n * 9);
  const pos = [];
  const idx = [];
  const wgt = [];
  const wgtRow = [0.5, 0.25, 0.125, 0.125];
  for (let i = 0; i < n; i++) {
    const p = [i + 1, i * 2 + 1, i * 3 + 1];
    const b = [(i + 1) % 5, (i + 2) % 5, (i + 3) % 5, (i + 4) % 5];
    for (let c = 0; c < 3; c++) posData[i * 9 + c] = p[c];
    for (let c = 0; c < 4; c++) idxData[i * 18 + 6 + c] = b[c];
    for (let c = 0; c < 4; c++) wgtData[i * 9 + 5 + c] = wgtRow[c];
    pos.push(...p);
    idx.push(...b);
    wgt.push(...wgtRow);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(posData, 9), 3, 0)
  );
  geo.setAttribute(
    'skinIndex',
    new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(idxData, 18), 4, 6)
  );
  geo.setAttribute(
    'skinWeight',
    new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(wgtData, 9), 4, 5)
  );
  const welded = positionWeld(geo);
  const intact = (name, expected, itemSize) => {
    const a = welded.getAttribute(name);
    if (!a || a.count !== n || a.isInterleavedBufferAttribute) return false;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < itemSize; c++) {
        if (a.getComponent(i, c) !== expected[i * itemSize + c]) return false;
      }
    }
    return true;
  };
  check('positionWeld keeps interleaved position intact', intact('position', pos, 3));
  check('positionWeld keeps interleaved skinIndex intact', intact('skinIndex', idx, 4));
  check('positionWeld keeps interleaved skinWeight intact', intact('skinWeight', wgt, 4));
}

// ---- 3. Laplacian stability bound is finite and sane ----------------------
const sim = new GrayScottSurface(sub.getAttribute('position').array, sub.getIndex().array);
check(
  'stability limit in a usable band',
  sim.stabilityLimit > 0.05 && sim.stabilityLimit < 2,
  `stabilityLimit=${sim.stabilityLimit}`
);

// ---- 4. Laplacian annihilates constants (row sums cancel) ------------------
// (L c)_i = sum_j w_ij (c - c) = 0 identically, so instead verify the weights
// are symmetric in action: apply to x and check the discrete integral ~ 0.
{
  const { rowPtr, cols, wts, vertexCount } = sim;
  const pos = sub.getAttribute('position').array;
  let integ = 0;
  for (let i = 0; i < vertexCount; i++) {
    const xi = pos[i * 3];
    let s = 0;
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
      s += wts[p] * (pos[cols[p] * 3] - xi);
    }
    integ += s; // on a closed surface, sum of (cot-laplacian x) over vertices ~ 0
  }
  check('integral of Δx over closed surface ≈ 0', Math.abs(integ) < 1, `got ${integ}`);
}

// ---- 5. Gray–Scott run: bounded, no NaN, and structure develops ------------
// Patterns need room: each vertex ≈ one canonical pixel, so 162 verts is
// under one wavelength. Use the same 4× subdivision as the app (~2.5k verts).
const big = midpointSubdivide(new THREE.IcosahedronGeometry(1, 0), 4);
const simBig = new GrayScottSurface(big.getAttribute('position').array, big.getIndex().array);
simBig.reset();
simBig.perturb(10, 2);
for (let s = 0; s < 1500; s++) simBig.step(1.0, 0.035, 0.065, 1.0, 0.5);
let nan = false;
let vmin = Infinity;
let vmax = -Infinity;
for (let i = 0; i < simBig.vertexCount; i++) {
  if (Number.isNaN(simBig.u[i]) || Number.isNaN(simBig.v[i])) nan = true;
  if (simBig.v[i] < vmin) vmin = simBig.v[i];
  if (simBig.v[i] > vmax) vmax = simBig.v[i];
}
check('no NaN after 1500 steps', !nan);
check('v stays bounded in [0, 1]', vmin >= -1e-6 && vmax <= 1, `[${vmin}, ${vmax}]`);
check('pattern develops contrast', vmax - vmin > 0.1, `range=${(vmax - vmin).toFixed(4)}`);

// reset restores a clean state
simBig.reset();
let reseedOk = true;
for (let i = 0; i < simBig.vertexCount; i++) if (simBig.u[i] !== 1 || simBig.v[i] > 0.005) reseedOk = false;
check('reset() restores u=1, v≈0', reseedOk);

process.exit(failures ? 1 : 0);
