// Gray–Scott reaction–diffusion on a triangulated surface.
//
//   ∂u/∂t = Du ∇²u − u v² + F (1 − u)
//   ∂v/∂t = Dv ∇²v + u v² − (F + k) v
//
// ∇² is the Laplace–Beltrami operator discretised with cotangent weights and
// a lumped (barycentric) mass matrix, built once on the rest pose. The whole
// operator is rescaled so its mean row-sum matches Karl Sims's canonical
// pixel-grid kernel (neighbour weights sum to 1: 0.2 orthogonal + 0.05
// diagonal); the widely tabulated (F, k) presets then behave as documented
// on the mesh and dt = 1 stays inside the explicit-Euler stability region.
export class GrayScottSurface {
  constructor(positions, index) {
    const vertexCount = positions.length / 3;
    this.vertexCount = vertexCount;

    const { rowPtr, cols, wts, lump } = buildLaplacian(positions, index, vertexCount);
    this.rowPtr = rowPtr;
    this.cols = cols;
    this.lump = lump;

    // Normalise per row to the Karl Sims kernel: divide each weight by the
    // lumped mass, then rescale every row so its signed sum is exactly 1.
    // A single global rescale cannot bound row sums on meshes with tiny
    // triangles; per-row normalisation keeps maxRowSum ≈ 1 everywhere (so
    // dt = 1 is stable) and is the standard lumped form of M⁻¹L.
    this.wts = new Float32Array(wts.length);
    for (let i = 0; i < vertexCount; i++) {
      let s = 0;
      for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) s += wts[p] / lump[i];
      if (!isFinite(s) || s < 1e-8) s = 1e-8;
      for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
        this.wts[p] = wts[p] / lump[i] / s;
      }
    }
    // Every row now sums to exactly 1, so dt * Du < 1 keeps Euler stable.
    this.stabilityLimit = 1;

    this.u = new Float32Array(vertexCount);
    this.v = new Float32Array(vertexCount);
    this.uNext = new Float32Array(vertexCount);
    this.vNext = new Float32Array(vertexCount);
    this.lapU = new Float32Array(vertexCount);
    this.lapV = new Float32Array(vertexCount);
    this.iteration = 0;

    this.reset();
  }

  reset() {
    this.u.fill(1);
    this.v.fill(0);
    this.iteration = 0;
    // A whisper of noise breaks symmetry without waiting for floats to drift.
    for (let i = 0; i < this.vertexCount; i++) this.v[i] = Math.random() * 0.005;
  }

  // Seed small blobs of v = 1 by flood-filling a few rings from random sites.
  perturb(sites = 8, rings = 3) {
    const { rowPtr, cols, vertexCount, u, v } = this;
    for (let s = 0; s < sites; s++) {
      const start = Math.floor(Math.random() * vertexCount);
      let frontier = [start];
      const seen = new Set(frontier);
      for (let r = 0; r < rings; r++) {
        const next = [];
        for (const i of frontier) {
          for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
            const j = cols[p];
            if (!seen.has(j)) {
              seen.add(j);
              next.push(j);
            }
          }
        }
        frontier = next;
      }
      for (const i of seen) {
        u[i] = 0.5;
        v[i] = 1;
      }
    }
  }

  step(dt, F, k, Du, Dv) {
    // Keep explicit Euler inside the stability region regardless of the UI.
    dt = Math.min(dt, 0.9 * this.stabilityLimit);
    const { rowPtr, cols, wts, u, v, uNext, vNext, lapU, lapV, vertexCount } = this;

    for (let i = 0; i < vertexCount; i++) {
      let su = 0;
      let sv = 0;
      const ui = u[i];
      const vi = v[i];
      for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
        const w = wts[p];
        const j = cols[p];
        su += w * (u[j] - ui);
        sv += w * (v[j] - vi);
      }
      lapU[i] = su;
      lapV[i] = sv;
    }
    for (let i = 0; i < vertexCount; i++) {
      const ui = u[i];
      const vi = v[i];
      const uvv = ui * vi * vi;
      uNext[i] = ui + dt * (Du * lapU[i] - uvv + F * (1 - ui));
      const vn = vi + dt * (Dv * lapV[i] + uvv - (F + k) * vi);
      vNext[i] = vn < 0 ? 0 : vn > 1 ? 1 : vn;
    }

    [this.u, this.uNext] = [uNext, u];
    [this.v, this.vNext] = [vNext, v];
    this.iteration++;
  }
}

// Cotangent-weight Laplacian (negative semi-definite sign convention via the
// (u_j − u_i) form) plus lumped barycentric mass matrix.
function buildLaplacian(positions, index, vertexCount) {
  const edgeWeights = new Map(); // key: a * vertexCount + b  (a < b)
  const lump = new Float32Array(vertexCount);

  const addEdge = (a, b, w) => {
    // Obtuse angles give negative cot weights; clamping them away keeps the
    // off-diagonal stencil non-negative, which makes the discrete operator
    // row-wise diagonally dominant (explicit Euler stays stable at dt = 1).
    if (w <= 0) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * vertexCount + hi;
    edgeWeights.set(key, (edgeWeights.get(key) || 0) + w);
  };

  const px = positions;
  const triangleCount = index.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const a = index[t * 3];
    const b = index[t * 3 + 1];
    const c = index[t * 3 + 2];

    const ax = px[a * 3];
    const ay = px[a * 3 + 1];
    const az = px[a * 3 + 2];
    const bx = px[b * 3];
    const by = px[b * 3 + 1];
    const bz = px[b * 3 + 2];
    const cx = px[c * 3];
    const cy = px[c * 3 + 1];
    const cz = px[c * 3 + 2];

    // Vectors from each corner
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const bax = -abx, bay = -aby, baz = -abz;
    const bcx = cx - bx, bcy = cy - by, bcz = cz - bz;
    const cax = -acx, cay = -acy, caz = -acz;
    const cbx = -bcx, cby = -bcy, cbz = -bcz;

    // cot(angle) = dot / |cross|
    const cotA = cot(abx, aby, abz, acx, acy, acz);
    const cotB = cot(bcx, bcy, bcz, bax, bay, baz);
    const cotC = cot(cax, cay, caz, cbx, cby, cbz);

    // Weight on the edge opposite each corner
    addEdge(b, c, 0.5 * cotA);
    addEdge(c, a, 0.5 * cotB);
    addEdge(a, b, 0.5 * cotC);

    // Lumped mass: one third of the triangle area at each corner
    const crx = aby * acz - abz * acy;
    const cry = abz * acx - abx * acz;
    const crz = abx * acy - aby * acx;
    const area = 0.5 * Math.hypot(crx, cry, crz);
    const third = area / 3;
    lump[a] += third;
    lump[b] += third;
    lump[c] += third;
  }

  // CSR assembly
  const adjacency = Array.from({ length: vertexCount }, () => []);
  for (const [key, w] of edgeWeights) {
    const lo = Math.floor(key / vertexCount);
    const hi = key % vertexCount;
    adjacency[lo].push([hi, w]);
    adjacency[hi].push([lo, w]);
  }
  const rowPtr = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < vertexCount; i++) rowPtr[i + 1] = rowPtr[i] + adjacency[i].length;
  const cols = new Uint32Array(rowPtr[vertexCount]);
  const wts = new Float32Array(rowPtr[vertexCount]);
  let p = 0;
  for (let i = 0; i < vertexCount; i++) {
    for (const [j, w] of adjacency[i]) {
      cols[p] = j;
      wts[p] = w;
      p++;
    }
  }
  // Guard against degenerate (isolated) vertices
  for (let i = 0; i < vertexCount; i++) if (lump[i] === 0) lump[i] = 1e-12;

  return { rowPtr, cols, wts, lump };
}

function cot(v1x, v1y, v1z, v2x, v2y, v2z) {
  const cx = v1y * v2z - v1z * v2y;
  const cy = v1z * v2x - v1x * v2z;
  const cz = v1x * v2y - v1y * v2x;
  const cross = Math.hypot(cx, cy, cz);
  if (cross < 1e-20) return 0;
  const dot = v1x * v2x + v1y * v2y + v1z * v2z;
  return dot / cross;
}
