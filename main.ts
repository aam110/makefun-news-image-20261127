// THE WORLD TODAY — one day's world news in one image.
// Friday 27 November 2026. Node 22, standard library only.
// Draws a 1024x1024 newspaper front page from embedded font outlines
// (glyphs.bin, extracted from OFL fonts with fontTools) and writes it to
// $MAKEFUN_OUTPUT_DIR/entry.png. Deterministic, no network.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------- fonts

type Pt = { x: number; y: number; on: boolean };
type Glyph = { advance: number; contours: Pt[][] };
type Font = { upem: number; glyphs: Map<number, Glyph>; kern: Map<string, number> };

function loadGlyphs(buf: Buffer): Map<string, Font> {
  let o = 0;
  const magic = buf.toString("ascii", 0, 5);
  o = 5;
  if (magic !== "GLYF1") throw new Error("bad glyphs.bin magic");
  const nFonts = buf.readUInt8(o);
  o += 1;
  const fonts = new Map<string, Font>();
  for (let f = 0; f < nFonts; f++) {
    const nlen = buf.readUInt8(o);
    o += 1;
    const name = buf.toString("ascii", o, o + nlen);
    o += nlen;
    const upem = buf.readUInt16LE(o);
    o += 2;
    const nGlyphs = buf.readUInt16LE(o);
    o += 2;
    const glyphs = new Map<number, Glyph>();
    for (let g = 0; g < nGlyphs; g++) {
      const cp = buf.readUInt32LE(o);
      o += 4;
      const advance = buf.readInt16LE(o);
      o += 2;
      const nCont = buf.readUInt16LE(o);
      o += 2;
      const contours: Pt[][] = [];
      for (let c = 0; c < nCont; c++) {
        const nPts = buf.readUInt16LE(o);
        o += 2;
        const pts: Pt[] = [];
        for (let p = 0; p < nPts; p++) {
          const x = buf.readInt16LE(o);
          o += 2;
          const y = buf.readInt16LE(o);
          o += 2;
          const on = buf.readUInt8(o);
          o += 1;
          pts.push({ x, y, on: on === 1 });
        }
        contours.push(pts);
      }
      glyphs.set(cp, { advance, contours });
    }
    const nKern = buf.readUInt16LE(o);
    o += 2;
    const kern = new Map<string, number>();
    for (let k = 0; k < nKern; k++) {
      const l = buf.readUInt32LE(o);
      o += 4;
      const r = buf.readUInt32LE(o);
      o += 4;
      const v = buf.readInt16LE(o);
      o += 2;
      kern.set(l + "," + r, v);
    }
    fonts.set(name, { upem, glyphs, kern });
  }
  return fonts;
}

let FONTS: Map<string, Font> = new Map();

// Resolve a glyph, falling back across fonts when a face lacks the char
// (e.g. the rupee sign lives in sansBold, not in the serif faces).
function resolveGlyph(
  fontName: string,
  cp: number,
): { font: Font; glyph: Glyph } | null {
  const order = [fontName, "sansBold", "serif", "serifBold", "display"];
  const seen = new Set<string>();
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const font = FONTS.get(name);
    if (!font) continue;
    const glyph = font.glyphs.get(cp);
    if (glyph) return { font, glyph };
  }
  return null;
}

function glyphAdvance(fontName: string, cp: number, px: number): number {
  const r = resolveGlyph(fontName, cp);
  if (!r) return px * 0.5;
  return (r.glyph.advance * px) / r.font.upem;
}

function kernValue(fontName: string, left: number, right: number, px: number): number {
  const font = FONTS.get(fontName);
  if (!font) return 0;
  const v = font.kern.get(left + "," + right);
  if (v === undefined) return 0;
  return (v * px) / font.upem;
}

function textWidth(
  text: string,
  fontName: string,
  px: number,
  tracking = 0,
): number {
  let w = 0;
  let prev = -1;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (prev >= 0) w += kernValue(fontName, prev, cp, px);
    w += glyphAdvance(fontName, cp, px) + tracking;
    prev = cp;
  }
  if (text.length > 0) w -= tracking;
  return w;
}

// ------------------------------------------------------- glyph rasteriser

type GlyphBitmap = { w: number; h: number; ox: number; oy: number; data: Uint8Array };
const glyphCache = new Map<string, GlyphBitmap>();

// Insert implied on-curve midpoints between consecutive off-curve points.
function expandContour(pts: Pt[]): Pt[] {
  const n = pts.length;
  if (n === 0) return [];
  let start = 0;
  while (start < n && !pts[start].on) start++;
  if (start === n) return [];
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const p = pts[(start + k) % n];
    out.push(p);
    const q = pts[(start + k + 1) % n];
    if (!p.on && !q.on) {
      out.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, on: true });
    }
  }
  return out;
}

// Flatten one contour to line segments in scaled pixel space.
function flattenContour(
  pts: Pt[],
  scale: number,
  out: { x0: number; y0: number; x1: number; y1: number }[],
): void {
  const e = expandContour(pts);
  const m = e.length;
  if (m < 2) return;
  let cx = e[0].x * scale;
  let cy = e[0].y * scale;
  let k = 1;
  while (k <= m) {
    const p = e[k % m];
    if (p.on) {
      const x = p.x * scale;
      const y = p.y * scale;
      out.push({ x0: cx, y0: cy, x1: x, y1: y });
      cx = x;
      cy = y;
      k++;
    } else {
      const end = e[(k + 1) % m];
      const ex = end.x * scale;
      const ey = end.y * scale;
      const qx = p.x * scale;
      const qy = p.y * scale;
      const dx = ex - cx;
      const dy = ey - cy;
      const len = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(2, Math.min(24, Math.ceil(len / 2)));
      let px0 = cx;
      let py0 = cy;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const mt = 1 - t;
        const x = mt * mt * cx + 2 * mt * t * qx + t * t * ex;
        const y = mt * mt * cy + 2 * mt * t * qy + t * t * ey;
        out.push({ x0: px0, y0: py0, x1: x, y1: y });
        px0 = x;
        py0 = y;
      }
      cx = ex;
      cy = ey;
      k += 2;
    }
  }
}

function rasterGlyph(fontName: string, cp: number, px: number): GlyphBitmap {
  const key = fontName + "|" + cp + "|" + px;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const empty: GlyphBitmap = { w: 0, h: 0, ox: 0, oy: 0, data: new Uint8Array(0) };
  const r = resolveGlyph(fontName, cp);
  if (!r) {
    glyphCache.set(key, empty);
    return empty;
  }
  const scale = px / r.font.upem;
  const segs: { x0: number; y0: number; x1: number; y1: number }[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of r.glyph.contours) {
    const before = segs.length;
    flattenContour(contour, scale, segs);
    for (let i = before; i < segs.length; i++) {
      const s = segs[i];
      minX = Math.min(minX, s.x0, s.x1);
      maxX = Math.max(maxX, s.x0, s.x1);
      minY = Math.min(minY, s.y0, s.y1);
      maxY = Math.max(maxY, s.y0, s.y1);
    }
  }
  if (segs.length === 0 || !isFinite(minX)) {
    glyphCache.set(key, empty);
    return empty;
  }
  const ss = px <= 24 ? 4 : 2;
  const ox = Math.floor(minX);
  const oy = Math.floor(minY);
  const w = Math.ceil(maxX) - ox + 1;
  const h = Math.ceil(maxY) - oy + 1;
  const sw = w * ss;
  const sh = h * ss;
  const cover = new Uint16Array(w * h);
  // Non-zero winding scanline fill at supersampled resolution.
  const edges: { y0: number; y1: number; x: number; dx: number; dir: number }[] = [];
  for (const s of segs) {
    if (s.y0 === s.y1) continue;
    const yTop = Math.min(s.y0, s.y1);
    const yBot = Math.max(s.y0, s.y1);
    const xAtTop = s.y0 < s.y1 ? s.x0 : s.x1;
    edges.push({
      y0: yTop,
      y1: yBot,
      x: xAtTop,
      dx: (s.x1 - s.x0) / (s.y1 - s.y0),
      dir: s.y1 > s.y0 ? 1 : -1,
    });
  }
  const crossings: { x: number; dir: number }[] = [];
  for (let sy = 0; sy < sh; sy++) {
    const y = oy + (sy + 0.5) / ss;
    crossings.length = 0;
    for (const e of edges) {
      if (y >= e.y0 && y < e.y1) {
        crossings.push({ x: e.x + (y - e.y0) * e.dx, dir: e.dir });
      }
    }
    if (crossings.length === 0) continue;
    crossings.sort((a, b) => a.x - b.x);
    let winding = 0;
    let spanStart = 0;
    for (let i = 0; i < crossings.length; i++) {
      const c = crossings[i];
      if (winding === 0) spanStart = c.x;
      winding += c.dir;
      if (winding === 0) {
        const x0 = Math.max(spanStart, ox);
        const x1 = Math.min(c.x, ox + w);
        const sx0 = Math.max(0, Math.floor((x0 - ox) * ss));
        const sx1 = Math.min(sw, Math.ceil((x1 - ox) * ss));
        // Bitmap row 0 is the TOP of the glyph (largest font-y); font-y
        // grows upward, so flip the scanline row when storing coverage.
        const py = h - 1 - Math.floor(sy / ss);
        for (let sx = sx0; sx < sx1; sx++) {
          cover[py * w + Math.floor(sx / ss)] += 1;
        }
      }
    }
  }
  const data = new Uint8Array(w * h);
  const denom = ss * ss;
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.min(255, Math.round((cover[i] / denom) * 255));
  }
  const bmp: GlyphBitmap = { w, h, ox, oy, data };
  glyphCache.set(key, bmp);
  return bmp;
}

// ---------------------------------------------------------------- canvas

type RGB = [number, number, number];

const PAPER: RGB = [246, 240, 225];
const INK: RGB = [25, 21, 18];
const SOFT: RGB = [74, 66, 56];
const FAINT: RGB = [120, 110, 96];
const RED: RGB = [178, 39, 24];
const RULE: RGB = [25, 21, 18];
const HAIR: RGB = [201, 191, 169];
const CREAM: RGB = [250, 246, 236];

const canvas = new Uint8Array(W * H * 3);

function fillAll(c: RGB): void {
  for (let i = 0; i < W * H; i++) {
    canvas[i * 3] = c[0];
    canvas[i * 3 + 1] = c[1];
    canvas[i * 3 + 2] = c[2];
  }
}

function setPx(x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  canvas[i] = c[0];
  canvas[i + 1] = c[1];
  canvas[i + 2] = c[2];
}

function blendPx(x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = (y * W + x) * 3;
  if (a >= 255) {
    canvas[i] = c[0];
    canvas[i + 1] = c[1];
    canvas[i + 2] = c[2];
    return;
  }
  canvas[i] = Math.round((c[0] * a + canvas[i] * (255 - a)) / 255);
  canvas[i + 1] = Math.round((c[1] * a + canvas[i + 1] * (255 - a)) / 255);
  canvas[i + 2] = Math.round((c[2] * a + canvas[i + 2] * (255 - a)) / 255);
}

function fillRect(x: number, y: number, w: number, h: number, c: RGB): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(W, Math.round(x + w));
  const y1 = Math.min(H, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * W + xx) * 3;
      canvas[i] = c[0];
      canvas[i + 1] = c[1];
      canvas[i + 2] = c[2];
    }
  }
}

function hLine(x: number, y: number, w: number, c: RGB, t = 1): void {
  fillRect(x, y, w, t, c);
}

function vLine(x: number, y: number, h: number, c: RGB, t = 1): void {
  fillRect(x, y, t, h, c);
}

function strokeRect(x: number, y: number, w: number, h: number, c: RGB, t = 1): void {
  hLine(x, y, w, c, t);
  hLine(x, y + h - t, w, c, t);
  vLine(x, y, h, c, t);
  vLine(x + w - t, y, h, c, t);
}

// Thick line as a filled quad.
function drawLine(x0: number, y0: number, x1: number, y1: number, t: number, c: RGB): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return;
  const nx = (-dy / len) * (t / 2);
  const ny = (dx / len) * (t / 2);
  fillPoly(
    [
      [x0 + nx, y0 + ny],
      [x1 + nx, y1 + ny],
      [x1 - nx, y1 - ny],
      [x0 - nx, y0 - ny],
    ],
    c,
  );
}

// Scanline polygon fill (even-odd is fine for our convex/simple shapes).
function fillPoly(pts: [number, number][], c: RGB): void {
  if (pts.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        const t = (y + 0.5 - a[1]) / (b[1] - a[1]);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i]));
      const x1 = Math.min(W - 1, Math.floor(xs[i + 1]));
      for (let x = x0; x <= x1; x++) setPx(x, y, c);
    }
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB): void {
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
    const x0 = Math.max(0, Math.ceil(cx - dx));
    const x1 = Math.min(W - 1, Math.floor(cx + dx));
    for (let x = x0; x <= x1; x++) setPx(x, y, c);
  }
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    const dx = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    const x0 = Math.max(0, Math.ceil(cx - dx));
    const x1 = Math.min(W - 1, Math.floor(cx + dx));
    for (let x = x0; x <= x1; x++) setPx(x, y, c);
  }
}

// ------------------------------------------------------------ PNG encoder

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function encodePNG(w: number, h: number, rgb: Uint8Array): Buffer {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride;
    const row = Buffer.from(rgb.buffer, rgb.byteOffset + rowStart, stride);
    // candidate filters: 0 None, 1 Sub, 2 Up, 4 Paeth; pick smallest
    // sum of absolute signed bytes.
    let bestFilter = 0;
    let bestScore = Infinity;
    let best: Buffer | null = null;
    for (const f of [0, 1, 2, 4]) {
      const filt = Buffer.alloc(stride);
      for (let x = 0; x < stride; x++) {
        const v = row[x];
        const a = x >= 3 ? row[x - 3] : 0;
        const b = prev[x];
        const cc = x >= 3 ? prev[x - 3] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 4) {
          const p = a + b - cc;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - cc);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
        }
        filt[x] = (v - pred) & 0xff;
      }
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const s = filt[x] >= 128 ? filt[x] - 256 : filt[x];
        score += Math.abs(s);
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
        best = filt;
      }
    }
    raw[y * (stride + 1)] = bestFilter;
    (best as Buffer).copy(raw, y * (stride + 1) + 1);
    prev.set(row);
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ text drawing

type TextOpts = {
  align?: "left" | "center" | "right";
  tracking?: number;
};

// Draw one line; (x, y) is the baseline start (left edge for align left).
function drawText(
  text: string,
  x: number,
  y: number,
  fontName: string,
  px: number,
  c: RGB,
  opts: TextOpts = {},
): void {
  const tracking = opts.tracking ?? 0;
  let sx = x;
  const w = textWidth(text, fontName, px, tracking);
  if (opts.align === "center") sx = x - w / 2;
  else if (opts.align === "right") sx = x - w;
  let cx = sx;
  let prev = -1;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (prev >= 0) cx += kernValue(fontName, prev, cp, px);
    const bmp = rasterGlyph(fontName, cp, px);
    if (bmp.w > 0) {
      // Glyph bitmap origin: (ox, oy) is the top-left of the outline box in
      // font units with y up; baseline is y=0, so screen top = y - oy - h.
      const top = Math.round(y - bmp.oy - bmp.h);
      const left = Math.round(cx + bmp.ox);
      for (let yy = 0; yy < bmp.h; yy++) {
        for (let xx = 0; xx < bmp.w; xx++) {
          const a = bmp.data[yy * bmp.w + xx];
          if (a > 0) blendPx(left + xx, top + yy, c, a);
        }
      }
    }
    cx += glyphAdvance(fontName, cp, px) + tracking;
    prev = cp;
  }
}

function wrapText(text: string, fontName: string, px: number, maxW: number, tracking = 0): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const test = cur === "" ? word : cur + " " + word;
    if (textWidth(test, fontName, px, tracking) <= maxW || cur === "") {
      cur = test;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

// Draw wrapped lines; returns the y of the last baseline drawn.
function drawLines(
  lines: string[],
  x: number,
  y: number,
  fontName: string,
  px: number,
  c: RGB,
  lineH: number,
  opts: TextOpts = {},
): number {
  let yy = y;
  for (const line of lines) {
    drawText(line, x, yy, fontName, px, c, opts);
    yy += lineH;
  }
  return yy - lineH;
}

// Fit one line into maxW by shrinking px down to minPx.
function drawFitLine(
  text: string,
  x: number,
  y: number,
  fontName: string,
  px: number,
  minPx: number,
  maxW: number,
  c: RGB,
  opts: TextOpts = {},
): void {
  let size = px;
  while (size > minPx && textWidth(text, fontName, size, opts.tracking ?? 0) > maxW) {
    size -= 0.5;
  }
  drawText(text, x, y, fontName, size, c, opts);
}

// ------------------------------------------------------- small scene art
// Every medium gets a small drawn scene (flat print style). Each painter
// works inside the box (x, y, w, h).

function sceneFire(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [58, 44, 38]);
  fillRect(x + w * 0.14, y + h * 0.42, w * 0.72, h * 0.58, [32, 26, 22]);
  // windows
  fillRect(x + w * 0.22, y + h * 0.52, w * 0.14, h * 0.16, [232, 190, 110]);
  fillRect(x + w * 0.62, y + h * 0.52, w * 0.14, h * 0.16, [232, 190, 110]);
  // flames
  fillPoly(
    [
      [x + w * 0.3, y + h * 0.95],
      [x + w * 0.38, y + h * 0.45],
      [x + w * 0.46, y + h * 0.7],
      [x + w * 0.54, y + h * 0.35],
      [x + w * 0.62, y + h * 0.68],
      [x + w * 0.7, y + h * 0.5],
      [x + w * 0.78, y + h * 0.95],
    ],
    [226, 110, 32],
  );
  fillPoly(
    [
      [x + w * 0.42, y + h * 0.95],
      [x + w * 0.48, y + h * 0.62],
      [x + w * 0.56, y + h * 0.8],
      [x + w * 0.62, y + h * 0.95],
    ],
    [240, 196, 60],
  );
  // smoke
  fillCircle(x + w * 0.3, y + h * 0.24, w * 0.05, [150, 140, 126]);
  fillCircle(x + w * 0.52, y + h * 0.16, w * 0.06, [170, 160, 146]);
  fillCircle(x + w * 0.72, y + h * 0.26, w * 0.05, [150, 140, 126]);
}

function sceneBorder(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [214, 226, 214]);
  // hills
  fillPoly(
    [
      [x, y + h],
      [x, y + h * 0.62],
      [x + w * 0.3, y + h * 0.45],
      [x + w * 0.6, y + h * 0.66],
      [x + w, y + h * 0.5],
      [x + w, y + h],
    ],
    [122, 148, 106],
  );
  // fence posts + dashed line
  for (let i = 0; i < 6; i++) {
    const px = x + w * (0.08 + i * 0.17);
    fillRect(px, y + h * 0.28, 3, h * 0.42, [90, 70, 52]);
  }
  for (let i = 0; i < 12; i++) {
    fillRect(x + w * (0.05 + i * 0.08), y + h * 0.34, w * 0.045, 2, [90, 70, 52]);
  }
  // big 40 on a clean chip so it never fights the fence posts
  fillRect(x + w * 0.6, y + h * 0.12, w * 0.36, h * 0.76, CREAM);
  strokeRect(x + w * 0.6, y + h * 0.12, w * 0.36, h * 0.76, INK, 1);
  drawText("40", x + w * 0.78, y + h * 0.62, "sansBold", 26, RED, { align: "center", tracking: 0 });
  drawText("CROSSINGS", x + w * 0.78, y + h * 0.8, "sansBold", 8, INK, { align: "center" });
}

function sceneGas(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [24, 52, 66]);
  // pipeline
  fillRect(x, y + h * 0.62, w, h * 0.12, [120, 128, 122]);
  fillRect(x, y + h * 0.62, w, 3, [180, 186, 180]);
  // flame
  fillPoly(
    [
      [x + w * 0.42, y + h * 0.6],
      [x + w * 0.5, y + h * 0.22],
      [x + w * 0.58, y + h * 0.6],
    ],
    [86, 170, 220],
  );
  fillPoly(
    [
      [x + w * 0.46, y + h * 0.6],
      [x + w * 0.5, y + h * 0.4],
      [x + w * 0.54, y + h * 0.6],
    ],
    [220, 235, 245],
  );
  drawText("20%", x + w * 0.68, y + h * 0.62, "sansBold", 24, [240, 235, 220]);
  drawText("FOR HOME", x + w * 0.68, y + h * 0.8, "sansBold", 8, [200, 205, 200]);
}

function sceneServers(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [232, 228, 216]);
  // three racks
  for (let i = 0; i < 3; i++) {
    const rx = x + w * (0.1 + i * 0.28);
    fillRect(rx, y + h * 0.18, w * 0.22, h * 0.68, [44, 48, 54]);
    for (let j = 0; j < 4; j++) {
      fillRect(rx + 4, y + h * (0.26 + j * 0.15), w * 0.22 - 8, 3, [120, 200, 120]);
    }
  }
  // lightning bolt
  fillPoly(
    [
      [x + w * 0.86, y + h * 0.12],
      [x + w * 0.72, y + h * 0.52],
      [x + w * 0.82, y + h * 0.52],
      [x + w * 0.74, y + h * 0.88],
      [x + w * 0.92, y + h * 0.44],
      [x + w * 0.82, y + h * 0.44],
    ],
    [226, 170, 32],
  );
}

function sceneChartDown(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [238, 232, 214]);
  // grid
  for (let i = 1; i < 4; i++) {
    hLine(x + 6, y + (h * i) / 4, w - 12, [210, 200, 176], 1);
  }
  // falling line
  drawLine(x + w * 0.08, y + h * 0.3, x + w * 0.42, y + h * 0.42, 3, RED);
  drawLine(x + w * 0.42, y + h * 0.42, x + w * 0.7, y + h * 0.58, 3, RED);
  drawLine(x + w * 0.7, y + h * 0.58, x + w * 0.92, y + h * 0.78, 3, RED);
  fillCircle(x + w * 0.92, y + h * 0.78, 4, RED);
  drawText("2%", x + w * 0.1, y + h * 0.9, "sansBold", 22, INK);
}

function sceneFlags(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [222, 214, 190]);
  // dome
  fillCircle(x + w * 0.5, y + h * 0.64, w * 0.08, [90, 110, 92]);
  fillRect(x + w * 0.34, y + h * 0.62, w * 0.32, h * 0.38, [90, 110, 92]);
  // three flags
  const cols: RGB[] = [
    [26, 122, 62],
    [240, 240, 235],
    [200, 60, 44],
  ];
  for (let i = 0; i < 3; i++) {
    const fx = x + w * (0.14 + i * 0.3);
    vLine(fx, y + h * 0.16, h * 0.6, INK, 2);
    fillRect(fx + 2, y + h * 0.16, w * 0.2, h * 0.16, cols[i]);
    strokeRect(fx + 2, y + h * 0.16, w * 0.2, h * 0.16, INK, 1);
  }
}

function sceneAudit(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [238, 234, 222]);
  // document
  fillRect(x + w * 0.16, y + h * 0.12, w * 0.5, h * 0.76, CREAM);
  strokeRect(x + w * 0.16, y + h * 0.12, w * 0.5, h * 0.76, INK, 1);
  for (let i = 0; i < 4; i++) {
    hLine(x + w * 0.22, y + h * (0.26 + i * 0.14), w * 0.38, [150, 140, 125], 2);
  }
  // red stamp
  drawLine(x + w * 0.58, y + h * 0.3, x + w * 0.94, y + h * 0.22, 2, RED);
  drawLine(x + w * 0.58, y + h * 0.44, x + w * 0.94, y + h * 0.36, 2, RED);
  drawText("AUDIT", x + w * 0.6, y + h * 0.42, "sansBold", 13, RED, { tracking: 1 });
  // magnifier
  fillCircle(x + w * 0.78, y + h * 0.68, w * 0.07, [70, 110, 140]);
  drawLine(x + w * 0.83, y + h * 0.73, x + w * 0.92, y + h * 0.86, 3, INK);
}

function sceneCoins(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [232, 224, 196]);
  // coin stack
  for (let i = 0; i < 4; i++) {
    fillEllipse(x + w * 0.24, y + h * (0.82 - i * 0.13), w * 0.16, h * 0.05, [212, 164, 60]);
    fillEllipse(x + w * 0.24, y + h * (0.82 - i * 0.13), w * 0.13, h * 0.035, [232, 190, 90]);
  }
  drawText("1.55", x + w * 0.48, y + h * 0.66, "sansBold", 26, INK);
  drawText("MONTHS' PAY", x + w * 0.48, y + h * 0.84, "sansBold", 9, SOFT);
}

function sceneBreach(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [30, 38, 52]);
  // shield
  fillPoly(
    [
      [x + w * 0.3, y + h * 0.14],
      [x + w * 0.62, y + h * 0.14],
      [x + w * 0.62, y + h * 0.5],
      [x + w * 0.46, y + h * 0.82],
      [x + w * 0.3, y + h * 0.5],
    ],
    [220, 225, 230],
  );
  // crack
  drawLine(x + w * 0.46, y + h * 0.16, x + w * 0.4, y + h * 0.4, 2, RED);
  drawLine(x + w * 0.4, y + h * 0.4, x + w * 0.52, y + h * 0.56, 2, RED);
  drawLine(x + w * 0.52, y + h * 0.56, x + w * 0.44, y + h * 0.78, 2, RED);
  // binary dots
  for (let i = 0; i < 8; i++) {
    fillCircle(x + w * (0.72 + (i % 2) * 0.1), y + h * (0.2 + Math.floor(i / 2) * 0.18), 2, [140, 200, 140]);
  }
}

function sceneRace(x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, [210, 220, 226]);
  // track curve
  drawLine(x + w * 0.05, y + h * 0.8, x + w * 0.45, y + h * 0.55, 8, [70, 70, 74]);
  drawLine(x + w * 0.45, y + h * 0.55, x + w * 0.9, y + h * 0.62, 8, [70, 70, 74]);
  // checkered flag
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      if ((r + c) % 2 === 0) fillRect(x + w * (0.62 + c * 0.07), y + h * (0.12 + r * 0.09), w * 0.07, h * 0.09, INK);
      else fillRect(x + w * (0.62 + c * 0.07), y + h * (0.12 + r * 0.09), w * 0.07, h * 0.09, CREAM);
    }
  }
  vLine(x + w * 0.6, y + h * 0.08, h * 0.36, INK, 2);
  drawText("P1 · P2", x + w * 0.08, y + h * 0.38, "sansBold", 15, INK);
  drawText("LUSAIL", x + w * 0.08, y + h * 0.54, "sansBold", 9, SOFT);
}

// ---------------------------------------------------------------- layout
// Page geometry: 1024 x 1024, content margins L/R 26 (width 972).

const MX = 26;
const CW = 972;

const REGION_COLORS: Record<string, RGB> = {
  OCEANIA: [46, 111, 142],
  "EAST ASIA": [178, 39, 24],
  "SOUTH ASIA": [198, 110, 30],
  "SE ASIA": [74, 124, 89],
  "N. AMERICA": [91, 74, 138],
  "MIDDLE EAST": [138, 109, 59],
  EUROPE: [63, 111, 181],
};

function drawMasthead(): void {
  // Masthead name — Noto Serif Display Black.
  drawText("THE WORLD TODAY", W / 2, 56, "display", 47, INK, {
    align: "center",
    tracking: 1,
  });
  // Dateline, flanked by rules.
  const dateText = "FRIDAY  •  27 NOVEMBER 2026";
  const dw = textWidth(dateText, "sansBold", 12, 1);
  const cx = W / 2;
  hLine(MX, 74, cx - dw / 2 - MX - 16, RULE, 1);
  hLine(cx + dw / 2 + 16, 74, W - MX - (cx + dw / 2 + 16), RULE, 1);
  drawText(dateText, cx, 78, "sansBold", 12, INK, { align: "center", tracking: 1 });
  // Double rule under the masthead.
  hLine(MX, 88, CW, RULE, 3);
  hLine(MX, 93, CW, RULE, 1);
  // Sub-headline, serif italic, one line, no capital F.
  drawText(
    "New Zealand counts 400,000 special votes, Tokyo prices quicken, and Macy's balloons go back up for Saturday's 100th parade.",
    W / 2,
    114,
    "serifItalic",
    15.5,
    SOFT,
    { align: "center" },
  );
  // Region bar.
  const regions: [string, number][] = [
    ["OCEANIA", 9],
    ["EAST ASIA", 5],
    ["SOUTH ASIA", 9],
    ["SE ASIA", 9],
    ["N. AMERICA", 2],
    ["MIDDLE EAST", 1],
    ["EUROPE", 1],
  ];
  let totalW = 0;
  const parts = regions.map(([name, n]) => {
    const t = name + " " + n;
    const w = 12 + textWidth(t, "sansBold", 9.5, 0.5) + 22;
    totalW += w;
    return { name, n, t, w };
  });
  totalW += 22 + textWidth("36 STORIES", "sansBold", 9.5, 0.5);
  let rx = (W - totalW) / 2;
  const ry = 134;
  for (const p of parts) {
    fillCircle(rx + 5, ry - 3, 4, REGION_COLORS[p.name]);
    drawText(p.t, rx + 13, ry, "sansBold", 9.5, INK, { tracking: 0.5 });
    rx += p.w;
  }
  drawText("36 STORIES", rx + 10, ry, "sansBold", 9.5, RED, { tracking: 0.5 });
  hLine(MX, 142, CW, HAIR, 1);
}

// ------------------------------------------------------------- hero paint

function heroFrame(x: number, y: number, w: number, h: number, num: number, kicker: string, color: RGB): void {
  fillRect(x, y, w, h, CREAM);
  strokeRect(x, y, w, h, HAIR, 1);
  // number tab
  fillRect(x, y, 26, 20, color);
  drawText(String(num), x + 13, y + 15, "sansBold", 12, [255, 255, 255], { align: "center" });
  drawText(kicker, x + 34, y + 15, "sansBold", 9.5, color, { tracking: 1 });
}

function hero1Diagram(x: number, y: number, w: number, h: number): void {
  heroFrame(x, y, w, h, 1, "OCEANIA  •  ONGOING", REGION_COLORS["OCEANIA"]);
  const tx = x + 12;
  const tw = w - 24;
  drawLines(
    wrapText("New Zealand counts 400,000 special votes", "serifBold", 20, tw),
    tx, y + 48, "serifBold", 20, INK, 23,
  );
  // Parliament seat bar: 7 party blocks, 131 seats.
  const barY = y + 96;
  const barH = 34;
  const seats: [string, number, RGB][] = [
    ["NAT", 42, [38, 84, 124]],
    ["LAB", 36, [178, 39, 24]],
    ["GRN", 16, [74, 124, 89]],
    ["ACT", 13, [198, 160, 30]],
    ["NZF", 12, [90, 90, 96]],
    ["TOP", 7, [120, 90, 150]],
    ["TPM", 5, [30, 90, 70]],
  ];
  let bx = tx;
  for (const [abbr, n, col] of seats) {
    const bw = (tw * n) / 131;
    fillRect(bx, barY, bw - 1, barH, col);
    // Seat count inside the bar where the segment is wide enough.
    if (bw >= 24) {
      drawText(String(n), bx + bw / 2, barY + 22, "sansBold", 10, abbr === "ACT" ? INK : [255, 255, 255], { align: "center" });
    }
    bx += bw;
  }
  // Majority line at 66 of 131.
  const majX = tx + (tw * 66) / 131;
  vLine(majX, barY - 8, barH + 16, RED, 2);
  drawText("66 TO GOVERN", majX, barY - 12, "sansBold", 8.5, RED, { align: "center" });
  // One legend line for all seven parties — the small segments get no
  // cramped label of their own.
  drawText(
    "NAT 42  •  LAB 36  •  GRN 16  •  ACT 13  •  NZF 12  •  TOP 7  •  TPM 5",
    tx + tw / 2, barY + barH + 13, "sansBold", 8.5, SOFT, { align: "center" },
  );
  // Big numbers row.
  drawText("67", tx, barY + barH + 44, "display", 30, INK);
  drawText("seats hold the coalition", tx + 62, barY + barH + 32, "serif", 11.5, SOFT);
  drawText("one more than the 66 it needs", tx + 62, barY + barH + 47, "serif", 11.5, SOFT);
  drawLines(
    wrapText(
      "The official count lands today at 14:00 NZDT; Labour leads on party votes by just 3,650.",
      "serif", 11.5, tw,
    ),
    tx, y + h - 28, "serif", 11.5, SOFT, 14,
  );
}

function hero2Chart(x: number, y: number, w: number, h: number): void {
  heroFrame(x, y, w, h, 2, "EAST ASIA  •  OFFICIAL", REGION_COLORS["EAST ASIA"]);
  const tx = x + 12;
  const tw = w - 24;
  drawLines(
    wrapText("Tokyo prices quicken: core CPI +2.9%", "serifBold", 20, tw),
    tx, y + 48, "serifBold", 20, INK, 23,
  );
  // Giant number — the data hero.
  drawText("+2.9%", tx, y + 126, "display", 52, RED);
  drawText("CORE CPI, YEAR ON YEAR", tx, y + 146, "sansBold", 9.5, SOFT, { tracking: 1 });
  // Bars: Oct 2.6, Nov 2.9, BOJ target 2.0.
  const chartY = y + 154;
  const chartH = 38;
  const maxV = 3.2;
  const bars: [string, number, RGB][] = [
    ["OCT 2.6%", 2.6, [120, 110, 96]],
    ["NOV 2.9%", 2.9, RED],
    ["TARGET 2.0%", 2.0, [46, 111, 142]],
  ];
  const bw = 52;
  const gap = (tw - bw * 3) / 2;
  bars.forEach(([label, v, col], i) => {
    const bx = tx + i * (bw + gap);
    const bh = (chartH * v) / maxV;
    fillRect(bx, chartY + chartH - bh, bw, bh, col);
    drawText(label, bx + bw / 2, chartY + chartH + 13, "sansBold", 8, SOFT, { align: "center" });
  });
  // Target dashed line at 2.0 across the chart.
  const ty = chartY + chartH - (chartH * 2.0) / maxV;
  for (let dx = tx; dx < tx + tw; dx += 8) {
    hLine(dx, ty, 5, INK, 1);
  }
  drawLines(
    wrapText(
      "Up from 2.6% in October, above the Bank of Japan's 2% target for a third month.",
      "serif", 11.5, tw,
    ),
    tx, y + h - 28, "serif", 11.5, SOFT, 14,
  );
}

function hero3Scene(x: number, y: number, w: number, h: number): void {
  heroFrame(x, y, w, h, 3, "N. AMERICA  •  CONFIRMED", REGION_COLORS["N. AMERICA"]);
  const tx = x + 12;
  const tw = w - 24;
  drawLines(
    wrapText("Macy's balloons go back up for the 100th parade", "serifBold", 20, tw),
    tx, y + 48, "serifBold", 20, INK, 23,
  );
  // Scene: sky, skyline, street, ONE giant balloon dominant.
  const sx = x + 1;
  const sy = y + 92;
  const sw = w - 2;
  const sh = 104;
  fillRect(sx, sy, sw, sh, [188, 211, 222]);
  // skyline
  fillRect(sx + 8, sy + sh - 52, 26, 52, [120, 130, 138]);
  fillRect(sx + 40, sy + sh - 66, 22, 66, [140, 148, 152]);
  fillRect(sx + sw - 66, sy + sh - 58, 24, 58, [120, 130, 138]);
  fillRect(sx + sw - 36, sy + sh - 44, 28, 44, [140, 148, 152]);
  // street
  fillRect(sx, sy + sh - 26, sw, 26, [138, 122, 99]);
  hLine(sx, sy + sh - 26, sw, [110, 96, 78], 2);
  // The giant balloon: one dominant subject, red with a cream band.
  const bcx = sx + sw * 0.52;
  const bcy = sy + sh * 0.42;
  fillEllipse(bcx, bcy, 74, 46, RED);
  // Cream band clipped to the balloon: paint row by row inside the ellipse.
  for (let yy = Math.round(bcy - 8); yy <= Math.round(bcy + 8); yy++) {
    const dy = (yy + 0.5 - bcy) / 46;
    const dx = 74 * Math.sqrt(Math.max(0, 1 - dy * dy));
    const x0 = Math.max(0, Math.ceil(bcx - dx));
    const x1 = Math.min(W - 1, Math.floor(bcx + dx));
    for (let xx = x0; xx <= x1; xx++) setPx(xx, yy, [240, 232, 210]);
  }
  // balloon face: two eyes + smile
  fillCircle(bcx - 26, bcy - 8, 5, INK);
  fillCircle(bcx + 26, bcy - 8, 5, INK);
  fillPoly(
    [
      [bcx - 18, bcy + 6],
      [bcx + 18, bcy + 6],
      [bcx, bcy + 16],
    ],
    INK,
  );
  // ropes to the crew below
  drawLine(bcx - 52, bcy + 30, bcx - 62, sy + sh - 8, 1.5, INK);
  drawLine(bcx + 52, bcy + 30, bcx + 62, sy + sh - 8, 1.5, INK);
  // tiny crew figures
  for (const fx of [bcx - 62, bcx + 62, bcx - 40]) {
    fillCircle(fx, sy + sh - 20, 3, INK);
    fillRect(fx - 2, sy + sh - 17, 4, 9, INK);
  }
  drawLines(
    wrapText(
      "Crews re-inflate the giants this afternoon; the parade marches on Saturday at 8:30 ET.",
      "serif", 11.5, tw,
    ),
    tx, y + h - 28, "serif", 11.5, SOFT, 14,
  );
}

function drawHeroes(): void {
  const y = 150;
  const h = 248;
  const gap = 10;
  const w1 = 326;
  const w2 = 313;
  const w3 = 313;
  hero1Diagram(MX, y, w1, h);
  hero2Chart(MX + w1 + gap, y, w2, h);
  hero3Scene(MX + w1 + gap + w2 + gap, y, w3, h);
  hLine(MX, y + h + 6, CW, HAIR, 1);
}

// ------------------------------------------------------------- mediums

type Medium = {
  scene: (x: number, y: number, w: number, h: number) => void;
  head: string;
  body: string;
};

const MEDIUMS: Medium[] = [
  {
    scene: sceneFire,
    head: "Seoul guesthouse fire kills a man in his 70s",
    body: "A guesthouse blaze in Seoul kills a man in his 70s.",
  },
  {
    scene: sceneBorder,
    head: "North Korean troops cross the border line 40 times",
    body: "Troops crossed the demarcation line 40 times since October.",
  },
  {
    scene: sceneGas,
    head: "Australia reserves 20% of gas for home use",
    body: "Parliament votes to reserve a fifth of gas for home use.",
  },
  {
    scene: sceneServers,
    head: "JERA in talks with Anthropic and Meta",
    body: "The power giant talks to Anthropic and Meta on data centres.",
  },
  {
    scene: sceneChartDown,
    head: "Bank of Korea warns on AI-led growth",
    body: "The bank says growth slips back to about 2% if AI slows.",
  },
  {
    scene: sceneFlags,
    head: "Pakistan, Saudi, Turkey meet in Islamabad",
    body: "A three-way meeting opens in Islamabad for two days.",
  },
  {
    scene: sceneAudit,
    head: "Damning audit of sanctions office",
    body: "Auditors damn the foreign ministry's sanctions office.",
  },
  {
    scene: sceneCoins,
    head: "Singapore bonus: 1.55 months' pay",
    body: "Civil servants receive a 1.55-month year-end bonus.",
  },
  {
    scene: sceneBreach,
    head: "RNZ probes a possible cyber breach",
    body: "The broadcaster probes a possible cyber breach.",
  },
  {
    scene: sceneRace,
    head: "Qatar GP: practice day at Lusail",
    body: "Practice 1 at 13:30 UTC, Practice 2 at 17:00 UTC.",
  },
];

function drawMediums(): void {
  const y0 = 410;
  drawText("THE DAY IN TEN", MX, y0 + 11, "sansBold", 10, INK, { tracking: 1.5 });
  drawText("4 — 13", MX + CW, y0 + 11, "sansBold", 10, FAINT, { align: "right", tracking: 1 });
  hLine(MX, y0 + 17, CW, RULE, 1);
  const cols = 5;
  const cellW = 186;
  const gap = 10;
  const cellH = 102;
  const rowGap = 6;
  const gridY = y0 + 24;
  MEDIUMS.forEach((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = MX + col * (cellW + gap);
    const y = gridY + row * (cellH + rowGap);
    const num = i + 4;
    // scene box
    m.scene(x, y, cellW, 42);
    strokeRect(x, y, cellW, 42, HAIR, 1);
    // number tab, top-left of the scene
    fillRect(x, y, 17, 13, RED);
    drawText(String(num), x + 8.5, y + 10, "sansBold", 9, [255, 255, 255], { align: "center" });
    const headLines = wrapText(m.head, "serifBold", 11, cellW);
    drawLines(headLines, x, y + 55, "serifBold", 11, INK, 12);
    const bodyLines = wrapText(m.body, "serif", 9.5, cellW);
    drawLines(bodyLines, x, y + 55 + headLines.length * 12 + 9, "serif", 9.5, SOFT, 11.5);
  });
  hLine(MX, gridY + 2 * cellH + rowGap + 6, CW, HAIR, 1);
}

// ------------------------------------------------------------------ map

// Rough continent outlines in lon/lat, equirectangular.
const CONTINENTS: [number, number][][] = [
  // North America
  [
    [-168, 66], [-140, 70], [-120, 72], [-95, 80], [-80, 73], [-55, 60],
    [-65, 45], [-75, 38], [-80, 32], [-81, 25], [-90, 21], [-97, 16],
    [-105, 20], [-114, 29], [-125, 40], [-124, 48], [-135, 58], [-155, 60], [-165, 60],
  ],
  // South America
  [
    [-80, 10], [-77, 4], [-80, -3], [-81, -6], [-77, -12], [-72, -18],
    [-70, -23], [-70, -30], [-72, -37], [-73, -44], [-70, -52], [-65, -55],
    [-68, -50], [-62, -41], [-57, -34], [-52, -32], [-48, -28], [-41, -23],
    [-35, -9], [-35, -6], [-44, -3], [-50, 0], [-55, 5], [-60, 8], [-70, 11],
  ],
  // Africa
  [
    [-6, 35], [0, 36], [10, 37], [20, 32], [30, 31], [32, 31], [35, 28],
    [38, 22], [43, 12], [48, 11], [51, 10], [44, 0], [40, -10], [35, -18],
    [32, -26], [28, -33], [20, -35], [15, -27], [12, -18], [13, -10],
    [9, -1], [9, 4], [-8, 4], [-13, 8], [-17, 15], [-17, 20], [-15, 27], [-10, 31],
  ],
  // Europe
  [
    [-10, 36], [-9, 43], [-2, 48], [-4, 49], [0, 51], [3, 53], [8, 57],
    [10, 59], [5, 60], [12, 56], [18, 56], [21, 55], [24, 59], [30, 60],
    [30, 70], [20, 70], [12, 65], [5, 58], [-2, 58], [-6, 52], [-10, 48],
  ],
  // Asia
  [
    [35, 70], [60, 70], [90, 75], [120, 73], [150, 72], [170, 68], [178, 65],
    [165, 60], [160, 55], [155, 50], [142, 45], [138, 40], [132, 38], [128, 34],
    [124, 32], [121, 28], [115, 23], [110, 20], [107, 12], [104, 9], [101, 7],
    [99, 12], [96, 16], [93, 20], [90, 22], [87, 21], [83, 18], [80, 15],
    [78, 9], [76, 10], [74, 15], [72, 20], [69, 22], [66, 25], [62, 25],
    [58, 26], [55, 26], [52, 27], [50, 29], [48, 30], [45, 29], [42, 31],
    [39, 33], [36, 36], [34, 36], [30, 36], [28, 40], [30, 45], [32, 55], [35, 65],
  ],
  // Australia
  [
    [113, -22], [114, -30], [115, -35], [120, -34], [124, -33], [129, -32],
    [132, -32], [135, -35], [138, -35], [140, -38], [145, -38], [150, -37],
    [153, -32], [153, -27], [150, -22], [146, -19], [142, -15], [142, -11],
    [137, -12], [135, -15], [132, -12], [130, -13], [126, -14], [122, -17], [118, -20],
  ],
];

type Pin = { n: number; lon: number; lat: number; label: string };
const PINS: Pin[] = [
  { n: 1, lon: 174.8, lat: -41.3, label: "Wellington" },
  { n: 2, lon: 139.7, lat: 35.7, label: "Tokyo" },
  { n: 3, lon: -74.0, lat: 40.7, label: "New York" },
  { n: 4, lon: 127.0, lat: 37.5, label: "Seoul" },
  { n: 5, lon: 127.4, lat: 38.3, label: "DMZ" },
  { n: 6, lon: 149.1, lat: -35.3, label: "Canberra" },
  { n: 7, lon: 73.1, lat: 33.7, label: "Islamabad" },
  { n: 8, lon: 103.8, lat: 1.35, label: "Singapore" },
  { n: 9, lon: 51.5, lat: 25.5, label: "Lusail" },
  { n: 10, lon: 77.2, lat: 28.6, label: "Delhi" },
  { n: 11, lon: 78.5, lat: 17.4, label: "Hyderabad" },
  { n: 12, lon: 92.0, lat: 24.8, label: "Assam" },
  { n: 13, lon: 80.3, lat: 13.1, label: "Chennai" },
];

function drawMapAndTimeline(): void {
  const y0 = 654;
  const mapX = MX;
  const mapW = 620;
  const mapH = 92;
  const tlX = MX + mapW + 14;
  const tlW = W - MX - tlX;
  drawText("WHERE IT HAPPENED — 13 PLACES", mapX, y0 + 11, "sansBold", 10, INK, { tracking: 1.5 });
  drawText("AROUND THE DAY — UTC", tlX, y0 + 11, "sansBold", 10, INK, { tracking: 1.5 });
  hLine(mapX, y0 + 17, mapW, RULE, 1);
  hLine(tlX, y0 + 17, tlW, RULE, 1);
  // Map panel.
  const my = y0 + 22;
  fillRect(mapX, my, mapW, mapH, [239, 232, 210]);
  strokeRect(mapX, my, mapW, mapH, HAIR, 1);
  const lonToX = (lon: number): number => mapX + ((lon + 170) / 360) * mapW;
  const latToY = (lat: number): number => my + ((72 - lat) / 122) * mapH;
  for (const cont of CONTINENTS) {
    fillPoly(
      cont.map(([lon, lat]) => [lonToX(lon), latToY(lat)] as [number, number]),
      [210, 198, 166],
    );
  }
  // New Zealand dots + Japan chain.
  fillCircle(lonToX(167), latToY(-41), 2.5, [210, 198, 166]);
  fillCircle(lonToX(172), latToY(-41.5), 2, [210, 198, 166]);
  drawLine(lonToX(130), latToY(31), lonToX(145), latToY(44), 3, [210, 198, 166]);
  // Pins.
  for (const pin of PINS) {
    const px = lonToX(pin.lon);
    const py = latToY(pin.lat);
    fillCircle(px, py, 7, RED);
    fillCircle(px, py, 7, RED);
    drawText(String(pin.n), px, py + 3.5, "sansBold", 8, [255, 255, 255], { align: "center" });
  }
  // Timeline (right column).
  const times: [string, string][] = [
    ["01:00", "NZ official count released"],
    ["13:30", "Qatar GP Practice 1, Lusail"],
    ["17:00", "Qatar GP Practice 2"],
    ["18:00", "US markets shut early"],
    ["19:00", "Macy's balloons re-inflated"],
    ["23:00", "These 36 stories filed"],
  ];
  let ty = y0 + 36;
  for (const [t, label] of times) {
    drawText(t, tlX, ty, "sansBold", 10.5, RED);
    drawText(label, tlX + 46, ty, "serif", 10.5, INK);
    ty += 14;
  }
  drawText(
    "All times UTC. Friday 27 November 2026.",
    tlX, ty + 2, "serifItalic", 10, SOFT,
  );
  hLine(MX, y0 + 130, CW, HAIR, 1);
}

// ----------------------------------------------------------- one-liners

const ONE_LINERS: string[] = [
  "Comancheros: about $12m in assets seized",
  "All Blacks face England in the Nations final",
  "Powerball jackpot reaches $150 million",
  "Kmart NZ profit up 15.1% to $117.5 million",
  "National returns a donor's gift after a report",
  "Vantara signs a 10-year pact with Madagascar",
  "Missing border guard's body found in Assam river",
  "Hyderabad airport storage capacity up 140%",
  "Kashmir clerics split over Vande Mataram",
  "Delhi's coldest morning of the season so far",
  "Delhi court voids a foreign-funding licence ban",
  "Tamil Nadu to sign 70 deals worth ₹50,000 crore",
  "Congress to march in 'Samvidhan Raksha' rallies",
  "Jail for a repeat mosque-fire offender in Singapore",
  "Singapore opens an underground ageing centre",
  "Katong pedestrian mall design contest opens",
  "13 unlicensed riders caught at Tuas checkpoint",
  "Balestier Market makeover is unveiled",
  "HealthHub app gets an upgrade",
  "korban refunds 32 of 123 claims",
  "Auxiliary officer jailed over Changi bus crash",
  "EU leaders skip Friday talks; budget deal slips",
  "US markets reopen for a shortened session",
];

function drawOneLiners(): void {
  const y0 = 780;
  drawText("AND IN BRIEF — 23 MORE", MX, y0 + 11, "sansBold", 10, INK, { tracking: 1.5 });
  drawText("14 — 36", MX + CW, y0 + 11, "sansBold", 10, FAINT, { align: "right", tracking: 1 });
  hLine(MX, y0 + 17, CW, RULE, 1);
  const colW = 316;
  const gap = 12;
  const rows = 8;
  const rowH = 14.5;
  const gridY = y0 + 30;
  ONE_LINERS.forEach((line, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = MX + col * (colW + gap);
    const y = gridY + row * rowH;
    const num = i + 14;
    drawText(String(num) + ".", x, y, "sansBold", 9.5, RED);
    const numW = textWidth(String(num) + ". ", "sansBold", 9.5);
    drawFitLine(line, x + numW, y, "serif", 10.5, 9.5, colW - numW, INK);
  });
  hLine(MX, gridY + rows * rowH + 6, CW, HAIR, 1);
}

// ------------------------------------------------------------ date check

const DATE_CHECK: string[] = [
  "Kuwait drone attack kills 2 Italians — 26 Nov",
  "Gukesh–Sindarov Game 3 drawn in 60 moves — 26 Nov",
  "Gaza strikes kill 9–10, incl. a Hamas minister — 26 Nov",
  "UK net migration 77,000, lowest since 1997 — 26 Nov",
  "Ebola in Congo: 12,021 cases, 5,904 deaths — 26 Nov",
  "Nepal declares ~4,000 flood-missing dead — 26 Nov",
  "Ibiza tanker Med Emre: 7,000 t diesel, 1 dead — 26 Nov",
  "Trump demands probe into 'fake' GDP figures — 26 Nov",
  "Depardieu to stand trial over 2018 rape claim — 26 Nov",
  "Bangkok refinery blast injures 9 — 26 Nov",
];

function drawDateCheck(): void {
  const y0 = 938;
  const h = 74;
  fillRect(MX, y0, CW, h, [249, 236, 232]);
  strokeRect(MX, y0, CW, h, RED, 2);
  drawText("DATE CHECK — THESE ARE NOT 27 NOVEMBER", MX + 10, y0 + 13, "sansBold", 11, RED, { tracking: 1 });
  const colW = (CW - 20) / 2;
  DATE_CHECK.forEach((item, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MX + 10 + col * colW;
    drawText("× " + item, x, y0 + 26 + row * 10.5, "serif", 9.5, SOFT);
  });
}

// ---------------------------------------------------------------- footer

function drawFooter(): void {
  const y = 1020;
  drawText(
    "SOURCES: REUTERS • NZ HERALD • THE HINDU • SYDNEY MORNING HERALD • STRAITS TIMES • KOREA JOONGANG DAILY • AJU PRESS • CNN • FORMULA1.COM • MINT • HINDUSTAN TIMES • TIMES OF INDIA",
    W / 2, y, "sansBold", 8.5, SOFT, { align: "center" },
  );
}

// ------------------------------------------------------------ glyph test
// MAKEFUN_GLYPH_TEST=1 renders a font test sheet instead of the page.

function renderGlyphTest(): void {
  fillAll(PAPER);
  let y = 40;
  drawText("GLYPH TEST — read every letter", 26, y, "sansBold", 14, INK);
  y += 34;
  const samples = ["ABCDEFGHIJKLM", "NOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", "0123456789"];
  for (const font of ["display", "serif", "serifBold", "serifItalic", "sansBold"]) {
    drawText(font, 26, y, "sansBold", 10, RED);
    y += 4;
    for (const s of samples) {
      drawText(s, 26, y + 12, font, 12, INK);
      y += 16;
    }
    y += 8;
  }
  drawText("SMALL SERIF 9.5px — the known F defect:", 26, y + 12, "sansBold", 10, RED);
  drawText("FRIDAY Formula FIFA OFFICIAL F", 26, y + 28, "serif", 9.5, INK);
  drawText("AgRy17 Ff — ‘ ’ “ ” • ° × ₹", 26, y + 44, "serif", 9.5, INK);
  drawText("FRIDAY Formula FIFA OFFICIAL F", 26, y + 60, "sansBold", 9.5, INK);
  drawText("AgRy17 Ff — ‘ ’ “ ” • ° × ₹", 26, y + 76, "sansBold", 9.5, INK);
  drawText("THE WORLD TODAY", 26, y + 116, "display", 47, INK);
  drawText("New Zealand counts 400,000 special votes, Tokyo prices quicken.", 26, y + 140, "serifItalic", 15.5, SOFT);
}

// ----------------------------------------------------------------- main

function renderPage(): void {
  fillAll(PAPER);
  drawMasthead();
  drawHeroes();
  drawMediums();
  drawMapAndTimeline();
  drawOneLiners();
  drawDateCheck();
  drawFooter();
}

function main(): void {
  const glyphPath = new URL("./glyphs.bin", import.meta.url);
  FONTS = loadGlyphs(readFileSync(glyphPath));
  if (process.env.MAKEFUN_GLYPH_TEST === "1") renderGlyphTest();
  else renderPage();
  const png = encodePNG(W, H, canvas);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "entry.png"), png);
}

main();
