// One-off inspection of the fox GLB: parse without textures, report mesh /
// rig / animation facts used to wire the model menu and treadmill constants.
// Run: node scripts/inspect-fox.mjs
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const buf = readFileSync(new URL('../public/models/fox.glb', import.meta.url));
const gltf = await new Promise((resolve, reject) => {
  new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve, reject);
});

let skinned = null;
gltf.scene.traverse((o) => {
  if (o.isSkinnedMesh && !skinned) skinned = o;
});

console.log('--- fox.glb inspection ---');
if (!skinned) {
  console.log('no SkinnedMesh found; scene graph:');
  gltf.scene.traverse((o) => console.log(' ', o.type, o.name));
  process.exit(1);
}
const vertCount = skinned.geometry.getAttribute('position').count;
const triCount = skinned.geometry.getIndex() ? skinned.geometry.getIndex().count / 3 : vertCount / 3;
console.log('skinned mesh:', skinned.name, '| verts:', vertCount, '| tris:', triCount, '| indexed:', !!skinned.geometry.getIndex());
console.log('bones:', skinned.skeleton.bones.length);
console.log('animations:');
for (const clip of gltf.animations) {
  console.log(`  ${clip.name}  ${clip.duration.toFixed(2)}s  tracks=${clip.tracks.length}`);
}

// Measure stride speed exactly like the cat was measured: walk clip, stance
// phase = lowest 30% of foot trajectory, at 1.4-unit display height.
gltf.scene.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(gltf.scene);
const size = box.getSize(new THREE.Vector3());
const s = 1.4 / size.y;
gltf.scene.scale.setScalar(s);
gltf.scene.updateMatrixWorld(true);
const scaled = new THREE.Box3().setFromObject(gltf.scene);
console.log(`raw size: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}; scaled feet-on-floor y range: [${scaled.min.y.toFixed(2)}, ${scaled.max.y.toFixed(2)}]`);

// IK/foot bones: take the four bones closest to the ground at rest.
const bones = skinned.skeleton.bones;
const v = new THREE.Vector3();
const boneYs = bones
  .map((b, i) => ({ b, y: b.getWorldPosition(new THREE.Vector3()).y }))
  .sort((a, b2) => a.y - b2.y)
  .slice(0, 6);
console.log('lowest bones at rest:', boneYs.map(({ b, y }) => `${b.name}(${y.toFixed(2)})`).join(', '));

const clip = gltf.animations.find((c) => /walk/i.test(c.name)) || gltf.animations.reduce((a, b2) => (a.duration > b2.duration ? a : b2));
const mixer = new THREE.AnimationMixer(gltf.scene);
mixer.clipAction(clip).play();

console.log(`measuring stride from clip "${clip.name}"...`);
const foot = boneYs.map((x) => x.b);
const N = 400;
const dt = clip.duration / N;
const pos = foot.map(() => []);
for (let i = 0; i <= N; i++) {
  mixer.setTime(i * dt);
  gltf.scene.updateMatrixWorld(true);
  foot.forEach((b, fi) => pos[fi].push(b.getWorldPosition(new THREE.Vector3()).clone()));
  mixer.update(0); // pose is applied via setTime
}
let velX = 0;
let velZ = 0;
let velN = 0;
for (let fi = 0; fi < foot.length; fi++) {
  const ys = pos[fi].map((p) => p.y);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  if (yMax - yMin < 1e-6) continue; // stationary bone (root joints)
  const thresh = yMin + (yMax - yMin) * 0.3;
  let dist = 0;
  let time = 0;
  for (let i = 1; i <= N; i++) {
    const a = pos[fi][i - 1];
    const b = pos[fi][i];
    if (a.y <= thresh && b.y <= thresh) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      dist += Math.hypot(dx, dz);
      time += dt;
      velX += dx;
      velZ += dz;
      velN++;
    }
  }
  const speed = time > 0 ? dist / time : 0;
  console.log(`  ${foot[fi].name}: stance speed ${speed.toFixed(3)} world units/s (y range ${yMin.toFixed(2)}..${yMax.toFixed(2)})`);
}
// Mean stance velocity direction. The treadmill convention (cat) is stance
// feet moving toward world -x; the yaw that maps this model's direction to
// that is phi = theta - PI, with theta = atan2(z, x) of the stance velocity.
if (velN > 0) {
  const mx = velX / velN;
  const mz = velZ / velN;
  const theta = Math.atan2(mz, mx);
  console.log(`mean stance velocity dir: (${mx.toFixed(4)}, ${mz.toFixed(4)}) per sample; theta=${theta.toFixed(3)} rad`);
  console.log(`suggested MODEL yaw (rotation.y) to walk along -x: ${(theta - Math.PI).toFixed(3)} rad`);
}
