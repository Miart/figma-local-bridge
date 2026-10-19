/**
 * The snippet standard library: `flb`, handed to every `use_figma` call.
 *
 * WHY THIS EXISTS. Snippets rediscover the same four traps on every call, and
 * each one fails in a way that looks like something else:
 *
 *   - this manifest declares `"documentAccess": "dynamic-page"`, where
 *     `figma.getNodeById` THROWS (the typings say so). Code recalled from older
 *     examples dies on line one, and the error points at the API, not at the
 *     mode the file is opened in;
 *   - writing characters into a TEXT node needs `figma.loadFontAsync` first, and
 *     the failure arrives as a font error even though the font exists;
 *   - `node.x` is parent-relative while `absoluteBoundingBox` is absolute, and
 *     atlas work mixes the two — sprites land one offset away from where the
 *     arithmetic said they would;
 *   - `fetch`-style habits reach for `getNodeById`/`findAll` on a page that is
 *     not loaded, and in dynamic-page mode that requires `page.loadAsync()`.
 *
 * The helpers are deliberately NOT a second API: they are the Plugin API with
 * the traps named. Every one of them refuses BEFORE writing when the write
 * cannot be true — outside the declared scope, on another page (where the
 * scope guard cannot see it), into an auto-layout parent that places children
 * itself, or by resizing something the API will refuse to resize.
 *
 * Nothing here touches `figma` at module scope, so the module loads in Node and
 * is unit-tested against a stub (test/helpers.test.mjs). The snippet gets the
 * result of `makeHelpers(figma, { scopeRootId, pageWide })` as its third
 * argument, which is why every message starts with `flb.` — the caller may never
 * have seen this file.
 */

const round = (n: number) => Math.round(n * 100) / 100;
const msg = (e: any) => String(e && e.message ? e.message : e);

/** How many matches `flb.find` tolerates before it refuses to answer. */
export const FIND_LIMIT = 1000;

/** The slice of the Plugin API the helpers use — a stub can satisfy it. */
export interface HelperApi {
  currentPage: any;
  getNodeByIdAsync(id: string): Promise<any>;
  loadFontAsync(font: { family: string; style: string }): Promise<void>;
  createText(): any;
  util?: { solidPaint(color: string, node?: any): any };
}

export interface HelperOptions {
  /** The subtree the call may touch. When set, write helpers refuse anything else. */
  scopeRootId?: string | null;
  /** The call was declared page-wide: scope refusals are off. */
  pageWide?: boolean;
}

export interface FindSelector {
  /** Where to search. Defaults to the current page. Descendants only — not the node itself. */
  within?: any;
  type?: string | readonly string[];
  /** Exact name. */
  name?: string;
  /** A RegExp, or a string used as one (a pattern, not a literal). */
  match?: RegExp | string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  render: boolean;
  note?: string;
}

export interface GridOptions {
  /** Where the nodes land. They are reparented into it; default: leave them where they are. */
  parent?: any;
  /** Uniform cell. Default: the largest render bounds among the nodes. */
  cell?: number | { width: number; height: number };
  /** Default: ceil(sqrt(n)). */
  columns?: number;
  /** Space between cells. */
  gap?: number;
  /** ABSOLUTE document coordinates of the first cell's top-left. Default: where the first node already is. */
  origin?: { x: number; y: number };
  /** Scale each node DOWN to fit its cell (never up). Refused for things that cannot be resized. */
  fit?: boolean;
}

export interface TextOptions {
  parent?: any;
  /** ABSOLUTE coordinates when `parent` is given, page coordinates otherwise. */
  x?: number;
  y?: number;
  size?: number;
  /** "Inter Bold" or { family, style }. Default Inter Regular. */
  font?: string | { family: string; style: string };
  /** A hex string (via figma.util.solidPaint) or a paint array. */
  fills?: string | readonly any[];
  name?: string;
  align?: "LEFT" | "CENTER" | "RIGHT";
  autoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE";
}

/** A node as the helpers describe it — enough to act on, not a full dump. */
const describe = (n: any) => (n ? `"${n.name}" (${n.type} ${n.id})` : "nothing");

/** The absolute origin of a node's coordinate space: where local (0,0) sits. */
function originOf(node: any): { x: number; y: number } {
  if (!node || node.type === "PAGE") return { x: 0, y: 0 };
  const t = node.absoluteTransform;
  if (Array.isArray(t) && Array.isArray(t[0])) return { x: t[0][2] ?? 0, y: t[1][2] ?? 0 };
  const b = node.absoluteBoundingBox;
  return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
}

/** The page a node lives on, found by walking up (no getNodeById here). */
function pageOf(node: any): any {
  let n: any = node;
  while (n && n.type !== "PAGE") n = n.parent;
  return n;
}

export function makeHelpers(api: HelperApi, options: HelperOptions = {}) {
  const scopeRootId = options.scopeRootId ? String(options.scopeRootId) : null;
  const pageWide = options.pageWide === true;

  const inScope = (node: any): boolean => {
    if (pageWide || !scopeRootId) return true;
    let n: any = node;
    while (n) {
      if (n.id === scopeRootId) return true;
      n = n.parent;
    }
    return false;
  };

  /** Refuse a target the scope guard would roll back anyway — before the write. */
  const claim = (node: any, what: string) => {
    if (inScope(node)) return;
    throw new Error(
      `${what}: ${describe(node)} is outside the declared scopeNodeId ${scopeRootId} — ` +
        `the call would be rolled back at the end. Use a node inside the scope, or declare a wider scopeNodeId.`,
    );
  };

  /**
   * The scope guard indexes ONE page (the page that was current when the call
   * started). A write that lands on another page is invisible to that diff, so
   * it would neither be rolled back nor reported — the helpers refuse it rather
   * than do something the call cannot verify.
   */
  const samePage = (node: any, what: string) => {
    if (!node || node.type === "PAGE") return;
    const page = pageOf(node);
    if (page && page !== api.currentPage) {
      throw new Error(
        `${what}: ${describe(node)} is on page "${page.name}", not the current page "${api.currentPage?.name}" — ` +
          `use_figma guards the current page only, so this write could not be checked or rolled back. ` +
          `Switch pages with the figma_set_page tool first, then run this call.`,
      );
    }
  };

  // ---------------------------------------------------------------- reading

  /**
   * Look a node up by id, with the dynamic-page rule built in.
   *
   * `figma.getNodeById` is deprecated AND throws in a dynamic-page manifest;
   * there is nothing an agent can do about the manifest from a snippet, so the
   * helper only ever calls the async form.
   */
  const byId = async (id: string): Promise<any> => {
    const node = await api.getNodeByIdAsync(String(id));
    if (!node) {
      throw new Error(
        `flb.byId: no node ${id} in this file. Ids belong to one file, so an id from another file's answer never resolves here; ` +
          `figma_get_metadata lists the ids this file actually has.`,
      );
    }
    return node;
  };

  /**
   * Every descendant matching the selector. Refuses to answer a page-wide
   * question with a truncated list — a silently capped result is how "3 nodes"
   * becomes "3 nodes I looked at".
   */
  const find = (sel: FindSelector = {}): any[] => {
    const within = sel.within ?? api.currentPage;
    if (!within || typeof within.findAll !== "function") {
      throw new Error(`flb.find: "within" must be a node that can be searched (got ${describe(within)}).`);
    }
    if (!sel.name && !sel.match && !sel.type) {
      throw new Error("flb.find: give a name, a match pattern or a type — an unfiltered search is the whole page.");
    }
    const types = sel.type ? new Set(Array.isArray(sel.type) ? sel.type : [sel.type]) : null;
    const re = sel.match
      ? sel.match instanceof RegExp
        ? sel.match
        : new RegExp(String(sel.match))
      : null;
    const wanted = (n: any) =>
      (!types || types.has(n.type)) && (sel.name === undefined || n.name === sel.name) && (!re || re.test(n.name));
    let all: any[];
    try {
      all = within.findAll(wanted);
    } catch (e) {
      throw new Error(
        `flb.find: ${msg(e)} — searching a page that is not open needs await page.loadAsync() first, ` +
          `and use_figma refuses a page switch mid-call: load it, or search a node instead of a page.`,
      );
    }
    if (all.length > FIND_LIMIT) {
      throw new Error(
        `flb.find: ${all.length} nodes match (limit ${FIND_LIMIT}) — narrow it with type, name, match or within, ` +
          `or you are about to act on a list nobody read.`,
      );
    }
    return all;
  };

  /** Exactly one descendant, or a refusal that names what else matched. */
  const one = (sel: FindSelector = {}): any => {
    const all = find(sel);
    if (all.length === 1) return all[0];
    const where = `in ${describe(sel.within ?? api.currentPage)}`;
    if (!all.length) throw new Error(`flb.one: nothing matches ${where}.`);
    throw new Error(
      `flb.one: ${all.length} nodes match ${where}: ` +
        `${all.slice(0, 8).map(describe).join(", ")}${all.length > 8 ? ` … +${all.length - 8}` : ""}. ` +
        `Narrow it (name, type, within) — picking the first of several is how the wrong sprite gets edited.`,
    );
  };

  /**
   * Absolute bounds. `render: true` asks for what is actually drawn — shadows,
   * strokes and overflow included — which is what packing sprites has to use,
   * because layout bounds stop at the node's own box.
   */
  const bbox = (node: any, o: { render?: boolean } = {}): Box => {
    if (!node || typeof node !== "object") throw new Error(`flb.bbox: pass a node (got ${typeof node}).`);
    const renderBox = o.render ? node.absoluteRenderBounds : null;
    const box = renderBox ?? node.absoluteBoundingBox;
    if (!box) {
      throw new Error(
        `flb.bbox: ${describe(node)} has no absolute bounds — a PAGE has none, and a node with nothing to draw ` +
          `(no fills, no children) has no render bounds.`,
      );
    }
    const out: Box = {
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      // True only when these numbers ARE the render bounds: a caller that asked
      // for them and got the layout box back has to be able to see that.
      render: renderBox != null,
    };
    if (o.render && renderBox == null) out.note = "nothing is drawn here, so render bounds are null: layout bounds returned";
    return out;
  };

  // ---------------------------------------------------------------- writing

  /**
   * Remove every child, and say what was removed. Iterates over a copy: the
   * live `children` array shifts under the loop otherwise.
   */
  const clear = (node: any): Array<{ id: string; name: string; type: string }> => {
    claim(node, "flb.clear");
    samePage(node, "flb.clear");
    if (node.type === "INSTANCE") {
      throw new Error(
        `flb.clear: ${describe(node)} is an INSTANCE — its children belong to its main component and cannot be removed here. ` +
          `Detach it first (flb.flatten) or edit the component itself.`,
      );
    }
    if (!Array.isArray(node.children)) {
      throw new Error(`flb.clear: ${describe(node)} has no children.`);
    }
    const removed = node.children.map((c: any) => ({ id: c.id, name: c.name, type: c.type }));
    for (const child of [...node.children]) child.remove();
    return removed;
  };

  /**
   * Detach every instance in the subtree, outermost first, so the result is
   * plain nodes with no component identity — what a sprite atlas needs, and
   * what `detachInstance()` does natively (it keeps every override, which a
   * data rebuild would lose).
   *
   * A partially detached tree is worse than none, so if anything refuses (an
   * instance locked by its main component, a nested one the API will not take),
   * the helper THROWS with the list instead of reporting success.
   */
  const flatten = (node: any): { root: any; detached: Array<{ id: string; name: string; frame: string }> } => {
    claim(node, "flb.flatten");
    samePage(node, "flb.flatten");
    const detached: Array<{ id: string; name: string; frame: string }> = [];
    const failed: Array<{ id: string; name: string; why: string }> = [];
    const detach = (inst: any): any => {
      // Read the instance's own facts FIRST: detachInstance() invalidates the
      // node, and even `inst.name` afterwards throws "The node with id … does
      // not exist" — the live run is where that was learned.
      const was = { id: inst.id, name: inst.name };
      try {
        const frame = inst.detachInstance();
        detached.push({ ...was, frame: frame?.id ?? "?" });
        return frame;
      } catch (e) {
        failed.push({ ...was, why: msg(e) });
        return null;
      }
    };

    let root = node;
    if (root.type === "INSTANCE") {
      const frame = detach(root);
      if (frame) root = frame;
    }
    const walk = (n: any) => {
      for (const child of [...(n.children ?? [])]) {
        if (child.type === "INSTANCE") {
          const frame = detach(child);
          if (frame) walk(frame); // detaching turned it into a frame: look inside for more
        } else {
          walk(child);
        }
      }
    };
    walk(root);

    if (failed.length) {
      throw new Error(
        `flb.flatten: ${failed.length} instance(s) could not be detached: ` +
          `${failed.map((f) => `${describe({ name: f.name, type: "INSTANCE", id: f.id })}: ${f.why}`).join("; ")}. ` +
          `Nothing is reported as flattened while any instance is left — handle those explicitly (or detach the outer one by hand) and run again.`,
      );
    }
    const out: { root: any; detached: Array<{ id: string; name: string; frame: string }>; note?: string } = {
      root,
      detached,
    };
    // The instance node the caller passed is dead the moment it is detached —
    // reading even its `.name` afterwards throws "The node with id … does not
    // exist". The live run showed a snippet holding `only.name` for later and
    // dying on the way out, so the returned value says it out loud.
    if (detached.length) {
      out.note = `the node(s) passed in no longer exist: use the returned root (or detached[i].frame) from here on`;
    }
    return out;
  };

  /**
   * Arrange nodes in a uniform grid — the atlas layout step.
   *
   * ABSOLUTE geometry in, ABSOLUTE geometry out: `origin` and the returned cell
   * boxes are document coordinates, converted to the parent's own space
   * internally, because `node.x` is parent-relative and mixing the two is how a
   * sprite lands one offset away from its cell.
   */
  const grid = (
    nodes: any[],
    o: GridOptions = {},
  ): {
    origin: { x: number; y: number };
    columns: number;
    rows: number;
    cell: { width: number; height: number };
    gap: number;
    width: number;
    height: number;
    cells: Array<{ id: string; name: string; x: number; y: number; width: number; height: number }>;
    resized: Array<{ id: string; name: string; from: [number, number]; to: [number, number]; why?: string }>;
    notes: string[];
  } => {
    if (!Array.isArray(nodes) || !nodes.length) throw new Error("flb.grid: pass the nodes to arrange.");
    const gap = o.gap ?? 0;
    const notes: string[] = [];

    // Everything is measured BEFORE reparenting: appendChild keeps a node's
    // LOCAL position, so the absolute geometry changes the moment the parent
    // does.
    const boxes = nodes.map((n) => bbox(n, { render: true }));
    let cell: { width: number; height: number };
    if (typeof o.cell === "number") {
      cell = { width: o.cell, height: o.cell };
    } else if (o.cell) {
      cell = { width: o.cell.width, height: o.cell.height };
    } else {
      cell = {
        width: round(Math.max(...boxes.map((b) => b.width))),
        height: round(Math.max(...boxes.map((b) => b.height))),
      };
      notes.push("cell sized to the largest render bounds; pass `cell` to make it uniform");
    }
    if (!(cell.width > 0) || !(cell.height > 0)) throw new Error("flb.grid: cell must have a positive width and height.");

    const columns = o.columns ?? Math.ceil(Math.sqrt(nodes.length));
    if (!(columns >= 1)) throw new Error("flb.grid: columns must be at least 1.");
    const rows = Math.ceil(nodes.length / columns);
    const origin = o.origin ?? { x: boxes[0].x, y: boxes[0].y };

    const parent = o.parent ?? null;
    if (!parent) {
      // Without a target parent the nodes keep theirs, and one grid only makes
      // sense in ONE coordinate space. Silently mixing two parents would place
      // every node in the second one somewhere its own math did not say.
      const parents = new Set(nodes.map((n) => n.parent?.id ?? "page"));
      if (parents.size > 1) {
        throw new Error(
          `flb.grid: the nodes live in ${parents.size} different parents (${[...parents].join(", ")}) — ` +
            `pass \`parent\` to place them together, or run one grid per parent.`,
        );
      }
    }
    if (parent) {
      claim(parent, "flb.grid");
      samePage(parent, "flb.grid");
      if (parent.layoutMode && parent.layoutMode !== "NONE") {
        const loose = nodes.filter((n) => n.layoutPositioning !== "ABSOLUTE");
        if (loose.length) {
          throw new Error(
            `flb.grid: ${describe(parent)} uses auto-layout (${parent.layoutMode}) and places its children itself — ` +
              `${loose.length} of ${nodes.length} node(s) would be ignored where the grid puts them. ` +
              `Set layoutPositioning = "ABSOLUTE" on those nodes first, or pass a plain frame.`,
          );
        }
      }
      for (const n of nodes) parent.appendChild(n);
    }

    // Absolute coordinates become local to the space the nodes actually sit in.
    const base = originOf(parent ?? nodes[0].parent ?? api.currentPage);
    const resized: Array<{ id: string; name: string; from: [number, number]; to: [number, number]; why?: string }> = [];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const col = i % columns;
      const row = Math.floor(i / columns);
      const cellX = origin.x + col * (cell.width + gap);
      const cellY = origin.y + row * (cell.height + gap);

      let box = boxes[i];
      if (o.fit && (box.width > cell.width || box.height > cell.height)) {
        const before: [number, number] = [box.width, box.height];
        const scale = Math.min(cell.width / box.width, cell.height / box.height);
        const why = resizeTo(node, box.width * scale, box.height * scale);
        box = bbox(node, { render: true });
        resized.push({ id: node.id, name: node.name, from: before, to: [box.width, box.height], why });
        if (why) notes.push(`${describe(node)}: ${why}`);
      }

      const x = round(cellX + (cell.width - box.width) / 2 - base.x);
      const y = round(cellY + (cell.height - box.height) / 2 - base.y);
      setPos(node, x, y);
    }

    return {
      origin: { x: round(origin.x), y: round(origin.y) },
      columns,
      rows,
      cell: { width: round(cell.width), height: round(cell.height) },
      gap,
      width: round(columns * cell.width + (columns - 1) * gap),
      height: round(rows * cell.height + (rows - 1) * gap),
      cells: nodes.map((node, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        return {
          id: node.id,
          name: node.name,
          x: round(origin.x + col * (cell.width + gap)),
          y: round(origin.y + row * (cell.height + gap)),
          width: round(cell.width),
          height: round(cell.height),
        };
      }),
      resized,
      notes,
    };
  };

  /**
   * Set a node's size, or say why it cannot be set. Plain `resize()` fails on
   * an INSTANCE and is ignored on a HUG-sized auto-layout frame and on text
   * with auto-resize on — three failures that read as "the resize did nothing".
   */
  function resizeTo(node: any, width: number, height: number): string | undefined {
    if (node.type === "INSTANCE") {
      throw new Error(
        `flb.grid/fit: ${describe(node)} is an INSTANCE and cannot be resized directly — its size belongs to the main component. ` +
          `Detach it first (flb.flatten), then resize.`,
      );
    }
    if (node.layoutMode && node.layoutMode !== "NONE") {
      const hug =
        node.layoutSizingHorizontal === "HUG" || node.layoutSizingVertical === "HUG"
          ? "HUG"
          : node.layoutSizingHorizontal === "FILL" || node.layoutSizingVertical === "FILL"
            ? "FILL"
            : null;
      if (hug) {
        throw new Error(
          `flb.grid/fit: ${describe(node)} sizes itself from its contents (layoutSizing ${hug}) and ignores resize() — ` +
            `set layoutSizingHorizontal/Vertical = "FIXED" first.`,
        );
      }
    }
    if (node.type === "TEXT" && node.textAutoResize !== "NONE") {
      const was = node.textAutoResize;
      node.textAutoResize = "NONE";
      node.resize(round(width), round(height));
      return `textAutoResize was ${was} and was set to NONE, otherwise the size would not stick`;
    }
    node.resize(round(width), round(height));
    return undefined;
  }

  /** `node.x` is parent-relative; nothing to convert when the parent is the page. */
  function setPos(node: any, x: number, y: number) {
    node.x = x;
    node.y = y;
  }

  /**
   * Create a text node with the font actually loaded — the step every
   * hand-written snippet forgets, and whose error message ("font could not be
   * loaded") points at the font rather than at the missing load call.
   */
  const text = async (content: string, o: TextOptions = {}): Promise<any> => {
    const font = parseFont(o.font);
    try {
      await api.loadFontAsync(font);
    } catch (e) {
      throw new Error(
        `flb.text: the font "${font.family} ${font.style}" could not be loaded (${msg(e)}) — ` +
          `check the family and style names (figma.listAvailableFontsAsync lists them), and remember every write to ` +
          `characters needs figma.loadFontAsync for that font first.`,
      );
    }
    const node = api.createText();
    node.fontName = font; // after the load, before any character is written
    node.characters = String(content);
    if (o.size !== undefined) node.fontSize = o.size;
    node.name = o.name ?? (String(content).slice(0, 40) || "text");
    if (o.align) node.textAlignHorizontal = o.align;
    if (o.autoResize) node.textAutoResize = o.autoResize;
    if (o.fills !== undefined) node.fills = paintOf(o.fills);

    if (o.parent) {
      claim(o.parent, "flb.text");
      samePage(o.parent, "flb.text");
      o.parent.appendChild(node);
      if (o.x !== undefined || o.y !== undefined) {
        const base = originOf(o.parent);
        // Only the axes the caller named: an unnamed axis keeps where the node landed.
        if (o.x !== undefined) node.x = round(o.x - base.x);
        if (o.y !== undefined) node.y = round(o.y - base.y);
      }
    } else {
      if (!pageWide && scopeRootId) {
        throw new Error(
          `flb.text: with no parent the text lands on the page, which is outside the declared scopeNodeId ${scopeRootId} — ` +
            `pass a parent inside the scope, or declare a wider scopeNodeId.`,
        );
      }
      if (o.x !== undefined) node.x = round(o.x);
      if (o.y !== undefined) node.y = round(o.y);
    }
    return node;
  };

  /** "Inter Bold" or { family, style }; unknown shape is refused by name. */
  function parseFont(font: TextOptions["font"]): { family: string; style: string } {
    if (!font) return { family: "Inter", style: "Regular" };
    if (typeof font === "string") {
      const at = font.trim().lastIndexOf(" ");
      if (at <= 0) return { family: font.trim(), style: "Regular" };
      return { family: font.trim().slice(0, at), style: font.trim().slice(at + 1) };
    }
    if (typeof font === "object" && font.family) return { family: String(font.family), style: String(font.style ?? "Regular") };
    throw new Error(`flb.text: font must be "Family Style" or { family, style } (got ${JSON.stringify(font)}).`);
  }

  /**
   * A hex string becomes a ONE-ELEMENT fill array through
   * `figma.util.solidPaint` (which also takes "#RRGGBBAA"); an array is passed
   * through. `solidPaint(hex)` returns a single SolidPaint, and assigning that
   * to `node.fills` fails validation in the real API ("Expected array, received
   * object") — the reason this wrapper returns an array. Hand-rolling
   * `{ r, g, b }` is where the 0–255 / 0–1 scale mistake lives.
   */
  function paintOf(fills: string | readonly any[]): any {
    if (typeof fills !== "string") return fills;
    if (!api.util || typeof api.util.solidPaint !== "function") {
      throw new Error("flb.text: figma.util.solidPaint is missing, so a hex string cannot be converted — pass a paint array.");
    }
    return [api.util.solidPaint(fills)];
  }

  return { byId, find, one, bbox, clear, flatten, grid, text };
}

export type Flab = ReturnType<typeof makeHelpers>;
