/**
 * Tiny signed-distance-field sculpting kit. Models are written as a list of
 * primitives (ellipsoids, capsules, rounded boxes, tori) blended with a smooth
 * minimum, then turned into a triangle mesh with naive surface nets. This
 * gives soft, toy-like Pokémon without any external model files.
 */

export type V3 = [number, number, number];

export interface Prim {
  /**
   * Shape: ellipsoid, round cone/capsule (a -> b), rounded box, torus (ring in the XZ plane), or a flat
   * trapezoid plate (in the YZ plane, `r` = [half thickness, half height, half width at the bottom],
   * `top` = half width at the top; for fan-shaped ears and fins).
   */
  k: "ell" | "cap" | "box" | "tor" | "trap" | "poly";
  /** Centre (ell, box, tor) or start point (cap). */
  p: V3;
  /** Radii (ell), half size (box), [R, r, 0] (tor). For cap: [r1, r2, 0]. */
  r: V3;
  /** End point (cap only). */
  b?: V3;
  /** Euler rotation (x, y, z) in radians, applied to ell / box / tor. */
  rot?: V3;
  /** Trapezoid: half width at the top edge. */
  top?: number;
  /** Trapezoid: rounding of the outline's corners (softer ears). */
  corner?: number;
  /**
   * Flat plate with any outline ("poly"): points as [y, z] in the prim's own plane
   * (before `rot`), extruded to half thickness r[0] along X. For ears with one sharp tip.
   */
  poly?: [number, number][];
  /** Box / trapezoid corner rounding. */
  round?: number;
  /** Colour (hex). */
  c: string;
  /** Smooth-union radius with what came before (0 = hard union). Negative = smooth subtraction. */
  k2?: number;
  /** Subtract this shape instead of adding it. */
  sub?: boolean;
  /** Mirror across the XY plane (z -> -z): adds a twin, for paired limbs, eyes, ears. */
  mirror?: boolean;
  /** Emissive amount for this colour region (0..1). */
  glow?: number;
  /** Only colours the surface inside this shape (eyes, spots, stripes); doesn't change the geometry. */
  paint?: boolean;
}

interface Compiled {
  k: number;
  p: V3;
  r: V3;
  b: V3;
  ba: V3;
  baba: number;
  m: number[] | null; // inverse rotation (row-major 3x3)
  round: number;
  top: number;
  corner: number;
  poly: [number, number][] | null;
  col: [number, number, number];
  glow: number;
  k2: number;
  sub: boolean;
  paint: boolean;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  // sRGB -> linear, since three.js treats vertex colours as linear.
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [lin((v >> 16) & 255), lin((v >> 8) & 255), lin(v & 255)];
}

function rotInv(rot: V3): number[] {
  const [x, y, z] = rot;
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  // R = Rz * Ry * Rx; inverse = transpose.
  const r00 = cz * cy, r01 = cz * sy * sx - sz * cx, r02 = cz * sy * cx + sz * sx;
  const r10 = sz * cy, r11 = sz * sy * sx + cz * cx, r12 = sz * sy * cx - cz * sx;
  const r20 = -sy, r21 = cy * sx, r22 = cy * cx;
  return [r00, r10, r20, r01, r11, r21, r02, r12, r22];
}

function compile(prims: Prim[]): Compiled[] {
  const out: Compiled[] = [];
  for (const q of prims) {
    const variants = q.mirror ? [q, mirrorZ(q)] : [q];
    for (const v of variants) {
      const b = v.b ?? v.p;
      const ba: V3 = [b[0] - v.p[0], b[1] - v.p[1], b[2] - v.p[2]];
      out.push({
        k: v.k === "ell" ? 0 : v.k === "cap" ? 1 : v.k === "box" ? 2 : v.k === "tor" ? 3 : v.k === "trap" ? 4 : 5,
        p: v.p,
        r: v.r,
        b,
        ba,
        baba: ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2],
        m: v.rot ? rotInv(v.rot) : null,
        round: v.round ?? 0,
        top: v.top ?? 0,
        corner: v.corner ?? 0,
        poly: v.poly ?? null,
        col: hexToRgb(v.c),
        glow: v.glow ?? 0,
        k2: v.k2 ?? 0,
        sub: v.sub ?? false,
        paint: v.paint ?? false,
      });
    }
  }
  return out;
}

function mirrorZ(q: Prim): Prim {
  const rot: V3 | undefined = q.rot ? [-q.rot[0], -q.rot[1], q.rot[2]] : undefined;
  // Mirroring a rotated prim = negated rotation applied to the mirrored local shape,
  // so a lopsided outline flips too.
  const poly = q.poly ? q.poly.map(([y, z]): [number, number] => [y, -z]) : undefined;
  return { ...q, p: [q.p[0], q.p[1], -q.p[2]], b: q.b ? [q.b[0], q.b[1], -q.b[2]] : undefined, rot, poly, mirror: false };
}

function primDist(c: Compiled, x: number, y: number, z: number): number {
  let px = x - c.p[0];
  let py = y - c.p[1];
  let pz = z - c.p[2];
  if (c.m && c.k !== 1) {
    const m = c.m;
    const qx = m[0] * px + m[1] * py + m[2] * pz;
    const qy = m[3] * px + m[4] * py + m[5] * pz;
    const qz = m[6] * px + m[7] * py + m[8] * pz;
    px = qx;
    py = qy;
    pz = qz;
  }
  switch (c.k) {
    case 0: {
      // Ellipsoid (iq's bound).
      const [rx, ry, rz] = c.r;
      const k0 = Math.hypot(px / rx, py / ry, pz / rz);
      const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
      return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
    }
    case 1: {
      // Round cone from p (radius r1) to b (radius r2).
      const r1 = c.r[0];
      const r2 = c.r[1];
      const ba = c.ba;
      const h = c.baba > 0 ? Math.max(0, Math.min(1, (px * ba[0] + py * ba[1] + pz * ba[2]) / c.baba)) : 0;
      const dx = px - ba[0] * h;
      const dy = py - ba[1] * h;
      const dz = pz - ba[2] * h;
      return Math.hypot(dx, dy, dz) - (r1 + (r2 - r1) * h);
    }
    case 2: {
      const qx = Math.abs(px) - c.r[0] + c.round;
      const qy = Math.abs(py) - c.r[1] + c.round;
      const qz = Math.abs(pz) - c.r[2] + c.round;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - c.round;
    }
    case 5: {
      // Flat outline plate: iq's 2D polygon distance in the local YZ plane, extruded along X, rounded.
      const v = c.poly!;
      const rd = c.round;
      let d = (py - v[0][0]) ** 2 + (pz - v[0][1]) ** 2;
      let s = 1;
      for (let i = 0, j = v.length - 1; i < v.length; j = i, i++) {
        const ey = v[j][0] - v[i][0];
        const ez = v[j][1] - v[i][1];
        const wy = py - v[i][0];
        const wz = pz - v[i][1];
        // Repeated points (e.g. both edges meeting at a tip) make a zero-length edge.
        const ee = ey * ey + ez * ez;
        const t = ee > 0 ? Math.max(0, Math.min(1, (wy * ey + wz * ez) / ee)) : 0;
        const by = wy - ey * t;
        const bz = wz - ez * t;
        d = Math.min(d, by * by + bz * bz);
        const c1 = pz >= v[i][1];
        const c2 = pz < v[j][1];
        const c3 = ey * wz > ez * wy;
        if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
      }
      const d2 = s * Math.sqrt(d) - c.corner;
      const wx = Math.abs(px) - c.r[0] + rd;
      return Math.min(Math.max(d2 + rd, wx), 0) + Math.hypot(Math.max(d2 + rd, 0), Math.max(wx, 0)) - rd;
    }
    case 3: {
      const qx = Math.hypot(px, pz) - c.r[0];
      return Math.hypot(qx, py) - c.r[1];
    }
    default: {
      // Trapezoid plate: iq's 2D trapezoid in the YZ plane (bottom half width r[2] at y = -r[1],
      // top half width `top` at y = +r[1]), extruded to thickness r[0] along X, edges rounded.
      const rd = c.round;
      const cr = c.corner;
      const r1 = c.r[2] - rd - cr;
      const r2 = c.top - rd - cr;
      const he = c.r[1] - rd - cr;
      const qx = Math.abs(pz);
      const qy = py;
      const k2x = r2 - r1;
      const k2y = 2 * he;
      const cax = qx - Math.min(qx, qy < 0 ? r1 : r2);
      const cay = Math.abs(qy) - he;
      const t = Math.max(0, Math.min(1, ((r2 - qx) * k2x + (he - qy) * k2y) / (k2x * k2x + k2y * k2y)));
      const cbx = qx - r2 + k2x * t;
      const cby = qy - he + k2y * t;
      const d2 = (cbx < 0 && cay < 0 ? -1 : 1) * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby)) - cr;
      const wy = Math.abs(px) - c.r[0] + rd;
      return Math.min(Math.max(d2, wy), 0) + Math.hypot(Math.max(d2, 0), Math.max(wy, 0)) - rd;
    }
  }
}

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

export class Sdf {
  readonly c: Compiled[];
  constructor(prims: Prim[]) {
    this.c = compile(prims);
  }

  dist(x: number, y: number, z: number): number {
    let d = 1e9;
    for (const c of this.c) {
      if (c.paint) continue;
      const e = primDist(c, x, y, z);
      if (c.sub) d = smax(d, -e, c.k2);
      else d = smin(d, e, c.k2);
    }
    return d;
  }

  /** Colour and glow of the primitive whose surface is closest (that's the one forming the skin here). */
  color(x: number, y: number, z: number): [number, number, number, number] {
    let best = 1e9;
    let col: [number, number, number] = [1, 1, 1];
    let glow = 0;
    for (let i = 0; i < this.c.length; i++) {
      const c = this.c[i];
      if (c.sub || c.paint) continue;
      // Later primitives win near-ties so details (eyes, spots, bellies) paint over bodies.
      const e = Math.abs(primDist(c, x, y, z)) - i * 0.0004;
      if (e < best) {
        best = e;
        col = c.col;
        glow = c.glow;
      }
    }
    for (const c of this.c) {
      if (c.paint && primDist(c, x, y, z) < 0) {
        col = c.col;
        glow = c.glow;
      }
    }
    return [col[0], col[1], col[2], glow];
  }

  bounds(): { min: V3; max: V3 } {
    const min: V3 = [1e9, 1e9, 1e9];
    const max: V3 = [-1e9, -1e9, -1e9];
    for (const c of this.c) {
      if (c.sub || c.paint) continue;
      const ext = c.k === 0 || c.k === 2 ? Math.max(...c.r) : c.k === 3 ? c.r[0] + c.r[1] : c.k === 4 ? Math.hypot(c.r[1], Math.max(c.r[2], c.top)) + c.r[0] : c.k === 5 ? Math.max(...c.poly!.map(([y, z]) => Math.hypot(y, z))) + c.r[0] + c.corner : Math.max(c.r[0], c.r[1]);
      for (const p of c.k === 1 ? [c.p, c.b] : [c.p]) {
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], p[i] - ext);
          max[i] = Math.max(max[i], p[i] + ext);
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      min[i] -= 0.05;
      max[i] += 0.05;
    }
    return { min, max };
  }
}

export interface MeshOut {
  pos: Float32Array;
  nrm: Float32Array;
  col: Float32Array; // rgb + glow per vertex
  idx: Uint32Array;
}

/**
 * Naive surface nets: one vertex per grid cell that the surface crosses (at
 * the mean of its edge crossings), one quad per crossed grid edge. Faces are
 * oriented using the field's gradient, normals come from the gradient too.
 */
export function mesh(sdf: Sdf, cell: number): MeshOut {
  const { min, max } = sdf.bounds();
  const nx = Math.max(2, Math.ceil((max[0] - min[0]) / cell) + 1);
  const ny = Math.max(2, Math.ceil((max[1] - min[1]) / cell) + 1);
  const nz = Math.max(2, Math.ceil((max[2] - min[2]) / cell) + 1);
  const val = new Float32Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) val[at(i, j, k)] = sdf.dist(min[0] + i * cell, min[1] + j * cell, min[2] + k * cell);

  const cx = nx - 1;
  const cy = ny - 1;
  const cz = nz - 1;
  const vid = new Int32Array(cx * cy * cz).fill(-1);
  const pos: number[] = [];
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const cv = new Float32Array(8);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const v = val[at(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
          cv[c] = v;
          if (v < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [a, b] of edges) {
          const va = cv[a];
          const vb = cv[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
          sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
          sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
          n++;
        }
        vid[(k * cy + j) * cx + i] = pos.length / 3;
        pos.push(min[0] + (i + sx / n) * cell, min[1] + (j + sy / n) * cell, min[2] + (k + sz / n) * cell);
      }

  const idx: number[] = [];
  const cellId = (i: number, j: number, k: number) => vid[(k * cy + j) * cx + i];
  const quad = (a: number, b: number, c: number, d: number) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    idx.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v0 = val[at(i, j, k)] < 0;
        // x-edge
        if (i < cx && j > 0 && k > 0 && j < cy && k < cz && v0 !== val[at(i + 1, j, k)] < 0) {
          quad(cellId(i, j - 1, k - 1), cellId(i, j, k - 1), cellId(i, j, k), cellId(i, j - 1, k));
        }
        // y-edge
        if (j < cy && i > 0 && k > 0 && i < cx && k < cz && v0 !== val[at(i, j + 1, k)] < 0) {
          quad(cellId(i - 1, j, k - 1), cellId(i, j, k - 1), cellId(i, j, k), cellId(i - 1, j, k));
        }
        // z-edge
        if (k < cz && i > 0 && j > 0 && i < cx && j < cy && v0 !== val[at(i, j, k + 1)] < 0) {
          quad(cellId(i - 1, j - 1, k), cellId(i, j - 1, k), cellId(i, j, k), cellId(i - 1, j, k));
        }
      }

  // Normals from the field gradient; colours from the closest primitive.
  const nv = pos.length / 3;
  const nrm = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 4);
  const e = cell * 0.5;
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3];
    const y = pos[v * 3 + 1];
    const z = pos[v * 3 + 2];
    let gx = sdf.dist(x + e, y, z) - sdf.dist(x - e, y, z);
    let gy = sdf.dist(x, y + e, z) - sdf.dist(x, y - e, z);
    let gz = sdf.dist(x, y, z + e) - sdf.dist(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    gx /= l;
    gy /= l;
    gz /= l;
    nrm[v * 3] = gx;
    nrm[v * 3 + 1] = gy;
    nrm[v * 3 + 2] = gz;
    const c = sdf.color(x, y, z);
    col.set(c, v * 4);
  }
  // Orient every triangle so it faces along the gradient.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    const ux = pos[b * 3] - pos[a * 3];
    const uy = pos[b * 3 + 1] - pos[a * 3 + 1];
    const uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const wx = pos[c * 3] - pos[a * 3];
    const wy = pos[c * 3 + 1] - pos[a * 3 + 1];
    const wz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const fx = uy * wz - uz * wy;
    const fy = uz * wx - ux * wz;
    const fz = ux * wy - uy * wx;
    const gx = nrm[a * 3] + nrm[b * 3] + nrm[c * 3];
    const gy = nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1];
    const gz = nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2];
    if (fx * gx + fy * gy + fz * gz < 0) {
      idx[t + 1] = c;
      idx[t + 2] = b;
    }
  }
  return { pos: new Float32Array(pos), nrm, col, idx: new Uint32Array(idx) };
}
