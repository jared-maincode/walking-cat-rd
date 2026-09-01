# Walking Cat — Reaction–Diffusion on a Moving Domain

A Gray–Scott reaction–diffusion system solved live on the surface of an
animated, walking animal (cat or fox — pick from the **Model** menu in the
panel) — Turing patterns on a deforming skin, rendered in real time in the
browser with Three.js.

Built with Matilda Desktop. Matilda Desktop was used as the development environment; the simulation itself runs entirely in the browser and does not require Matilda, a backend, analytics, or a hosted model.

![Engine: three.js + Vite](https://img.shields.io/badge/engine-three.js%20%2B%20vite-blue)

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually <http://localhost:5173>).

## What you're looking at

The Gray–Scott system

```
∂u/∂t = Du ∇²u − u v² + F (1 − u)
∂v/∂t = Dv ∇²v + u v² − (F + k) v
```

is integrated with explicit Euler directly on the animal's triangle mesh
(~26k vertices for the cat, ~18k for the fox, after refinement). The
activator/inhibitor field `v` is shown with the matplotlib *viridis*
colourmap (dark purple → bright yellow), normalised each frame against the
EMA-smoothed live `v` range so the pattern always spans the full colourmap
(the colourbar ticks track the window).

The animal walks (skinned animation via an `AnimationMixer` clip) while the
pattern evolves on the rest-pose surface — a genuine **moving-domain**
visualisation: the domain deforms under your eyes while the fields live on it.

### The numerics

- **Laplacian.** Laplace–Beltrami operator discretised with cotangent
  weights and a lumped barycentric mass matrix, assembled once on the rest
  pose into CSR form (`src/sim.js`). Negative cotangent weights (obtuse
  triangles — abundant on organic meshes) are clamped to zero, which keeps
  the off-diagonal stencil non-negative and the operator diagonally dominant.
- **Normalisation.** Each row is rescaled so its weights sum to exactly 1 —
  the Karl Sims pixel-grid convention (0.2 orthogonal + 0.05 diagonal). That
  is what lets the widely tabulated `(F, k)` presets behave as documented on
  an irregular mesh, with `dt = 1` inside the explicit-Euler stability region
  (`0.9 × stabilityLimit` is enforced regardless of what the UI asks for).
- **Moving domain, honestly.** The simulator runs on the *rest pose* geometry;
  the same vertex colours are skinned to the animated pose each frame. This is
  a visualisation of a deforming domain, not a full ALE (arbitrary
  Lagrangian–Eulerian) solver: it does not include the advective/dilative
  correction terms that a domain-motion-aware scheme would add. For a walking
  cycle the artifact is small; the caveat is stated here, not hidden.
- **Refinement.** The game meshes are welded (position-only hashing, since
  seam splits carry duplicate UVs/normals) and subdivided three times; skin
  indices/weights of edge-midpoint vertices are blended from their endpoints
  so the refined mesh rides the same skeleton (`src/subdivide.js`). The final
  subdivision pass uses the **Loop mask** rather than pure midpoint splitting,
  which rounds the silhouette (head, tail, limbs) instead of converging to
  the faceted limit surface of the original 406-vertex model.
- **Models.** The **Model** dropdown swaps between the Quaternius cat
  (`cat.fbx`, FBX) and the Khronos sample fox (`fox.glb`, glTF, textures
  stripped — the app renders vertex colours). Swapping disposes the old
  geometry/simulation and rebuilds everything from the per-model config in
  `src/main.js` (`MODELS`): file, loader, walk-clip regex, yaw, measured
  stride speed (for the treadmill scroll) and subdivision levels.

## Controls

| Control | Effect |
| --- | --- |
| Drag / scroll | Orbit / zoom the camera |
| **Model** dropdown | Swap between cat and fox (rebuilds mesh, sim and colours) |
| **F, k** sliders | Feed and kill rates (`Du`, `Dv`, `dt` also exposed) |
| **Presets** | Spots · Coral · Labyrinth · Mitosis (Karl Sims parameters) |
| **Substeps** | Simulation steps per rendered frame (speed vs. smoothness) |
| **Walk speed / Walk on-off** | Animation playback rate |
| Pause · Reset · Perturb | Control the integration, reseed the field |
| Turntable | Slow rotation for inspecting the pattern |

The panel shows live stats: iteration count, FPS, mesh size, per-frame
simulation cost (ms), the `v` range, and the stability-limited `dt` cap.

The animal runs on a treadmill: the graph-paper ground scrolls beneath it at
the measured stride speed of the walk clip to sell the translation while the
camera stays put.

## Development

```bash
npm test     # numerics unit tests (topology, Laplacian properties, pattern growth)
npm run smoke  # end-to-end pipeline check against the real model assets
npm run build  # production build -> dist/
```

- `test/sim.test.mjs` — subdivision topology, skin-weight conservation,
  Loop-mask rounding, Laplacian sanity (closed-surface integral ≈ 0),
  bounded 1500-step Gray–Scott run with pattern formation on a
  2.5k-vertex sphere.
- `test/app-smoke.mjs` — loads both real assets (cat FBX, fox GLB), welds,
  subdivides, builds the operator and integrates 500 steps per model;
  asserts `stabilityLimit = 1`, no NaN, pattern contrast, and that 10
  substeps fit in a frame.
- `scripts/strip-fox.mjs` — one-off: strip textures from the raw Khronos
  fox GLB (`fox-raw.glb`) and prune unused data to produce `fox.glb`.
- `scripts/inspect-fox.mjs` — one-off: report a GLB's mesh/rig/clip facts
  and measure walk-clip stride speed + direction (the `MODELS` tuning
  values in `src/main.js`).

## Attribution

The cat model (`public/models/cat.fbx`) is from Quaternius's *Animal Pack
Vol.2*, CC0 / public domain. The fox (`public/models/fox.glb`) is the
Khronos glTF sample *Fox*: model © PixelMannen (CC0), rig and animation ©
tomkranis (CC-BY 4.0), glTF conversion © AsoboStudio and @scurest (CC-BY
4.0). Full credits in `public/models/ATTRIBUTION.txt`. The viridis
colourmap data comes via the `colormap` npm package.

## License

The source code is licensed under the Apache License 2.0. The cat and fox model assets retain the separate licenses documented in `public/models/ATTRIBUTION.txt`. The Matilda name and logo are Maincode brand assets and are not granted for use beyond reasonable attribution. See `NOTICE`.
