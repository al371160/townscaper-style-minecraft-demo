// Main thread: WebGL2 renderer, chunk streaming, player physics, block editing, UI.
import { hashString } from './noise.js';
import { Terrain, SEA, H } from './terrain.js';
import { L, SQ3, worldToChunk, chunkCenterWorld, hexDist, generateGrid, CHUNK_NEIGHBORS } from './grid.js';
import { buildAtlas, TS } from './atlas.js';
import * as B from './blocks.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#gl');
const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
if (!gl) { document.body.innerHTML = '<p style="color:#fff;padding:2rem">WebGL2 is required.</p>'; throw new Error('no webgl2'); }

// ================================================================ shaders
const TERRAIN_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aLayer;
layout(location=3) in float aAO;
layout(location=4) in vec3 aNormal;
uniform mat4 uViewProj;
uniform vec3 uOffset;      // chunk centre - camera (camera-relative rendering)
uniform vec2 uWaveOrigin;  // chunk centre mod 20π, keeps wave phase continuous across chunks
uniform float uTime;
out vec2 vUV; flat out float vLayer; flat out float vAnim; out float vAO; out vec3 vN; out vec3 vP;
void main(){
  vec3 p = aPos + uOffset;
  float anim = aLayer >= 127.5 ? 1.0 : 0.0;
  // water waves: displace the lowered fluid surface (y fraction ≈ .88)
  if (anim > 0.5 && fract(aPos.y) > 0.5) {
    vec2 w = aPos.xz + uWaveOrigin;
    p.y += 0.05 * sin(w.x * 0.7 + uTime * 1.6) + 0.04 * sin(w.y * 0.9 - uTime * 1.3) - 0.05;
  }
  vUV = aUV; vLayer = anim > 0.5 ? aLayer - 128.0 : aLayer; vAnim = anim;
  vAO = aAO; vN = aNormal; vP = p;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform vec3 uFogColor; uniform vec2 uFog; uniform float uGrid; uniform float uAlpha; uniform float uTime;
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uAmbient;
in vec2 vUV; flat in float vLayer; flat in float vAnim; in float vAO; in vec3 vN; in vec3 vP;
out vec4 outColor;
void main(){
  vec2 uv = vUV;
  if (vAnim > 0.5) uv.y = fract(uv.y - uTime * 0.18);   // scroll water / lava textures
  vec4 t = texture(uTex, vec3(uv, vLayer));
  if (uAlpha > 0.99 && t.a < 0.5) discard;
  float nl = length(vN);
  vec3 light;
  if (nl < 0.1) light = vec3(1.25, 1.1, 1.0);                  // emissive lava
  else {
    vec3 n = vN / nl;
    float lam = max(dot(n, uSunDir), 0.0);
    float sky = 0.75 + 0.25 * n.y;
    light = (uAmbient * sky + uSunColor * lam) * vAO;
  }
  vec3 c = t.rgb * light;
  if (uAlpha < 0.99) {                                         // water: sun glint
    vec3 v = normalize(-vP);
    vec3 h = normalize(v + uSunDir);
    c += uSunColor * pow(max(h.y, 0.0), 180.0) * 0.6;
  }
  if (uGrid > 0.5) {                                           // show the Townscaper grid
    vec2 e = min(vUV, 1.0 - vUV);
    float d = min(e.x, e.y);
    float w = fwidth(d) * 1.2 + 0.012;
    c = mix(c * 0.25 + vec3(0.02, 0.05, 0.09), c, smoothstep(0.0, w, d));
  }
  float f = smoothstep(uFog.x, uFog.y, length(vP));
  outColor = vec4(mix(c, uFogColor, f), uAlpha);
}`;

const SKY_VS = `#version 300 es
out vec2 vP;
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0; vP = p; gl_Position = vec4(p, 0.9999, 1.0); }`;
const SKY_FS = `#version 300 es
precision highp float;
uniform vec3 uF, uR, uU; uniform vec2 uTan; uniform vec3 uSunDir;
uniform vec3 uZenith, uHorizon, uSunColor; uniform float uNight;
in vec2 vP; out vec4 o;
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main(){
  vec3 d = normalize(uF + vP.x * uTan.x * uR + vP.y * uTan.y * uU);
  float up = max(d.y, 0.0);
  vec3 c = mix(uHorizon, uZenith, pow(up, 0.55));
  if (d.y < 0.0) c = mix(uHorizon, uHorizon * 0.55, min(1.0, -d.y * 3.0));
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (pow(s, 6.0) * 0.35 + pow(s, 64.0) * 0.4);      // glow: bright near sun, dusky far away
  c += uSunColor * smoothstep(0.9993, 0.9997, s) * 3.0;            // sun disk
  float m = max(dot(d, -uSunDir), 0.0);
  c += vec3(0.8, 0.85, 1.0) * smoothstep(0.9990, 0.9994, m) * uNight; // moon
  if (uNight > 0.0 && d.y > 0.0) {
    vec3 g = floor(d * 260.0);
    float st = step(0.9975, hash(g));
    c += vec3(st) * uNight * up;
  }
  o = vec4(c, 1.0);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uViewProj; uniform vec3 uOffset;
void main(){ gl_Position = uViewProj * vec4(aPos + uOffset, 1.0); gl_Position.z -= 0.0008 * gl_Position.w; }`;
const LINE_FS = `#version 300 es
precision mediump float; out vec4 o; void main(){ o = vec4(0.05, 0.05, 0.05, 0.85); }`;

const POST_VS = SKY_VS;
const POST_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene; uniform int uMedium; uniform float uTime; uniform vec2 uRes;
in vec2 vP; out vec4 o;
void main(){
  vec2 uv = vP * 0.5 + 0.5;
  if (uMedium > 0) {   // animated distortion when submerged
    uv += vec2(sin(uv.y * 24.0 + uTime * 2.2), cos(uv.x * 20.0 + uTime * 1.7)) * 0.0035;
  }
  vec3 c = texture(uScene, uv).rgb;
  if (uMedium == 1) c = mix(c, vec3(0.06, 0.22, 0.5), 0.45) * vec3(0.8, 0.95, 1.15);
  if (uMedium == 2) c = mix(c, vec3(0.9, 0.22, 0.02), 0.6);
  vec2 q = vP; c *= 1.0 - 0.18 * dot(q, q) * 0.5;                // light vignette
  o = vec4(c, 1.0);
}`;

function compile(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}
const progTerrain = compile(TERRAIN_VS, TERRAIN_FS);
const progSky = compile(SKY_VS, SKY_FS);
const progLine = compile(LINE_VS, LINE_FS);
const progPost = compile(POST_VS, POST_FS);
const emptyVao = gl.createVertexArray();

// ================================================================ texture atlas → texture array
const atlas = buildAtlas();
const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, TS, TS, atlas.count, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas.data);
gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
{
  const pv = $('#atlas');
  pv.width = atlas.canvas.width; pv.height = atlas.canvas.height;
  pv.getContext('2d').drawImage(atlas.canvas, 0, 0);
  $('#atlasDl').onclick = () => { const a = document.createElement('a'); a.download = 'atlas.png'; a.href = atlas.canvas.toDataURL(); a.click(); };
}

// ================================================================ shared quad index buffer
let idxBuf = null, idxCap = 0;
function ensureIndex(quads) {
  if (quads <= idxCap) return idxBuf;
  const cap = Math.max(quads, idxCap * 2, 1 << 16);
  const a = new Uint32Array(cap * 6);
  for (let i = 0; i < cap; i++) {
    const v = i * 4, o = i * 6;
    a[o] = v; a[o + 1] = v + 1; a[o + 2] = v + 2; a[o + 3] = v; a[o + 4] = v + 2; a[o + 5] = v + 3;
  }
  idxBuf = gl.createBuffer();                 // old buffers stay alive for VAOs that use them
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, a, gl.STATIC_DRAW);
  idxCap = cap;
  return idxBuf;
}
ensureIndex(1 << 17);

const STRIDE = 20;
function makeMesh(buf, nVerts) {
  if (!nVerts) return null;
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.UNSIGNED_BYTE, true, STRIDE, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, STRIDE, 14);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, true, STRIDE, 15);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 3, gl.BYTE, true, STRIDE, 16);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ensureIndex(nVerts / 4));
  gl.bindVertexArray(null);
  return { vao, vbo, count: (nVerts / 4) * 6, bytes: buf.byteLength };
}
function freeMesh(m) { if (m) { gl.deleteBuffer(m.vbo); gl.deleteVertexArray(m.vao); } }

// selection outline
const lineVao = gl.createVertexArray();
const lineVbo = gl.createBuffer();
gl.bindVertexArray(lineVao);
gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
gl.bufferData(gl.ARRAY_BUFFER, 24 * 12, gl.DYNAMIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
gl.bindVertexArray(null);

// ================================================================ offscreen framebuffer (post-process)
let fbo = null, fboTex = null, fboDepth = null, fboW = 0, fboH = 0;
function ensureFbo(w, h) {
  if (fbo && w === fboW && h === fboH) return;
  if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(fboTex); gl.deleteRenderbuffer(fboDepth); }
  fboW = w; fboH = h;
  fboTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fboTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  fboDepth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, fboDepth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, fboDepth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ================================================================ math
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function viewRot(f, r, u) { // rows = right, up, -forward (camera at origin)
  return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, 0, 0, 0, 1]);
}
function frustumPlanes(m) {
  const p = [];
  const row = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  for (const [a, s] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]]) {
    p.push([r3[0] + s * a[0], r3[1] + s * a[1], r3[2] + s * a[2], r3[3] + s * a[3]]);
  }
  return p;
}
function boxVisible(planes, x0, y0, z0, x1, y1, z1) {
  for (const [a, b, c, d] of planes) {
    if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + d < 0) return false;
  }
  return true;
}
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ================================================================ state
const params = new URLSearchParams(location.search);
const state = {
  seedText: params.get('seed') || 'townscaper',
  seed: 0,
  renderDist: +(params.get('rd') || 7),
  speed: 22,
  grid: false,
  fly: true,
  tod: 0.36, cycle: true,
  hotbar: 0,
  guided: params.get('classic') !== '1',
};
const parseSeed = (s) => (/^-?\d+$/.test(s.trim()) ? (parseInt(s, 10) >>> 0) : hashString(s));

const player = { x: 0, y: 160, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0.6, pitch: -0.25, onGround: false };
const EYE = 1.5, HALF_W = 0.3, BODY_H = 1.8;
let terrain = null;

// ================================================================ chunks + workers
const chunks = new Map();          // "q,r" → chunk
const DEEP_R = 2;                  // chunks within this ring get full cave geometry
let workers = [], jobId = 1, epoch = 0, queue = [], lastQueueAt = 0, lastChunkKey = '';
const results = [];
const editsMain = new Map();       // "q,r,c" → Map(y → block)
const stats = { built: 0, buildMs: 0 };

function startWorkers() {
  for (const w of workers) w.terminate();
  workers = [];
  const n = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.busy = 0;
    const myEpoch = epoch;
    w.onmessage = (e) => { w.busy--; if (myEpoch === epoch) results.push(e.data); };
    w.onerror = (e) => console.error('worker error', e.message || e);
    w.postMessage({ type: 'init', seed: state.seed, guided: state.guided, edits: [...editsMain].map(([k, m]) => [k, [...m]]) });
    workers.push(w);
  }
}

function freeChunk(ch) { freeMesh(ch.opaque); freeMesh(ch.water); ch.opaque = ch.water = null; }

function resetWorld() {
  epoch++;
  for (const ch of chunks.values()) freeChunk(ch);
  chunks.clear(); results.length = 0; queue = []; editsMain.clear(); lastChunkKey = '';
  state.seed = parseSeed(state.seedText);
  terrain = new Terrain(state.seed, state.guided);
  startWorkers();
  spawn();
  $('#seed').value = state.seedText;
  const u = new URL(location.href); u.searchParams.set('seed', state.seedText);
  if (state.guided) u.searchParams.delete('classic'); else u.searchParams.set('classic', '1');
  history.replaceState(null, '', u);
}

function spawn() {
  // walk outward until we find dry land that isn't a mountain peak
  for (let i = 0; i < 400; i++) {
    const a = i * 2.39996, d = i * 6;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const h = terrain.info(x, z);
    if (h > SEA + 2 && h < 175) { player.x = x; player.z = z; player.y = h + 14; break; }
  }
  player.vx = player.vy = player.vz = 0;
}

function requestBuild(ch, priority = false) {
  ch.ver++;
  ch.wantDeep = hexDist(ch.q - camChunk[0], ch.r - camChunk[1]) <= DEEP_R;
  ch.pendingJob = { q: ch.q, r: ch.r, ver: ch.ver, deep: ch.wantDeep };
  if (priority) priorityJobs.push(ch);
}
const priorityJobs = [];
let camChunk = [0, 0];

function rebuildQueue() {
  const [cq, cr] = camChunk;
  const R = state.renderDist;
  const fx = Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  queue = [];
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = Math.max(-R, -dq - R); dr <= Math.min(R, -dq + R); dr++) {
      const q = cq + dq, r = cr + dr, key = q + ',' + r;
      let ch = chunks.get(key);
      const dist = hexDist(dq, dr);
      if (!ch) {
        const [x, z] = chunkCenterWorld(q, r);
        ch = { key, q, r, cx: x, cz: z, ver: 0, gotVer: -1, opaque: null, water: null, data: null, deep: false, wantDeep: false, pendingJob: null, inFlight: 0, minY: 0, maxY: H };
        chunks.set(key, ch);
        requestBuild(ch);
      } else if (ch.data && !ch.pendingJob) {
        // LOD: upgrade nearby chunks to full cave geometry, downgrade far ones to save memory
        if (dist <= DEEP_R && !ch.deep && !ch.wantDeep) requestBuild(ch);
        else if (dist > DEEP_R + 2 && ch.deep && ch.wantDeep) requestBuild(ch);
      }
      if (ch.pendingJob && !priorityJobs.includes(ch)) {
        const [x, z] = chunkCenterWorld(q, r);
        const dx = x - player.x, dz = z - player.z, d = Math.hypot(dx, dz);
        const facing = d > 1 ? (dx * fx + dz * fz) / d : 1;
        queue.push({ ch, score: d * (1.3 - 0.45 * facing) + (ch.data ? 40 : 0) });
      }
    }
  }
  queue.sort((a, b) => b.score - a.score); // pop() takes the best
  // unload chunks outside the render distance
  for (const [key, ch] of chunks) {
    if (hexDist(ch.q - cq, ch.r - cr) > R + 1) { freeChunk(ch); chunks.delete(key); }
  }
}

function dispatch() {
  for (const w of workers) {
    while (w.busy < 2) {
      let ch = priorityJobs.shift();
      if (!ch) { const it = queue.pop(); if (!it) return; ch = it.ch; }
      if (!ch.pendingJob || chunks.get(ch.key) !== ch) continue;
      const job = ch.pendingJob; ch.pendingJob = null;
      w.busy++;
      w.postMessage({ type: 'build', id: jobId++, ...job });
    }
  }
}

function processResults() {
  const t0 = performance.now();
  while (results.length && performance.now() - t0 < 6) {
    const d = results.shift();
    const ch = chunks.get(d.q + ',' + d.r);
    stats.built++; stats.buildMs += d.ms;
    if (!ch || d.ver < ch.gotVer) continue;
    ch.gotVer = d.ver;
    freeChunk(ch);
    ch.opaque = makeMesh(d.opaque, d.nOpaque);
    ch.water = makeMesh(d.water, d.nWater);
    ch.minY = d.minY; ch.maxY = d.maxY; ch.deep = d.deep;
    setChunkData(ch, d);
  }
}

// ================================================================ world queries (cells + RLE columns)
const BK = 1, BG = Math.ceil((2 * L) / BK) + 2;
function setChunkData(ch, d) {
  const verts = new Float32Array(d.verts), cells = new Uint16Array(d.cells);
  const nc = cells.length / 4;
  const prev = ch.data;
  const data = { verts, cells, nc, rle: new Uint8Array(d.rle), rleOff: new Uint32Array(d.rleOff), cache: new Map(), buckets: prev ? prev.buckets : null };
  if (!data.buckets) {
    const buckets = Array.from({ length: BG * BG }, () => []);
    for (let c = 0; c < nc; c++) {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let e = 0; e < 4; e++) {
        const v = cells[c * 4 + e];
        x0 = Math.min(x0, verts[v * 2]); x1 = Math.max(x1, verts[v * 2]);
        z0 = Math.min(z0, verts[v * 2 + 1]); z1 = Math.max(z1, verts[v * 2 + 1]);
      }
      for (let bz = Math.floor((z0 + L) / BK); bz <= Math.floor((z1 + L) / BK); bz++)
        for (let bx = Math.floor((x0 + L) / BK); bx <= Math.floor((x1 + L) / BK); bx++)
          if (bx >= 0 && bz >= 0 && bx < BG && bz < BG) buckets[bz * BG + bx].push(c);
    }
    data.buckets = buckets;
  }
  // keep locally-applied edits that the worker result may not include yet
  ch.data = data;
}

function cellInChunk(ch, x, z) {
  const d = ch.data;
  if (!d) return -1;
  const lx = x - ch.cx, lz = z - ch.cz;
  const bx = Math.floor((lx + L) / BK), bz = Math.floor((lz + L) / BK);
  if (bx < 0 || bz < 0 || bx >= BG || bz >= BG) return -1;
  const { verts, cells } = d;
  for (const c of d.buckets[bz * BG + bx]) {
    let inside = true;
    for (let e = 0; e < 4; e++) {
      const a = cells[c * 4 + e], b = cells[c * 4 + ((e + 1) & 3)];
      const ax = verts[a * 2], az = verts[a * 2 + 1];
      if ((verts[b * 2] - ax) * (lz - az) - (verts[b * 2 + 1] - az) * (lx - ax) < -1e-7) { inside = false; break; }
    }
    if (inside) return c;
  }
  return -1;
}

// → {ch, c} or null
function locate(x, z) {
  const [q, r] = worldToChunk(x, z);
  let ch = chunks.get(q + ',' + r);
  if (ch && ch.data) { const c = cellInChunk(ch, x, z); if (c >= 0) return { ch, c }; }
  for (const [dq, dr] of CHUNK_NEIGHBORS) {      // exactly on a border
    ch = chunks.get((q + dq) + ',' + (r + dr));
    if (ch && ch.data) { const c = cellInChunk(ch, x, z); if (c >= 0) return { ch, c }; }
  }
  return null;
}

function column(ch, c) {
  const d = ch.data;
  let a = d.cache.get(c);
  if (a) return a;
  a = new Uint8Array(H);
  let y = 0;
  for (let i = d.rleOff[c]; i < d.rleOff[c + 1]; i += 2) { a.fill(d.rle[i], y, y + d.rle[i + 1]); y += d.rle[i + 1]; }
  const e = editsMain.get(ch.q + ',' + ch.r + ',' + c);
  if (e) for (const [yy, b] of e) a[yy] = b;
  d.cache.set(c, a);
  return a;
}

// block id, or -1 when the chunk isn't loaded yet
function blockAt(x, y, z) {
  if (y < 0) return B.BEDROCK;
  if (y >= H) return B.AIR;
  const hit = locate(x, z);
  if (!hit) return -1;
  return column(hit.ch, hit.c)[Math.floor(y)];
}

function setBlock(ch, c, y, b) {
  const key = ch.q + ',' + ch.r + ',' + c;
  let m = editsMain.get(key); if (!m) editsMain.set(key, (m = new Map()));
  m.set(y, b);
  column(ch, c)[y] = b;
  for (const w of workers) w.postMessage({ type: 'edit', q: ch.q, r: ch.r, c, y, b });
  requestBuild(ch, true);
  // cells near the hex border affect neighbouring chunk meshes (culling + AO)
  const d = ch.data, v0 = d.cells[c * 4];
  const lx = d.verts[v0 * 2], lz = d.verts[v0 * 2 + 1];
  const inr = L * SQ3 / 2;
  let m2 = 0;
  for (let k = 0; k < 3; k++) { const a = Math.PI / 6 + k * Math.PI / 3; m2 = Math.max(m2, Math.abs(lx * Math.cos(a) + lz * Math.sin(a))); }
  if (inr - m2 < 2.5) for (const [dq, dr] of CHUNK_NEIGHBORS) {
    const n = chunks.get((ch.q + dq) + ',' + (ch.r + dr));
    if (n && n.data) requestBuild(n, true);
  }
}

// ================================================================ ray cast (grid march through irregular cells)
const REACH = 3;
let target = null;
function raycast() {
  const f = forward();
  const ex = player.x, ey = player.y + EYE, ez = player.z;
  let prev = null, lastKey = '';
  for (let t = 0; t <= REACH; t += 0.02) {
    const x = ex + f[0] * t, y = ey + f[1] * t, z = ez + f[2] * t;
    if (y < 0 || y >= H) return null;
    const hit = locate(x, z);
    if (!hit) return null;
    const yi = Math.floor(y);
    const key = hit.ch.key + ':' + hit.c + ':' + yi;
    if (key === lastKey) continue;
    lastKey = key;
    const b = column(hit.ch, hit.c)[yi];
    if (B.SOLID[b]) return { ch: hit.ch, c: hit.c, y: yi, b, prev };
    prev = { ch: hit.ch, c: hit.c, y: yi, b };
  }
  return null;
}

// ================================================================ player physics
function forward() {
  const cp = Math.cos(player.pitch);
  return [cp * Math.sin(player.yaw), Math.sin(player.pitch), -cp * Math.cos(player.yaw)];
}
function solidAt(x, y, z) { const b = blockAt(x, y, z); return b < 0 || B.SOLID[b] === 1; }
const SAMPLE_Y = [0.001, 0.9, BODY_H - 0.02];
const SAMPLE_XZ = [[-HALF_W, -HALF_W], [HALF_W, -HALF_W], [HALF_W, HALF_W], [-HALF_W, HALF_W], [0, 0]];
function collides(px, py, pz) {
  for (const sy of SAMPLE_Y) for (const [sx, sz] of SAMPLE_XZ) if (solidAt(px + sx, py + sy, pz + sz)) return true;
  return false;
}
function mediumAt(x, y, z) {
  const b = blockAt(x, y, z);
  return b === B.WATER ? 1 : b === B.LAVA ? 2 : 0;
}

const keys = new Set();
function tickPlayer(dt) {
  const f = forward();
  const fx = Math.sin(player.yaw), fz = -Math.cos(player.yaw);   // flattened forward
  const rx = Math.cos(player.yaw), rz = Math.sin(player.yaw);    // right
  const k = (c) => keys.has(c);
  const inFluid = !state.fly && (mediumAt(player.x, player.y + 0.4, player.z) || mediumAt(player.x, player.y + 1.2, player.z));
  const fluidK = inFluid ? 2 / 3 : 1;
  const sprint = k('ShiftLeft') || k('ShiftRight') ? 2.5 : 1;

  if (state.fly) {
    let ax = 0, ay = 0, az = 0;
    if (k('KeyW')) { ax += f[0]; ay += f[1]; az += f[2]; }
    if (k('KeyS')) { ax -= f[0]; ay -= f[1]; az -= f[2]; }
    if (k('KeyD')) { ax += rx; az += rz; }
    if (k('KeyA')) { ax -= rx; az -= rz; }
    if (k('KeyE') || k('Space')) ay += 1;
    if (k('KeyQ')) ay -= 1;
    const len = Math.hypot(ax, ay, az) || 1;
    const damp = Math.exp(-8 * dt);                       // friction first, then acceleration
    const acc = state.speed * sprint * 8;
    player.vx = player.vx * damp + (ax / len) * acc * dt;
    player.vy = player.vy * damp + (ay / len) * acc * dt;
    player.vz = player.vz * damp + (az / len) * acc * dt;
    player.x += player.vx * dt; player.y += player.vy * dt; player.z += player.vz * dt;
    player.y = Math.max(1, Math.min(H + 60, player.y));
    return;
  }

  // ground mode
  let ax = 0, az = 0;
  if (k('KeyW')) { ax += fx; az += fz; }
  if (k('KeyS')) { ax -= fx; az -= fz; }
  if (k('KeyD')) { ax += rx; az += rz; }
  if (k('KeyA')) { ax -= rx; az -= rz; }
  const len = Math.hypot(ax, az) || 1;
  const walk = 5.2 * (sprint > 1 ? 1.6 : 1) * fluidK;
  const damp = Math.exp(-(player.onGround || inFluid ? 12 : 2.5) * dt);
  const acc = walk * (player.onGround || inFluid ? 12 : 2.5);
  player.vx = player.vx * damp + (ax / len) * acc * dt;
  player.vz = player.vz * damp + (az / len) * acc * dt;
  if (inFluid) {
    player.vy = player.vy * Math.exp(-3 * dt) - 26 * fluidK * 0.35 * dt;
    if (k('Space')) player.vy = 3.2;                    // swim up at a constant rate
  } else {
    player.vy -= 26 * dt;
    if (k('Space') && player.onGround) player.vy = 8.6;
  }
  player.vy = Math.max(player.vy, -50);

  const stuck = collides(player.x, player.y, player.z);
  const moveAxis = (axis, d) => {
    const n = Math.ceil(Math.abs(d) / 0.2);
    const st = d / (n || 1);
    for (let i = 0; i < n; i++) {
      const nx = player.x + (axis === 0 ? st : 0), ny = player.y + (axis === 1 ? st : 0), nz = player.z + (axis === 2 ? st : 0);
      if (stuck || !collides(nx, ny, nz)) { player.x = nx; player.y = ny; player.z = nz; continue; }
      if (axis === 1) {
        if (st < 0) {
          const snap = Math.floor(ny) + 1;               // land exactly on the block top
          if (snap <= player.y + 0.05 && !collides(player.x, snap, player.z)) player.y = snap;
          player.onGround = true;
        }
        player.vy = 0;
      } else if (axis === 0) player.vx = 0; else player.vz = 0;
      return;
    }
  };
  player.onGround = false;
  moveAxis(0, player.vx * dt);
  moveAxis(2, player.vz * dt);
  moveAxis(1, player.vy * dt);
}

// ================================================================ day / night
function sky() {
  const th = (state.tod - 0.25) * Math.PI * 2;
  let sx = Math.cos(th), sy = Math.sin(th), sz = 0.35;
  const l = Math.hypot(sx, sy, sz); sx /= l; sy /= l; sz /= l;
  const e = sy;
  const NIGHT = { z: [0.01, 0.015, 0.05], h: [0.03, 0.04, 0.09], sun: [0.0, 0.0, 0.0], amb: [0.14, 0.16, 0.26] };
  const DUSK = { z: [0.16, 0.2, 0.42], h: [0.98, 0.52, 0.3], sun: [1.0, 0.55, 0.3], amb: [0.36, 0.3, 0.36] };
  const DAY = { z: [0.22, 0.46, 0.86], h: [0.66, 0.8, 0.95], sun: [1.0, 0.96, 0.88], amb: [0.42, 0.46, 0.55] };
  let a, b, t;
  if (e < -0.18) { a = NIGHT; b = NIGHT; t = 0; }
  else if (e < 0.08) { a = NIGHT; b = DUSK; t = sstep(-0.18, 0.08, e); }
  else { a = DUSK; b = DAY; t = sstep(0.08, 0.42, e); }
  const mixk = (k) => lerp3(a[k], b[k], t);
  const sunUp = sstep(-0.05, 0.1, e);
  // at night, light comes from the moon
  const moon = e < -0.05;
  return {
    sunDir: moon ? [-sx, -sy, -sz] : [sx, sy, sz],
    lightCol: moon ? [0.12, 0.14, 0.22] : mixk('sun').map((v) => v * (0.25 + 0.75 * sunUp)),
    skySunDir: [sx, sy, sz],
    zenith: mixk('z'), horizon: mixk('h'), sunCol: mixk('sun'), amb: mixk('amb'),
    night: 1 - sstep(-0.2, 0.02, e),
  };
}

// ================================================================ render
let viewProj = null, planes = null;
const drawStats = { calls: 0, tris: 0 };
let time = 0;

function render() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ensureFbo(w, h);

  const f = forward();
  const r = [Math.cos(player.yaw), 0, Math.sin(player.yaw)];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const fov = (72 * Math.PI) / 180, aspect = w / h;
  const fogFar = state.renderDist * L * SQ3 * 0.98, fogNear = fogFar * 0.45;
  viewProj = mul(perspective(fov, aspect, 0.05, fogFar * 1.4), viewRot(f, r, u));
  planes = frustumPlanes(viewProj);
  const S = sky();

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, w, h);
  gl.clear(gl.DEPTH_BUFFER_BIT);

  // sky
  gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
  gl.useProgram(progSky.p);
  gl.uniform3fv(progSky.u.uF, f); gl.uniform3fv(progSky.u.uR, r); gl.uniform3fv(progSky.u.uU, u);
  gl.uniform2f(progSky.u.uTan, Math.tan(fov / 2) * aspect, Math.tan(fov / 2));
  gl.uniform3fv(progSky.u.uSunDir, S.skySunDir);
  gl.uniform3fv(progSky.u.uZenith, S.zenith); gl.uniform3fv(progSky.u.uHorizon, S.horizon);
  gl.uniform3fv(progSky.u.uSunColor, S.sunCol); gl.uniform1f(progSky.u.uNight, S.night);
  gl.bindVertexArray(emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // terrain
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  const P = progTerrain;
  gl.useProgram(P.p);
  gl.uniformMatrix4fv(P.u.uViewProj, false, viewProj);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.uniform1i(P.u.uTex, 0);
  gl.uniform3fv(P.u.uFogColor, S.horizon); gl.uniform2f(P.u.uFog, fogNear, fogFar);
  gl.uniform1f(P.u.uGrid, state.grid ? 1 : 0); gl.uniform1f(P.u.uTime, time);
  gl.uniform3fv(P.u.uSunDir, S.sunDir); gl.uniform3fv(P.u.uSunColor, S.lightCol); gl.uniform3fv(P.u.uAmbient, S.amb);
  gl.uniform1f(P.u.uAlpha, 1);

  const visible = [];
  for (const ch of chunks.values()) {
    if (!ch.opaque && !ch.water) continue;
    const ox = ch.cx - player.x, oz = ch.cz - player.z;
    if (!boxVisible(planes, ox - L, ch.minY - player.y - EYE, oz - L, ox + L, ch.maxY + 1 - player.y - EYE, oz + L)) continue;
    visible.push({ ch, d: ox * ox + oz * oz, ox, oz });
  }
  visible.sort((a, b) => a.d - b.d);   // front-to-back for early-z
  drawStats.calls = 0; drawStats.tris = 0;
  const setChunkUniforms = (v) => {
    gl.uniform3f(P.u.uOffset, v.ox, -player.y - EYE, v.oz);
    const W = 20 * Math.PI;
    gl.uniform2f(P.u.uWaveOrigin, ((v.ch.cx % W) + W) % W, ((v.ch.cz % W) + W) % W);
  };
  for (const v of visible) {
    if (!v.ch.opaque) continue;
    setChunkUniforms(v);
    gl.bindVertexArray(v.ch.opaque.vao);
    gl.drawElements(gl.TRIANGLES, v.ch.opaque.count, gl.UNSIGNED_INT, 0);
    drawStats.calls++; drawStats.tris += v.ch.opaque.count / 3;
  }

  // selection outline
  if (target) drawOutline(target);

  // transparent pass (water), back-to-front
  gl.useProgram(P.p);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false); gl.disable(gl.CULL_FACE);
  gl.uniform1f(P.u.uAlpha, 0.72);
  for (let i = visible.length - 1; i >= 0; i--) {
    const v = visible[i];
    if (!v.ch.water) continue;
    setChunkUniforms(v);
    gl.bindVertexArray(v.ch.water.vao);
    gl.drawElements(gl.TRIANGLES, v.ch.water.count, gl.UNSIGNED_INT, 0);
    drawStats.calls++; drawStats.tris += v.ch.water.count / 3;
  }
  gl.disable(gl.BLEND); gl.depthMask(true);

  // post-process to screen
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(progPost.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fboTex);
  gl.uniform1i(progPost.u.uScene, 0);
  gl.uniform1i(progPost.u.uMedium, Math.max(0, mediumAt(player.x, player.y + EYE, player.z)));
  gl.uniform1f(progPost.u.uTime, time);
  gl.bindVertexArray(emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

function drawOutline(t) {
  const d = t.ch.data, a = [];
  const vx = (i) => d.verts[d.cells[t.c * 4 + i] * 2], vz = (i) => d.verts[d.cells[t.c * 4 + i] * 2 + 1];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    a.push(vx(i), t.y, vz(i), vx(j), t.y, vz(j));
    a.push(vx(i), t.y + 1, vz(i), vx(j), t.y + 1, vz(j));
    a.push(vx(i), t.y, vz(i), vx(i), t.y + 1, vz(i));
  }
  gl.useProgram(progLine.p);
  gl.uniformMatrix4fv(progLine.u.uViewProj, false, viewProj);
  gl.uniform3f(progLine.u.uOffset, t.ch.cx - player.x, -player.y - EYE, t.ch.cz - player.z);
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(a));
  gl.drawArrays(gl.LINES, 0, 24);
}

// ================================================================ input
canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => {
  $('#lockHint').classList.toggle('hidden', document.pointerLockElement === canvas);
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw += e.movementX * 0.0023;
  player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - e.movementY * 0.0023));
});
canvas.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return;
  const t = raycast();
  if (!t) return;
  if (e.button === 0) {
    if (t.b !== B.BEDROCK) setBlock(t.ch, t.c, t.y, B.AIR);
  } else if (e.button === 2 && t.prev) {
    const p = t.prev, col = column(p.ch, p.c), old = col[p.y];
    col[p.y] = B.HOTBAR[state.hotbar];
    const blocked = !state.fly && B.SOLID[col[p.y]] && collides(player.x, player.y, player.z);
    col[p.y] = old;
    if (!blocked) setBlock(p.ch, p.c, p.y, B.HOTBAR[state.hotbar]);
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code === 'KeyF') { state.fly = !state.fly; player.vy = 0; updateModeUi(); }
  if (e.code === 'KeyG') { state.grid = !state.grid; $('#gridToggle').checked = state.grid; }
  if (e.code === 'KeyP') togglePipeline();
  if (e.code === 'KeyT') { state.cycle = !state.cycle; $('#cycle').checked = state.cycle; }
  if (/^Digit[1-9]$/.test(e.code)) { state.hotbar = +e.code.slice(5) - 1; drawHotbar(); }
  if (e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
canvas.addEventListener('wheel', (e) => {
  state.hotbar = (state.hotbar + (e.deltaY > 0 ? 1 : -1) + B.HOTBAR.length) % B.HOTBAR.length;
  drawHotbar();
}, { passive: true });

// ================================================================ UI
$('#seed').value = state.seedText;
$('#seedForm').addEventListener('submit', (e) => { e.preventDefault(); state.seedText = $('#seed').value.trim() || '0'; resetWorld(); });
$('#randomSeed').onclick = () => { state.seedText = String((Math.random() * 1e9) | 0); resetWorld(); };
$('#rd').value = state.renderDist; $('#rdVal').textContent = state.renderDist;
$('#rd').oninput = (e) => { state.renderDist = +e.target.value; $('#rdVal').textContent = state.renderDist; lastQueueAt = 0; };
$('#speed').value = state.speed; $('#speedVal').textContent = state.speed;
$('#speed').oninput = (e) => { state.speed = +e.target.value; $('#speedVal').textContent = state.speed; };
$('#gridToggle').onchange = (e) => { state.grid = e.target.checked; };
$('#guided').checked = state.guided;
$('#guided').onchange = (e) => { state.guided = e.target.checked; resetWorld(); };
$('#cycle').checked = state.cycle;
$('#cycle').onchange = (e) => { state.cycle = e.target.checked; };
$('#tod').oninput = (e) => { state.tod = +e.target.value; };
$('#modeBtn').onclick = () => { state.fly = !state.fly; player.vy = 0; updateModeUi(); };
$('#teleport').onclick = () => {
  const a = Math.random() * Math.PI * 2;
  player.x += Math.cos(a) * 1e6; player.z += Math.sin(a) * 1e6;
  const h = terrain.info(player.x, player.z); player.y = Math.max(h, SEA) + 25;
  state.fly = true; updateModeUi(); lastQueueAt = 0;
};
$('#pipeBtn').onclick = () => togglePipeline();
$('#pipeClose').onclick = () => togglePipeline(false);
function updateModeUi() { $('#modeBtn').textContent = state.fly ? 'Flight mode (F)' : 'Walk mode (F)'; }
updateModeUi();

function drawHotbar() {
  const hb = $('#hotbar');
  hb.innerHTML = '';
  B.HOTBAR.forEach((b, i) => {
    const cv = document.createElement('canvas');
    cv.width = TS; cv.height = TS;
    const layer = B.FACE_TILE[b * 3 + 1];
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(atlas.data.buffer, layer * TS * TS * 4, TS * TS * 4).slice(), TS, TS), 0, 0);
    cv.className = i === state.hotbar ? 'sel' : '';
    cv.title = `${i + 1}: ${B.BLOCK_NAMES[b]}`;
    hb.appendChild(cv);
  });
  $('#hotbarName').textContent = B.BLOCK_NAMES[B.HOTBAR[state.hotbar]];
}
drawHotbar();

// ---------------------------------------------------------------- grid pipeline viewer
let pipeStage = 4;
const STAGES = ['1 · Hex triangles', '2 · Random merge', '3 · Subdivide', '4 · Relax', '5 · Tiled chunks', '6 · Hex guides', '7 · Noise terrain'];
{
  const tabs = $('#pipeTabs');
  STAGES.forEach((s, i) => {
    const b = document.createElement('button');
    b.textContent = s;
    b.onclick = () => { pipeStage = i + 1; drawPipeline(); };
    tabs.appendChild(b);
  });
}
function togglePipeline(force) {
  const el = $('#pipeline');
  const show = force ?? el.classList.contains('hidden');
  el.classList.toggle('hidden', !show);
  if (show) { if (document.pointerLockElement) document.exitPointerLock(); drawPipeline(); }
}
function drawPipeline() {
  [...$('#pipeTabs').children].forEach((b, i) => b.classList.toggle('active', i + 1 === pipeStage));
  const cv = $('#pipeCanvas'), ctx = cv.getContext('2d');
  const W = cv.width;
  ctx.fillStyle = '#0f1419'; ctx.fillRect(0, 0, W, W);
  const [q, r] = camChunk;
  const poly = (pts, fill, stroke, lw = 1) => {
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  };
  const desc = $('#pipeDesc');
  if (pipeStage <= 4) {
    const g = generateGrid(q, r, state.seed, true), st = g.stages;
    const [ox, oz] = chunkCenterWorld(q, r);
    const sc = (W / 2 - 18) / L;
    const P = (x, z) => [W / 2 + (x - ox) * sc, W / 2 + (z - oz) * sc];
    const U = (v) => P(st.ux[v], st.uz[v]);
    if (pipeStage === 1) {
      st.tris.forEach((t, i) => poly(t.map(U), i % 2 ? '#1d3b5a' : '#21476b', '#6cb6ff', 1));
      desc.textContent = `Chunk (${q}, ${r}): a side-${8} hexagon on the global triangular lattice → ${st.tris.length} triangles.`;
    } else if (pipeStage === 2) {
      let nq = 0;
      st.polys.forEach((p) => { if (p.length === 4) nq++; poly(p.map(U), p.length === 4 ? '#24507a' : '#7a3b2e', '#9ecbff', 1); });
      desc.textContent = `Seeded random merging of neighbouring triangles: ${nq} quads (blue) + ${st.polys.length - nq} leftover triangles (red).`;
    } else if (pipeStage === 3) {
      for (let c = 0; c < g.nc; c++) poly([0, 1, 2, 3].map((e) => U(st.cells[c * 4 + e])), (g.hash[c] & 1) ? '#1f3d2d' : '#244a35', '#8fe3b0', 0.8);
      desc.textContent = `Every polygon is split at edge midpoints + centre → ${g.nc} quads (tri→3, quad→4). Now everything is a quad.`;
    } else {
      for (let c = 0; c < g.nc; c++) poly([0, 1, 2, 3].map((e) => P(g.vx[g.cells[c * 4 + e]], g.vz[g.cells[c * 4 + e]])), (g.hash[c] & 1) ? '#3b2f52' : '#46386a', '#d2b8ff', 0.8);
      ctx.fillStyle = '#ffd166';
      for (let v = 0; v < g.nv; v++) if (g.fixed[v]) { const [x, y] = P(g.vx[v], g.vz[v]); ctx.fillRect(x - 1.5, y - 1.5, 3, 3); }
      desc.textContent = 'Relaxation pulls every quad toward a square. Yellow border vertices stay pinned to the lattice so neighbouring chunks stitch seamlessly.';
    }
  } else {
    const list = [[0, 0], ...CHUNK_NEIGHBORS];
    const [ox, oz] = chunkCenterWorld(q, r);
    const sc = (W / 2 - 10) / (L * 2.7);
    const P = (x, z) => [W / 2 + (x - ox) * sc, W / 2 + (z - oz) * sc];
    const tmp = new Uint8Array(H);
    list.forEach(([dq, dr], i) => {
      const g = generateGrid(q + dq, r + dr, state.seed);
      for (let c = 0; c < g.nc; c++) {
        const pts = [0, 1, 2, 3].map((e) => P(g.vx[g.cells[c * 4 + e]], g.vz[g.cells[c * 4 + e]]));
        let fill;
        if (pipeStage === 5) fill = `hsl(${(i * 51 + 200) % 360} 45% ${(g.hash[c] & 1) ? 30 : 36}%)`;
        else if (pipeStage === 6) {
          const h = terrain.info(g.cx[c], g.cz[c]);
          const k = Math.max(8, Math.min(70, 8 + (h - 120) * 0.55));
          fill = h <= SEA ? `hsl(205 45% ${Math.max(12, k - 6)}%)` : `hsl(${(140 - (h - SEA) * 1.1) | 0} 22% ${k}%)`;
        } else {
          tmp.fill(0);
          const h = terrain.column(g.cx[c], g.cz[c], g.hash[c], tmp);
          let y = H - 1; while (y > 0 && tmp[y] === 0) y--;
          const base = B.MAP_COLOR[tmp[y]] || '#888';
          const k = Math.max(0.55, Math.min(1.35, 0.6 + (h - 128) / 110));
          fill = shadeHex(base, tmp[y] === B.WATER ? 0.75 + (h - 120) / 80 : k);
        }
        poly(pts, fill, pipeStage === 5 ? 'rgba(255,255,255,0.35)' : pipeStage === 6 ? null : 'rgba(0,0,0,0.25)', 0.6);
      }
    });
    if (pipeStage === 6 && state.guided) {
      // original hexagons (before the triangle split), their control lattice and guide curves
      list.forEach(([dq, dr]) => {
        const hc = terrain.hexCurves(q + dq, r + dr);
        const corners = [0, 1, 2, 3, 4, 5].map((k) => P(hc.ox + L * Math.cos(k * Math.PI / 3), hc.oz + L * Math.sin(k * Math.PI / 3)));
        poly(corners, null, 'rgba(255,255,255,0.55)', 1.5);
        ctx.fillStyle = '#ffd166';
        [P(hc.ox, hc.oz), ...corners].forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); });
        hc.pattern.forEach(([a, b], ci) => {
          ctx.beginPath();
          for (let s = 0; s <= 14; s++) {
            const o = (ci * 15 + s) * 2, [x, y] = P(hc.pts[o], hc.pts[o + 1]);
            if (s) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          ctx.strokeStyle = (a - b + 6) % 6 === 3 ? '#ff8fa3' : '#7ee0ff'; ctx.lineWidth = 3; ctx.stroke();
        });
      });
    }
    desc.textContent = pipeStage === 5
      ? 'Seven chunks: each one has its own seeded grid, but the shared lattice border makes the whole plane one continuous irregular grid.'
      : pipeStage === 6
      ? (state.guided
        ? 'Before the triangle split, each hexagon carries smooth guides. Macro height is sampled only at hex centres + corners (yellow) and blended with a C² kernel. Each hex links its edge midpoints with Bézier curves (blue arcs, pink straight lines) that meet their neighbours tangentially, so ridges and swales flow across chunks. Cells are shaded by the resulting height.'
        : 'Hex guides are off (classic per-cell noise). Enable "Hex-guided smooth terrain" in the panel.')
      : 'Noise terrain applied per cell: each irregular cell becomes a voxel column whose height & biome come from noise sampled at its centroid.';
  }
}
function shadeHex(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ================================================================ main loop
let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0, hudAt = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  if (state.cycle) { state.tod = (state.tod + dt / 360) % 1; $('#tod').value = state.tod; }

  tickPlayer(dt);
  camChunk = worldToChunk(player.x, player.z);
  const ck = camChunk.join(',');
  if (ck !== lastChunkKey || now - lastQueueAt > 300) { lastChunkKey = ck; lastQueueAt = now; rebuildQueue(); }
  dispatch();
  processResults();
  target = document.pointerLockElement === canvas ? raycast() : null;
  render();

  fpsAcc += dt; fpsN++;
  if (now - hudAt > 250) {
    fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; hudAt = now;
    let ready = 0, pending = 0, bytes = 0;
    for (const ch of chunks.values()) {
      if (ch.data) ready++;
      if (ch.pendingJob || ch.gotVer < ch.ver) pending++;
      bytes += (ch.opaque ? ch.opaque.bytes : 0) + (ch.water ? ch.water.bytes : 0);
    }
    const hh = Math.floor(state.tod * 24), mm = Math.floor((state.tod * 24 - hh) * 60);
    const here = locate(player.x, player.z);
    $('#stats').innerHTML = [
      `<b>${fps.toFixed(0)}</b> fps · ${drawStats.calls} draws · ${(drawStats.tris / 1e6).toFixed(2)}M tris`,
      `pos ${player.x.toFixed(1)}, ${player.y.toFixed(1)}, ${player.z.toFixed(1)}`,
      `chunk (${camChunk[0]}, ${camChunk[1]})${here ? ` · cell #${here.c}` : ''}`,
      `chunks ${ready} ready · ${pending} building · ${workers.length} workers`,
      `GPU mesh ${(bytes / 1048576).toFixed(0)} MB · avg build ${(stats.buildMs / Math.max(1, stats.built)).toFixed(0)} ms`,
      `time ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${state.fly ? 'flying' : player.onGround ? 'walking' : 'airborne'}`,
      target ? `target: ${B.BLOCK_NAMES[target.b]} @ y${target.y}` : '&nbsp;',
    ].join('<br>');
  }
  requestAnimationFrame(frame);
}

resetWorld();
requestAnimationFrame(frame);
window.demo = { player, state, blockAt, chunks, raycast, setBlock, locate, column,
  step(dt = 1 / 60) { tickPlayer(dt); camChunk = worldToChunk(player.x, player.z); rebuildQueue(); dispatch(); processResults(); } }; // handy for debugging from the console
