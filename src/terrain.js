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

import { Simplex, hash3 } from './noise.js';
import * as B from './blocks.js';

export const H = 256;
export const SEA = 138;
export const STONE_TOP = 128;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const INV32 = 1 / 4294967296;

export class Terrain {
  constructor(seed) {
    this.seed = seed >>> 0;
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

  // Height + biome parameters at (x,z). Results are written to this.h / this.t / this.temp / this.moist.
  info(x, z) {
    const b = this.fbm(this.nBlend, x / 1100, z / 1100, 2) * 1.25;
    const t = sstep(0.25, 0.75, 0.5 + 0.5 * b);
    let h = this.grassland(x, z) * (1 - t) + this.mountain(x, z) * t;
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
