// Produce public/models/fox.glb from the raw Khronos sample: textures are
// removed (the app renders vertex colours) and unused data pruned.
// Run once after downloading fox-raw.glb: node scripts/strip-fox.mjs
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import { fileURLToPath } from 'node:url';

const root = new URL('../public/models/', import.meta.url);
const io = new NodeIO();
const doc = await io.read(fileURLToPath(new URL('fox-raw.glb', root)));
for (const tex of doc.getRoot().listTextures()) tex.dispose();
for (const mat of doc.getRoot().listMaterials()) {
  mat.setBaseColorTexture(null);
  mat.setMetallicRoughnessTexture(null);
  mat.setNormalTexture(null);
  mat.setOcclusionTexture(null);
  mat.setEmissiveTexture(null);
}
await doc.transform(prune());
await io.write(fileURLToPath(new URL('fox.glb', root)), doc);
console.log('wrote public/models/fox.glb');
