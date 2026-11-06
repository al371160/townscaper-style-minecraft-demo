// Block ids, texture-layer names and per-face tile lookup.

export const TILES = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'sand', 'water', 'log_side', 'log_top',
  'leaves', 'snow', 'snow_side', 'bedrock', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore',
  'gravel', 'ice', 'cactus_side', 'cactus_top', 'sandstone_side', 'sandstone_top', 'lava', 'planks',
];
export const T = Object.fromEntries(TILES.map((n, i) => [n, i]));

export const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, SAND = 4, WATER = 5, LOG = 6, LEAVES = 7,
  SNOW = 8, BEDROCK = 9, COAL = 10, IRON = 11, GOLD = 12, DIAMOND = 13, GRAVEL = 14, ICE = 15,
  CACTUS = 16, SANDSTONE = 17, SNOWBLOCK = 18, LAVA = 19, PLANKS = 20;
export const BLOCK_COUNT = 21;

export const BLOCK_NAMES = ['air', 'grass', 'dirt', 'stone', 'sand', 'water', 'log', 'leaves', 'snowy grass',
  'bedrock', 'coal ore', 'iron ore', 'gold ore', 'diamond ore', 'gravel', 'ice', 'cactus', 'sandstone',
  'snow', 'lava', 'planks'];

// [top, side, bottom] tile layer per block
const tiles = {
  [GRASS]: ['grass_top', 'grass_side', 'dirt'],
  [DIRT]: ['dirt', 'dirt', 'dirt'],
  [STONE]: ['stone', 'stone', 'stone'],
  [SAND]: ['sand', 'sand', 'sand'],
  [WATER]: ['water', 'water', 'water'],
  [LOG]: ['log_top', 'log_side', 'log_top'],
  [LEAVES]: ['leaves', 'leaves', 'leaves'],
  [SNOW]: ['snow', 'snow_side', 'dirt'],
  [BEDROCK]: ['bedrock', 'bedrock', 'bedrock'],
  [COAL]: ['coal_ore', 'coal_ore', 'coal_ore'],
  [IRON]: ['iron_ore', 'iron_ore', 'iron_ore'],
  [GOLD]: ['gold_ore', 'gold_ore', 'gold_ore'],
  [DIAMOND]: ['diamond_ore', 'diamond_ore', 'diamond_ore'],
  [GRAVEL]: ['gravel', 'gravel', 'gravel'],
  [ICE]: ['ice', 'ice', 'ice'],
  [CACTUS]: ['cactus_top', 'cactus_side', 'cactus_top'],
  [SANDSTONE]: ['sandstone_top', 'sandstone_side', 'sandstone_top'],
  [SNOWBLOCK]: ['snow', 'snow', 'snow'],
  [LAVA]: ['lava', 'lava', 'lava'],
  [PLANKS]: ['planks', 'planks', 'planks'],
};
export const FACE_TILE = new Uint8Array(BLOCK_COUNT * 3);
for (const [id, names] of Object.entries(tiles)) {
  for (let f = 0; f < 3; f++) FACE_TILE[id * 3 + f] = T[names[f]];
}

// Rendering: opaque blocks hide neighbouring faces. Air, water and leaves do not.
// Lava is drawn as an opaque (emissive, animated) surface.
export const OPAQUE = new Uint8Array(256);
for (let i = 1; i < BLOCK_COUNT; i++) OPAQUE[i] = 1;
OPAQUE[WATER] = 0;
OPAQUE[LEAVES] = 0;

// Physics: what the player collides with / what a ray hits.
export const SOLID = new Uint8Array(256);
for (let i = 1; i < BLOCK_COUNT; i++) SOLID[i] = 1;
SOLID[WATER] = 0;
SOLID[LAVA] = 0;

export const ANIMATED = new Uint8Array(256);
ANIMATED[WATER] = 1;
ANIMATED[LAVA] = 1;

// Blocks the player can place with the number keys
export const HOTBAR = [GRASS, DIRT, STONE, PLANKS, LOG, LEAVES, SAND, SNOWBLOCK, WATER];

// Colours used by the 2D map preview
export const MAP_COLOR = {
  [GRASS]: '#6aa84f', [DIRT]: '#86603f', [STONE]: '#8a8a8a', [SAND]: '#dccf9c', [WATER]: '#3a6fc4',
  [LOG]: '#6b4f2e', [LEAVES]: '#3d7d2a', [SNOW]: '#eef4f8', [SNOWBLOCK]: '#f4f8fb', [GRAVEL]: '#8b8580',
  [ICE]: '#a8c8f4', [CACTUS]: '#4f8c34', [SANDSTONE]: '#d6c48e', [LAVA]: '#e2561b',
};
