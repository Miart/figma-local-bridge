// The image codec and the diff, against fixtures that the code under test did
// NOT produce:
//
//  - the PNG fixture was written by hand with one filter type per scanline
//    (0,1,2,3,4,0,1,2,...), then read back by PIL, which had to reproduce the
//    source pixels exactly — so the bytes fed to decodePng below are known-good
//    to an independent decoder, and every unfilter path is exercised;
//  - the RGBA fixture is PIL's own answer for those bytes;
//  - a second set of tiny fixtures, also from PIL, covers every colour type a
//    PNG can arrive in (greyscale, RGB, greyscale+alpha, palette with tRNS) and
//    every legal sample depth (1, 2, 4 and 8 bits); the expected RGBA is PIL's
//    own conversion of each one, which is where the sample scaling shows up;
//  - the encoder was cross-checked the other way when it was written: PIL
//    decoded its output pixel-identical.
//
// CRCs are recomputed here with an independent (table-free) implementation:
// decodePng deliberately ignores them — a wrong CRC is no reason to refuse to
// diff a picture — so nothing else would catch a CRC bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { decodePng, encodePng, diffImages, heatmapPng } from "../server/dist/compare.js";

const FIXTURE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAB8ElEQVR42s2Tf2jMYRzHP+dE59b8qHGSdbtNNDaGzC6aNvuWuIZ6apkU05aSP7RCkZP9YbqSkFpZK/nDR0mR0tGasDU/cl8/E7Wm6EJqmfbPevke++Om4+5bUz716nk+z9Pzeff07i0igl+8zJYpFImPJZJHpUynRmYRkQIaJECTzGOfFHJIimiTEk7JQjqklEtSxjVZRlxW8EBWkZAqeStrrI9SHRuSGntU6gKeqTPnpwRkgvA4WOlMcgTkX+LND4WjPt8MmSCOORSnaP+1Xpz8U8n53u/0tg1L5hodY3zdO7x83Hv/2CrF5jTl5ixV5jzrTQf15gLbTBeFfQddkTS9fDP9gnlsTTNPYwXmmR00LwOe0uarGU2+sysubsru3OvOZLf1R5ODkeMZTX4d7HEl0JoclPY0k33ZTG5KuMtAao4/wxyxNMQWXcB2XUSLLma/lnNEKzihKzmjlXRqWC7rWrmh66Rba6VfLV7oBgZ0E5+0nu+6FY8a8rSBOdooId1hlenO2GrdbddqS8ATiVeTQzrTe/6vJFcc2BjNIZ3pfTSXJGc1OQ2y3P8V2cN1WrnJUW5xktuco5su7nKF+85pHz085BFPeEWCQZ7zxdmN8AYv78hngLm8p4QPLCVJmM9Sx1drM0OxRobtZkYCPwCBKBbNzTxptQAAAABJRU5ErkJggg==", "base64");
const FIXTURE_RGBA = Buffer.from("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", "base64");
const W = 24;
const H = 16;

/** PIL-written PNGs, one per colour type, with PIL's own RGBA conversion. */
const COLOUR_TYPES = {
  gray8: { png: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAAAAADbboAnAAAAEklEQVR4nGNk4IUAJnYoIIYBACuBAX96q80oAAAAAElFTkSuQmCC", rgba: "AAAA/w0NDf8aGhr/Jycn/zQ0NP9BQUH/Tk5O/1tbW/8HBwf/FBQU/yEhIf8uLi7/Ozs7/0hISP9VVVX/YmJi/w4ODv8bGxv/KCgo/zU1Nf9CQkL/T09P/1xcXP9paWn/FRUV/yIiIv8vLy//PDw8/0lJSf9WVlb/Y2Nj/3BwcP8cHBz/KSkp/zY2Nv9DQ0P/UFBQ/11dXf9qamr/d3d3/yMjI/8wMDD/PT09/0pKSv9XV1f/ZGRk/3Fxcf9+fn7/", depth: 8, color: 0 },
  rgb: { png: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAG0lEQVR4nGNkYGDgZmDGRCwM4qwMDMyYiB4SAHu/AW3W+JFaAAAAAElFTkSuQmCC", rgba: "AAAA/wsAA/8WAAb/IQAJ/ywADP83AA//QgAS/00AFf8AFwX/CxcI/xYXC/8hFw7/LBcR/zcXFP9CFxf/TRca/wAuCv8LLg3/Fi4Q/yEuE/8sLhb/Ny4Z/0IuHP9NLh//AEUP/wtFEv8WRRX/IUUY/yxFG/83RR7/QkUh/01FJP8AXBT/C1wX/xZcGv8hXB3/LFwg/zdcI/9CXCb/TVwp/wBzGf8Lcxz/FnMf/yFzIv8scyX/N3Mo/0JzK/9Ncy7/", depth: 8, color: 2 },
  grayalpha: { png: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAQAAABUDBdwAAAAFUlEQVR4nGNkYJAVQoZMDEKokBoCAO/xBCUUyCGMAAAAAElFTkSuQmCC", rgba: "AAAAAB0dHRI6OjokV1dXNnR0dEiRkZFarq6ubMvLy34AAAASHR0dJDo6OjZXV1dIdHR0WpGRkWyurq5+y8vLkAAAACQdHR02Ojo6SFdXV1p0dHRskZGRfq6urpDLy8uiAAAANh0dHUg6OjpaV1dXbHR0dH6RkZGQrq6uosvLy7QAAABIHR0dWjo6OmxXV1d+dHR0kJGRkaKurq60y8vLxgAAAFodHR1sOjo6fldXV5B0dHSikZGRtK6ursbLy8vY", depth: 8, color: 4 },
  bilevel: { png: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGAQAAAADWfuJWAAAADklEQVR4nGMIZQplgGIADCQCBf3Jo2YAAAAASUVORK5CYII=", rgba: "AAAA//////8AAAD//////wAAAP//////AAAA////////////AAAA//////8AAAD//////wAAAP//////AAAA/wAAAP//////AAAA//////8AAAD//////wAAAP///////////wAAAP//////AAAA//////8AAAD//////wAAAP8AAAD//////wAAAP//////AAAA//////8AAAD///////////8AAAD//////wAAAP//////AAAA//////8AAAD/", depth: 1, color: 0 },
  palette4: { png: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGBAMAAAAMK8LIAAAAMFBMVEUAAAAQIQcgQg4wYxVAhBxQpSNgxipw5zGACDiQKT+gSkawa03AjFTQrVvgzmLw72n2RxINAAAAEHRSTlP/yJZkMhkKAP//////////9Qmr1AAAACZJREFUeJxjYFR2TWcQMgmrYFB2Te9kMAmrmMXgmt65miGsYtYeAGnICN05JuODAAAAAElFTkSuQmCC", rgba: "AAAA/xAhB8ggQg6WMGMVZECEHDJQpSMZYMYqCnDnMQAQIQfIIEIOljBjFWRAhBwyUKUjGWDGKgpw5zEAgAg4/yBCDpYwYxVkQIQcMlClIxlgxioKcOcxAIAIOP+QKT//MGMVZECEHDJQpSMZYMYqCnDnMQCACDj/kCk//6BKRv9AhBwyUKUjGWDGKgpw5zEAgAg4/5ApP/+gSkb/sGtN/1ClIxlgxioKcOcxAIAIOP+QKT//oEpG/7BrTf/AjFT/", depth: 4, color: 3 },
  palette2: { png: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGAgMAAACDazdoAAAADFBMVEUKFB7I0twAAAD/gABWycxDAAAAF0lEQVR4nGNgXc8Q9YFhPSvDhygGMBsAMpkF+7HMMykAAAAASUVORK5CYII=", rgba: "ChQe/woUHv/I0tz/yNLc/wAAAP8AAAD//4AA//+AAP/I0tz/yNLc/wAAAP8AAAD//4AA//+AAP8KFB7/ChQe/wAAAP8AAAD//4AA//+AAP8KFB7/ChQe/8jS3P/I0tz//4AA//+AAP8KFB7/ChQe/8jS3P/I0tz/AAAA/wAAAP8KFB7/ChQe/8jS3P/I0tz/AAAA/wAAAP//gAD//4AA/8jS3P/I0tz/AAAA/wAAAP//gAD//4AA/woUHv8KFB7/", depth: 2, color: 3 },
};

// ------------------------------------------------------------------ fixtures

function bitmap(width, height, fill = [0, 0, 0, 255]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set(fill, i * 4);
  return { width, height, rgba };
}

function setPx(bmp, x, y, [r, g, b, a]) {
  bmp.rgba.set([r, g, b, a], (y * bmp.width + x) * 4);
}

function idatOf(png) {
  const parts = [];
  for (let off = 8; off + 12 <= png.length; ) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    if (type === "IDAT") parts.push(png.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  return Buffer.concat(parts);
}

/** Patch one byte inside IHDR and re-seal the chunk, to build broken inputs. */
function patchIhdr(png, byteInIhdr, value) {
  const out = Buffer.from(png);
  const ihdr = 8; // IHDR is always the first chunk
  out[ihdr + 8 + byteInIhdr] = value;
  const body = out.subarray(ihdr + 4, ihdr + 8 + 13);
  out.writeUInt32BE(crc32(body), ihdr + 8 + 13);
  return out;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------- decoding

test("the decoder reproduces an independent decoder's pixels exactly", () => {
  const bmp = decodePng(FIXTURE_PNG);
  assert.equal(bmp.width, W);
  assert.equal(bmp.height, H);
  assert.ok(Buffer.from(bmp.rgba).equals(FIXTURE_RGBA), "decoded pixels differ from PIL's");
});

test("the fixture really does carry all five filter types", () => {
  const flat = inflateSync(idatOf(FIXTURE_PNG));
  const stride = W * 4;
  const used = new Set();
  for (let y = 0; y < H; y++) used.add(flat[y * (stride + 1)]);
  assert.deepEqual([...used].sort(), [0, 1, 2, 3, 4]);
});

test("every colour type a PNG can arrive in widens to RGBA the way PIL says", () => {
  for (const [name, f] of Object.entries(COLOUR_TYPES)) {
    const bmp = decodePng(Buffer.from(f.png, "base64"));
    assert.deepEqual([bmp.width, bmp.height], [8, 6], `${name}: size`);
    assert.ok(Buffer.from(bmp.rgba).equals(Buffer.from(f.rgba, "base64")), `${name}: RGBA differs from PIL`);
  }
});

test("the colour-type fixtures really do cover every legal sample depth", () => {
  const depths = [...new Set(Object.values(COLOUR_TYPES).map((f) => f.depth))].sort();
  assert.deepEqual(depths, [1, 2, 4, 8]);
});

test("a non-PNG fails loudly instead of being diffed as garbage", () => {
  assert.throws(() => decodePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), /not a PNG/);
});

test("a bit depth the decoder does not read, and an interlaced file, are refused", () => {
  // 8 -> 16 bits: legal PNG, nothing Figma produces, and not something this
  // codec pretends to understand.
  assert.throws(() => decodePng(patchIhdr(FIXTURE_PNG, 8, 16)), /bit depth 16/);
  assert.throws(() => decodePng(patchIhdr(FIXTURE_PNG, 12, 1)), /interlaced/);
});

// ------------------------------------------------------------------- encoding

test("every chunk the encoder writes carries a correct CRC", () => {
  const png = encodePng(decodePng(FIXTURE_PNG));
  const types = [];
  for (let off = 8; off + 12 <= png.length; ) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    assert.equal(png.readUInt32BE(off + 8 + len), crc32(png.subarray(off + 4, off + 8 + len)), `CRC of ${type}`);
    types.push(type);
    off += 12 + len;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
});

test("a round trip through our own codec is byte for byte", () => {
  const again = decodePng(encodePng(decodePng(FIXTURE_PNG)));
  assert.ok(Buffer.from(again.rgba).equals(FIXTURE_RGBA));
});

// -------------------------------------------------------------------- diffing

test("tolerance decides what counts as different, and the boundary is inclusive", () => {
  const a = bitmap(2, 1, [100, 100, 100, 255]);
  const b = bitmap(2, 1, [100, 100, 100, 255]);
  setPx(b, 0, 0, [108, 100, 100, 255]); // delta 8
  setPx(b, 1, 0, [109, 100, 100, 255]); // delta 9

  assert.equal(diffImages(a, b, 8).different, 1, "delta == tolerance must still be equal");
  assert.equal(diffImages(a, b, 10).different, 0);
  assert.equal(diffImages(a, b, 0).different, 2);
});

test("invisible pixels are equal whatever their colour; visible ones are not", () => {
  const a = bitmap(2, 1, [0, 0, 0, 0]);
  const b = bitmap(2, 1, [0, 0, 0, 0]);
  setPx(b, 0, 0, [255, 0, 255, 0]); // garbage RGB under zero alpha
  setPx(b, 1, 0, [0, 0, 0, 255]); // now actually visible

  const r = diffImages(a, b, 8);
  assert.equal(r.different, 1);
  assert.deepEqual(r.bbox, [1, 0, 1, 1]);
});

test("a size mismatch is a finding: the extra area counts as different", () => {
  const a = bitmap(4, 2, [10, 20, 30, 255]);
  const b = bitmap(6, 3, [10, 20, 30, 255]);

  const r = diffImages(a, b, 8);
  assert.equal(r.sizeMismatch, true);
  assert.deepEqual(r.reference, [4, 2]);
  assert.deepEqual(r.render, [6, 3]);
  assert.deepEqual(r.compared, { width: 6, height: 3 });
  assert.equal(r.total, 18);
  assert.equal(r.different, 10, "the 4x2 overlap is identical, the rest is not");
  assert.deepEqual(r.bbox, [0, 0, 6, 3], "the band and the column are one bounding box");
});

test("transparent padding in a taller export is not a difference", () => {
  const a = bitmap(2, 2, [50, 60, 70, 255]);
  const b = bitmap(2, 3, [50, 60, 70, 255]);
  for (let x = 0; x < 2; x++) setPx(b, x, 2, [255, 255, 255, 0]);

  const r = diffImages(a, b, 8);
  assert.equal(r.sizeMismatch, true);
  assert.equal(r.different, 0);
  assert.equal(r.identical, true);
  assert.equal(r.bbox, null);
  assert.equal(r.maxDelta, 0);
});

test("separated differences are separate clusters, biggest first", () => {
  const a = bitmap(40, 20);
  const b = bitmap(40, 20);
  for (let x = 1; x <= 3; x++) for (let y = 1; y <= 3; y++) setPx(b, x, y, [255, 255, 255, 255]);
  for (let x = 30; x <= 31; x++) setPx(b, x, 15, [255, 255, 255, 255]);

  const r = diffImages(a, b, 8);
  assert.equal(r.different, 11);
  assert.equal(r.clustersTotal, 2);
  assert.deepEqual(r.clusters[0], { x: 1, y: 1, width: 3, height: 3, pixels: 9 });
  assert.deepEqual(r.clusters[1], { x: 30, y: 15, width: 2, height: 1, pixels: 2 });
  assert.deepEqual(r.bbox, [1, 1, 31, 15]);
  assert.equal(r.maxDelta, 255);
  assert.equal(r.meanDelta, 255);
});

// -------------------------------------------------------------------- heatmap

test("the heatmap shows differences in red, the rest dimmed, and the bbox outlined", () => {
  const a = bitmap(20, 10, [200, 200, 200, 255]);
  const b = bitmap(20, 10, [200, 200, 200, 255]);
  for (let x = 4; x <= 6; x++) for (let y = 4; y <= 6; y++) setPx(b, x, y, [0, 0, 0, 255]);

  const heat = decodePng(heatmapPng(a, b, 8));
  const at = (x, y) => [...heat.rgba.subarray((y * heat.width + x) * 4, (y * heat.width + x) * 4 + 4)];
  assert.deepEqual([heat.width, heat.height], [20, 10]);

  const centre = at(5, 5);
  assert.ok(centre[0] > centre[1] + 100, `the differing pixel should be red, got ${centre}`);

  const corner = at(4, 4);
  assert.deepEqual(corner, [255, 214, 74, 255], "the bounding box should be outlined");

  const backdrop = at(0, 0);
  assert.equal(backdrop[0], backdrop[1]);
  assert.equal(backdrop[1], backdrop[2]);
  assert.ok(backdrop[0] > 50 && backdrop[0] < 70, `the backdrop should be a dimmed grey, got ${backdrop}`);
});

test("two identical images produce an empty report and a heatmap with no red", () => {
  const a = bitmap(8, 4, [12, 34, 56, 255]);
  const b = bitmap(8, 4, [12, 34, 56, 255]);

  const r = diffImages(a, b, 8);
  assert.equal(r.identical, true);
  assert.equal(r.different, 0);
  assert.equal(r.ratio, 0);
  assert.equal(r.bbox, null);
  assert.deepEqual(r.clusters, []);
  assert.equal(r.clustersTotal, 0);

  const heat = decodePng(heatmapPng(a, b, 8));
  for (let i = 0; i < heat.width * heat.height; i++) {
    assert.ok(heat.rgba[i * 4] === heat.rgba[i * 4 + 1], "no pixel should be tinted red");
  }
});
