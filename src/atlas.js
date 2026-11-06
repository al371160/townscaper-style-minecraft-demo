// Procedurally painted 16x16 pixel-art texture atlas (original art, generated at startup).
// Output is a stack of layers for a WebGL2 TEXTURE_2D_ARRAY (no atlas bleeding, clean mipmaps),
// plus a classic 2D atlas canvas for preview.
import { TILES } from './blocks.js';
import { mulberry32 } from './noise.js';

export const TS = 16;
const rnd = mulberry32(0xb10c);
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// small tileable value noise
function vnoise(cells, rng = rnd) {
  const g = Array.from({ length: cells * cells }, () => rng());
  const out = new Float32Array(TS * TS);
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const fx = (x / TS) * cells, fy = (y / TS) * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (i, j) => g[((j % cells) * cells) + (i % cells)];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    out[y * TS + x] = a + (b - a) * sy;
  }
  return out;
}

function tile(fn) {
  const d = new Uint8Array(TS * TS * 4);
  const set = (x, y, c, a = 255) => {
    const i = (y * TS + x) * 4;
    d[i] = clamp(c[0]); d[i + 1] = clamp(c[1]); d[i + 2] = clamp(c[2]); d[i + 3] = a;
  };
  const get = (x, y) => { const i = (y * TS + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  fn(set, get);
  return d;
}
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const jitter = (c, amt) => shade(c, 1 + (rnd() - 0.5) * amt);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function speckle(base, amt, extra) {
  return tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      let c = jitter(base, amt);
      if (extra) c = extra(x, y, c) || c;
      set(x, y, c);
    }
  });
}

const DIRT = [134, 96, 66];
const GRASS = [104, 168, 66];
const STONE = [128, 128, 132];
const SAND = [222, 208, 158];

function dirtPx(x, y, c) {
  const r = rnd();
  if (r < 0.1) return shade(DIRT, 0.72);
  if (r < 0.16) return shade(DIRT, 1.2);
  return c;
}

function stoneTile() {
  const n = vnoise(4), n2 = vnoise(8);
  return tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const v = 0.82 + n[y * TS + x] * 0.25 + n2[y * TS + x] * 0.1 + (rnd() - 0.5) * 0.08;
      let c = shade(STONE, v);
      if (Math.abs(n2[y * TS + x] - 0.5) < 0.025) c = shade(STONE, 0.62);
      set(x, y, c);
    }
  });
}

function oreTile(color) {
  const base = stoneTile();
  const d = new Uint8Array(base);
  const put = (x, y, c) => {
    x = (x + TS) % TS; y = (y + TS) % TS;
    const i = (y * TS + x) * 4; d[i] = clamp(c[0]); d[i + 1] = clamp(c[1]); d[i + 2] = clamp(c[2]);
  };
  for (let k = 0; k < 5; k++) {
    const cx = 2 + Math.floor(rnd() * 12), cy = 2 + Math.floor(rnd() * 12);
    put(cx, cy, color); put(cx + 1, cy, shade(color, 0.8)); put(cx, cy + 1, shade(color, 0.7));
    if (rnd() < 0.6) put(cx + 1, cy + 1, shade(color, 1.15));
    if (rnd() < 0.4) put(cx - 1, cy, shade(color, 0.9));
  }
  return d;
}

function sideWithTop(topColor, rowsMin, rowsMax, amt) {
  return tile((set) => {
    for (let x = 0; x < TS; x++) {
      const rows = rowsMin + Math.floor(rnd() * (rowsMax - rowsMin + 1));
      for (let y = 0; y < TS; y++) {
        if (y < rows) set(x, y, jitter(y === rows - 1 ? shade(topColor, 0.85) : topColor, amt));
        else set(x, y, dirtPx(x, y, jitter(DIRT, 0.22)));
      }
    }
  });
}

const painters = {
  grass_top: () => {
    const n = vnoise(4);
    return speckle(GRASS, 0.25, (x, y, c) => {
      c = shade(c, 0.85 + n[y * TS + x] * 0.3);
      return rnd() < 0.08 ? shade(GRASS, 0.75) : c;
    });
  },
  grass_side: () => sideWithTop(GRASS, 3, 5, 0.25),
  dirt: () => speckle(DIRT, 0.22, dirtPx),
  stone: stoneTile,
  sand: () => speckle(SAND, 0.1, (x, y, c) => (rnd() < 0.07 ? shade(SAND, 0.86) : c)),
  water: () => tile((set) => {
    // vertically periodic so UV scrolling animates seamlessly
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const w = Math.sin((y / TS) * Math.PI * 4 + Math.sin((x / TS) * Math.PI * 2) * 1.4);
      const c = mix([38, 84, 182], [92, 150, 230], 0.5 + 0.5 * w);
      set(x, y, jitter(c, 0.06), 255);
    }
  }),
  lava: () => tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const w = Math.sin((y / TS) * Math.PI * 2 + Math.sin((x / TS) * Math.PI * 4) * 1.8);
      const w2 = Math.sin((x / TS) * Math.PI * 2 + (y / TS) * Math.PI * 4);
      const t = Math.max(0, Math.min(1, 0.5 + 0.35 * w + 0.25 * w2));
      set(x, y, jitter(mix([196, 52, 10], [255, 200, 60], t), 0.06));
    }
  }),
  log_side: () => {
    const off = Array.from({ length: TS }, () => rnd());
    return tile((set) => {
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
        let c = jitter([108, 82, 50], 0.18);
        if ((x + (off[y] > 0.8 ? 1 : 0)) % 4 === 0) c = shade(c, 0.68);
        set(x, y, c);
      }
    });
  },
  log_top: () => tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      let c;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 6.5) c = jitter([96, 72, 44], 0.2);
      else c = (Math.floor(Math.hypot(dx, dy) * 0.9) % 2) ? [178, 142, 90] : [154, 118, 70];
      set(x, y, jitter(c, 0.08));
    }
  }),
  planks: () => tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const band = Math.floor(y / 4);
      let c = jitter(band % 2 ? [176, 136, 84] : [164, 126, 76], 0.1);
      if (y % 4 === 3) c = shade(c, 0.62);
      if ((x + band * 5) % 16 === 0) c = shade(c, 0.7);
      set(x, y, c);
    }
  }),
  leaves: () => tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const r = rnd();
      const c = jitter([60, 132, 44], 0.4);
      set(x, y, r < 0.12 ? shade(c, 0.6) : c, r > 0.86 ? 0 : 255);
    }
  }),
  snow: () => speckle([238, 244, 250], 0.05, (x, y, c) => (rnd() < 0.06 ? [214, 226, 240] : c)),
  snow_side: () => sideWithTop([240, 246, 252], 3, 6, 0.05),
  bedrock: () => tile((set) => {
    const lv = [36, 64, 92, 124];
    const n = vnoise(6);
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const v = lv[Math.min(3, Math.floor((n[y * TS + x] * 0.7 + rnd() * 0.45) * 4))];
      set(x, y, [v, v, v + 4]);
    }
  }),
  coal_ore: () => oreTile([34, 34, 36]),
  iron_ore: () => oreTile([214, 172, 140]),
  gold_ore: () => oreTile([252, 222, 64]),
  diamond_ore: () => oreTile([92, 232, 222]),
  gravel: () => {
    const n = vnoise(8);
    return tile((set) => {
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
        const v = n[y * TS + x];
        const c = v > 0.62 ? [150, 142, 136] : v < 0.35 ? [96, 90, 88] : [124, 118, 114];
        set(x, y, jitter(c, 0.16));
      }
    });
  },
  ice: () => tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      let c = jitter([152, 190, 246], 0.05);
      if ((x + y) % 7 === 0 || (x * 2 + y) % 13 === 0) c = [210, 230, 255];
      set(x, y, c);
    }
  }),
  cactus_side: () => tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      let c = jitter([70, 138, 50], 0.12);
      if (x === 1 || x === 14) c = shade(c, 0.6);
      if (x === 5 || x === 10) c = shade(c, 0.8);
      if ((x === 3 || x === 12) && y % 4 === 1) c = [214, 224, 176];
      set(x, y, c);
    }
  }),
  cactus_top: () => tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      let c = jitter([84, 150, 60], 0.1);
      if (d > 6.5) c = shade(c, 0.6); else if (Math.floor(d) % 3 === 0) c = shade(c, 0.85);
      set(x, y, c);
    }
  }),
  sandstone_side: () => tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      let c = jitter([216, 196, 140], 0.07);
      if (y < 3) c = shade(c, 1.05);
      if (y === 3 || y === 11) c = shade(c, 0.8);
      if (y > 11 && rnd() < 0.15) c = shade(c, 0.9);
      set(x, y, c);
    }
  }),
  sandstone_top: () => tile((set) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      let c = jitter([222, 204, 150], 0.05);
      if (x === 0 || y === 0 || x === 15 || y === 15) c = shade(c, 0.86);
      set(x, y, c);
    }
  }),
};

export function buildAtlas() {
  const n = TILES.length;
  const data = new Uint8Array(TS * TS * 4 * n);
  TILES.forEach((name, i) => data.set(painters[name](), i * TS * TS * 4));

  // 2D atlas canvas (8 tiles per row) for the preview panel
  const cols = 8, rows = Math.ceil(n / cols);
  const cv = document.createElement('canvas');
  cv.width = cols * TS; cv.height = rows * TS;
  const ctx = cv.getContext('2d');
  for (let i = 0; i < n; i++) {
    const img = new ImageData(new Uint8ClampedArray(data.buffer, i * TS * TS * 4, TS * TS * 4), TS, TS);
    ctx.putImageData(img, (i % cols) * TS, Math.floor(i / cols) * TS);
  }
  return { data, count: n, canvas: cv };
}
