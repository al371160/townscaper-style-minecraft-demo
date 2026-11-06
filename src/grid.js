// Townscaper-style irregular quad grid, generated per hexagonal chunk.
//
// Pipeline (after Oskar Stålberg / Boris the Brave's Sylves tutorial):
//   1. A big hexagon (side N) on a global triangular lattice is split into 6·N² triangles.
//   2. Adjacent triangle pairs are randomly merged into quads (seeded per chunk).
//   3. Every polygon is subdivided into quads (tri → 3 quads, quad → 4 quads).
//   4. Interior vertices are relaxed towards squares; hexagon border vertices stay fixed.
//
// Because the border vertices lie on the shared global lattice and are never moved,
// neighbouring chunks stitch together seamlessly → near-infinite irregular grid.
//
// Vertices are identified by exact integer keys (lattice coords × 12), so cells and
// edges can be matched across chunks without floating point comparisons.

import { mulberry32, hash3 } from './noise.js';

export const SQ3 = Math.sqrt(3);
export const S = 2;          // lattice triangle edge length (world units); final cells ≈ 1 block wide
export const N = 8;          // hexagon side length in lattice edges
export const L = S * N;      // chunk hexagon circumradius in world units
const K = 12;                // key sub-units per lattice step (divisible by 2,3,4)
const OFF = 2 ** 25, MUL = 2 ** 26;
const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
export const CHUNK_NEIGHBORS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const RELAX_ITERS = 28;

export function chunkCenterWorld(q, r) { return [L * 1.5 * q, L * SQ3 * (r + q * 0.5)]; }
export function hexDist(dq, dr) { return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2; }
export function worldToChunk(x, z) {
  const qf = ((2 / 3) * x) / L, rf = (-x / 3 + (SQ3 / 3) * z) / L, sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf); const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s; else if (dr > ds) r = -q - s;
  return [q, r];
}
export function edgeKey(ka, kb) { return ka < kb ? ka + '_' + kb : kb + '_' + ka; }

export function generateGrid(q, r, seed, keepStages = false) {
  const ci = N * (q - r), cj = N * (q + 2 * r); // chunk centre in lattice coords
  const vmap = new Map(); const vI = [], vJ = [];
  const vid = (I, J) => {
    const k = (I + OFF) * MUL + (J + OFF);
    let id = vmap.get(k);
    if (id === undefined) { id = vI.length; vmap.set(k, id); vI.push(I); vJ.push(J); }
    return id;
  };

  // 1. triangulate the hexagon
  const tris = [];
  for (let k = 0; k < 6; k++) {
    const [ax, ay] = DIRS[k], [bx, by] = DIRS[(k + 1) % 6];
    const P = (a, b) => vid((ci + a * ax + b * bx) * K, (cj + a * ay + b * by) * K);
    for (let a = 0; a < N; a++) for (let b = 0; a + b < N; b++) {
      tris.push([P(a, b), P(a + 1, b), P(a, b + 1)]);
      if (a + b < N - 1) tris.push([P(a + 1, b), P(a + 1, b + 1), P(a, b + 1)]);
    }
  }
  const ek = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);

  // 2. random merge of adjacent triangles into quads
  const rng = mulberry32(hash3(seed, q * 73856093 + 1, r * 19349663 + 7));
  const edgeTris = new Map();
  tris.forEach((t, ti) => {
    for (let e = 0; e < 3; e++) {
      const k = ek(t[e], t[(e + 1) % 3]);
      const l = edgeTris.get(k); if (l) l.push(ti); else edgeTris.set(k, [ti]);
    }
  });
  const order = tris.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const used = new Uint8Array(tris.length);
  const polys = [];
  for (const ti of order) {
    if (used[ti]) continue;
    used[ti] = 1;
    const t = tris[ti];
    const cand = [];
    for (let e = 0; e < 3; e++) {
      for (const o of edgeTris.get(ek(t[e], t[(e + 1) % 3]))) if (!used[o]) cand.push(o, e);
    }
    if (cand.length) {
      const p = Math.floor((rng() * cand.length) / 2) * 2;
      const o = cand[p], e = cand[p + 1];
      used[o] = 1;
      const a = t[e], b = t[(e + 1) % 3], c = t[(e + 2) % 3], ot = tris[o];
      const w = ot[0] !== a && ot[0] !== b ? ot[0] : ot[1] !== a && ot[1] !== b ? ot[1] : ot[2];
      polys.push([a, w, b, c]);
    } else polys.push(t.slice());
  }

  // 3. subdivide every polygon into quads
  const quads = [];
  for (const p of polys) {
    const n = p.length;
    let sI = 0, sJ = 0;
    for (const v of p) { sI += vI[v]; sJ += vJ[v]; }
    const c = vid(sI / n, sJ / n);
    const m = [];
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      m.push(vid((vI[a] + vI[b]) / 2, (vJ[a] + vJ[b]) / 2));
    }
    for (let i = 0; i < n; i++) quads.push(p[i], m[i], c, m[(i + n - 1) % n]);
  }

  const nv = vI.length, nc = quads.length / 4;
  const cells = Int32Array.from(quads);
  const vx = new Float64Array(nv), vz = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    const i = vI[v] / K, j = vJ[v] / K;
    vx[v] = S * (i + j * 0.5); vz[v] = S * j * SQ3 * 0.5;
  }
  // enforce counter-clockwise (in x/z) winding for every cell
  {
    const a = cells[0], b = cells[1], c = cells[2];
    const area = (vx[b] - vx[a]) * (vz[c] - vz[a]) - (vz[b] - vz[a]) * (vx[c] - vx[a]);
    if (area < 0) for (let i = 0; i < nc; i++) { const t = cells[i * 4 + 1]; cells[i * 4 + 1] = cells[i * 4 + 3]; cells[i * 4 + 3] = t; }
  }

  // adjacency
  const nbr = new Int32Array(nc * 4).fill(-1);
  const em = new Map();
  for (let c = 0; c < nc; c++) for (let e = 0; e < 4; e++) {
    const k = ek(cells[c * 4 + e], cells[c * 4 + ((e + 1) & 3)]);
    const p = em.get(k);
    if (p === undefined) em.set(k, c * 4 + e);
    else { nbr[c * 4 + e] = p >> 2; nbr[p] = c; }
  }
  const vkeys = new Float64Array(nv);
  for (let v = 0; v < nv; v++) vkeys[v] = (vI[v] + OFF) * MUL + (vJ[v] + OFF);
  const fixed = new Uint8Array(nv);
  const boundary = new Map();
  for (let c = 0; c < nc; c++) for (let e = 0; e < 4; e++) {
    if (nbr[c * 4 + e] >= 0) continue;
    const a = cells[c * 4 + e], b = cells[c * 4 + ((e + 1) & 3)];
    fixed[a] = 1; fixed[b] = 1;
    boundary.set(edgeKey(vkeys[a], vkeys[b]), c * 4 + e);
  }

  let stages = null;
  if (keepStages) stages = { tris, polys, cells: cells.slice(), ux: vx.slice(), uz: vz.slice() };

  // 4. relaxation towards squares
  const cnt = new Uint8Array(nv);
  for (let i = 0; i < cells.length; i++) cnt[cells[i]]++;
  const fx = new Float64Array(nv), fz = new Float64Array(nv);
  for (let it = 0; it < RELAX_ITERS; it++) {
    fx.fill(0); fz.fill(0);
    for (let c = 0; c < nc; c++) {
      const i0 = cells[c * 4], i1 = cells[c * 4 + 1], i2 = cells[c * 4 + 2], i3 = cells[c * 4 + 3];
      const x0 = vx[i0], x1 = vx[i1], x2 = vx[i2], x3 = vx[i3];
      const z0 = vz[i0], z1 = vz[i1], z2 = vz[i2], z3 = vz[i3];
      const cx = (x0 + x1 + x2 + x3) * 0.25, cz = (z0 + z1 + z2 + z3) * 0.25;
      const d0x = x0 - cx, d1x = x1 - cx, d2x = x2 - cx, d3x = x3 - cx;
      const d0z = z0 - cz, d1z = z1 - cz, d2z = z2 - cz, d3z = z3 - cz;
      // rotate each corner back by -i·90° and average → ideal square "radius" vector
      const rx = (d0x + d1z - d2x - d3z) * 0.25;
      const rz = (d0z - d1x - d2z + d3x) * 0.25;
      fx[i0] += cx + rx - x0; fz[i0] += cz + rz - z0;
      fx[i1] += cx - rz - x1; fz[i1] += cz + rx - z1;
      fx[i2] += cx - rx - x2; fz[i2] += cz - rz - z2;
      fx[i3] += cx + rz - x3; fz[i3] += cz - rx - z3;
    }
    for (let v = 0; v < nv; v++) {
      if (fixed[v]) continue;
      vx[v] += (fx[v] / cnt[v]) * 0.6;
      vz[v] += (fz[v] / cnt[v]) * 0.6;
    }
  }

  // per-cell centroid + stable hash
  const cx = new Float64Array(nc), cz = new Float64Array(nc), hash = new Uint32Array(nc);
  for (let c = 0; c < nc; c++) {
    let sx = 0, sz = 0, sI = 0, sJ = 0;
    for (let e = 0; e < 4; e++) { const v = cells[c * 4 + e]; sx += vx[v]; sz += vz[v]; sI += vI[v]; sJ += vJ[v]; }
    cx[c] = sx / 4; cz[c] = sz / 4;
    hash[c] = hash3(seed ^ 0x5bd1e995, sI, sJ);
  }

  // vertex → cells (CSR)
  const vcStart = new Int32Array(nv + 1);
  for (let i = 0; i < cells.length; i++) vcStart[cells[i] + 1]++;
  for (let v = 0; v < nv; v++) vcStart[v + 1] += vcStart[v];
  const vcList = new Int32Array(cells.length);
  const fill = vcStart.slice(0, nv);
  for (let c = 0; c < nc; c++) for (let e = 0; e < 4; e++) vcList[fill[cells[c * 4 + e]]++] = c;

  return { q, r, nv, nc, vx, vz, vkeys, vmap, fixed, cells, nbr, boundary, cx, cz, hash, vcStart, vcList, stages };
}
