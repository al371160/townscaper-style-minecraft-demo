// Noise-based terrain applied on top of the Townscaper grid: every irregular cell is a
// voxel column whose height / biome is sampled at the cell centroid.
//
// Follows the Mini Minecraft spec:
//   • grassland(x,z): rolling hills (fBm + Worley/Voronoi bumps)
//   • mountain(x,z):  jagged ridged fractal noise  fbm(1-|perlin|)
//   • t = smoothstep(0.25, 0.75, low-frequency noise) blends the two
//   • heights in [0,255]; Y 0–128 stone, grass/dirt or stone (+snow above 200) above that
//   • empty blocks between Y 128 and 138 become WATER
//   • caves: 3D noise in Y∈[1,128] → EMPTY (LAVA when Y < 25), BEDROCK at Y = 0
// Extras: temperature/moisture biomes (desert, snowy plains), rivers, ores, trees.

//
// Hex-guided mode (default): before the hexagon is split into triangles, it already
// carries two smooth structures that shape the terrain:
//   • a control lattice: every hexagon centre + corner (a triangular lattice of
//     spacing L). Macro height is sampled only there and blended with a C² Wendland
//     partition of unity, so the surface is smooth instead of noisy per cell.
//   • guide curves: every hexagon pairs its 6 edge midpoints with 3 non-crossing
//     cubic Béziers (hex Truchet tile: three corner arcs, or one straight line +
//     two arcs). Tangents are perpendicular to the edge, and midpoints are jittered
//     by an edge hash shared by both hexes, so the curves join G¹-smoothly across
//     chunks into endless winding lines. Ridges and swales follow these curves.

import { Simplex, hash3 } from './noise.js';
import * as B from './blocks.js';
import { L, SQ3, worldToChunk, chunkCenterWorld } from './grid.js';

// non-crossing pairings of the 6 hexagon edges (Catalan(3) = 5)
export const TRUCHET = [
  [[0, 1], [2, 3], [4, 5]], [[1, 2], [3, 4], [5, 0]],
  [[0, 3], [1, 2], [4, 5]], [[1, 4], [2, 3], [5, 0]], [[2, 5], [3, 4], [0, 1]],
];
const EDGE_NB = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]; // neighbour across edge k
const APO = (L * SQ3) / 2;           // hexagon apothem (centre → edge midpoint)
const SEG = 14;                      // polyline segments per guide curve
const RKER = 1.5 * L;                // Wendland kernel radius over the control lattice
const LAT_DZ = L * SQ3 * 0.5;
const W_LOW = 7, W_MNT = 9;          // half-widths of swales / mountain ridges

export const H = 256;
export const SEA = 138;
export const STONE_TOP = 128;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const INV32 = 1 / 4294967296;

export class Terrain {
  constructor(seed, guided = true) {
    this.seed = seed >>> 0;
    this.guided = guided;
    this.ctrl = new Map();   // control lattice heights
    this.hexes = new Map();  // hexagon guide curves
    const s = (k) => hash3(this.seed, k, 0x51ed);
    this.nBlend = new Simplex(s(1));
    this.nHill = new Simplex(s(2));
    this.nMount = new Simplex(s(3));
    this.nDet = new Simplex(s(4));
    this.nTemp = new Simplex(s(5));
    this.nMoist = new Simplex(s(6));
    this.nRiver = new Simplex(s(7));
    this.nCaveA = new Simplex(s(8));
    this.nCaveB = new Simplex(s(9));
    this.wseed = s(10);
    this.nGuide = new Simplex(s(11));
    this.hseed = s(12);
    // outputs of info()
    this.h = 0; this.t = 0; this.temp = 0; this.moist = 0; this.treeKind = 0;
  }

  fbm(n, x, z, oct) {
    let a = 1, f = 1, s = 0, t = 0;
    for (let i = 0; i < oct; i++) { s += a * n.noise2D(x * f, z * f); t += a; a *= 0.5; f *= 2.03; }
    return s / t;
  }

  // Worley F1 distance (0 at feature points, ~1 between them)
  worley(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z);
    let best = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const h = hash3(this.wseed, xi + i, zi + j);
      const px = xi + i + (h & 1023) / 1023, pz = zi + j + ((h >>> 10) & 1023) / 1023;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < best) best = d;
    }
    return Math.min(1, Math.sqrt(best));
  }

  grassland(x, z) {
    const roll = 0.5 + 0.5 * this.fbm(this.nHill, x / 160, z / 160, 3);
    const bumps = 1 - this.worley(x / 70, z / 70);
    return 131 + roll * 18 + bumps * bumps * 9 + this.fbm(this.nDet, x / 30, z / 30, 2) * 2;
  }

  mountain(x, z) {
    // ridged fractal of |perlin|
    let a = 1, f = 1 / 220, s = 0, t = 0;
    for (let i = 0; i < 5; i++) {
      const r = 1 - Math.abs(this.nMount.noise2D(x * f, z * f));
      s += a * r * r; t += a; a *= 0.5; f *= 2.1;
    }
    return 142 + (s / t) * 108;
  }

  blend(x, z) { return sstep(0.25, 0.75, 0.5 + 0.5 * this.fbm(this.nBlend, x / 1100, z / 1100, 2) * 1.25); }
  raw(x, z) { const t = this.blend(x, z); return this.grassland(x, z) * (1 - t) + this.mountain(x, z) * t; }

  // ---- hex-guided structures -------------------------------------------------
  // macro height at control-lattice node (i, j): position i·(L,0) + j·(L/2, L√3/2)
  ctrlH(i, j) {
    const k = (i + 1048576) * 2097152 + (j + 1048576);
    let v = this.ctrl.get(k);
    if (v === undefined) {
      if (this.ctrl.size > 60000) this.ctrl.clear();
      v = this.raw(i * L + j * L * 0.5, j * LAT_DZ);
      this.ctrl.set(k, v);
    }
    return v;
  }

  // smooth macro height: Wendland C² partition of unity over the hexagon centre/corner lattice
  smoothBase(x, z) {
    const jc = Math.floor(z / LAT_DZ);
    let sw = 0, sv = 0;
    for (let j = jc - 1; j <= jc + 2; j++) {
      const ic = Math.floor((x - j * L * 0.5) / L);
      for (let i = ic - 1; i <= ic + 2; i++) {
        const dx = i * L + j * L * 0.5 - x, dz = j * LAT_DZ - z;
        const d = Math.sqrt(dx * dx + dz * dz) / RKER;
        if (d >= 1) continue;
        const a = 1 - d, w = a * a * a * a * (4 * d + 1);
        sw += w; sv += w * this.ctrlH(i, j);
      }
    }
    return sv / sw;
  }

  // jittered midpoint of the edge shared by hexes A and B (identical from both sides)
  edgeMid(qa, ra, qb, rb) {
    if (qb < qa || (qb === qa && rb < ra)) { let t = qa; qa = qb; qb = t; t = ra; ra = rb; rb = t; }
    const [ax, az] = chunkCenterWorld(qa, ra), [bx, bz] = chunkCenterWorld(qb, rb);
    const s = ((hash3(this.hseed, qa + qb, ra + rb) & 0xffff) / 65535 - 0.5) * 0.45 * L; // along the edge
    const ex = -(bz - az) / (L * SQ3), ez = (bx - ax) / (L * SQ3);
    return [(ax + bx) * 0.5 + ex * s, (az + bz) * 0.5 + ez * s];
  }

  // three guide curves of hexagon (q,r) as polylines: Float64Array(3·(SEG+1)·2)
  hexCurves(q, r) {
    const key = q * 1e7 + r;
    let hc = this.hexes.get(key);
    if (hc) return hc;
    if (this.hexes.size > 8000) this.hexes.clear();
    const hv = hash3(this.hseed ^ 0x9e3779b9, q, r);
    const pattern = TRUCHET[hv % 5];
    const [ox, oz] = chunkCenterWorld(q, r);
    const pts = new Float64Array(3 * (SEG + 1) * 2);
    pattern.forEach(([a, b], ci) => {
      const [ax, az] = this.edgeMid(q, r, q + EDGE_NB[a][0], r + EDGE_NB[a][1]);
      const [bx, bz] = this.edgeMid(q, r, q + EDGE_NB[b][0], r + EDGE_NB[b][1]);
      // inward normals (towards the hex centre) keep curves perpendicular to the edges
      const na = (Math.PI / 6) + (Math.PI / 3) * a, nb = (Math.PI / 6) + (Math.PI / 3) * b;
      const straight = (a - b + 6) % 6 === 3;
      const base = straight ? APO * 0.66 : 6.2;
      const ka = base * (0.7 + 0.6 * (((hv >>> (8 + ci * 4)) & 15) / 15));
      const kb = base * (0.7 + 0.6 * (((hv >>> (20 + ci * 4)) & 15) / 15));
      const p1x = ax - Math.cos(na) * ka, p1z = az - Math.sin(na) * ka;
      const p2x = bx - Math.cos(nb) * kb, p2z = bz - Math.sin(nb) * kb;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG, u = 1 - t;
        const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
        const o = (ci * (SEG + 1) + s) * 2;
        pts[o] = w0 * ax + w1 * p1x + w2 * p2x + w3 * bx;
        pts[o + 1] = w0 * az + w1 * p1z + w2 * p2z + w3 * bz;
      }
    });
    hc = { q, r, ox, oz, pattern, pts };
    this.hexes.set(key, hc);
    return hc;
  }

  // smooth union of guide-curve bumps around (x,z): writes this.gLow / this.gMnt ∈ [0,1]
  guides(x, z) {
    const [q, r] = worldToChunk(x, z);
    const [ox, oz] = chunkCenterWorld(q, r);
    const lx = x - ox, lz = z - oz;
    let keepLow = 1, keepMnt = 1;
    for (let k = -1; k < 6; k++) {
      let hq = q, hr = r;
      if (k >= 0) {
        // a neighbour's curves can only matter when we are close to that shared edge
        const a = Math.PI / 6 + (Math.PI / 3) * k;
        if (lx * Math.cos(a) + lz * Math.sin(a) < APO - W_MNT - 4) continue;
        hq += EDGE_NB[k][0]; hr += EDGE_NB[k][1];
      }
      const pts = this.hexCurves(hq, hr).pts;
      for (let ci = 0; ci < 3; ci++) {
        let best = 1e9;
        for (let s = 0; s < SEG; s++) {
          const o = (ci * (SEG + 1) + s) * 2;
          const ax = pts[o], az = pts[o + 1], bx = pts[o + 2], bz = pts[o + 3];
          const ex = bx - ax, ez = bz - az;
          let t = ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = ax + ex * t - x, dz = az + ez * t - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) best = d2;
        }
        const d = Math.sqrt(best);
        if (d < W_LOW) keepLow *= sstep(0, W_LOW, d);
        if (d < W_MNT) keepMnt *= sstep(0, W_MNT, d);
      }
    }
    this.gLow = 1 - keepLow; this.gMnt = 1 - keepMnt;
  }

  // Height + biome parameters at (x,z). Results are written to this.h / this.t / this.temp / this.moist.
  info(x, z) {
    const t = this.blend(x, z);
    let h;
    if (this.guided) {
      h = this.smoothBase(x, z);
      this.guides(x, z);
      // lowlands: gentle swales (−) or berms (+) follow the curves, sign drifts across the map
      const sgn = Math.max(-1, Math.min(1, this.fbm(this.nGuide, x / 420, z / 420, 2) * 2.2));
      h += this.gLow * sgn * 3.5 * (1 - t);
      // mountains: rounded ridgelines run along the same curves
      h += this.gMnt * t * t * 14;
    } else {
      h = this.grassland(x, z) * (1 - t) + this.mountain(x, z) * t;
    }
    // rivers carve the lowlands
    const rv = Math.abs(this.nRiver.noise2D(x / 620, z / 620) + 0.3 * this.nRiver.noise2D(x / 150, z / 150));
    const rb = (1 - sstep(0.02, 0.085, rv)) * (1 - clamp01(t * 2.2));
    h += (SEA - 4 - h) * rb;
    this.h = Math.max(1, Math.min(254, Math.floor(h)));
    this.t = t;
    this.temp = this.fbm(this.nTemp, x / 1300, z / 1300, 2) * 1.5 - Math.max(0, this.h - 170) / 60;
    this.moist = this.fbm(this.nMoist, x / 900, z / 900, 2) * 1.5;
    return this.h;
  }

  // Fill a column (Uint8Array(H), zeroed) for a cell at centroid (x,z) with stable hash hv.
  // Returns the terrain height; sets this.treeKind (0 none, 1 oak, 2 cactus, 3 pine).
  column(x, z, hv, out) {
    const h = this.info(x, z);
    const mountain = this.t > 0.5;
    const desert = !mountain && this.temp > 0.32 && this.moist < 0.0;
    const snowy = this.temp < -0.38;

    out[0] = B.BEDROCK;
    for (let y = 1; y <= h; y++) out[y] = B.STONE;

    if (h > STONE_TOP) {
      if (mountain) {
        if (h > 200 || (snowy && h > SEA + 1)) out[h] = B.SNOWBLOCK;
        else if (h < 175 && this.moist > -0.2 && this.t < 0.62) { out[h] = B.GRASS; out[h - 1] = B.DIRT; }
      } else if (h <= SEA + 1) {
        const fill = h < SEA - 3 ? B.GRAVEL : B.SAND;
        for (let y = Math.max(STONE_TOP + 1, h - 3); y <= h; y++) out[y] = fill;
      } else if (desert) {
        for (let y = STONE_TOP + 1; y <= h; y++) out[y] = y > h - 4 ? B.SAND : B.SANDSTONE;
      } else {
        for (let y = STONE_TOP + 1; y < h; y++) out[y] = B.DIRT;
        out[h] = snowy ? B.SNOW : B.GRASS;
      }
    }

    // caves: 3D noise in [1,128]
    const caveTop = Math.min(STONE_TOP, h <= SEA + 2 ? h - 4 : h);
    for (let y = 1; y <= caveTop; y++) {
      const n = this.nCaveA.noise3D(x / 34, y / 20, z / 34) + 0.5 * this.nCaveB.noise3D(x / 15, y / 11, z / 15);
      // floor of the cave ramps the threshold so caves thin out with depth near bedrock
      if (n < -0.32 - (y < 6 ? (6 - y) * 0.15 : 0)) out[y] = y < 25 ? B.LAVA : B.AIR;
    }

    // ores
    for (let y = 1; y < Math.min(h, STONE_TOP); y++) {
      if (out[y] !== B.STONE) continue;
      const r = hash3(hv, y, 31) * INV32;
      if (y < 20 && r < 0.003) out[y] = B.DIAMOND;
      else if (y < 40 && r < 0.006) out[y] = B.GOLD;
      else if (y < 80 && r < 0.014) out[y] = B.IRON;
      else if (r < 0.022) out[y] = B.COAL;
    }

    // water fills empty space between 128 and 138
    for (let y = Math.max(h + 1, STONE_TOP + 1); y <= SEA; y++) out[y] = (snowy && y === SEA) ? B.ICE : B.WATER;

    // tree decision (pure function of this cell)
    this.treeKind = 0;
    if (h > SEA + 1 && h < 196) {
      const r = hash3(hv, 9, 77) * INV32;
      const top = out[h];
      if (desert && top === B.SAND) { if (r < 0.007) this.treeKind = 2; }
      else if (top === B.SNOW || (top === B.GRASS && (snowy || h > 168))) { if (r < (this.moist > 0 ? 0.045 : 0.012)) this.treeKind = 3; }
      else if (top === B.GRASS) {
        const dens = this.moist > 0.2 ? 0.07 : this.moist > -0.15 ? 0.014 : 0.003;
        if (r < dens) this.treeKind = 1;
      }
    }
    return h;
  }
}
