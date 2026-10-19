import { deflateSync, inflateSync } from "node:zlib";

/**
 * Image diff for "did what I built land where I meant".
 *
 * This runs in the MCP server and never in Figma: the bridge can already render
 * a node to PNG, so a comparison cannot touch the document it is checking. The
 * codec is hand-rolled on zlib on purpose — the repo ships no image stack, and a
 * native dependency for one diff would be a larger thing than the bridge.
 *
 * Three things the report stays honest about:
 *
 * 1. Anti-aliasing and font rasterisation differ by a hair between two renders
 *    of the same node, so a per-channel tolerance (default 8/255) decides what
 *    counts as different — and every number is reported at that tolerance.
 *
 * 2. A size mismatch is a finding, not an error. The extra area counts as
 *    different, and both sizes are reported, because "the render is 40px wider
 *    than the mockup" is usually the answer the caller is looking for.
 *
 * 3. "3.4% different" is useless without places. The report carries the bounding
 *    box and the largest clusters of differing pixels, so a rebuild can be
 *    corrected instead of merely regretted.
 *
 * Not supported, and loud about it: interlaced PNGs, 16-bit samples, indexed
 * images without PLTE. Everything else a PNG can legally be — grey, RGB,
 * grey+alpha, RGBA, palette, at 1, 2, 4 or 8 bits per sample — is read and
 * widened to RGBA the way the spec's sample scaling asks. tRNS is honoured for
 * palette entries; a grey/RGB colour key is not (it has not turned up yet).
 */

export interface Bitmap {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
  rgba: Uint8Array;
}

/** Differing-pixel clusters are found on this block grid, then measured exactly. */
const CLUSTER_BLOCK = 8;
/** Beyond this many clusters the report is noise; the bbox still covers them all. */
const CLUSTER_MAX = 12;

// ------------------------------------------------------------------ decoding

/**
 * Pixel size from a PNG's IHDR — the header only, no decode. Used where a file
 * that was just written has to be checked against a manifest: a full decode of a
 * 4096×4096 sheet would allocate 64 MB to answer a question about 8 bytes.
 */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

export function decodePng(buf: Buffer): Bitmap {
  if (buf.length < 16 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error("not a PNG file (bad signature)");
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let alpha: Buffer | null = null;
  const parts: Buffer[] = [];

  while (off + 8 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + length);
    off += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") alpha = Buffer.from(data);
    else if (type === "IDAT") parts.push(Buffer.from(data));
    else if (type === "IEND") break;
  }

  if (!width || !height) throw new Error("PNG has no IHDR");
  if (interlace) throw new Error("interlaced PNG is not supported");
  if (depth !== 1 && depth !== 2 && depth !== 4 && depth !== 8) {
    throw new Error(`unsupported PNG bit depth ${depth} (1, 2, 4 or 8 only)`);
  }
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${color}`);
  if (color === 3 && !palette) throw new Error("indexed PNG without a PLTE chunk");

  const raw = inflateSync(Buffer.concat(parts));
  // Filters work on bytes, not samples: bpp is the byte width of a pixel and is
  // never below 1, which is what makes a 1-bit row filter against a bit offset.
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  if (raw.length < (stride + 1) * height) throw new Error("PNG data is truncated");

  // Unfilter in place: each scanline starts with its filter type byte.
  const flat = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = flat.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? flat.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      cur[i] = v & 0xff;
    }
  }

  // Widen to RGBA so everything downstream has one shape to reason about.
  // Samples below 8 bits are unpacked and scaled the way the PNG spec asks:
  // grey 1/2/4-bit values spread over 0..255 (1 -> 0 and 255, 2 -> 0/85/170/255),
  // while palette entries stay indices and are never scaled.
  const rgba = new Uint8Array(width * height * 4);
  const max = (1 << depth) - 1;
  const scale = (v: number) => (max === 255 ? v : Math.round((v * 255) / max));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      const s = [0, 0, 0, max];
      if (depth === 8) {
        const at = row + x * bpp;
        for (let c = 0; c < channels; c++) s[c] = flat[at + c];
      } else {
        const bit = x * depth;
        s[0] = (flat[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
      }
      if (color === 0) {
        const g = scale(s[0]);
        rgba[dst] = g; rgba[dst + 1] = g; rgba[dst + 2] = g; rgba[dst + 3] = 255;
      } else if (color === 2) {
        rgba[dst] = s[0]; rgba[dst + 1] = s[1]; rgba[dst + 2] = s[2]; rgba[dst + 3] = 255;
      } else if (color === 3) {
        const p = s[0] * 3;
        rgba[dst] = palette![p]; rgba[dst + 1] = palette![p + 1]; rgba[dst + 2] = palette![p + 2];
        rgba[dst + 3] = alpha && s[0] < alpha.length ? alpha[s[0]] : 255;
      } else if (color === 4) {
        const g = s[0];
        rgba[dst] = g; rgba[dst + 1] = g; rgba[dst + 2] = g; rgba[dst + 3] = s[1];
      } else {
        rgba[dst] = s[0]; rgba[dst + 1] = s[1]; rgba[dst + 2] = s[2]; rgba[dst + 3] = s[3];
      }
    }
  }
  return { width, height, rgba };
}

// ------------------------------------------------------------------ encoding

export function encodePng(bmp: Bitmap): Buffer {
  const { width, height, rgba } = bmp;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter 0: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

let crcTable: Int32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// -------------------------------------------------------------------- diffing

export interface CompareCluster {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Differing pixels inside this cluster's bounding box. */
  pixels: number;
}

export interface CompareReport {
  tolerance: number;
  reference: [number, number];
  render: [number, number];
  sizeMismatch: boolean;
  /** The union of both images — the area every number below is out of. */
  compared: { width: number; height: number };
  different: number;
  total: number;
  /** different / total, 0..1. */
  ratio: number;
  /** Largest per-channel delta seen, 0..255. */
  maxDelta: number;
  /** Mean delta over the differing pixels only — the size of the differences. */
  meanDelta: number;
  /** [x, y, width, height] of everything that differs, or null when identical. */
  bbox: [number, number, number, number] | null;
  clusters: CompareCluster[];
  clustersTotal: number;
  identical: boolean;
}

/**
 * Compare two images at `tolerance`, out of the union of their sizes.
 *
 * `reference` is the expected picture and `render` the produced one; the order
 * only matters for the heatmap, not for the numbers.
 */
export function diffImages(reference: Bitmap, render: Bitmap, tolerance = 8): CompareReport {
  const width = Math.max(reference.width, render.width);
  const height = Math.max(reference.height, render.height);
  const gridW = Math.ceil(width / CLUSTER_BLOCK);
  const gridH = Math.ceil(height / CLUSTER_BLOCK);
  const blocks = new Uint32Array(gridW * gridH);
  const blockBox = new Int32Array(gridW * gridH * 4); // x0, y0, x1, y1
  blockBox.fill(-1);

  let different = 0;
  let maxDelta = 0;
  let sumDelta = 0;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -1;
  let by1 = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const delta = pixelDelta(reference, render, x, y);
      if (delta <= tolerance) continue;
      different++;
      sumDelta += delta;
      if (delta > maxDelta) maxDelta = delta;
      if (x < bx0) bx0 = x;
      if (y < by0) by0 = y;
      if (x > bx1) bx1 = x;
      if (y > by1) by1 = y;
      const block = Math.floor(y / CLUSTER_BLOCK) * gridW + Math.floor(x / CLUSTER_BLOCK);
      blocks[block] += 1;
      const b = block * 4;
      if (blockBox[b] < 0 || x < blockBox[b]) blockBox[b] = x;
      if (blockBox[b + 1] < 0 || y < blockBox[b + 1]) blockBox[b + 1] = y;
      if (x > blockBox[b + 2]) blockBox[b + 2] = x;
      if (y > blockBox[b + 3]) blockBox[b + 3] = y;
    }
  }

  const { clusters, total: clustersTotal } = clustersOf(blocks, blockBox, gridW, gridH);
  return {
    tolerance,
    reference: [reference.width, reference.height],
    render: [render.width, render.height],
    sizeMismatch: reference.width !== render.width || reference.height !== render.height,
    compared: { width, height },
    different,
    total: width * height,
    ratio: width * height ? different / (width * height) : 0,
    maxDelta,
    meanDelta: different ? sumDelta / different : 0,
    bbox: different ? [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1] : null,
    clusters,
    clustersTotal,
    identical: different === 0,
  };
}

/**
 * One pixel's difference, 0..255.
 *
 * Two invisible pixels are equal whatever their colour channels say: exports
 * carry garbage RGB under a zero alpha, and reporting that as a difference would
 * drown the real one. Everything else is the largest channel delta, alpha
 * included — a shape drawn at 50% where the mockup has it solid is a difference.
 */
function pixelDelta(a: Bitmap, b: Bitmap, x: number, y: number): number {
  const inA = x < a.width && y < a.height;
  const inB = x < b.width && y < b.height;
  if (!inA || !inB) {
    // Only one image covers this pixel: a difference, unless that pixel is
    // invisible anyway (a taller-than-needed export has transparent padding).
    const at = inA ? a : b;
    const alpha = at.rgba[(y * at.width + x) * 4 + 3];
    return alpha <= 8 ? 0 : 255;
  }
  const ia = (y * a.width + x) * 4;
  const ib = (y * b.width + x) * 4;
  const aAlpha = a.rgba[ia + 3];
  const bAlpha = b.rgba[ib + 3];
  if (aAlpha <= 8 && bAlpha <= 8) return 0;
  const dr = Math.abs(a.rgba[ia] - b.rgba[ib]);
  const dg = Math.abs(a.rgba[ia + 1] - b.rgba[ib + 1]);
  const db = Math.abs(a.rgba[ia + 2] - b.rgba[ib + 2]);
  const da = Math.abs(aAlpha - bAlpha);
  return Math.max(dr, dg, db, da);
}

/** Group adjacent differing blocks into clusters, biggest first. */
function clustersOf(
  blocks: Uint32Array,
  blockBox: Int32Array,
  gridW: number,
  gridH: number,
): { clusters: CompareCluster[]; total: number } {
  const seen = new Uint8Array(blocks.length);
  const found: CompareCluster[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i] || seen[i]) continue;
    // Flood fill over 4-connected blocks: one visual difference, one cluster.
    const queue = [i];
    seen[i] = 1;
    let pixels = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    while (queue.length) {
      const at = queue.pop()!;
      pixels += blocks[at];
      x0 = Math.min(x0, blockBox[at * 4]);
      y0 = Math.min(y0, blockBox[at * 4 + 1]);
      x1 = Math.max(x1, blockBox[at * 4 + 2]);
      y1 = Math.max(y1, blockBox[at * 4 + 3]);
      const bx = at % gridW;
      const by = Math.floor(at / gridW);
      const neighbours = [
        bx > 0 ? at - 1 : -1,
        bx < gridW - 1 ? at + 1 : -1,
        by > 0 ? at - gridW : -1,
        by < gridH - 1 ? at + gridW : -1,
      ];
      for (const n of neighbours) {
        if (n >= 0 && blocks[n] && !seen[n]) {
          seen[n] = 1;
          queue.push(n);
        }
      }
    }
    found.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels });
  }
  found.sort((a, b) => b.pixels - a.pixels);
  return { clusters: found.slice(0, CLUSTER_MAX), total: found.length };
}

/**
 * A PNG a human can read: the reference dimmed to a backdrop, differing pixels
 * in red (brighter with the size of the difference), the bounding box outlined.
 *
 * The canvas is the union of both sizes, so a render that is too wide or too
 * tall shows up as a red band rather than as a cropped surprise.
 */
export function heatmapPng(reference: Bitmap, render: Bitmap, tolerance = 8): Buffer {
  const width = Math.max(reference.width, render.width);
  const height = Math.max(reference.height, render.height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      const delta = pixelDelta(reference, render, x, y);
      if (delta > tolerance) {
        const heat = 70 + Math.round((Math.min(delta, 255) / 255) * 180);
        rgba[dst] = heat; rgba[dst + 1] = 24; rgba[dst + 2] = 24; rgba[dst + 3] = 255;
        continue;
      }
      const inA = x < reference.width && y < reference.height;
      const at = inA ? reference : render;
      const src = (y * at.width + x) * 4;
      const luma = (at.rgba[src] * 299 + at.rgba[src + 1] * 587 + at.rgba[src + 2] * 114) / 1000;
      const g = Math.round(luma * 0.32);
      rgba[dst] = g; rgba[dst + 1] = g; rgba[dst + 2] = g; rgba[dst + 3] = 255;
    }
  }
  // Outline everything that differs: "the difference is in here" at a glance.
  const report = diffImages(reference, render, tolerance);
  if (report.bbox) {
    const [bx, by, bw, bh] = report.bbox;
    for (let x = bx; x < bx + bw; x++) {
      outline(rgba, width, height, x, by);
      outline(rgba, width, height, x, by + bh - 1);
    }
    for (let y = by; y < by + bh; y++) {
      outline(rgba, width, height, bx, y);
      outline(rgba, width, height, bx + bw - 1, y);
    }
  }
  return encodePng({ width, height, rgba });
}

function outline(rgba: Uint8Array, width: number, height: number, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const at = (y * width + x) * 4;
  rgba[at] = 255; rgba[at + 1] = 214; rgba[at + 2] = 74; rgba[at + 3] = 255;
}
