# Townscaper × Voxel Terrain (WebGL2)

Minecraft-style terrain generation on top of a **Townscaper-style irregular quad grid**.
Every irregular cell is a voxel column. The grid is generated first and the noise terrain is applied per cell.

```bash
python3 -m http.server 8765 --bind 127.0.0.1   # then open http://localhost:8765/?seed=anything
```

No build step and no dependencies: plain ES modules plus module Web Workers.

## Pipeline
1. **Grid** (`src/grid.js`). Each chunk is a side-8 hexagon on a global triangular lattice. It is split into 384 triangles. Adjacent pairs are randomly merged into quads (seeded per chunk), everything is subdivided into quads, and interior vertices are relaxed toward squares. Border vertices are never moved, and vertices use exact integer keys, so neighbouring chunks stitch together seamlessly into a near-infinite grid. Press **P** in-app to step through every stage.
2. **Hex guides** (`src/terrain.js`, on by default; add `?classic=1` or untick the panel box for raw per-cell noise). These are built on each chunk hexagon *before* it is split into triangles:
   - **Control lattice.** Macro height is sampled only at hexagon centres and corners, then blended with a C² Wendland kernel. This removes the per-cell jitter.
   - **Guide curves.** Each hexagon pairs its 6 edge midpoints with 3 non-crossing cubic Béziers (a hex Truchet tile: corner arcs, or one straight line plus two arcs). The curves leave each edge perpendicularly, and the midpoints are jittered by a hash shared by both neighbours, so they join tangentially into endless winding lines across chunks.
   - Mountain ridges and lowland swales or berms follow these curves. Mean height step between neighbouring cells drops from 0.71 to 0.55 blocks, and the 99th percentile from 3 to 2. Pipeline stage 6 visualises it.
3. **Terrain** (`src/terrain.js`). Noise is sampled at each cell's centroid, following the Mini Minecraft spec:
   - Grassland is fBm plus Worley (Voronoi) hills. Mountains are ridged `fbm(1-|perlin|)`.
   - The two are blended with `smoothstep(0.25, 0.75, noise)`. Heights run from 0 to 255.
   - Y 0–128 is stone. Water fills empty space from 128 to 138. Mountain columns above 200 get snow.
   - Caves come from 3D noise in Y 1–128, with lava below 25 and bedrock at Y 0.
   - Also included: ores, rivers, temperature/moisture biomes (desert, snowy plains, forest), and trees, pines and cacti.
4. **Meshing** (`src/worker.js`, pool of Web Workers):
   - Faces are culled against neighbours, including across chunk borders. Opaque and transparent geometry go in separate buffers.
   - Each vertex is 20 bytes: position, UV, texture-array layer, AO and normal. Smooth vertex AO is computed over the irregular vertex neighbourhoods.
   - Positions are relative to the chunk centre, so rendering stays precise millions of blocks out.
5. **Rendering** (`src/main.js`): WebGL2 with a texture array for the atlas (no bleeding at mip levels).
   - Per frame: raycast sky with a day/night cycle, sun and moon, and stars.
   - Terrain is lit by the sun's direction, with distance fog and animated UV scrolling for water and lava.
   - Water has vertex-shader waves and a sun glint.
   - A post-process pass adds a water or lava tint plus distortion.

## Optimizations
- Generation and meshing run in parallel workers, with an LRU cache of grids and columns per worker.
- Chunks load in priority order: nearest first, then the ones in your view direction. Far chunks are unloaded, and only a few milliseconds of GPU uploads happen per frame.
- Frustum culling per chunk, opaque geometry drawn front-to-back, and one shared quad index buffer.
- Geometry LOD: chunks more than 2 rings away skip cave geometry below Y 124, which is about 75% of the vertices. They are re-meshed at full detail when you get close.

## Controls
Click to capture the mouse. Then:
- **WASD** to move. **E/Q** for up/down in flight mode. **Space** to jump, or to swim while in water or lava (2/3 speed).
- **Shift** to sprint. **F** switches between flight and walk mode; walk mode has gravity and collision for a 2-block-tall player.
- **LMB** breaks a block and **RMB** places one, within 3 blocks. Bedrock can't be broken. **1–9** or the mouse wheel picks the block.
- **G** toggles the grid overlay, **T** toggles the day cycle, and **P** opens the pipeline viewer.

The texture atlas is original pixel art, generated procedurally at startup (`src/atlas.js`). You can save it as a PNG from the side panel.
