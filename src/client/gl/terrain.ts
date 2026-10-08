import type { GameMap } from "../../sim/map.ts";

/**
 * Builds a heightfield mesh from the sim's blocked-tile grid: walkable ground
 * is flat at y=0 (so units always stand on it), blocked tiles rise into rocky
 * cliffs that start exactly at the tile edge, so visuals match collision.
 */

export const CLIFF_HEIGHT = 2.2;
const RES = 4; // vertices per tile
export const MARGIN = 10; // tiles of scenery outside the playable map

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number): number {
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
    s += amp * valueNoise(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return s;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface TerrainMesh {
  pos: Float32Array;
  nrm: Float32Array;
  col: Float32Array;
  idx: Uint32Array;
}

export function buildTerrain(m: GameMap): TerrainMesh {
  const x0 = -MARGIN;
  const y0 = -MARGIN;
  const cols = (m.w + MARGIN * 2) * RES + 1;
  const rows = (m.h + MARGIN * 2) * RES + 1;
  const walk = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < m.w && ty < m.h && m.blocked[ty * m.w + tx] === 0;

  // Distance from each vertex to the nearest walkable tile (0 on walkable ground).
  const H = new Float32Array(cols * rows);
  const D = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = x0 + c / RES;
      const py = y0 + r / RES;
      const tx = Math.floor(px);
      const ty = Math.floor(py);
      let best = 4;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const ax = tx + dx;
          const ay = ty + dy;
          if (!walk(ax, ay)) continue;
          const cx = Math.max(ax, Math.min(ax + 1, px));
          const cy = Math.max(ay, Math.min(ay + 1, py));
          const d = Math.hypot(px - cx, py - cy);
          if (d < best) best = d;
        }
      D[r * cols + c] = best;
      const rise = smooth(0, 0.95, best);
      const rock = (fbm(px * 0.9, py * 0.9) - 0.5) * 0.9 + (fbm(px * 3.1 + 7, py * 3.1) - 0.5) * 0.35;
      const plateau = best > 1.2 ? (fbm(px * 0.25 + 40, py * 0.25) - 0.4) * 1.6 : 0;
      H[r * cols + c] = rise * (CLIFF_HEIGHT + rock * smooth(0.15, 1.0, best)) + Math.max(0, plateau) * smooth(1.2, 3, best);
    }
  }

  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const h = (c: number, r: number) => H[Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, c))];
  const step = 1 / RES;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const px = x0 + c * step;
      const py = y0 + r * step;
      const y = H[i];
      pos.set([px, y, py], i * 3);
      const nx = h(c - 1, r) - h(c + 1, r);
      const nz = h(c, r - 1) - h(c, r + 1);
      const ny = 2 * step;
      const len = Math.hypot(nx, ny, nz);
      const NX = nx / len;
      const NY = ny / len;
      const NZ = nz / len;
      nrm.set([NX, NY, NZ], i * 3);

      // Colour: dirt/grass ground with patches, rock on slopes, mossy plateaus.
      const d = D[i];
      const patch = fbm(px * 0.18, py * 0.18);
      const fine = fbm(px * 1.7 + 11, py * 1.7);
      let R: number, G: number, B: number;
      // Ground: warm dirt blended with muted grass (SC2 Bel'Shir-ish)
      const g = smooth(0.42, 0.62, patch);
      R = 0.36 * (1 - g) + 0.27 * g;
      G = 0.31 * (1 - g) + 0.33 * g;
      B = 0.22 * (1 - g) + 0.17 * g;
      const v = 0.85 + fine * 0.3;
      R *= v;
      G *= v;
      B *= v;
      // Ambient occlusion: darker ground right at the foot of cliffs.
      if (d <= 0.001) {
        let near = 3;
        const tx = Math.floor(px);
        const ty = Math.floor(py);
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            if (walk(tx + dx, ty + dy)) continue;
            const cx = Math.max(tx + dx, Math.min(tx + dx + 1, px));
            const cy = Math.max(ty + dy, Math.min(ty + dy + 1, py));
            near = Math.min(near, Math.hypot(px - cx, py - cy));
          }
        const ao = 0.6 + 0.4 * smooth(0, 1.4, near);
        R *= ao;
        G *= ao;
        B *= ao;
      }
      // Rock where it's steep or raised.
      const steep = 1 - NY;
      const rockAmt = Math.max(smooth(0.08, 0.35, steep), smooth(0.05, 0.4, d));
      const rv = 0.8 + fine * 0.28 + (patch - 0.5) * 0.2;
      const rockR = 0.42 * rv;
      const rockG = 0.38 * rv;
      const rockB = 0.34 * rv;
      R = R * (1 - rockAmt) + rockR * rockAmt;
      G = G * (1 - rockAmt) + rockG * rockAmt;
      B = B * (1 - rockAmt) + rockB * rockAmt;
      // Moss on flat tops of the high ground.
      if (y > CLIFF_HEIGHT * 0.7 && NY > 0.85) {
        const moss = smooth(0.85, 0.97, NY) * smooth(0.45, 0.6, fbm(px * 0.6 + 3, py * 0.6));
        R = R * (1 - moss) + 0.24 * moss;
        G = G * (1 - moss) + 0.3 * moss;
        B = B * (1 - moss) + 0.15 * moss;
      }
      // Outside the playable area: fade toward darkness.
      const out = Math.max(0, -px, -py, px - m.w, py - m.h);
      const fade = 1 - smooth(0, MARGIN * 0.8, out) * 0.85;
      col.set([R * fade, G * fade, B * fade], i * 3);
    }
  }

  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + cols;
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = a + 1;
      idx[k++] = b;
      idx[k++] = b + 1;
      idx[k++] = a + 1;
    }
  return { pos, nrm, col, idx };
}
