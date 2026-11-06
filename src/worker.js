// Terrain + mesh worker. Each worker owns an LRU cache of chunk grids/columns.
// Message in:  {type:'init', seed} | {type:'build', id, q, r, ver} | {type:'edit', q, r, c, y, b}
// Message out: {id, q, r, ver, opaque, water, minY, maxY, nOpaque, nWater, verts, cells, rle, rleOff}

import { generateGrid, CHUNK_NEIGHBORS, chunkCenterWorld, edgeKey } from './grid.js';
import { Terrain, H } from './terrain.js';
import * as B from './blocks.js';
import { hash3 } from './noise.js';

let seed = 0, terrain = null;
const grids = new Map();
const MAX_GRIDS = 90;
const edits = new Map(); // "q,r,c" → Map(y → block)

const OPQ = B.OPAQUE, FT = B.FACE_TILE, ANIM = B.ANIMATED;
const { AIR, WATER, LEAVES, LOG, CACTUS, LAVA } = B;

function getGrid(q, r) {
  const k = q + ',' + r;
  let g = grids.get(k);
  if (g) { grids.delete(k); grids.set(k, g); return g; }
  g = generateGrid(q, r, seed);
  g.cols = new Array(g.nc).fill(null);
  g.hts = new Int16Array(g.nc);
  g.tree = new Int8Array(g.nc);
  grids.set(k, g);
  if (grids.size > MAX_GRIDS) grids.delete(grids.keys().next().value);
  return g;
}

function applyEdits(g, c, a) {
  const e = edits.get(g.q + ',' + g.r + ',' + c);
  if (e) for (const [y, b] of e) a[y] = b;
}

// terrain-only column (+ player edits) for any cell in any grid
function col(g, c) {
  let a = g.cols[c];
  if (!a) {
    a = new Uint8Array(H);
    g.hts[c] = terrain.column(g.cx[c], g.cz[c], g.hash[c], a);
    g.tree[c] = terrain.treeKind;
    applyEdits(g, c, a);
    g.cols[c] = a;
  }
  return a;
}

// ---------------------------------------------------------------- mesh buffer
// Vertex layout (20 bytes): pos f32×3 | u8 u, u8 v, u8 layer(+128 = animated), u8 ao | i8 normal×3, pad
export const STRIDE = 20;
class MeshBuf {
  constructor(cap = 1 << 15) { this.alloc(cap); this.n = 0; this.nx = 0; this.ny = 127; this.nz = 0; }
  alloc(cap) {
    const ab = new ArrayBuffer(cap * STRIDE);
    if (this.u) new Uint8Array(ab).set(this.u);
    this.ab = ab; this.f = new Float32Array(ab); this.u = new Uint8Array(ab); this.s = new Int8Array(ab); this.cap = cap;
  }
  nrm(x, y, z) { this.nx = x; this.ny = y; this.nz = z; }
  v(x, y, z, uu, vv, layer, light) {
    if (this.n >= this.cap) this.alloc(this.cap * 2);
    const i = this.n * 5;
    this.f[i] = x; this.f[i + 1] = y; this.f[i + 2] = z;
    const b = this.n * STRIDE + 12;
    this.u[b] = uu; this.u[b + 1] = vv; this.u[b + 2] = layer; this.u[b + 3] = light;
    this.s[b + 4] = this.nx; this.s[b + 5] = this.ny; this.s[b + 6] = this.nz;
    this.n++;
  }
  take() { return this.ab.slice(0, this.n * STRIDE); }
}
const om = new MeshBuf(), wm = new MeshBuf();

// ---------------------------------------------------------------- build
const DEEP_Y = 124; // far chunks skip cave geometry below this height (LOD)
function build(q, r, deep) {
  const g = getGrid(q, r);
  const nb = CHUNK_NEIGHBORS.map(([dq, dr]) => getGrid(q + dq, r + dr));
  const { nc, nv, cells, nbr } = g;
  const [ocx, ocz] = chunkCenterWorld(q, r);

  // main columns (copies, so trees don't leak into the terrain cache)
  const cols = new Array(nc);
  for (let c = 0; c < nc; c++) cols[c] = col(g, c).slice();

  // neighbour column across every boundary edge
  const edgeCol = new Array(nc * 4).fill(null);
  for (let c = 0; c < nc; c++) for (let e = 0; e < 4; e++) {
    if (nbr[c * 4 + e] >= 0) continue;
    const k = edgeKey(g.vkeys[cells[c * 4 + e]], g.vkeys[cells[c * 4 + ((e + 1) & 3)]]);
    for (let i = 0; i < 6; i++) {
      const hit = nb[i].boundary.get(k);
      if (hit !== undefined) { edgeCol[c * 4 + e] = col(nb[i], hit >> 2); break; }
    }
  }

  // ---- procedural trees (may come from neighbouring chunks' cells too)
  const ringMain = (G, c) => {
    const out = new Set();
    for (let i = 0; i < 4; i++) {
      const v = G.cells[c * 4 + i];
      const mv = G === g ? v : g.vmap.get(G.vkeys[v]);
      if (mv === undefined) continue;
      for (let j = g.vcStart[mv]; j < g.vcStart[mv + 1]; j++) out.add(g.vcList[j]);
    }
    if (G === g) out.delete(c);
    return out;
  };
  const setIfAir = (c, y, b) => { if (y < H && cols[c][y] === AIR) cols[c][y] = b; };
  const applyTree = (G, c) => {
    const kind = G.tree[c];
    if (!kind) return;
    const isMain = G === g, h = G.hts[c], hv = G.hash[c];
    if (G.cols[c][h] === AIR) return; // surface was dug away
    if (kind === 2) {
      if (isMain) for (let y = h + 1; y <= h + 2 + (hv % 2); y++) setIfAir(c, y, CACTUS);
      return;
    }
    const ring = ringMain(G, c);
    if (kind === 1) {
      const th = 4 + (hv % 3);
      for (const n of ring) {
        setIfAir(n, h + th - 1, LEAVES); setIfAir(n, h + th, LEAVES);
        if (hash3(g.hash[n], hv, 5) & 1) setIfAir(n, h + th + 1, LEAVES);
      }
      if (isMain) {
        for (let y = h + 1; y <= h + th; y++) if (y < H && (cols[c][y] === AIR || cols[c][y] === LEAVES)) cols[c][y] = LOG;
        setIfAir(c, h + th + 1, LEAVES); setIfAir(c, h + th + 2, LEAVES);
      }
    } else {
      const th = 6 + (hv % 3);
      for (const n of ring) {
        for (let y = h + 3; y < h + th; y += 2) setIfAir(n, y, LEAVES);
        if (hash3(g.hash[n], hv, 9) & 1) setIfAir(n, h + th - 2 + 1, LEAVES);
      }
      if (isMain) {
        for (let y = h + 1; y < h + th; y++) if (y < H && (cols[c][y] === AIR || cols[c][y] === LEAVES)) cols[c][y] = LOG;
        setIfAir(c, h + th, LEAVES); setIfAir(c, h + th + 1, LEAVES);
      }
    }
  };
  for (let c = 0; c < nc; c++) applyTree(g, c);
  for (const G of nb) {
    const seen = new Set();
    for (let v = 0; v < nv; v++) {
      if (!g.fixed[v]) continue;
      const id = G.vmap.get(g.vkeys[v]);
      if (id === undefined) continue;
      for (let j = G.vcStart[id]; j < G.vcStart[id + 1]; j++) {
        const cc = G.vcList[j];
        if (seen.has(cc)) continue;
        seen.add(cc); col(G, cc); applyTree(G, cc);
      }
    }
  }
  // player edits override trees
  for (let c = 0; c < nc; c++) applyEdits(g, c, cols[c]);

  // ---- columns around each vertex (for ambient occlusion)
  const vCols = new Array(nv);
  for (let v = 0; v < nv; v++) {
    const list = [];
    for (let j = g.vcStart[v]; j < g.vcStart[v + 1]; j++) list.push(cols[g.vcList[j]]);
    if (g.fixed[v]) for (const G of nb) {
      const id = G.vmap.get(g.vkeys[v]);
      if (id === undefined) continue;
      for (let j = G.vcStart[id]; j < G.vcStart[id + 1]; j++) list.push(col(G, G.vcList[j]));
    }
    vCols[v] = list;
  }
  const ao = (v, h) => {
    const list = vCols[v]; let s = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (h > 0) s += OPQ[a[h - 1]];
      if (h < H) s += OPQ[a[h]];
    }
    const f = s / (2 * list.length);
    return f <= 0.5 ? 1 : 1 - (f - 0.5) * 1.35;
  };

  // local vertex positions (relative to chunk centre → full float precision anywhere)
  const lx = new Float32Array(nv), lz = new Float32Array(nv);
  for (let v = 0; v < nv; v++) { lx[v] = g.vx[v] - ocx; lz[v] = g.vz[v] - ocz; }
  // per-edge outward normals (sides)
  const sideN = new Int8Array(nc * 8);
  for (let c = 0; c < nc; c++) for (let e = 0; e < 4; e++) {
    const a = cells[c * 4 + e], b = cells[c * 4 + ((e + 1) & 3)];
    const dx = lx[b] - lx[a], dz = lz[b] - lz[a], len = Math.hypot(dx, dz) || 1;
    sideN[(c * 4 + e) * 2] = Math.round((dz / len) * 127);
    sideN[(c * 4 + e) * 2 + 1] = Math.round((-dx / len) * 127);
  }

  om.n = 0; wm.n = 0;
  let minY = H, maxY = 0;
  const lightByte = (s) => (s >= 1 ? 255 : Math.round(s * 255));
  const vis = (b, n) => (b === WATER ? n !== WATER && !OPQ[n] : !OPQ[n]);

  for (let c = 0; c < nc; c++) {
    const a = cols[c];
    let top = H - 1;
    while (top > 0 && a[top] === AIR) top--;
    const v0 = cells[c * 4], v1 = cells[c * 4 + 1], v2 = cells[c * 4 + 2], v3 = cells[c * 4 + 3];
    const tint = 0.95 + (g.hash[c] & 7) / 100;
    for (let y = deep ? 0 : DEEP_Y; y <= top; y++) {
      const b = a[y];
      if (b === AIR) continue;
      const fluid = b === WATER;
      const m = fluid ? wm : om;
      const anim = ANIM[b] ? 128 : 0;
      const glow = b === LAVA;
      const above = y + 1 < H ? a[y + 1] : AIR;
      // fluid surfaces sit a little lower than a full block
      const yTop = fluid && above !== WATER && !OPQ[above] ? y + 0.88 : y + 1;
      let drew = false;
      if (vis(b, above)) {
        const t = FT[b * 3] | anim, s = glow ? 1 : tint;
        if (glow) m.nrm(0, 0, 0); else m.nrm(0, 127, 0);
        m.v(lx[v0], yTop, lz[v0], 0, 0, t, lightByte(s * ao(v0, y + 1)));
        m.v(lx[v3], yTop, lz[v3], 0, 255, t, lightByte(s * ao(v3, y + 1)));
        m.v(lx[v2], yTop, lz[v2], 255, 255, t, lightByte(s * ao(v2, y + 1)));
        m.v(lx[v1], yTop, lz[v1], 255, 0, t, lightByte(s * ao(v1, y + 1)));
        drew = true;
      }
      if (y > 0 && vis(b, a[y - 1])) {
        const t = FT[b * 3 + 2] | anim, s = glow ? 1 : 0.9;
        if (glow) m.nrm(0, 0, 0); else m.nrm(0, -127, 0);
        m.v(lx[v0], y, lz[v0], 0, 0, t, lightByte(s * ao(v0, y)));
        m.v(lx[v1], y, lz[v1], 255, 0, t, lightByte(s * ao(v1, y)));
        m.v(lx[v2], y, lz[v2], 255, 255, t, lightByte(s * ao(v2, y)));
        m.v(lx[v3], y, lz[v3], 0, 255, t, lightByte(s * ao(v3, y)));
        drew = true;
      }
      for (let e = 0; e < 4; e++) {
        const n = nbr[c * 4 + e];
        const nc2 = n >= 0 ? cols[n] : edgeCol[c * 4 + e];
        const nbB = nc2 ? nc2[y] : AIR;
        if (!vis(b, nbB)) continue;
        const va = cells[c * 4 + e], vb = cells[c * 4 + ((e + 1) & 3)];
        const t = FT[b * 3 + 1] | anim, s = glow ? 1 : tint;
        if (glow) m.nrm(0, 0, 0); else m.nrm(sideN[(c * 4 + e) * 2], 0, sideN[(c * 4 + e) * 2 + 1]);
        const vt = yTop === y + 1 ? 0 : 30;
        m.v(lx[va], y, lz[va], 0, 255, t, lightByte(s * ao(va, y)));
        m.v(lx[va], yTop, lz[va], 0, vt, t, lightByte(s * ao(va, y + 1)));
        m.v(lx[vb], yTop, lz[vb], 255, vt, t, lightByte(s * ao(vb, y + 1)));
        m.v(lx[vb], y, lz[vb], 255, 255, t, lightByte(s * ao(vb, y)));
        drew = true;
      }
      if (drew) { if (y < minY) minY = y; if (y + 1 > maxY) maxY = y + 1; }
    }
  }

  // world data for the main thread (physics + ray casting): geometry + RLE columns
  const verts = new Float32Array(nv * 2);
  for (let v = 0; v < nv; v++) { verts[v * 2] = lx[v]; verts[v * 2 + 1] = lz[v]; }
  const cellsOut = new Uint16Array(cells);
  const rleOff = new Uint32Array(nc + 1);
  let rle = new Uint8Array(nc * 24), rn = 0;
  for (let c = 0; c < nc; c++) {
    rleOff[c] = rn;
    const a = cols[c];
    let y = 0;
    while (y < H) {
      const b = a[y]; let len = 1;
      while (y + len < H && a[y + len] === b && len < 255) len++;
      if (rn + 2 > rle.length) { const t = new Uint8Array(rle.length * 2); t.set(rle); rle = t; }
      rle[rn++] = b; rle[rn++] = len;
      y += len;
    }
  }
  rleOff[nc] = rn;
  rle = rle.slice(0, rn);

  return {
    q, r, minY: minY > maxY ? 0 : minY, maxY,
    opaque: om.take(), nOpaque: om.n, water: wm.take(), nWater: wm.n,
    verts: verts.buffer, cells: cellsOut.buffer, rle: rle.buffer, rleOff: rleOff.buffer,
  };
}

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'init') {
    seed = d.seed >>> 0; terrain = new Terrain(seed); grids.clear(); edits.clear();
    if (d.edits) for (const [k, list] of d.edits) edits.set(k, new Map(list));
  } else if (d.type === 'edit') {
    const k = d.q + ',' + d.r + ',' + d.c;
    let m = edits.get(k); if (!m) edits.set(k, (m = new Map()));
    m.set(d.y, d.b);
    const g = grids.get(d.q + ',' + d.r);
    if (g) g.cols[d.c] = null;
  } else if (d.type === 'build') {
    const t0 = performance.now();
    const res = build(d.q, d.r, d.deep);
    res.id = d.id; res.ver = d.ver; res.deep = !!d.deep; res.ms = performance.now() - t0;
    self.postMessage(res, [res.opaque, res.water, res.verts, res.cells, res.rle, res.rleOff]);
  }
};
