/**
 * Refuse a `figma_use` snippet *before it is sent* when it assigns an enum
 * literal that is a known-bad spelling or a near-miss of a runtime value.
 *
 * The expensive case this exists for:
 *
 *   list.overflowDirection = "VERTICAL_SCROLLING";
 *   // in set_overflowDirection: Property "overflowDirection" failed validation:
 *   // Invalid option: expected one of "NONE"|"HORIZONTAL"|"VERTICAL"|"BOTH"
 *
 * One bad enum value throws inside the plugin, which rolls the whole snippet
 * back — every write before that line is lost, and the caller learns the
 * accepted values only after paying for the round trip. The vocabulary is
 * fixed and small, so the obvious mistakes can be checked locally with no node
 * in hand, before anything is sent. A refusal here has no rollback to report:
 * nothing changed.
 *
 * Refusal policy — deliberately conservative, because a false refusal blocks
 * correct work:
 *  - a known cross-API spelling (VERTICAL_SCROLLING, ROW, COLUMN, AUTO for a
 *    sizing mode) is refused with the value the runtime wants;
 *  - a value within two edits of an accepted one is refused as a typo;
 *  - anything else is allowed through: the table tracks the pinned typings, and
 *    a newer runtime value must not be blocked by an older bridge. The runtime
 *    still validates it and its error lists the current accepted values.
 *
 * Scope: `node.prop = "literal"` and `node["prop"] = "literal"` only. The
 * snippet is tokenised, so an assignment quoted in a comment or a string is not
 * a violation. A value held in a variable is left to the runtime; the prelude's
 * `setEnum` is the in-snippet guard for that case.
 *
 * The table is duplicated in `skills/figma-local-bridge/assets/prelude.js`
 * (`ENUMS`) so a snippet can validate without the bridge;
 * test/enum-guard.test.mjs fails if the two drift.
 */

/**
 * Runtime strings accepted by the properties snippets assign most, copied from
 * `@figma/plugin-typings`. Include every value the pinned typings know: a value
 * missing here is passed through, and the test against the prelude keeps the two
 * copies identical.
 */
export const RUNTIME_ENUMS: Readonly<Record<string, readonly string[]>> = {
  overflowDirection: ["NONE", "HORIZONTAL", "VERTICAL", "BOTH"],
  layoutMode: ["NONE", "HORIZONTAL", "VERTICAL", "GRID"],
  primaryAxisSizingMode: ["FIXED", "AUTO"],
  counterAxisSizingMode: ["FIXED", "AUTO"],
  layoutSizingHorizontal: ["FIXED", "HUG", "FILL"],
  layoutSizingVertical: ["FIXED", "HUG", "FILL"],
  layoutAlign: ["MIN", "CENTER", "MAX", "STRETCH", "INHERIT"],
  layoutPositioning: ["AUTO", "ABSOLUTE"],
  primaryAxisAlignItems: ["MIN", "MAX", "CENTER", "SPACE_BETWEEN", "SPACE_EVENLY", "SPACE_AROUND"],
  counterAxisAlignItems: ["MIN", "MAX", "CENTER", "BASELINE"],
  textAutoResize: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"],
  textAlignHorizontal: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"],
  textAlignVertical: ["TOP", "CENTER", "BOTTOM"],
  textCase: ["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"],
  textDecoration: ["NONE", "UNDERLINE", "STRIKETHROUGH"],
  strokeAlign: ["CENTER", "INSIDE", "OUTSIDE"],
  strokeCap: ["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED", "CIRCLE_FILLED"],
  strokeJoin: ["MITER", "BEVEL", "ROUND"],
  scaleMode: ["FILL", "FIT", "CROP", "TILE"],
};

/** Spellings borrowed from other layout APIs, mapped to the runtime value. */
const ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  overflowDirection: {
    VERTICAL_SCROLLING: "VERTICAL",
    HORIZONTAL_SCROLLING: "HORIZONTAL",
    VERTICAL_SCROLL: "VERTICAL",
    HORIZONTAL_SCROLL: "HORIZONTAL",
    SCROLLING: "VERTICAL",
  },
  layoutMode: { ROW: "HORIZONTAL", COLUMN: "VERTICAL" },
  primaryAxisSizingMode: { HUG: "AUTO" },
  counterAxisSizingMode: { HUG: "AUTO" },
  layoutSizingHorizontal: { AUTO: "HUG" },
  layoutSizingVertical: { AUTO: "HUG" },
  textAutoResize: { AUTO: "HEIGHT", WIDTH: "HEIGHT" },
  textAlignHorizontal: { START: "LEFT", END: "RIGHT", JUSTIFY: "JUSTIFIED" },
  textAlignVertical: { MIDDLE: "CENTER" },
  textCase: { CAPS: "UPPER", CAPITALIZE: "TITLE" },
};

export interface EnumViolation {
  /** The Figma property that received the literal. */
  property: string;
  /** The literal as written. */
  value: string;
  /** Runtime values the property accepts. */
  accepted: readonly string[];
  /** The value the runtime wants. */
  suggestion: string;
  /** 1-based line in the snippet. */
  line: number;
}

type Token = {
  kind: "ident" | "string" | "punct";
  /** Identifier name, string contents, or the punctuation itself. */
  value: string;
  start: number;
};

const PUNCT = ["===", "!==", "=>", "==", "!=", "+=", "-=", "*=", "/=", "&&", "||", "??", "?."];

/**
 * Just enough JavaScript to tell an assignment from prose: identifiers,
 * strings, punctuation, whitespace and comments. Comments and whitespace are
 * dropped; a quoted assignment in either cannot reach the checker. Template
 * literals are opaque (an assignment inside `${…}` is deliberately not seen).
 */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? code.length : end;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const start = i;
      i += 1;
      let value = "";
      while (i < code.length) {
        const ch = code[i];
        if (ch === "\\") { value += code.slice(i, i + 2); i += 2; continue; }
        if (ch === quote) { i += 1; break; }
        value += ch;
        i += 1;
      }
      tokens.push({ kind: "string", value, start });
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      while (i < code.length && isId(code[i])) i += 1;
      tokens.push({ kind: "ident", value: code.slice(start, i), start });
      continue;
    }
    const multi = PUNCT.find((p) => code.startsWith(p, i));
    if (multi) {
      tokens.push({ kind: "punct", value: multi, start: i });
      i += multi.length;
      continue;
    }
    tokens.push({ kind: "punct", value: c, start: i });
    i += 1;
  }
  return tokens;
}

function normalize(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/** Levenshtein distance, capped at 3: only "is this a typo?" matters. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 4;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** The accepted value a rejected literal most likely meant, if it is a typo. */
function nearest(value: string, accepted: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of accepted) {
    const d = editDistance(value, candidate);
    if (d < bestDistance) { bestDistance = d; best = candidate; }
  }
  return bestDistance <= 2 ? best : undefined;
}

/**
 * Every enum literal this guard can refuse, in source order. An empty array
 * means nothing known-bad was found; it does not prove the snippet is valid.
 * A value that is unfamiliar but not a known mistake is allowed through.
 */
export function findEnumLiteralViolations(code: string): EnumViolation[] {
  const tokens = tokenize(code);
  const found: EnumViolation[] = [];
  const add = (property: string, raw: string, start: number) => {
    const accepted = RUNTIME_ENUMS[property];
    if (!accepted) return;
    const normalized = normalize(raw);
    if (accepted.includes(normalized)) return;
    const suggestion = ALIASES[property]?.[normalized] ?? nearest(normalized, accepted);
    if (!suggestion) return; // possibly a newer runtime value: let the runtime decide
    found.push({ property, value: raw, accepted, suggestion, line: lineAt(code, start) });
  };

  for (let i = 0; i < tokens.length; i++) {
    // node.property = "literal"
    if (
      tokens[i].kind === "punct" && tokens[i].value === "." &&
      tokens[i + 1]?.kind === "ident" &&
      tokens[i + 2]?.kind === "punct" && tokens[i + 2].value === "=" &&
      tokens[i + 3]?.kind === "string"
    ) {
      add(tokens[i + 1].value, tokens[i + 3].value, tokens[i + 3].start);
    }
    // node["property"] = "literal"
    if (
      tokens[i].kind === "punct" && tokens[i].value === "[" &&
      tokens[i + 1]?.kind === "string" &&
      tokens[i + 2]?.kind === "punct" && tokens[i + 2].value === "]" &&
      tokens[i + 3]?.kind === "punct" && tokens[i + 3].value === "=" &&
      tokens[i + 4]?.kind === "string"
    ) {
      add(tokens[i + 1].value, tokens[i + 4].value, tokens[i + 4].start);
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line += 1;
  return line;
}

/** The error text a caller sees; it must name the fix and that nothing ran. */
export function formatEnumViolations(violations: readonly EnumViolation[]): string {
  const lines = violations.map((v) => {
    const accept = v.accepted.join(" | ");
    return `  line ${v.line}: .${v.property} = ${JSON.stringify(v.value)} — accepted: ${accept}. Use "${v.suggestion}".`;
  });
  return [
    "figma_use refused before sending: enum value not accepted by the Figma runtime.",
    ...lines,
    "Nothing was sent, so nothing changed and nothing was rolled back.",
    "Fix the literal(s) above. The accepted list is authoritative: do not guess another spelling. " +
      "For a value held in a variable, the prelude's setEnum(node, property, value) validates it before assigning.",
  ].join("\n");
}
