import * as THREE from 'three';

// Midpoint (1-to-4) triangle subdivision for an indexed BufferGeometry.
// Position/normal/uv are linearly interpolated; skinIndex/skinWeight are
// blended by averaging endpoint influences and keeping the top 4 bones.
// Non-indexed input is welded first so edges are shared.
export function midpointSubdivide(geometry, iterations = 1) {
  let g = geometry.index ? geometry : positionWeld(geometry);
  for (let i = 0; i < iterations; i++) g = subdivideOnce(g);
  return g;
}

// Weld coincident vertices by position alone (HQ's mergeVertices compares all
// attributes, so mirrored UVs / split normals would keep copies separate and
// tear the surface). Other attributes take their value from the first copy.
export function positionWeld(geometry, tolerance = 1e-5) {
  if (geometry.index) return geometry;
  const src = geometry.attributes;
  const pos = src.position;
  const count = pos.count;
  const map = new Map();
  const remap = new Uint32Array(count);
  const keepers = [];
  for (let i = 0; i < count; i++) {
    const key =
      Math.round(pos.getX(i) / tolerance) * 73856093 +
      Math.round(pos.getY(i) / tolerance) * 19349663 +
      Math.round(pos.getZ(i) / tolerance) * 83492791;
    let v = map.get(key);
    if (v === undefined) {
      v = keepers.length;
      map.set(key, v);
      keepers.push(i);
    }
    remap[i] = v;
  }
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(src)) {
    const a = src[name];
    // glTF assets can arrive with interleaved attributes (the fox GLB does);
    // read through the attribute API so strides/offsets are honoured, and
    // write out a fresh packed array.
    const arr = new a.array.constructor(keepers.length * a.itemSize);
    const copy = new THREE.BufferAttribute(arr, a.itemSize, a.normalized);
    for (let d = 0; d < keepers.length; d++) {
      const s = keepers[d];
      for (let c = 0; c < a.itemSize; c++) copy.setComponent(d, c, a.getComponent(s, c));
    }
    out.setAttribute(name, copy);
  }
  out.setIndex(Array.from(remap));
  return out;
}

function subdivideOnce(geometry) {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const si = geometry.getAttribute('skinIndex');
  const sw = geometry.getAttribute('skinWeight');
  const index = geometry.getIndex();

  const positions = Array.from(pos.array);
  const normals = nrm ? Array.from(nrm.array) : null;
  const uvs = uv ? Array.from(uv.array) : null;
  const skinIndices = si ? Array.from(si.array) : null;
  const skinWeights = sw ? Array.from(sw.array) : null;

  let vertexCount = pos.count;
  const edgeCache = new Map();
  const newIndex = [];

  const pushMid = (a, b) => {
    const key = a < b ? a * 16777216 + b : b * 16777216 + a;
    const cached = edgeCache.get(key);
    if (cached !== undefined) return cached;

    const m = vertexCount++;
    for (let c = 0; c < 3; c++) {
      positions.push((positions[a * 3 + c] + positions[b * 3 + c]) / 2);
    }
    if (normals) {
      let nx = (normals[a * 3] + normals[b * 3]) / 2;
      let ny = (normals[a * 3 + 1] + normals[b * 3 + 1]) / 2;
      let nz = (normals[a * 3 + 2] + normals[b * 3 + 2]) / 2;
      const l = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / l, ny / l, nz / l);
    }
    if (uvs) {
      uvs.push((uvs[a * 2] + uvs[b * 2]) / 2, (uvs[a * 2 + 1] + uvs[b * 2 + 1]) / 2);
    }
    if (skinIndices && skinWeights) {
      const { idx, wgt } = blendSkin(skinIndices, skinWeights, a, b);
      skinIndices.push(idx[0], idx[1], idx[2], idx[3]);
      skinWeights.push(wgt[0], wgt[1], wgt[2], wgt[3]);
    }
    edgeCache.set(key, m);
    return m;
  };

  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    if (a === b || b === c || c === a) continue;
    const ab = pushMid(a, b);
    const bc = pushMid(b, c);
    const ca = pushMid(c, a);
    newIndex.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals) out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (uvs) out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (skinIndices) {
    out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    out.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  }
  out.setIndex(newIndex);
  return out;
}

// One Loop-subdivision pass: same 1-to-4 split as midpoint subdivision, but
// interior vertices are repositioned with the Loop beta mask and interior
// edge vertices with the 3/8–1/8 mask, so the surface rounds out toward the
// smooth limit surface instead of converging to the original facets. Boundary
// verts/edges (seams, open edges) fall back to midpoint so they don't shrink.
// Normal/uv attributes are dropped — callers recompute normals afterwards.
export function loopRefine(geometry) {
  const g = geometry.index ? geometry : positionWeld(geometry);
  const pos = g.getAttribute('position');
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const index = g.getIndex();
  const vertexCount = pos.count;

  // Face list (degenerate triangles skipped, matching subdivideOnce) and
  // edge → incident faces map.
  const faces = [];
  const edges = new Map();
  const edgeKey = (a, b) => (a < b ? a * 16777216 + b : b * 16777216 + a);
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    if (a === b || b === c || c === a) continue;
    faces.push(a, b, c);
    for (const [p, q, opp] of [[a, b, c], [b, c, a], [c, a, b]]) {
      const key = edgeKey(p, q);
      let e = edges.get(key);
      if (!e) {
        e = { a: Math.min(p, q), b: Math.max(p, q), opp: [] };
        edges.set(key, e);
      }
      e.opp.push(opp);
    }
  }

  // Interior test: a vertex is interior iff every incident edge has exactly 2
  // incident faces and it is surrounded by as many faces as edges.
  const faceCount = new Uint32Array(vertexCount);
  for (let f = 0; f < faces.length; f++) faceCount[faces[f]]++;
  const incidentEdges = new Uint32Array(vertexCount);
  const incidentInterior = new Uint32Array(vertexCount);
  const neighbours = new Map();
  for (const e of edges.values()) {
    const interior = e.opp.length === 2 ? 1 : 0;
    for (const v of [e.a, e.b]) {
      incidentEdges[v]++;
      incidentInterior[v] += interior;
    }
    if (!neighbours.has(e.a)) neighbours.set(e.a, []);
    if (!neighbours.has(e.b)) neighbours.set(e.b, []);
    neighbours.get(e.a).push(e.b);
    neighbours.get(e.b).push(e.a);
  }

  const px = pos.array;
  // Reposition existing interior vertices with the Loop beta mask. Updates
  // are computed from the original positions only.
  const smoothed = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const n = incidentEdges[i];
    const interior = n > 0 && n === faceCount[i] && n === incidentInterior[i];
    if (!interior) {
      smoothed[i * 3] = px[i * 3];
      smoothed[i * 3 + 1] = px[i * 3 + 1];
      smoothed[i * 3 + 2] = px[i * 3 + 2];
      continue;
    }
    const beta = (1 / n) * (5 / 8 - (3 / 8 + Math.cos((2 * Math.PI) / n) / 4) ** 2);
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const j of neighbours.get(i)) {
      sx += px[j * 3];
      sy += px[j * 3 + 1];
      sz += px[j * 3 + 2];
    }
    const k = 1 - n * beta;
    smoothed[i * 3] = k * px[i * 3] + beta * sx;
    smoothed[i * 3 + 1] = k * px[i * 3 + 1] + beta * sy;
    smoothed[i * 3 + 2] = k * px[i * 3 + 2] + beta * sz;
  }

  const positions = Array.from(smoothed);
  const skinIndices = si ? Array.from(si.array) : null;
  const skinWeights = sw ? Array.from(sw.array) : null;
  let count = vertexCount;
  const edgeMid = new Map();
  const newIndex = [];

  const pushEdge = (a, b) => {
    const key = edgeKey(a, b);
    const cached = edgeMid.get(key);
    if (cached !== undefined) return cached;
    const e = edges.get(key);
    const m = count++;
    if (e.opp.length === 2) {
      const o1 = e.opp[0];
      const o2 = e.opp[1];
      for (let c = 0; c < 3; c++) {
        positions.push(
          0.375 * (px[a * 3 + c] + px[b * 3 + c]) +
            0.125 * (px[o1 * 3 + c] + px[o2 * 3 + c])
        );
      }
    } else {
      for (let c = 0; c < 3; c++) {
        positions.push((px[a * 3 + c] + px[b * 3 + c]) / 2);
      }
    }
    if (skinIndices && skinWeights) {
      const { idx, wgt } = blendSkin(skinIndices, skinWeights, a, b);
      skinIndices.push(idx[0], idx[1], idx[2], idx[3]);
      skinWeights.push(wgt[0], wgt[1], wgt[2], wgt[3]);
    }
    edgeMid.set(key, m);
    return m;
  };

  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t];
    const b = faces[t + 1];
    const c = faces[t + 2];
    const ab = pushEdge(a, b);
    const bc = pushEdge(b, c);
    const ca = pushEdge(c, a);
    newIndex.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (skinIndices) {
    out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    out.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  }
  out.setIndex(newIndex);
  return out;
}

// Combined refinement: midpoint splits for bulk resolution, Loop mask passes
// at the end to round the silhouette (head, tail, limbs).
export function smoothSubdivide(geometry, { levels = 3, smoothLevels = 1 } = {}) {
  let g = geometry.index ? geometry : positionWeld(geometry);
  for (let i = 0; i < levels; i++) {
    g = i >= levels - smoothLevels ? loopRefine(g) : subdivideOnce(g);
  }
  return g;
}

// Average the two endpoints' bone influences, keep the 4 strongest,
// renormalise weights to sum to 1.
function blendSkin(skinIndices, skinWeights, a, b) {
  const acc = new Map();
  for (let k = 0; k < 4; k++) {
    const wiA = skinWeights[a * 4 + k];
    if (wiA > 0) acc.set(skinIndices[a * 4 + k], (acc.get(skinIndices[a * 4 + k]) || 0) + wiA * 0.5);
    const wiB = skinWeights[b * 4 + k];
    if (wiB > 0) acc.set(skinIndices[b * 4 + k], (acc.get(skinIndices[b * 4 + k]) || 0) + wiB * 0.5);
  }
  const sorted = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
  let total = sorted.reduce((s, [, w]) => s + w, 0) || 1;
  const idx = [0, 0, 0, 0];
  const wgt = [0, 0, 0, 0];
  sorted.forEach(([bone, w], i) => {
    idx[i] = bone;
    wgt[i] = w / total;
  });
  return { idx, wgt };
}
