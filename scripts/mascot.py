#!/usr/bin/env python3
"""Hold the ASCII octopus mascot and emit it as a JS block for plugin/ui.html.

The art lives on a 21x10 grid of shade characters — the same grid the panel
renders, one cell per character, and the panel's mono cell is 13.6px wide, so
the octopus is a 285.6x220 CSS px block on screen.  Shading does the modelling:
a solid head with a dim rim, two eye sockets under pale arcs, arm tips rising
beside the head, and four tentacles hanging with sucker gaps (the reference art
this follows is dense terminal art, and its *shape* is what survives at this
size — a chunky head with big dark eyes and spread arms, not the fine sucker
dots).

Three frames are authored (rest / sway / droop) and the panel animates the
mascot by swapping them: the sway lifts the arm tips and moves the outer
tentacles, the droop dims the crown, drops the tips and pulls the tentacles in.

The two 2-character eye sockets are blank on purpose.  ui.html always writes a
mood's own two characters into them (EYES), so the face never comes from the
art: it is the link's state.  A glyph sitting on an equally dense art cell
would vanish into it, so blank is also the only sane background for "oo".

Usage:
    python3 scripts/mascot.py --print   # the grid, with a ruler, for review
    python3 scripts/mascot.py --emit    # rewrite the art block in ui.html
"""
import re
import sys
from pathlib import Path

# ------------------------------------------------------------------ the grid
W, H = 21, 10            # cells of the art = characters in the panel
SHADES = " ░▒▓█"         # what the art may use, light to dense

EYE_ROW = 3              # the row the sockets sit in
EYE_COLS = (8, 11)       # left cell of each 2-char socket (8-9 / 11-12)

ART = {
    # rest: tips up, tentacles hanging straight
    "a": [
        "      ░▓▓▓▓▓▓▓░      ",
        "     ▒▓░█████░▓▒     ",
        "    ░▓██░░█░░██▓░    ",
        "    ▓██▒  █  ▒██▓    ",
        " ░▓   ▒█▓███▓█▒   ▓░ ",
        " ▓█  ▓█████████▓  █▓ ",
        "▓██▒▒▓██▒███▒██▓▒▒██▓",
        "  ░██  ▒██ ██▒  ██░  ",
        "  █░   ▓█   █▓   ░█  ",
        "   ░    ▓   ▓    ░   ",
    ],
    # sway: the tips lift, the outer tentacles swing out one cell
    "b": [
        "      ░▓▓▓▓▓▓▓░      ",
        "     ▒▓░█████░▓▒     ",
        "    ░▓██░░█░░██▓░    ",
        "    ▓██▒  █  ▒██▓    ",
        " ▓█   ▒█▓███▓█▒   █▓ ",
        " ░▓  ▓█████████▓  ▓░ ",
        "▓██▒▒▓██▒███▒██▓▒▒██▓",
        " ░██   ▒██ ██▒   ██░ ",
        " █░    ▓█   █▓    ░█ ",
        "  ░     ▓   ▓     ░  ",
    ],
    # droop: a dimmer crown, the tips dropped, the tentacles pulled in
    "d": [
        "      ░▒▒▒▒▒▒▒░      ",
        "     ▒▓░█████░▓▒     ",
        "    ░▓██░░█░░██▓░    ",
        "    ▓██▒  █  ▒██▓    ",
        "      ▒█▓███▓█▒      ",
        "  ░▒ ▓█████████▓ ▒░  ",
        "▓██▒▒▓██▒███▒██▓▒▒██▓",
        "   ░██ ▒██ ██▒ ██░   ",
        "   █░  ▓█   █▓  ░█   ",
        "    ░   ▓   ▓   ░    ",
    ],
}


def check(rows):
    """Every row is W wide and mirrored around the axis between col 10 and 11.

    The octopus faces the reader dead on, so both halves of every frame are the
    same picture; writing one half and mirroring it by hand is how these rows
    got their symmetry, and this guard keeps it that way.
    """
    for i, row in enumerate(rows):
        if len(row) != W:
            raise SystemExit("row %d is %d cells, want %d" % (i, len(row), W))
        for c in range(W):
            if row[c] != row[W - 1 - c]:
                raise SystemExit("row %d is not symmetric: col %d %r vs col %d %r"
                                 % (i, c, row[c], W - 1 - c, row[W - 1 - c]))


def blank_sockets(rows):
    """Leave the eye sockets empty: the moods write the pupils themselves."""
    out = [list(r) for r in rows]
    for c0 in EYE_COLS:
        for c in (c0, c0 + 1):
            out[EYE_ROW][c] = " "
    return ["".join(r).rstrip() for r in out]


def render_js(frames):
    lines = ["      const ART = {"]
    for name in ("a", "b", "d"):
        lines.append("        " + name + ": [")
        for row in frames[name]:
            lines.append('          "' + row.replace("\\", "\\\\").replace('"', '\\"') + '",')
        lines.append("        ],")
    lines.append("      };")
    lines.append("      // eye cells: two characters per eye, replaced per mood")
    lines.append("      const EYE_AT = { col: %d, row: %d, right: %d };" %
                 (EYE_COLS[0], EYE_ROW, EYE_COLS[1]))
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


def ruled(rows):
    out = ["    " + "".join(str((i // 10) % 10) for i in range(W)),
           "    " + "".join(str(i % 10) for i in range(W))]
    for r in rows:
        out.append("    |" + r.ljust(W) + "|")
    return "\n".join(out)


def main():
    for name, rows in ART.items():
        check(rows)
    frames = {name: blank_sockets(rows) for name, rows in ART.items()}

    if "--print" in sys.argv:
        for name in ("a", "b", "d"):
            print(name)
            print(ruled(frames[name]))

    js = render_js(frames)
    if "--emit" not in sys.argv:
        print(js)
        return

    target = Path(__file__).resolve().parent.parent / "plugin" / "ui.html"
    text = target.read_text()
    pattern = (r"(?s)(// >>> mascot art[^\n]*\n).*?(" +
               re.escape("      // <<< mascot art") + r")")
    text2, n = re.subn(pattern, lambda m: m.group(1) + js + "\n" + m.group(2), text, count=1)
    if n == 0:
        print("no mascot markers found in ui.html", file=sys.stderr)
        sys.exit(1)
    target.write_text(text2)
    print("ui.html updated")


if __name__ == "__main__":
    main()
