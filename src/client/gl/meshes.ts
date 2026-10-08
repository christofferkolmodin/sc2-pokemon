/** Primitive meshes used to assemble placeholder unit models. All centred at the origin, unit size. */

export interface MeshData {
  pos: Float32Array;
  nrm: Float32Array;
  idx: Uint16Array;
}

function build(p: number[], n: number[], i: number[]): MeshData {
  return { pos: new Float32Array(p), nrm: new Float32Array(n), idx: new Uint16Array(i) };
}

/** Sphere of radius 1. */
export function sphere(seg = 18, rings = 12): MeshData {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const v = r / rings;
    const phi = v * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const th = (s / seg) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(th);
      p.push(x, y, z);
      n.push(x, y, z);
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s;
      const b = a + seg + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return build(p, n, idx);
}

/** Cone along +Y: base radius 1 at y=0, tip at y=1. */
export function cone(seg = 14): MeshData {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const slope = 1 / Math.SQRT2;
  for (let s = 0; s <= seg; s++) {
    const th = (s / seg) * Math.PI * 2;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    p.push(c, 0, sn, 0, 1, 0);
    n.push(c * slope, slope, sn * slope, c * slope, slope, sn * slope);
  }
  for (let s = 0; s < seg; s++) idx.push(s * 2, s * 2 + 1, s * 2 + 2);
  // Base cap.
  const base = p.length / 3;
  p.push(0, 0, 0);
  n.push(0, -1, 0);
  for (let s = 0; s <= seg; s++) {
    const th = (s / seg) * Math.PI * 2;
    p.push(Math.cos(th), 0, Math.sin(th));
    n.push(0, -1, 0);
  }
  for (let s = 0; s < seg; s++) idx.push(base, base + s + 2, base + s + 1);
  return build(p, n, idx);
}

/** Cylinder along +Y from y=0 to y=1, radius 1. */
export function cylinder(seg = 14): MeshData {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s <= seg; s++) {
    const th = (s / seg) * Math.PI * 2;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    p.push(c, 0, sn, c, 1, sn);
    n.push(c, 0, sn, c, 0, sn);
  }
  for (let s = 0; s < seg; s++) {
    const a = s * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  for (const y of [0, 1]) {
    const base = p.length / 3;
    p.push(0, y, 0);
    n.push(0, y ? 1 : -1, 0);
    for (let s = 0; s <= seg; s++) {
      const th = (s / seg) * Math.PI * 2;
      p.push(Math.cos(th), y, Math.sin(th));
      n.push(0, y ? 1 : -1, 0);
    }
    for (let s = 0; s < seg; s++) {
      if (y) idx.push(base, base + s + 1, base + s + 2);
      else idx.push(base, base + s + 2, base + s + 1);
    }
  }
  return build(p, n, idx);
}

/** Torus in the XZ plane: ring radius 1, tube radius `tube`. */
export function torus(tube = 0.3, seg = 20, sides = 8): MeshData {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s <= seg; s++) {
    const u = (s / seg) * Math.PI * 2;
    for (let t = 0; t <= sides; t++) {
      const v = (t / sides) * Math.PI * 2;
      const cx = Math.cos(u);
      const cz = Math.sin(u);
      const nx = Math.cos(v) * cx;
      const ny = Math.sin(v);
      const nz = Math.cos(v) * cz;
      p.push(cx + tube * nx, tube * ny, cz + tube * nz);
      n.push(nx, ny, nz);
    }
  }
  for (let s = 0; s < seg; s++)
    for (let t = 0; t < sides; t++) {
      const a = s * (sides + 1) + t;
      const b = a + sides + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  return build(p, n, idx);
}

/**
 * Bat-like wing in the XZ plane, attached at the origin, spanning toward +Z.
 * Two-sided (separate top and bottom faces) with a little thickness.
 */
export function wing(): MeshData {
  // Outline points (x, z): leading edge from shoulder out to tip, scalloped trailing edge back.
  const outline: [number, number][] = [
    [0.1, 0],
    [0.28, 0.38],
    [0.2, 1.0],
    [0.0, 0.72],
    [-0.1, 0.8],
    [-0.18, 0.52],
    [-0.3, 0.55],
    [-0.28, 0.18],
    [-0.16, 0],
  ];
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  for (const [side, y] of [
    [1, 0.02],
    [-1, -0.02],
  ]) {
    const base = p.length / 3;
    p.push(-0.1, y, 0.2);
    n.push(0, side, 0);
    for (const [x, z] of outline) {
      p.push(x, y, z);
      n.push(0, side, 0);
    }
    for (let i = 0; i < outline.length - 1; i++) {
      if (side > 0) idx.push(base, base + i + 2, base + i + 1);
      else idx.push(base, base + i + 1, base + i + 2);
    }
  }
  return build(p, n, idx);
}

/** Unit quad in the XZ plane (-1..1), facing up. Used for ground decals. */
export function quad(): MeshData {
  return build([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], [0, 2, 1, 0, 3, 2]);
}
