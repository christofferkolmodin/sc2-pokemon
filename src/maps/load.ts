import type { MapDef, MapObjectKind } from "../sim/map.ts";

/** Doodad categories the importer keeps (see tools/import-sc2maps.py). */
export type DoodadType = "tree" | "bush" | "rock" | "crystal" | "prop" | "pillar";

export interface Doodad {
  t: DoodadType;
  x: number; // tiles
  y: number;
  r: number; // rotation (radians)
  s: number; // scale
  v: number; // variation
}

/** Imported SC2 map as written by tools/import-sc2maps.py. */
export interface MapJson {
  key: string;
  name: string;
  source?: string;
  tileset?: string;
  w: number;
  h: number;
  players: number;
  terrain: string; // base64, 1 byte per tile
  level: string;
  nobuild: string;
  starts: { x: number; y: number }[];
  objects: { kind: MapObjectKind; tx: number; ty: number }[];
  /** Vertex heights in milli-tiles (uint16 LE) on a grid offset by (x, y) tiles from the playable area. */
  heights: { x: number; y: number; w: number; h: number; data: string };
  doodads: Doodad[];
  minimap?: string;
}

export interface MapIndexEntry {
  key: string;
  name: string;
  w: number;
  h: number;
  players: number;
}

/** Presentation-only map data (not part of the deterministic sim). */
export interface RenderData {
  /** Vertex heights in tiles. Vertex (i, j) sits at tile coordinate (x0 + i, y0 + j). */
  heights: { x0: number; y0: number; w: number; h: number; data: Float32Array } | null;
  doodads: Doodad[];
  /** URL of the map's own minimap image (imported maps). */
  minimap?: string;
  tileset?: string;
}

export function decodeBase64(s: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(s, "base64"));
}

export function mapFromJson(j: MapJson, assetBase = ""): { def: MapDef; render: RenderData } {
  const n = j.w * j.h;
  const grid = (s: string) => {
    const g = decodeBase64(s);
    if (g.length !== n) throw new Error(`map ${j.key}: grid size ${g.length} != ${n}`);
    return g;
  };
  const def: MapDef = {
    key: j.key,
    name: j.name,
    w: j.w,
    h: j.h,
    terrain: grid(j.terrain),
    level: grid(j.level),
    nobuild: grid(j.nobuild),
    starts: j.starts,
    objects: j.objects,
  };
  const raw = decodeBase64(j.heights.data);
  const hw = j.heights.w;
  const hh = j.heights.h;
  const data = new Float32Array(hw * hh);
  for (let i = 0; i < hw * hh; i++) data[i] = (raw[i * 2] | (raw[i * 2 + 1] << 8)) / 1000;
  return {
    def,
    render: {
      heights: { x0: j.heights.x, y0: j.heights.y, w: hw, h: hh, data },
      doodads: j.doodads,
      minimap: j.minimap ? assetBase + j.minimap : undefined,
      tileset: j.tileset,
    },
  };
}
