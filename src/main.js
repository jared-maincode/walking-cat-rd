import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { smoothSubdivide, positionWeld } from './subdivide.js';
import { GrayScottSurface } from './sim.js';
import { VIRIDIS, viridisCss } from './viridis.js';

// ---- per-model tuning knobs, set by measurement/inspection -----------------
// stride: mean horizontal velocity of the stance foot/toe bones during the
// walk clip, at the 1.4-unit display scale (scripts/inspect-fox.mjs documents
// the methodology), in world units per second at walkSpeed = 1. yaw:
// rotation.y that puts stance-foot motion along world −x, the treadmill
// convention. levels/smooth: midpoint subdivision levels, then Loop-smoothed
// final passes (see src/subdivide.js).
const MODELS = {
  cat: {
    file: 'models/cat.fbx',
    format: 'fbx',
    clip: /walking/i,
    yaw: 0,
    stride: 0.6,
    levels: 3, // 406 -> ~26k vertices
    smooth: 1,
  },
  fox: {
    file: 'models/fox.glb',
    format: 'gltf',
    clip: /^walk$/i,
    yaw: Math.PI / 2,
    stride: 1.93,
    levels: 3, // 576 tris -> ~37k tris, ~19k vertices
    smooth: 1,
  },
};
const SEED_SITES = 10;
const SEED_RINGS = 6;
// ---------------------------------------------------------------------------

const params = {
  F: 0.035,
  k: 0.065,
  Du: 1.0,
  Dv: 0.5,
  dt: 1.0,
  substeps: 10,
  walkSpeed: 1.0,
  walking: true,
  paused: false,
  turntable: false,
};

const PRESETS = {
  Spots: { F: 0.035, k: 0.065 },
  Coral: { F: 0.0545, k: 0.062 },
  Labyrinth: { F: 0.029, k: 0.057 },
  Mitosis: { F: 0.0367, k: 0.0649 },
};

// ---------- renderer / scene ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r183: PCFSoftShadowMap is deprecated and falls back to this anyway
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f5f7);
scene.fog = new THREE.Fog(0xf4f5f7, 26, 60);

const camera = new THREE.PerspectiveCamera(42, 2, 0.1, 200);
camera.position.set(2.8, 1.9, 4.4);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.75, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 + 0.05;
controls.minDistance = 1.5;
controls.maxDistance = 25;

scene.add(new THREE.HemisphereLight(0xe8eef7, 0x9a917f, 0.85));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(4, 7, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -5;
sun.shadow.camera.right = 5;
sun.shadow.camera.top = 5;
sun.shadow.camera.bottom = -5;
sun.shadow.bias = -0.0005;
scene.add(sun);

// Graph-paper ground: the "paper" the moving domain lives on.
const gridTex = makeGridTexture();
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(36, 72),
  new THREE.MeshStandardMaterial({ map: gridTex, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------- state ----------
let animal = null; // group containing the skinned model
let cfg = MODELS.cat;
let mixer = null;
let sim = null;
let colourAttr = null;
let walkAction = null;
let fpsEma = 60;
let costEma = 0;

function loadModel(key) {
  cfg = MODELS[key];
  mixer?.stopAllAction();
  mixer = null;
  sim = null;
  colourAttr = null;
  walkAction = null;
  if (animal) {
    scene.remove(animal);
    animal.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    animal = null;
  }
  document.querySelector('#loading p').textContent = 'assembling Laplace–Beltrami operator…';
  document.getElementById('loading').classList.remove('hidden');
  const onError = (err) => {
    document.querySelector('#loading p').textContent = `failed to load ${cfg.file} — see console`;
    console.error(err);
  };
  new (cfg.format === 'gltf' ? GLTFLoader : FBXLoader)().load(cfg.file, onModelLoaded, undefined, onError);
}

function onModelLoaded(asset) {
  // FBXLoader yields the root Group; GLTFLoader yields { scene, animations }.
  const root = asset.scene ?? asset;
  const skinned = root.getObjectByProperty('isSkinnedMesh', true);
  if (!skinned) {
    console.error(`no SkinnedMesh found in ${cfg.file}`);
    return;
  }

  // Merge duplicate seam vertices, then refine for pattern resolution. The
  // final passes use the Loop mask so the silhouette rounds out instead of
  // converging to the original facets. Skin indices/weights are interpolated
  // across new edge vertices, so the refined mesh rides the same skeleton.
  let geom = positionWeld(skinned.geometry, 1e-6);
  geom = smoothSubdivide(geom, { levels: cfg.levels, smoothLevels: cfg.smooth });
  geom.computeVertexNormals();
  skinned.geometry = geom;

  skinned.material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
  });
  skinned.castShadow = true;

  // Normalised placement: model ~1.4 units tall, feet on y = 0, centred.
  animal = new THREE.Group();
  root.rotation.y = cfg.yaw;
  animal.add(root);
  animal.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(animal);
  const size = box.getSize(new THREE.Vector3());
  const s = 1.4 / (size.y || 1);
  animal.scale.setScalar(s);
  animal.updateMatrixWorld(true);
  const scaled = new THREE.Box3().setFromObject(animal);
  const centre = scaled.getCenter(new THREE.Vector3());
  animal.position.set(-centre.x, -scaled.min.y, -centre.z);
  scene.add(animal);

  // Reaction–diffusion on the rest-pose surface.
  const posAttr = geom.getAttribute('position');
  sim = new GrayScottSurface(new Float32Array(posAttr.array), geom.getIndex().array);
  sim.perturb(SEED_SITES, SEED_RINGS);

  colourAttr = new THREE.BufferAttribute(new Float32Array(posAttr.count * 3), 3);
  geom.setAttribute('color', colourAttr);

  // Walk cycle.
  mixer = new THREE.AnimationMixer(root);
  const clip =
    asset.animations.find((c) => cfg.clip.test(c.name)) ||
    asset.animations.reduce((a, b) => (a.duration > b.duration ? a : b));
  walkAction = mixer.clipAction(clip);
  walkAction.play();

  // Fresh sim, fresh colour window.
  displayWindow.lo = 0;
  displayWindow.hi = 0.5;

  // Static stats
  document.getElementById('st-verts').textContent = posAttr.count.toLocaleString();
  document.getElementById('st-tris').textContent = (geom.getIndex().count / 3).toLocaleString();
  document.getElementById('st-dtmax').textContent = sim.stabilityLimit.toFixed(3);
  document.getElementById('st-iter').textContent = '0';

  document.getElementById('loading').classList.add('hidden');
}

function makeGridTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fbfbfb';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#e4e7ee';
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i + 0.5, 0);
    ctx.lineTo(i + 0.5, size);
    ctx.moveTo(0, i + 0.5);
    ctx.lineTo(size, i + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = '#ccd2de';
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

// ---------- animation loop ----------
const timer = new THREE.Timer();
timer.connect(document); // zero the delta while the tab is hidden
const statsTimer = { t: 0 };
let iterAtLastStats = 0;

// Display window for the viridis mapping. The pattern only spans part of
// [0, 1]; normalising by the live (EMA-smoothed) range uses the whole
// colourmap. A minimum span keeps a flat field from mapping to noise.
const displayWindow = { lo: 0, hi: 0.5 };
const MIN_SPAN = 0.05;

function applyColours() {
  const v = sim.v;
  const arr = colourAttr.array;
  let { lo, hi } = displayWindow;
  if (hi - lo < MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  const invSpan = 255 / (hi - lo);
  for (let i = 0; i < v.length; i++) {
    let j = ((v[i] - lo) * invSpan) | 0;
    if (j < 0) j = 0;
    else if (j > 255) j = 255;
    arr[i * 3] = VIRIDIS[j * 3];
    arr[i * 3 + 1] = VIRIDIS[j * 3 + 1];
    arr[i * 3 + 2] = VIRIDIS[j * 3 + 2];
  }
  colourAttr.needsUpdate = true;
}

function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const frameDt = Math.min(timer.getDelta(), 0.1);
  fpsEma = fpsEma * 0.95 + (frameDt > 0 ? 1 / frameDt : 60) * 0.05;

  controls.update();

  if (animal && animal.visible && params.turntable) animal.rotation.y += frameDt * 0.4;
  if (mixer && params.walking) mixer.update(frameDt * params.walkSpeed);

  if (sim && !params.paused) {
    const t0 = performance.now();
    for (let s = 0; s < params.substeps; s++) {
      sim.step(params.dt, params.F, params.k, params.Du, params.Dv);
    }
    costEma = costEma * 0.9 + (performance.now() - t0) * 0.1;

    applyColours();

    statsTimer.t += frameDt;
    if (statsTimer.t > 0.25) {
      statsTimer.t = 0;
      updateStats();
    }
  }

  // Treadmill: scroll the graph paper to sell the animal travelling. One UV
  // offset unit spans a texture tile, i.e. (diameter / repeat) world units.
  if (params.walking && animal) {
    gridTex.offset.x +=
      (cfg.stride * params.walkSpeed * frameDt) / ((2 * 36) / 24);
  }

  renderer.render(scene, camera);
}

function updateStats() {
  let vmin = Infinity;
  let vmax = -Infinity;
  const v = sim.v;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < vmin) vmin = v[i];
    if (v[i] > vmax) vmax = v[i];
  }
  // Slow EMA so the colour window tracks the pattern without flickering.
  displayWindow.lo += (vmin - displayWindow.lo) * 0.25;
  displayWindow.hi += (vmax - displayWindow.hi) * 0.25;

  document.getElementById('st-iter').textContent = sim.iteration.toLocaleString();
  document.getElementById('st-fps').textContent = fpsEma.toFixed(0);
  document.getElementById('st-vrange').textContent = `[${vmin.toFixed(3)}, ${vmax.toFixed(3)}]`;
  document.getElementById('st-cost').textContent = `${costEma.toFixed(2)} ms`;
  document.getElementById('cb-hi').textContent = displayWindow.hi.toFixed(2);
  document.getElementById('cb-mid').textContent =
    ((displayWindow.lo + displayWindow.hi) / 2).toFixed(2);
  document.getElementById('cb-lo').textContent = displayWindow.lo.toFixed(2);
  iterAtLastStats = sim.iteration;
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
onResize();

// ---------- UI ----------
const $ = (id) => document.getElementById(id);

function bindRange(key, fmt) {
  const input = $(`in-${key}`);
  const out = $(`out-${key}`);
  if (!input || !out || !(key in params)) {
    console.error(`bindRange: missing control or param for "${key}"`);
    return;
  }
  const render = () => (out.textContent = fmt(params[key]));
  input.value = params[key];
  render();
  input.addEventListener('input', () => {
    params[key] = parseFloat(input.value);
    render();
  });
}

const f4 = (x) => x.toFixed(4);
const f2 = (x) => x.toFixed(2);
bindRange('F', f4);
bindRange('k', f4);
bindRange('Du', f2);
bindRange('Dv', f2);
bindRange('dt', f2);
bindRange('substeps', (x) => x.toFixed(0));
bindRange('walkSpeed', f2);

const presetHost = $('presets');
for (const [name, preset] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', () => {
    params.F = preset.F;
    params.k = preset.k;
    $('in-F').value = preset.F;
    $('in-k').value = preset.k;
    $('out-F').textContent = f4(preset.F);
    $('out-k').textContent = f4(preset.k);
    [...presetHost.children].forEach((c) => c.classList.toggle('active', c === b));
  });
  presetHost.appendChild(b);
}
presetHost.children[0].classList.add('active');

$('btn-reset').addEventListener('click', () => sim?.reset());
$('btn-perturb').addEventListener('click', () => sim?.perturb(SEED_SITES, SEED_RINGS));
$('btn-pause').addEventListener('click', (e) => {
  params.paused = !params.paused;
  e.target.textContent = params.paused ? 'Resume' : 'Pause';
});
$('btn-walk').addEventListener('click', (e) => {
  params.walking = !params.walking;
  e.target.textContent = `Walk: ${params.walking ? 'on' : 'off'}`;
});
$('btn-rotate').addEventListener('click', (e) => {
  params.turntable = !params.turntable;
  e.target.textContent = `Turntable: ${params.turntable ? 'on' : 'off'}`;
});

$('colourbar-bar').style.background = viridisCss(12);

// Model picker: swapping reloads geometry, skeleton, sim and colour window.
const selModel = $('sel-model');
for (const key of Object.keys(MODELS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = key[0].toUpperCase() + key.slice(1);
  selModel.appendChild(opt);
}
selModel.value = 'cat';
selModel.addEventListener('change', () => loadModel(selModel.value));

loadModel('cat');
animate();

// Hooks for the automated smoke test.
window.__APP_STATE = () => ({
  ready: !!sim,
  iteration: sim?.iteration ?? 0,
  vertices: sim?.vertexCount ?? 0,
  fps: fpsEma,
  costMs: costEma,
});
