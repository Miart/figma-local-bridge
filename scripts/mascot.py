#!/usr/bin/env python3
"""Draw the ASCII octopus mascot and emit it as a JS block for plugin/ui.html.

The art is drawn as a greyscale picture (soft shapes, ridges, sucker dots) and
then quantised to characters, which is what gives it the dense terminal-art
look instead of the outline doodle it used to be.  Three tentacle phases are
produced (rest / sway / droop) so the panel can animate the mascot by swapping
frames; the eyes are left out on purpose and come from ui.html, so moods can
put an expression in them.

The picture is DRAWN at 40x20 cells and SHIPPED at 20x10 (COARSE): the panel
renders the emitted grid at twice the font size, so the mascot keeps its size
on screen while every character becomes a bigger, chunkier "pixel".

Needs pillow + numpy:  python3 scripts/mascot.py
"""
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ------------------------------------------------------------------ the grid
W, H = 40, 20            # cells of the DRAWN grid = the canvas resolution
ASPECT = 0.6             # cell width / cell height (the panel font)
S = 40                   # canvas px per unit (1 unit = 1 line height)
COARSE = 2               # drawn cells per EMITTED cell: the art ships at half
                         # the resolution per axis — a quarter of the cells,
                         # each twice as wide and tall on screen (the panel
                         # doubles the font size), so the picture keeps its
                         # size and every cell becomes a chunkier "pixel"
AW, AH = W // COARSE, H // COARSE
UW = W * ASPECT
CW, CH = int(round(UW * S)), H * S

RAMP = " .:-~=+*coO8%@"

C = lambda col, row: (col * ASPECT, row)      # char coords -> units

HCX, HCY = C(20.0, 5.6)[0], 5.6               # head centre, units
HRX, HRY = 8.6 * ASPECT, 3.95

def _S(col_row):
    x, y = C(col_row[0], col_row[1])
    return ((x - C(17.0, 0)[0]) * 1.19 + HCX, (y - 4.6) * 1.21 + HCY)


ARMS = [
    # raised pair, hugging the head from behind
    ("back", [_S([15.0, 8.2]), _S([13.6, 5.8]), _S([11.8, 3.2]), _S([10.4, 1.5]), _S([11.8, 0.5])], 1.25, 0.42),
    ("back", [_S([19.0, 8.2]), _S([20.4, 5.8]), _S([22.2, 3.2]), _S([23.6, 1.5]), _S([22.2, 0.5])], 1.25, 0.42),
    # outer pair, sweeping wide, the tips hooked up
    ("front", [_S([13.0, 8.8]), _S([9.6, 9.7]), _S([5.6, 10.8]), _S([2.8, 12.4]), _S([2.4, 14.2]), _S([4.2, 15.2]), _S([6.0, 14.4])], 1.62, 0.38),
    ("front", [_S([21.0, 8.8]), _S([24.4, 9.7]), _S([28.4, 10.8]), _S([31.2, 12.4]), _S([31.6, 14.2]), _S([29.8, 15.2]), _S([28.0, 14.4])], 1.62, 0.38),
    # mid pair, an S down to the left / right
    ("front", [_S([14.6, 9.3]), _S([13.0, 11.0]), _S([10.6, 12.4]), _S([9.6, 14.4]), _S([10.6, 15.6])], 1.50, 0.38),
    ("front", [_S([19.4, 9.3]), _S([21.0, 11.0]), _S([23.4, 12.4]), _S([24.4, 14.4]), _S([23.4, 15.6])], 1.50, 0.38),
    # front pair, S curves hanging down the middle
    ("front", [_S([16.2, 9.6]), _S([17.2, 11.6]), _S([16.4, 13.6]), _S([15.4, 15.0]), _S([16.6, 15.9])], 1.44, 0.38),
    ("front", [_S([17.8, 9.6]), _S([16.8, 11.6]), _S([17.6, 13.6]), _S([18.6, 15.0]), _S([17.4, 15.9])], 1.44, 0.38),
]

# Left cell of each 2-char pupil, full grid. The sockets sit at x = 9.6 and
# 14.4 units, i.e. centred on columns 16 and 24, so a centred pair starts one
# cell earlier: 15 and 23.
EYE_COLS = (15, 23)
EYE_ROW = 6              # the row the sockets' centres (y = 6.2) fall in


# ------------------------------------------------------------------ helpers
def alpha_of(polys, blur=2.0):
    im = Image.new("L", (CW, CH), 0)
    d = ImageDraw.Draw(im)
    for p in polys:
        d.polygon([(x * S, y * S) for x, y in p], fill=255)
    im = im.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(im, dtype=np.float32) / 255.0


def put(lum, a, v):
    lum *= (1.0 - a)
    lum += v * a
    return lum


def poly_circle(cx, cy, r, ry=None):
    ry = r if ry is None else ry
    n = 64
    return [(cx + r * math.cos(t / n * 2 * math.pi), cy + ry * math.sin(t / n * 2 * math.pi)) for t in range(n)]


def catmull(pts, n=160):
    p = [pts[0]] + list(pts) + [pts[-1]]
    out = []
    segs = len(p) - 3
    for i in range(segs):
        p0, p1, p2, p3 = p[i], p[i + 1], p[i + 2], p[i + 3]
        steps = max(2, n // segs)
        for t in range(steps + 1):
            t = t / steps
            t2, t3 = t * t, t * t * t
            x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            out.append((x, y))
    return out


def resample(curve, n=160):
    d = [0.0]
    for i in range(1, len(curve)):
        d.append(d[-1] + math.hypot(curve[i][0] - curve[i - 1][0], curve[i][1] - curve[i - 1][1]))
    total = max(d[-1], 1e-6)
    out = []
    j = 0
    for i in range(n):
        target = total * i / (n - 1)
        while j < len(d) - 2 and d[j + 1] < target:
            j += 1
        span = max(d[j + 1] - d[j], 1e-6)
        t = (target - d[j]) / span
        out.append((curve[j][0] + (curve[j + 1][0] - curve[j][0]) * t,
                    curve[j][1] + (curve[j + 1][1] - curve[j][1]) * t))
    return out


def stroke_poly(curve, w0, w1, shift=0.0, power=0.85, n=160):
    pts = resample(curve, n)
    left, right = [], []
    for i, (x, y) in enumerate(pts):
        t = i / (n - 1)
        w = w0 + (w1 - w0) * (t ** power)
        if i == 0:
            dx, dy = pts[1][0] - x, pts[1][1] - y
        elif i == n - 1:
            dx, dy = x - pts[-2][0], y - pts[-2][1]
        else:
            dx, dy = pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]
        L = max(math.hypot(dx, dy), 1e-6)
        nx, ny = -dy / L, dx / L
        x, y = x + nx * shift * w, y + ny * shift * w
        left.append((x + nx * w / 2, y + ny * w / 2))
        right.append((x - nx * w / 2, y - ny * w / 2))
    return left + right[::-1]


def arm_points(pts, phase=0.0, droop=0.0):
    """phase swings the arms sideways, droop pulls them in and down."""
    out = []
    for i, (x, y) in enumerate(pts):
        t = i / (len(pts) - 1)
        s = math.sin(math.pi * t)
        x2 = HCX + (x - HCX) * (1 - 0.13 * droop) + phase * 0.5 * s
        y2 = y + droop * 0.55 * s + abs(phase) * 0.28 * s
        out.append((x2, y2))
    return catmull(out, 160)


def smooth_noise(seed, cells=7):
    rng = np.random.default_rng(seed)
    small = rng.random((cells, max(2, int(cells * CH / CW))))
    im = Image.fromarray((small * 255).astype(np.uint8)).resize((CW, CH), Image.BICUBIC)
    return np.asarray(im, dtype=np.float32) / 255.0


NOISE1 = smooth_noise(3, 5)
NOISE2 = smooth_noise(9, 11)
NOISE3 = smooth_noise(17, 24)


def head_mask(rx=HRX, ry=HRY, bite=0.0):
    yy, xx = np.mgrid[0:CH, 0:CW].astype(np.float32)
    ux = xx / S - HCX
    uy = yy / S - HCY
    rx_at = rx * (0.90 + 0.10 * np.clip(uy / ry, -1, 1))
    m1 = ((np.abs(ux / rx_at) ** 2.6) + (np.abs(uy / ry) ** 2.6)) <= 1.0
    m2 = ((np.abs(ux / (rx * 0.86)) ** 2.2) + (np.abs((uy - 1.35) / (ry * 0.92)) ** 2.2)) <= 1.0
    m = (m1 | m2).astype(np.float32)
    if bite:
        # noise only eats into the silhouette: a bumpy skin edge, no haze outside
        m = np.clip(m - bite * np.clip(NOISE2 - 0.45, 0, 1) * 2.2, 0, 1)
    return m


def blob(mask, blur=1.2):
    return np.asarray(Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur)), dtype=np.float32) / 255.0


def draw_arm(lum, arm_mask, pts, w0, w1, phase, droop, shade, outline=0.62):
    curve = arm_points(pts, phase, droop)
    a_out = alpha_of([stroke_poly(curve, w0 + outline, w1 + outline * 0.7)], blur=2.2)
    put(lum, a_out, 0.02)
    arm_mask += a_out
    a = alpha_of([stroke_poly(curve, w0, w1)], blur=1.5)
    put(lum, a, shade * 1.06)
    arm_mask += a
    # ridge highlight along the upper side of the arm
    put(lum, alpha_of([stroke_poly(curve, w0 * 0.34, w1 * 0.34, shift=0.30)], blur=1.4), np.minimum(shade + 0.30, 1.0))
    # suckers along the lower side
    dots = []
    cp = resample(curve, 90)
    for i in range(int(len(cp) * 0.28), int(len(cp) * 0.86), 5):
        x, y = cp[i]
        dots.append(poly_circle(x - 0.15, y + 0.15, 0.19))
    if dots:
        put(lum, alpha_of(dots, blur=1.3), 1.0)


def build(phase=0.0, droop=0.0):
    lum = np.zeros((CH, CW), dtype=np.float32)
    arm_mask = np.zeros((CH, CW), dtype=np.float32)

    for layer, pts, w0, w1 in ARMS:
        if layer == "back":
            draw_arm(lum, arm_mask, pts, w0, w1, phase, droop, 0.46 + 0.10 * (NOISE1 - 0.5))

    # ---------------------------------------------------------------- head
    hb = blob(head_mask(bite=0.22), 1.2)
    yy, xx = np.mgrid[0:CH, 0:CW].astype(np.float32)
    ux, uy = xx / S - HCX, yy / S - HCY
    shade = (0.46
             + 0.12 * np.clip(-uy / HRY, -1, 1)
             - 0.10 * np.clip((np.abs(ux) / HRX - 0.5) / 0.5, 0, 1)
             + 0.20 * (NOISE1 - 0.5) + 0.10 * (NOISE3 - 0.5))
    put(lum, hb, 0.02)
    lum += hb * np.clip(shade, 0.04, 1.0)
    # rim: bright at the top, fading towards the chin
    rim = np.clip(hb - blob(head_mask(rx=HRX - 0.34, ry=HRY - 0.30), 1.0), 0, 1)
    rim_v = (0.88 - 0.60 * np.clip((uy + 0.6) / HRY, 0, 2) / 2)
    lum += rim * rim_v
    # a thin inner contour line, like the reference art's double rim
    inner = blob(head_mask(rx=HRX - 0.95, ry=HRY - 0.80), 1.0)
    inner2 = blob(head_mask(rx=HRX - 1.30, ry=HRY - 1.10), 1.0)
    arc = np.clip(inner - inner2, 0, 1) * np.clip(0.35 + 0.65 * np.clip(-uy / HRY, 0, 1), 0, 1)
    lum += arc * 0.30

    for layer, pts, w0, w1 in ARMS:
        if layer == "front":
            draw_arm(lum, arm_mask, pts, w0, w1, phase, droop, 0.56 + 0.12 * (NOISE1 - 0.5))

    # ---------------------------------------------------------------- eyes
    # socket + iris ring are drawn here; the pupil belongs to ui.html (moods)
    for ex in (C(16.0, 0)[0], C(24.0, 0)[0]):
        ey = 6.2
        put(lum, alpha_of([poly_circle(ex, ey, 1.78, 1.58)], blur=1.5), 0.0)
        ring = alpha_of([poly_circle(ex, ey, 1.30, 1.19)], blur=1.2) - alpha_of([poly_circle(ex, ey, 0.50, 0.45)], blur=1.2)
        put(lum, np.clip(ring, 0, 1), 0.99)

    # ---------------------------------------------------------------- bubbles
    for bx, by, br in ((C(35.4, 2.6)[0], 2.6, 0.20), (C(36.9, 1.6)[0], 1.6, 0.14), (C(34.8, 1.0)[0], 1.0, 0.10)):
        put(lum, alpha_of([poly_circle(bx, by, br)], blur=1.0), 0.45)

    return lum, arm_mask


def to_ascii(lum, edge=0.30):
    im = Image.fromarray((np.clip(lum, 0, 1) * 255).astype(np.uint8))
    cells = np.asarray(im.resize((AW, AH), Image.BOX), dtype=np.float32) / 255.0
    gy, gx = np.gradient(cells)
    g = np.hypot(gx, gy) * 3.0
    val = np.clip(cells * 0.95 + g * edge * np.clip(cells * 5.0, 0, 1), 0, 1)
    idx = np.clip((val * (len(RAMP) - 1) + 0.5).astype(int), 0, len(RAMP) - 1)
    return ["".join(RAMP[i] for i in row) for row in idx]


def cell_mask(arm_mask, thr=0.04):
    m = Image.fromarray((np.clip(arm_mask, 0, 1) * 255).astype(np.uint8)).resize((AW, AH), Image.BOX)
    return np.asarray(m, dtype=np.float32) / 255.0 > thr


def main():
    frames = {"a": build(0.0, 0.0), "b": build(0.9, 0.0), "d": build(0.0, 1.0)}
    grid = {}
    mask = {}
    for name, (lum, am) in frames.items():
        grid[name] = to_ascii(lum)
        mask[name] = cell_mask(am)
    movable = mask["a"] | mask["b"] | mask["d"]

    base = grid["a"]
    out = {}
    for name in ("a", "b", "d"):
        lines = []
        for r in range(AH):
            row = ""
            for c in range(AW):
                row += grid[name][r][c] if movable[r][c] else base[r][c]
            lines.append(row.rstrip())
        out[name] = lines

    # The pupil cells are blanked on purpose. ui.html always overwrites them
    # with the mood's own two characters, so nothing the art puts there is ever
    # seen — and at one emitted cell per pupil, a glyph drawn on top of an
    # equally dense art cell would vanish into it. Blank is the background the
    # mood's "oo" / "xx" / "--" is meant to sit on.
    prow, pl, pr = EYE_ROW // COARSE, EYE_COLS[0] // COARSE, EYE_COLS[1] // COARSE
    for name in ("a", "b", "d"):
        row = list(out[name][prow].ljust(AW))
        for c in (pl, pl + 1, pr, pr + 1):
            row[c] = " "
        out[name][prow] = "".join(row)

    # ...and the ring is rebuilt at the emitted scale. At one cell per pupil the
    # mood's glyph IS the whole eye, and a mid-density glyph against the mid
    # densities the thin ring averages into at half resolution would vanish —
    # so the cells above, below and outboard of each pupil pair go to the
    # densest character: the old 40x20 "%oo@" look with one cell per side. The
    # inboard sides keep the art's own darker cells, which is what separates
    # the two eyes.
    for name in ("a", "b", "d"):
        rows = [list(l.ljust(AW)) for l in out[name]]
        for c0, outer in ((pl, pl - 1), (pr, pr + 2)):
            for c in (c0, c0 + 1):
                rows[prow - 1][c] = "@"
                rows[prow + 1][c] = "@"
            rows[prow][outer] = "@"
        out[name] = ["".join(r).rstrip() for r in rows]

    if "--print" in sys.argv:
        for name in ("a", "b", "d"):
            print(name)
            for l in out[name]:
                print("|" + l + "|")

    js = render_js(out)
    target = Path(__file__).resolve().parent.parent / "plugin" / "ui.html"
    if "--emit" in sys.argv:
        text = target.read_text()
        pattern = (r"(?s)(// >>> mascot art[^\n]*\n).*?(" +
                   re.escape("      // <<< mascot art") + r")")
        text2, n = re.subn(pattern, lambda m: m.group(1) + js + "\n" + m.group(2), text, count=1)
        if n == 0:
            print("no mascot markers found in ui.html", file=sys.stderr)
            sys.exit(1)
        target.write_text(text2)
        print("ui.html updated")
    else:
        print(js)


def render_js(out):
    lines = ["      const ART = {"]
    for name, lines_ in out.items():
        lines.append("        " + name + ": [")
        for l in lines_:
            lines.append('          "' + l.replace("\\", "\\\\").replace('"', '\\"') + '",')
        lines.append("        ],")
    lines.append("      };")
    lines.append("      // eye cells: two characters per eye, replaced per mood")
    lines.append("      const EYE_AT = { col: %d, row: %d, right: %d };" %
                 (EYE_COLS[0] // COARSE, EYE_ROW // COARSE, EYE_COLS[1] // COARSE))
    lines.append("      const EYES = {")
    for mood, l, r in (
        ("ready", "oo", "oo"),
        ("busy", "oO", "Oo"),
        ("look", "oo", "--"),
        ("happy", "^^", "^^"),
        ("sad", "xx", "xx"),
        ("annoyed", "><", "><"),
        ("sleep", "--", "--"),
    ):
        lines.append('        %s: ["%s", "%s"],' % (mood, l, r))
    lines.append("      };")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
