#!/usr/bin/env python3
"""
Import StarCraft II melee maps into SC2 Pokemon.

Reads .SC2Map / .s2ma files (MPQ archives) and writes, for each map,
assets-private/maps/<key>.json (pathing, cliff levels, heights, resources,
start locations, doodads) and <key>.png (the map's own minimap image), plus
assets-private/maps/index.json. assets-private/ is git-ignored: these are
Blizzard's files, keep them off GitHub.

Usage:
  python tools/import-sc2maps.py                 # every melee map in your Battle.net cache
  python tools/import-sc2maps.py path/to/X.SC2Map ...
  python tools/import-sc2maps.py --list          # just list what would be imported

Only the Python standard library is needed (SC2 compresses with bzip2, which
Node can't read without extra packages).
"""
import base64
import bz2
import glob
import json
import lzma
import math
import os
import re
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets-private", "maps")
CACHE = os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), "Blizzard Entertainment", "Battle.net", "Cache")
MARGIN = 12  # tiles of scenery kept around the playable area

# ----------------------------------------------------------------- MPQ


def _crypt_table():
    t = [0] * 0x500
    seed = 0x00100001
    for i in range(0x100):
        idx = i
        for _ in range(5):
            seed = (seed * 125 + 3) % 0x2AAAAB
            a = (seed & 0xFFFF) << 16
            seed = (seed * 125 + 3) % 0x2AAAAB
            t[idx] = a | (seed & 0xFFFF)
            idx += 0x100
    return t


CRYPT = _crypt_table()


def _hash(s, kind):
    s1, s2 = 0x7FED7FED, 0xEEEEEEEE
    for ch in s.upper().replace("/", "\\"):
        c = ord(ch)
        s1 = (CRYPT[(kind << 8) + c] ^ (s1 + s2)) & 0xFFFFFFFF
        s2 = (c + s1 + s2 + (s2 << 5) + 3) & 0xFFFFFFFF
    return s1


def _decrypt(data, key):
    out = bytearray()
    s2 = 0xEEEEEEEE
    for i in range(0, len(data) - len(data) % 4, 4):
        s2 = (s2 + CRYPT[0x400 + (key & 0xFF)]) & 0xFFFFFFFF
        v = struct.unpack_from("<I", data, i)[0]
        v = (v ^ (key + s2)) & 0xFFFFFFFF
        key = (((~key << 0x15) + 0x11111111) | (key >> 0x0B)) & 0xFFFFFFFF
        s2 = (v + s2 + (s2 << 5) + 3) & 0xFFFFFFFF
        out += struct.pack("<I", v)
    return bytes(out)


class MPQ:
    def __init__(self, path):
        with open(path, "rb") as f:
            d = f.read()
        self.d = d
        off = 0
        if d[:4] == b"MPQ\x1b":
            off = struct.unpack_from("<I", d, 8)[0]
        if d[off:off + 4] != b"MPQ\x1a":
            raise ValueError("not an MPQ archive")
        self.off = off
        (_hs, _as, _fmt, ssz, hto, bto, hcount, bcount) = struct.unpack_from("<IIHHIIII", d, off + 4)
        self.sector = 512 << ssz
        ht = _decrypt(d[off + hto: off + hto + hcount * 16], _hash("(hash table)", 3))
        bt = _decrypt(d[off + bto: off + bto + bcount * 16], _hash("(block table)", 3))
        self.hashes = [struct.unpack_from("<IIHHI", ht, i * 16) for i in range(hcount)]
        self.blocks = [struct.unpack_from("<IIII", bt, i * 16) for i in range(bcount)]

    def _find(self, name):
        n = len(self.hashes)
        start = _hash(name, 0) % n
        a, b = _hash(name, 1), _hash(name, 2)
        i = start
        while True:
            ha, hb, _loc, _plat, bi = self.hashes[i]
            if bi == 0xFFFFFFFF:
                return None
            if ha == a and hb == b and bi != 0xFFFFFFFE:
                return self.blocks[bi]
            i = (i + 1) % n
            if i == start:
                return None

    @staticmethod
    def _decomp(data, usize):
        if len(data) >= usize:
            return data[:usize]
        t = data[0]
        body = data[1:]
        if t == 0x02:
            return zlib.decompress(body)
        if t == 0x10:
            return bz2.decompress(body)
        if t == 0x12:
            return lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[{"id": lzma.FILTER_LZMA1}]).decompress(body)
        raise ValueError("unsupported compression 0x%02x" % t)

    def read(self, name):
        b = self._find(name)
        if not b:
            return None
        pos, csize, usize, flags = b
        if flags & 0x10000:
            return None  # encrypted (protected maps)
        raw = self.d[self.off + pos: self.off + pos + csize]
        if flags & 0x01000000:
            return self._decomp(raw, usize) if flags & 0x200 else raw
        if not flags & 0x200:
            return raw
        n = (usize + self.sector - 1) // self.sector
        offs = struct.unpack_from("<%dI" % (n + 1), raw, 0)
        out = bytearray()
        for i in range(n):
            out += self._decomp(raw[offs[i]:offs[i + 1]], min(self.sector, usize - i * self.sector))
        return bytes(out)


# --------------------------------------------------------------- parsing


def cstr(d, pos):
    end = d.index(b"\0", pos)
    return d[pos:end].decode("utf8", "replace"), end + 1


def playable_bounds(mapinfo, w, h):
    """Playable area (left, bottom, right, top) in SC2 cells. Follows the two names after the header."""
    try:
        pos = 42
        _lighting, pos = cstr(mapinfo, pos)
        _tileset, pos = cstr(mapinfo, pos)
        l, b, r, t = struct.unpack_from("<IIII", mapinfo, pos)
        if 0 <= l < r <= w and 0 <= b < t <= h and r - l >= 32 and t - b >= 32:
            return l, b, r, t, _tileset
    except (ValueError, struct.error):
        pass
    return 0, 0, w, h, ""


def grid_layer(m, name, w, h):
    """CellAttribute_* painted layers: 4-byte header, then one byte per cell (0-255 coverage)."""
    d = m.read(name)
    if not d or len(d) < 4 + w * h:
        return None
    return d[4:4 + w * h]


def doodad_category(t):
    s = t.lower()
    for bad in ("splat", "decal", "trim", "curtain", "logo", "light", "fog", "dust", "bird", "wave", "sidewalk", "curb",
                "sky", "cloud", "neon", "zone", "glow", "shadow", "steam", "water", "banner", "flag", "cable", "wire",
                "pipe", "conduit", "road", "street", "bridge", "fence", "ground", "carpet", "trash", "paper", "smoke"):
        if bad in s:
            return None
    for key, cat in (("crystal", "crystal"), ("mineralformation", "crystal"), ("tree", "tree"), ("palm", "tree"),
                     ("pine", "tree"), ("redwood", "tree"), ("bush", "bush"), ("plant", "bush"), ("shrub", "bush"),
                     ("fern", "bush"), ("grass", "bush"), ("seaweed", "bush"), ("flower", "bush"), ("vine", "bush"),
                     ("mushroom", "bush"), ("topiary", "bush"), ("cactus", "bush"), ("coral", "bush"),
                     ("rock", "rock"), ("boulder", "rock"), ("stone", "rock"), ("spire", "rock"), ("crag", "rock"),
                     ("cliff", "rock"), ("crate", "prop"), ("container", "prop"), ("barrel", "prop"),
                     ("sandbag", "prop"), ("tire", "prop"), ("debris", "prop"), ("wreck", "prop"), ("pillar", "pillar"),
                     ("column", "pillar"), ("statue", "pillar"), ("obelisk", "pillar"), ("ruin", "prop")):
        if key in s:
            return cat
    return None


def object_kind(unit_type):
    s = unit_type.lower()
    if "mineralfield" in s:
        if "rich" in s:
            return "rich", 2, 1
        if "750" in s or "450" in s:
            return "mineral900", 2, 1
        return "mineral", 2, 1
    if "geyser" in s:
        return "geyser", 3, 3
    if s.startswith("destructible") and ("6x6" in s or "rampdiagonal" in s or "16x6" in s):
        return "rock", 6, 6
    if s.startswith("destructible") and ("4x4" in s or "rock" in s or "debris" in s) and "light" not in s:
        return "rock", 6, 6
    if s.startswith("debris2x2") or (s.startswith("destructible") and "2x2" in s):
        return "rock2", 2, 2
    if s.startswith("unbuildable"):
        return "nobuild", 2, 2
    if s == "xelnagatower":
        return "tower", 2, 2
    return None, 0, 0


def b64(data):
    return base64.b64encode(bytes(data)).decode("ascii")


def write_png(path, w, h, rgb):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgb[y * w * 3:(y + 1) * w * 3]

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def read_tga(d):
    idlen, _cmt, itype = d[0], d[1], d[2]
    w, h, bpp, desc = struct.unpack_from("<HHBB", d, 12)
    if itype != 2 or bpp not in (24, 32):
        return None
    px = bpp // 8
    data = d[18 + idlen:]
    top_down = bool(desc & 0x20)
    rgb = bytearray(w * h * 3)
    for y in range(h):
        sy = y if top_down else h - 1 - y
        row = data[sy * w * px:(sy + 1) * w * px]
        for x in range(w):
            b, g, r = row[x * px], row[x * px + 1], row[x * px + 2]
            o = (y * w + x) * 3
            rgb[o], rgb[o + 1], rgb[o + 2] = r, g, b
    return w, h, rgb


def open_diagonals(terrain, level, nobuild, w, h):
    """
    SC2 paths on a finer grid than its cells, so diagonal ramps whose walkable
    cells only touch corner to corner are fine there. Our pathing works per cell,
    so open the two blocking cells of such a corner when both walkable cells are
    at (nearly) the same height. Corners across a real cliff stay closed.
    """
    for _ in range(4):
        changed = 0
        for y in range(h - 1):
            for x in range(w - 1):
                a, b, c, d = y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1
                for p, q, r1, r2 in ((a, d, b, c), (b, c, a, d)):
                    if terrain[p] or terrain[q] or not (terrain[r1] and terrain[r2]):
                        continue
                    if abs(level[p] - level[q]) > 8:
                        continue
                    for r in (r1, r2):
                        terrain[r] = 0
                        nobuild[r] = 1
                        level[r] = (level[p] + level[q]) // 2
                    changed += 1
        if not changed:
            break


def crop_minimap(minimap, pw, ph):
    """SC2 draws the playable area at a power-of-two pixels-per-tile scale, centred in the image. Cut it out."""
    w, h, rgb = minimap
    ratio = min(w / pw, h / ph)
    s = 1
    while s * 2 <= ratio:
        s *= 2
    if ratio < 1:
        return w, h, rgb
    cw, ch = pw * s, ph * s
    x0 = (w - cw) // 2
    y0 = (h - ch) // 2
    out = bytearray(cw * ch * 3)
    for y in range(ch):
        src = ((y0 + y) * w + x0) * 3
        out[y * cw * 3:(y + 1) * cw * 3] = rgb[src:src + cw * 3]
    return cw, ch, out


def slug(name):
    s = re.sub(r"^\[[^\]]*\]\s*", "", name)
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or "map"


def map_name(m):
    for loc in ("enUS", "enGB", "deDE", "frFR", "esES", "koKR", "zhCN", "ruRU"):
        gs = m.read(loc + ".SC2Data\\LocalizedData\\GameStrings.txt")
        if gs:
            hit = re.search(rb"DocInfo/Name=(.*)", gs)
            if hit:
                return hit.group(1).strip().decode("utf8", "replace")
    return None


def convert(path):
    m = MPQ(path)
    name = map_name(m)
    cl = m.read("t3SyncCliffLevel")
    flags = m.read("t3CellFlags")
    smap = m.read("t3SyncHeightMap")
    objs = m.read("Objects")
    info = m.read("MapInfo")
    if not (name and cl and flags and smap and objs and info):
        return None
    w, h = struct.unpack_from("<II", cl, 8)
    lev = struct.unpack_from("<%dH" % (w * h), cl, 32)
    fw, fh = struct.unpack_from("<II", flags, 24)
    cflags = flags[32:32 + fw * fh]
    # Older maps (cell-flag format 101) set the cliff bit on ramp cells too; there
    # ramps are walkable and only the real cliff cells around them block. Newer
    # maps (102) flag just the ramp edges, which are genuinely unpathable.
    old_flags = struct.unpack_from("<I", flags, 4)[0] <= 101
    sw, sh = struct.unpack_from("<II", smap, 8)
    sheights = struct.unpack_from("<%dI" % (sw * sh), smap, 64)
    left, bottom, right, top, tileset = playable_bounds(info, w, h)
    pw, ph = right - left, top - bottom
    pnp = grid_layer(m, "CellAttribute_Pnp", w, h)
    pnb = grid_layer(m, "CellAttribute_Pnb", w, h)
    pgr = grid_layer(m, "CellAttribute_Pgr", w, h)
    ob = objs.decode("utf8", "replace")

    starts = []
    for x, y in re.findall(r'<ObjectPoint[^>]*Position="([-\d.]+),([-\d.]+),[^"]*"[^>]*Type="StartLoc"', ob):
        starts.append({"x": int(math.floor(float(x))) - left, "y": (top - 1) - int(math.floor(float(y)))})
    if len(starts) < 2:
        return None

    # Grids over the playable area. Our y axis points south (SC2's points north).
    def cell(x, y):  # our tile -> SC2 cell index
        return (top - 1 - y) * w + (left + x)

    levels = []
    for y in range(ph):
        for x in range(pw):
            levels.append(lev[cell(x, y)])
    base = min(v for v in levels)
    terrain = bytearray(pw * ph)
    level = bytearray(pw * ph)
    nobuild = bytearray(pw * ph)
    for y in range(ph):
        for x in range(pw):
            c = cell(x, y)
            i = y * pw + x
            v = lev[c]
            cliff = (cflags[c] & 1) if c < len(cflags) else 0
            if old_flags and v % 64 != 0:
                cliff = 0
            blocked = cliff or (pnp is not None and pnp[c] >= 128)
            if pgr is not None and pgr[c] >= 128:
                blocked = 0
            terrain[i] = 1 if blocked else 0
            level[i] = max(0, min(255, (v - base + 2) // 4))
            ramp = v % 64 != 0
            nobuild[i] = 1 if (blocked or ramp or (pnb is not None and pnb[c] >= 128)) else 0

    open_diagonals(terrain, level, nobuild, pw, ph)

    objects = []
    for mo in re.finditer(r"<ObjectUnit\b[^>]*>", ob):
        tag = mo.group(0)
        tm = re.search(r'UnitType="([^"]*)"', tag)
        pm = re.search(r'Position="([-\d.]+),([-\d.]+)', tag)
        if not tm or not pm:
            continue
        kind, kw, kh = object_kind(tm.group(1))
        if not kind:
            continue
        sx, sy = float(pm.group(1)), float(pm.group(2))
        tx = int(math.floor(sx - kw / 2 + 0.01)) - left
        sty = int(math.floor(sy - kh / 2 + 0.01))
        ty = top - sty - kh
        if tx < 0 or ty < 0 or tx + kw > pw or ty + kh > ph:
            continue
        if kind == "nobuild":
            for yy in range(ty, ty + kh):
                for xx in range(tx, tx + kw):
                    nobuild[yy * pw + xx] = 1
            continue
        objects.append({"kind": kind, "tx": tx, "ty": ty})

    if sum(1 for o in objects if o["kind"].startswith("mineral") or o["kind"] == "rich") < 8:
        return None

    # Render-only data: vertex heights (tiles) over the playable area plus a margin of scenery.
    hx0 = max(0, left - MARGIN)
    hx1 = min(sw - 1, right + MARGIN)
    hy0 = max(0, bottom - MARGIN)
    hy1 = min(sh - 1, top + MARGIN)
    hw = hx1 - hx0 + 1
    hh = hy1 - hy0 + 1
    hmin = min(sheights[(sy) * sw + sx] for sy in range(hy0, hy1 + 1) for sx in range(hx0, hx1 + 1))
    heights = bytearray()
    for Y in range(hh):
        sy = hy1 - Y
        for X in range(hw):
            v = (sheights[sy * sw + hx0 + X] - hmin) / 32768.0  # 2.0 per cliff level
            heights += struct.pack("<H", max(0, min(65535, int(round(v * 1000)))))
    # Our vertex (X, Y) of the height grid sits at tile coordinate (hx0 - left + X, top - hy1 + Y).
    hox = hx0 - left
    hoy = top - hy1

    doodads = []
    for mo in re.finditer(r"<ObjectDoodad\b([^>]*?)(/>|>(.*?)</ObjectDoodad>)", ob, re.S):
        attrs = mo.group(1)
        tm = re.search(r'Type="([^"]*)"', attrs)
        pm = re.search(r'Position="([-\d.]+),([-\d.]+),([-\d.]+)"', attrs)
        if not tm or not pm:
            continue
        cat = doodad_category(tm.group(1))
        if not cat:
            continue
        x = float(pm.group(1)) - left
        y = top - float(pm.group(2))
        if x < hox or y < hoy or x > hox + hw - 1 or y > hoy + hh - 1:
            continue
        rm = re.search(r'Rotation="([-\d.]+)"', attrs)
        scm = re.search(r'Scale="([-\d.]+)', attrs)
        vm = re.search(r'Variation="(\d+)"', attrs)
        doodads.append({
            "t": cat,
            "x": round(x, 2),
            "y": round(y, 2),
            "r": round(-float(rm.group(1)) if rm else 0.0, 2),
            "s": round(float(scm.group(1)) if scm else 1.0, 2),
            "v": int(vm.group(1)) if vm else 0,
        })
        if len(doodads) >= 8000:
            break

    key = slug(name)
    out = {
        "key": key,
        "name": re.sub(r"^\[[^\]]*\]\s*", "", name),
        "source": os.path.basename(path),
        "tileset": tileset,
        "w": pw,
        "h": ph,
        "players": len(starts),
        "terrain": b64(terrain),
        "level": b64(level),
        "nobuild": b64(nobuild),
        "starts": starts,
        "objects": objects,
        "heights": {"x": hox, "y": hoy, "w": hw, "h": hh, "data": b64(heights)},
        "doodads": doodads,
    }

    tga = m.read("Minimap.tga")
    minimap = read_tga(tga) if tga else None
    return out, minimap


def main(argv):
    only_list = "--list" in argv
    paths = [a for a in argv if not a.startswith("--")]
    if not paths:
        paths = glob.glob(os.path.join(CACHE, "**", "*.s2ma"), recursive=True)
        if not paths:
            print("No maps found in", CACHE, "- pass .SC2Map files as arguments instead.")
            return 1
    paths.sort(key=lambda p: -os.path.getsize(p))
    os.makedirs(OUT, exist_ok=True)
    index = {}
    seen = set()
    for p in paths:
        try:
            res = convert(p)
        except Exception as e:  # noqa: BLE001 - skip anything unreadable, keep going
            if "not an MPQ" not in str(e):
                print("skip", os.path.basename(p), "-", e)
            continue
        if not res:
            continue
        data, minimap = res
        key = data["key"]
        # The cache often holds tournament copies of ladder maps ("[ESL] X", "X LE"): keep one.
        same = re.sub(r"-le$", "", key)
        if key in index or same in seen:
            continue
        seen.add(same)
        if only_list:
            print(f"{data['name']:32s} {data['w']}x{data['h']}  {data['players']} players  {len(data['doodads'])} doodads")
            index[key] = True
            continue
        if minimap:
            mw, mh, rgb = crop_minimap(minimap, data["w"], data["h"])
            write_png(os.path.join(OUT, key + ".png"), mw, mh, rgb)
            data["minimap"] = key + ".png"
        with open(os.path.join(OUT, key + ".json"), "w", encoding="utf8") as f:
            json.dump(data, f, separators=(",", ":"))
        index[key] = {"key": key, "name": data["name"], "w": data["w"], "h": data["h"], "players": data["players"]}
        print(f"imported {data['name']:32s} {data['w']}x{data['h']}  {data['players']} players  -> {key}.json")
    if not only_list:
        with open(os.path.join(OUT, "index.json"), "w", encoding="utf8") as f:
            json.dump(sorted(index.values(), key=lambda m: m["name"]), f, indent=1)
        print(f"{len(index)} maps written to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
