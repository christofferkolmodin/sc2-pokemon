import * as THREE from "three";
import type { GameMap } from "../../sim/map.ts";
import type { RenderData } from "../../maps/load.ts";

/**
 * Terrain: a heightfield mesh plus a painted albedo texture.
 *
 * Imported SC2 maps bring their own vertex heights (2 tiles per cliff level)
 * and minimap image. Built-in maps get heights from the cliff-level grid:
 * walkable ground is flat per level, cliff bands become steep S-shaped walls,
 * and blocked tiles that aren't cliffs rise into rock formations.
 */

export const LEVEL_HEIGHT = 2; // tiles per cliff level (SC2)
export const MARGIN = 10;

export interface HeightGrid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Vertex heights (tiles), vertex (i, j) at tile coordinate (x0 + i, y0 + j). */
  data: Float32Array;
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number, oct = 4): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return s;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Per-tile classification used by the built-in height generator and the albedo painter. */
function classify(m: GameMap) {
  const { w, h, level, terrain } = m;
  const cliff = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!terrain[i]) continue;
      for (let dy = -1; dy <= 1 && !cliff[i]; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (Math.abs(level[ny * w + nx] - level[i]) > 8) {
            cliff[i] = 1;
            break;
          }
        }
    }
  return cliff;
}

/** Heights for maps without imported height data. RES vertices per tile. */
export function builtinHeights(m: GameMap, res = 2): HeightGrid {
  const cliff = classify(m);
  const x0 = -MARGIN;
  const y0 = -MARGIN;
  const w = (m.w + MARGIN * 2) * res + 1;
  const h = (m.h + MARGIN * 2) * res + 1;
  const data = new Float32Array(w * h);
  const walk = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < m.w && ty < m.h && !m.terrain[ty * m.w + tx];
  const lvl = (tx: number, ty: number) => (m.level[Math.max(0, Math.min(m.h - 1, ty)) * m.w + Math.max(0, Math.min(m.w - 1, tx))] / 16) * LEVEL_HEIGHT;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const px = x0 + i / res;
      const py = y0 + j / res;
      const tx = Math.floor(px);
      const ty = Math.floor(py);
      // Ground: inverse-distance weighting of nearby walkable tiles with a high power,
      // which keeps each level flat and makes the transitions between them steep.
      let ws = 0;
      let hs = 0;
      let nearest = 9;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const ax = tx + dx;
          const ay = ty + dy;
          if (!walk(ax, ay)) continue;
          const cx = Math.max(ax, Math.min(ax + 1, px));
          const cy = Math.max(ay, Math.min(ay + 1, py));
          const d = Math.hypot(px - cx, py - cy);
          nearest = Math.min(nearest, d);
          const wgt = 1 / (Math.pow(d, 5) + 1e-4);
          ws += wgt;
          hs += wgt * lvl(ax, ay);
        }
      let height = ws > 0 ? hs / ws : lvl(tx, ty);
      const inside = tx >= 0 && ty >= 0 && tx < m.w && ty < m.h;
      const isCliff = inside && cliff[ty * m.w + tx];
      // Rock formations and the scenery around the map rise out of the ground.
      if (nearest > 0 && !isCliff) {
        const out = Math.max(0, -px, -py, px - m.w, py - m.h);
        const rock = (fbm(px * 0.9, py * 0.9) - 0.5) * 1.1 + (fbm(px * 3.1 + 7, py * 3.1) - 0.5) * 0.4;
        const rise = smooth(0, 0.9, nearest) * (2.0 + rock * smooth(0.1, 1.0, nearest)) + Math.max(0, (fbm(px * 0.22 + 40, py * 0.22) - 0.35) * 2.2) * smooth(1.2, 3, nearest);
        height += rise + out * 0.15;
      } else if (isCliff) {
        height += (fbm(px * 2.5, py * 2.5) - 0.5) * 0.35 * smooth(0, 0.6, nearest);
      }
      data[j * w + i] = height;
    }
  return { x0, y0, w, h, data };
}

/** Imported heights are one vertex per tile; upsample them (bicubic-ish) with a little rock noise on steep parts. */
export function importedHeights(r: NonNullable<RenderData["heights"]>, res = 2): HeightGrid {
  const w = (r.w - 1) * res + 1;
  const h = (r.h - 1) * res + 1;
  const data = new Float32Array(w * h);
  const at = (i: number, j: number) => r.data[Math.max(0, Math.min(r.h - 1, j)) * r.w + Math.max(0, Math.min(r.w - 1, i))];
  const cubic = (p0: number, p1: number, p2: number, p3: number, t: number) =>
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const fx = i / res;
      const fy = j / res;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const row = (jj: number) => cubic(at(ix - 1, jj), at(ix, jj), at(ix + 1, jj), at(ix + 2, jj), tx);
      let v = cubic(row(iy - 1), row(iy), row(iy + 1), row(iy + 2), ty);
      const slope = Math.abs(at(ix + 1, iy) - at(ix, iy)) + Math.abs(at(ix, iy + 1) - at(ix, iy));
      const px = r.x0 + fx;
      const py = r.y0 + fy;
      v += (fbm(px * 2.3, py * 2.3) - 0.5) * 0.4 * smooth(0.5, 1.5, slope);
      data[j * w + i] = v;
    }
  return { x0: r.x0, y0: r.y0, w, h, data, res } as HeightGrid & { res: number };
}

export class Heights {
  readonly res: number;
  constructor(
    readonly g: HeightGrid,
    res: number,
  ) {
    this.res = res;
  }
  /** Terrain height (tiles) at map position (x, y) in tiles. */
  at(x: number, y: number): number {
    const g = this.g;
    const fx = (x - g.x0) * this.res;
    const fy = (y - g.y0) * this.res;
    const ix = Math.max(0, Math.min(g.w - 2, Math.floor(fx)));
    const iy = Math.max(0, Math.min(g.h - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - ix));
    const ty = Math.max(0, Math.min(1, fy - iy));
    const a = g.data[iy * g.w + ix];
    const b = g.data[iy * g.w + ix + 1];
    const c = g.data[(iy + 1) * g.w + ix];
    const d = g.data[(iy + 1) * g.w + ix + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }
}

/** Builds the terrain geometry (positions, normals, uvs into the albedo texture). */
export function terrainGeometry(H: Heights): THREE.BufferGeometry {
  const g = H.g;
  const res = H.res;
  const n = g.w * g.h;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const hgt = (i: number, j: number) => g.data[Math.max(0, Math.min(g.h - 1, j)) * g.w + Math.max(0, Math.min(g.w - 1, i))];
  const step = 1 / res;
  for (let j = 0; j < g.h; j++)
    for (let i = 0; i < g.w; i++) {
      const k = j * g.w + i;
      pos[k * 3] = g.x0 + i * step;
      pos[k * 3 + 1] = g.data[k];
      pos[k * 3 + 2] = g.y0 + j * step;
      const nx = hgt(i - 1, j) - hgt(i + 1, j);
      const nz = hgt(i, j - 1) - hgt(i, j + 1);
      const ny = 2 * step;
      const l = Math.hypot(nx, ny, nz);
      nrm[k * 3] = nx / l;
      nrm[k * 3 + 1] = ny / l;
      nrm[k * 3 + 2] = nz / l;
      uv[k * 2] = i / (g.w - 1);
      uv[k * 2 + 1] = 1 - j / (g.h - 1);
    }
  const idx = new Uint32Array((g.w - 1) * (g.h - 1) * 6);
  let t = 0;
  for (let j = 0; j < g.h - 1; j++)
    for (let i = 0; i < g.w - 1; i++) {
      const a = j * g.w + i;
      const b = a + g.w;
      idx[t++] = a;
      idx[t++] = b;
      idx[t++] = a + 1;
      idx[t++] = b;
      idx[t++] = b + 1;
      idx[t++] = a + 1;
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Per-tile inputs for painting ramps: which walkable tiles are ramps (between
 * two cliff levels), each walkable tile's level, and how close each tile is
 * to blocked ground (the cliffs along a ramp's sides).
 */
function rampFields(m: GameMap) {
  const { w, h, level, terrain } = m;
  const ramp = new Float32Array(w * h);
  const lvl = new Float32Array(w * h);
  const walk = new Float32Array(w * h);
  const wall = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    walk[i] = terrain[i] ? 0 : 1;
    lvl[i] = level[i];
    ramp[i] = !terrain[i] && level[i] % 16 !== 0 ? 1 : 0;
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && terrain[ny * w + nx]) n++;
        }
      wall[y * w + x] = Math.min(1, n / 3);
    }
  return { w, h, ramp, lvl, walk, wall };
}

/** Bilinear sample of a per-tile field at tile coordinates (tile centres at +0.5); `weight` skips tiles (e.g. blocked ones). */
function sampleTiles(f: Float32Array, w: number, h: number, x: number, y: number, weight?: Float32Array): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const ax = fx - ix;
  const ay = fy - iy;
  let s = 0;
  let ws = 0;
  for (let k = 0; k < 4; k++) {
    const tx = Math.max(0, Math.min(w - 1, ix + (k & 1)));
    const ty = Math.max(0, Math.min(h - 1, iy + (k >> 1)));
    let wt = (k & 1 ? ax : 1 - ax) * (k >> 1 ? ay : 1 - ay);
    if (weight) wt *= weight[ty * w + tx];
    s += f[ty * w + tx] * wt;
    ws += wt;
  }
  return ws > 1e-6 ? s / ws : 0;
}

/**
 * Ramps, SC2-style: a worn path in the ground's own hue with soft, broken
 * edges, step-like bands along the height contours so the incline reads at a
 * glance, and darker margins where the ramp meets the cliffs beside it.
 */
function paintRamp(R: ReturnType<typeof rampFields>, m: GameMap, x: number, y: number, r: number, g: number, b: number): [number, number, number] {
  if (x < -1 || y < -1 || x > m.w + 1 || y > m.h + 1) return [r, g, b];
  const raw = sampleTiles(R.ramp, R.w, R.h, x, y);
  if (raw <= 0.01) return [r, g, b];
  const edgeNoise = (fbm(x * 1.3 + 3, y * 1.3 - 7) - 0.5) * 0.45;
  const mask = smooth(0.2, 0.62, raw + edgeNoise);
  if (mask <= 0) return [r, g, b];
  // Worn path: lighter and a little warmer than the ground around it, keeping its hue.
  const lum = (r + g + b) / 3;
  const worn = 0.8 + fbm(x * 2.4, y * 2.4 + 9) * 0.35;
  let pr = (r * 0.7 + lum * 0.3) * 1.22 * worn + 0.05;
  let pg = (g * 0.7 + lum * 0.3) * 1.17 * worn + 0.04;
  let pb = (b * 0.7 + lum * 0.3) * 1.08 * worn + 0.02;
  // Steps: a sawtooth along the level, one band per quarter cliff level (about a tile on most ramps).
  const lv = sampleTiles(R.lvl, R.w, R.h, x, y, R.walk) / 4;
  const t = lv - Math.floor(lv);
  const step = 0.93 + 0.1 * smooth(0, 0.85, t) - 0.09 * smooth(0.85, 1, t);
  // Margins along the cliffs.
  const wall = sampleTiles(R.wall, R.w, R.h, x, y);
  const side = 1 - smooth(0.6, 1, wall) * 0.12;
  pr *= step * side;
  pg *= step * side;
  pb *= step * side;
  return [r + (pr - r) * mask, g + (pg - g) * mask, b + (pb - b) * mask];
}

/** Palette for maps without a minimap image (lush SC2 "Bel'Shir"-like). */
const PALETTE = {
  low: [0.46, 0.4, 0.31],
  mid: [0.38, 0.42, 0.25],
  high: [0.31, 0.4, 0.21],
  dirt: [0.45, 0.37, 0.27],
  rock: [0.44, 0.4, 0.35],
  dark: [0.12, 0.12, 0.11],
};

/**
 * Paints the albedo texture over the height grid's area. With a minimap
 * image (imported maps) the map's real colours are used; otherwise colours
 * come from the cliff level, pathability and noise.
 */
export function paintAlbedo(H: Heights, m: GameMap, minimap: HTMLImageElement | null, ppt = 6): THREE.CanvasTexture {
  const g = H.g;
  const tilesW = (g.w - 1) / H.res;
  const tilesH = (g.h - 1) / H.res;
  const W = Math.min(4096, Math.round(tilesW * ppt));
  const Hh = Math.min(4096, Math.round(tilesH * ppt));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = Hh;
  const ctx = canvas.getContext("2d")!;
  let mm: ImageData | null = null;
  if (minimap) {
    const c2 = document.createElement("canvas");
    c2.width = minimap.naturalWidth;
    c2.height = minimap.naturalHeight;
    const x2 = c2.getContext("2d")!;
    x2.drawImage(minimap, 0, 0);
    mm = x2.getImageData(0, 0, c2.width, c2.height);
  }
  const cliff = classify(m);
  const ramps = rampFields(m);
  const img = ctx.createImageData(W, Hh);
  for (let py = 0; py < Hh; py++)
    for (let px = 0; px < W; px++) {
      const x = g.x0 + ((px + 0.5) / W) * tilesW;
      const y = g.y0 + ((py + 0.5) / Hh) * tilesH;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      const inside = tx >= 0 && ty >= 0 && tx < m.w && ty < m.h;
      const ti = inside ? ty * m.w + tx : -1;
      const patch = fbm(x * 0.15, y * 0.15);
      const fine = fbm(x * 1.6 + 11, y * 1.6);
      let r: number;
      let gg: number;
      let b: number;
      if (mm) {
        // Bilinear: minimaps can be as coarse as one pixel per tile.
        const fx = Math.max(0, Math.min(mm.width - 1.001, (x / m.w) * mm.width - 0.5));
        const fy = Math.max(0, Math.min(mm.height - 1.001, (y / m.h) * mm.height - 0.5));
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const ax = fx - ix;
        const ay = fy - iy;
        const px = (dx: number, dy: number, c: number) => mm!.data[((iy + dy) * mm!.width + ix + dx) * 4 + c] / 255;
        const lerp = (c: number) => (px(0, 0, c) * (1 - ax) + px(1, 0, c) * ax) * (1 - ay) + (px(0, 1, c) * (1 - ax) + px(1, 1, c) * ax) * ay;
        r = lerp(0);
        gg = lerp(1);
        b = lerp(2);
        // The minimap is lit and low-res: flatten its lighting a bit and add detail.
        const lum = (r + gg + b) / 3 + 1e-3;
        const target = 0.36 + lum * 0.35;
        r = (r / lum) * target;
        gg = (gg / lum) * target;
        b = (b / lum) * target;
      } else {
        const lv = inside ? m.level[ti] / 16 : 0;
        const low = PALETTE.low;
        const mid = PALETTE.mid;
        const high = PALETTE.high;
        const t1 = Math.min(1, lv);
        const t2 = Math.max(0, Math.min(1, lv - 1));
        r = low[0] + (mid[0] - low[0]) * t1 + (high[0] - mid[0]) * t2;
        gg = low[1] + (mid[1] - low[1]) * t1 + (high[1] - mid[1]) * t2;
        b = low[2] + (mid[2] - low[2]) * t1 + (high[2] - mid[2]) * t2;
        // Worn dirt patches and lusher grass patches at two scales, like SC2 texture blending.
        const dirt = smooth(0.52, 0.66, fbm(x * 0.09 + 31, y * 0.09)) * 0.75 + smooth(0.6, 0.72, fbm(x * 0.35 + 5, y * 0.35)) * 0.35;
        const grass = smooth(0.45, 0.62, patch) * (1 - Math.min(1, dirt));
        const d = Math.min(1, dirt);
        r = r * (1 - d) + PALETTE.dirt[0] * d;
        gg = gg * (1 - d) + PALETTE.dirt[1] * d;
        b = b * (1 - d) + PALETTE.dirt[2] * d;
        r = r * (1 - grass * 0.3) + 0.24 * grass * 0.3;
        gg = gg * (1 - grass * 0.3) + 0.38 * grass * 0.3;
        b = b * (1 - grass * 0.3) + 0.14 * grass * 0.3;
        if (inside && m.terrain[ti] && !cliff[ti]) {
          r = r * 0.4 + PALETTE.rock[0] * 0.6;
          gg = gg * 0.4 + PALETTE.rock[1] * 0.6;
          b = b * 0.4 + PALETTE.rock[2] * 0.6;
        }
      }
      [r, gg, b] = paintRamp(ramps, m, x, y, r, gg, b);
      const vary = 0.86 + fine * 0.28;
      r *= vary;
      gg *= vary;
      b *= vary;
      // Darken outside the playable area like SC2's map bounds.
      const out = Math.max(0, -x, -y, x - m.w, y - m.h);
      const fade = 1 - smooth(0, 6, out) * 0.55;
      const o = (py * W + px) * 4;
      img.data[o] = Math.min(255, r * fade * 255);
      img.data[o + 1] = Math.min(255, gg * fade * 255);
      img.data[o + 2] = Math.min(255, b * fade * 255);
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** Tileable greyscale noise used for fine ground and rock detail in the shader. */
export function detailTexture(): THREE.DataTexture {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      // Tileable fbm: sample on a torus.
      const a = (x / S) * Math.PI * 2;
      const b = (y / S) * Math.PI * 2;
      const nx = Math.cos(a) * 4 + 10;
      const ny = Math.sin(a) * 4 + 10;
      const nz = Math.cos(b) * 4 + 20;
      const nw = Math.sin(b) * 4 + 20;
      const n1 = fbm(nx + nz * 0.7, ny + nw * 0.7, 5);
      const n2 = fbm(nx * 2.7 + nw, ny * 2.7 - nz, 3);
      const v = Math.max(0, Math.min(255, (n1 * 0.7 + n2 * 0.3) * 255));
      const o = (y * S + x) * 4;
      data[o] = v;
      data[o + 1] = Math.max(0, Math.min(255, n2 * 255));
      data[o + 2] = Math.max(0, Math.min(255, fbm(nx * 6, ny * 6 + nz, 2) * 255));
      data[o + 3] = 255;
    }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
