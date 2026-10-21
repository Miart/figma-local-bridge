/// <reference types="@figma/plugin-typings" />

/**
 * Read-only design-system audit.
 *
 * The output is deliberately boring: one finding per node per rule, with a
 * path, the rule, a severity and the value that caused it. It never edits. That
 * is what makes it usable before a handoff and in CI-style checks — a report
 * that changes the file is not a report.
 *
 * The rules are the ones that actually go wrong in a Figma file:
 *
 *   - a built tree has gained a node nobody keyed (a manual edit);
 *   - two nodes claim the same stable key;
 *   - a fill/stroke is a literal instead of a style or variable;
 *   - text has no text style;
 *   - placeholder copy survived into the design;
 *   - a detached instance lost its main component;
 *   - text contrast is below WCAG AA against its effective background;
 *   - spacing/radius is off the team's scale (opt-in, because it is noisy).
 */

import { KEY_DATA, BUILD_DATA, PROTECTED_DATA } from "./ui-build";

export const AUDIT_SCHEMA = "audit-v2";

type Json = any;

const DEFAULT_RULES = [
  "duplicate-key",
  "unkeyed-node",
  "hardcoded-fill",
  "hardcoded-stroke",
  "unstyled-text",
  "placeholder-text",
  "detached-instance",
  "contrast",
  "default-name",
];

const RULES: Record<string, { description: string; severity: string }> = {
  "duplicate-key": { description: "two nodes share the same stable key", severity: "error" },
  "unkeyed-node": { description: "a node inside a built tree has no stable key", severity: "warning" },
  "hardcoded-fill": { description: "a visible solid fill is a literal, not a style or variable", severity: "warning" },
  "hardcoded-stroke": { description: "a visible solid stroke is a literal, not a style or variable", severity: "warning" },
  "unstyled-text": { description: "text has no text style", severity: "warning" },
  "placeholder-text": { description: "placeholder copy is still in the design", severity: "warning" },
  "detached-instance": { description: "an instance has no reachable main component", severity: "warning" },
  contrast: { description: "text contrast is below WCAG AA against its effective background", severity: "error" },
  "default-name": { description: "a layer still has a default Figma name", severity: "info" },
  "empty-text": { description: "a visible text layer has no characters", severity: "warning" },
  "hardcoded-effect": { description: "a visible effect is a literal, not an effect style", severity: "warning" },
  spacing: { description: "auto-layout spacing is off the chosen scale", severity: "info" },
  radius: { description: "corner radius is off the chosen scale", severity: "info" },
};

const PLACEHOLDER = /(lorem ipsum|\bTBD\b|\bTODO\b|placeholder|click here|coming soon)/i;
const DEFAULT_NAME = /^(Frame|Rectangle|Ellipse|Line|Text|Group|Component|Instance|Section|Slice)\s+\d+$/;

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const errMsg = (e: any) => String(e && e.message ? e.message : e);

function isMixed(v: any, ctx: any): boolean {
  return v === ctx.mixed || v === Symbol.for("figma.mixed") || typeof v === "symbol";
}

function cssColor(c: { r: number; g: number; b: number }): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function alpha(paint: any, nodeOpacity = 1): number {
  const a = paint.opacity === undefined ? 1 : Number(paint.opacity);
  return Math.max(0, Math.min(1, a)) * Math.max(0, Math.min(1, Number(nodeOpacity)));
}

function visibleSolid(fills: any, ctx: any, nodeOpacity = 1): { color: any; opacity: number; hex: string } | null {
  if (!Array.isArray(fills)) return null;
  let found: any = null;
  for (const p of fills) {
    if (!p || p.visible === false) continue;
    if (p.type !== "SOLID") {
      // An image or gradient has no single background/foreground colour to
      // compare. Refusing to guess is the honest answer.
      return null;
    }
    found = p;
  }
  if (!found || !found.color) return null;
  return { color: found.color, opacity: alpha(found, nodeOpacity), hex: cssColor(found.color) };
}

function composite(fg: { r: number; g: number; b: number }, a: number, bg: { r: number; g: number; b: number }) {
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

function effectiveBackground(node: any, ctx: any): { color: any; opacity: number; hex: string; source: string } | null {
  // Collect the ancestors bottom-to-top, then composite in that order. Returning
  // as soon as a translucent fill was found used to ignore a solid card behind
  // it; the text colour was then compared with white, not with the card.
  const chain: any[] = [];
  let current: any = node.parent;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.visible === false) {
      current = current.parent;
      continue;
    }
    if (current.blendMode && current.blendMode !== "NORMAL" && current.blendMode !== "PASS_THROUGH") return null;
    chain.unshift(current);
    current = current.parent;
  }

  let result = { r: 1, g: 1, b: 1 };
  let coverage = 0;
  const sources: string[] = [];
  for (const ancestor of chain) {
    const parentOpacity = Math.max(0, Math.min(1, Number(ancestor.opacity === undefined ? 1 : ancestor.opacity)));
    const fills = ancestor.fills;
    if (!Array.isArray(fills)) continue;
    // Figma lists the topmost fill first; composite from the bottom of the stack.
    for (let i = fills.length - 1; i >= 0; i--) {
      const p = fills[i];
      if (!p || p.visible === false) continue;
      if (p.type !== "SOLID" || !p.color) return null;
      const a = alpha(p, parentOpacity);
      result = composite(p.color, a, result);
      coverage = a + coverage * (1 - a);
      if (a > 0) sources.push(`${ancestor.type} ${ancestor.id}`);
    }
  }
  if (!sources.length) return { color: result, opacity: 1, hex: cssColor(result), source: "page" };
  return {
    color: result,
    opacity: 1,
    hex: cssColor(result),
    source: `${sources.slice(0, 4).join(" -> ")}${coverage < 0.999 ? " over white" : ""}`,
  };
}

function luminance(c: { r: number; g: number; b: number }): number {
  const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrastRaw(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return round(contrastRaw(a, b));
}

function isLargeText(node: any): boolean {
  const size = Number(node.fontSize);
  if (!Number.isFinite(size)) return false;
  if (size >= 24) return true;
  const style = node.fontName && typeof node.fontName === "object" ? String(node.fontName.style || "") : "";
  return size >= 18.66 && /bold|semibold|semi bold|black|heavy/i.test(style);
}

function nodeKey(node: any): string {
  try { return node.getPluginData(KEY_DATA) || ""; } catch { return ""; }
}

function buildId(node: any): string {
  try { return node.getPluginData(BUILD_DATA) || ""; } catch { return ""; }
}

function protectedNode(node: any): boolean {
  try { return node.getPluginData(PROTECTED_DATA) === "1"; } catch { return false; }
}

function pathOf(node: any): string {
  const parts: string[] = [];
  let n: any = node;
  while (n && n.type !== "DOCUMENT") {
    parts.unshift(n.name || n.type);
    n = n.parent;
  }
  return parts.join(" / ");
}

function normalizeScale(value: any, name: string): number[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty array of numbers`);
  const out = value.map(Number);
  if (out.some((n) => !Number.isFinite(n) || n < 0)) throw new Error(`${name} values must be non-negative numbers`);
  return [...new Set(out)].sort((a, b) => a - b);
}

function offScale(value: number, scale: number[] | null, multiple: number): boolean {
  if (!Number.isFinite(value) || value === 0) return false;
  if (scale) return !scale.some((s) => Math.abs(s - value) < 0.001);
  return Math.abs(value / multiple - Math.round(value / multiple)) > 0.001;
}

interface PaintStyleCandidate {
  id: string;
  name: string;
  hex: string;
  color: { r: number; g: number; b: number };
}

interface TextStyleCandidate {
  id: string;
  name: string;
  fontName: { family: string; style: string };
  fontSize: number;
}

interface ColorVariableCandidate {
  id: string;
  name: string;
  collection: string;
  modes: string[];
  values: Array<{ mode: string; color: { r: number; g: number; b: number } }>;
}

function validRgb(v: any): v is { r: number; g: number; b: number } {
  if (!v || typeof v !== "object") return false;
  return [v.r, v.g, v.b].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1);
}

function rgbEqual(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  // Exact at 8-bit resolution is the only colour match the audit calls safe.
  const epsilon = 1 / 255 + 1e-6;
  return Math.abs(a.r - b.r) <= epsilon && Math.abs(a.g - b.g) <= epsilon && Math.abs(a.b - b.b) <= epsilon;
}

async function loadPaintStyles(ctx: any, warnings: string[]): Promise<PaintStyleCandidate[]> {
  if (!ctx || typeof ctx.getLocalPaintStylesAsync !== "function") return [];
  let styles: any[] = [];
  try {
    styles = await ctx.getLocalPaintStylesAsync();
  } catch (e) {
    warnings.push(`paint-style suggestions unavailable: ${errMsg(e)}`);
    return [];
  }
  const out: PaintStyleCandidate[] = [];
  for (const style of styles || []) {
    if (!style || typeof style.id !== "string" || !style.id) continue;
    const visible = (Array.isArray(style.paints) ? style.paints : []).filter((p: any) => p && p.visible !== false);
    if (visible.length !== 1) continue;
    const paint = visible[0];
    if (paint.type !== "SOLID" || !validRgb(paint.color)) continue;
    if (paint.blendMode && paint.blendMode !== "NORMAL") continue;
    const opacity = paint.opacity === undefined ? 1 : Number(paint.opacity);
    if (!Number.isFinite(opacity) || Math.abs(opacity - 1) > 1e-6) continue;
    out.push({
      id: style.id,
      name: String(style.name || style.id),
      hex: cssColor(paint.color),
      color: { r: paint.color.r, g: paint.color.g, b: paint.color.b },
    });
  }
  return out;
}

async function loadTextStyles(ctx: any, warnings: string[]): Promise<TextStyleCandidate[]> {
  if (!ctx || typeof ctx.getLocalTextStylesAsync !== "function") return [];
  let styles: any[] = [];
  try {
    styles = await ctx.getLocalTextStylesAsync();
  } catch (e) {
    warnings.push(`text-style suggestions unavailable: ${errMsg(e)}`);
    return [];
  }
  const out: TextStyleCandidate[] = [];
  for (const style of styles || []) {
    if (!style || typeof style.id !== "string" || !style.id) continue;
    const fontName = style.fontName;
    const fontSize = Number(style.fontSize);
    if (!fontName || typeof fontName !== "object" || typeof fontName.family !== "string" || typeof fontName.style !== "string") continue;
    if (!Number.isFinite(fontSize) || fontSize <= 0) continue;
    out.push({
      id: style.id,
      name: String(style.name || style.id),
      fontName: { family: fontName.family, style: fontName.style },
      fontSize,
    });
  }
  return out;
}

async function loadColorVariables(ctx: any, warnings: string[]): Promise<ColorVariableCandidate[]> {
  const api = ctx && ctx.variables;
  if (!api || typeof api.getLocalVariableCollectionsAsync !== "function" || typeof api.getLocalVariablesAsync !== "function") {
    return [];
  }
  try {
    const [collections, variables] = await Promise.all([
      api.getLocalVariableCollectionsAsync(),
      api.getLocalVariablesAsync("COLOR"),
    ]);
    const byId = new Map<string, any>((collections || []).map((c: any) => [c.id, c]));
    const out: ColorVariableCandidate[] = [];
    for (const variable of variables || []) {
      if (!variable || variable.resolvedType !== "COLOR") continue;
      const collection = byId.get(variable.variableCollectionId);
      if (!collection) continue;
      const modes = Array.isArray(collection.modes) ? collection.modes : [];
      const values: Array<{ mode: string; color: { r: number; g: number; b: number } }> = [];
      for (const mode of modes) {
        const raw = variable.valuesByMode ? variable.valuesByMode[mode.modeId] : undefined;
        if (validRgb(raw)) values.push({ mode: String(mode.name), color: { r: raw.r, g: raw.g, b: raw.b } });
      }
      if (!values.length) continue;
      out.push({
        id: String(variable.id),
        name: String(variable.name || variable.id),
        collection: String(collection.name || collection.id),
        modes: modes.map((m: any) => String(m.name)),
        values,
      });
    }
    return out;
  } catch (e) {
    warnings.push(`colour-variable suggestions unavailable: ${errMsg(e)}`);
    return [];
  }
}

function paintSuggestions(color: { r: number; g: number; b: number }, styles: PaintStyleCandidate[]) {
  return styles.filter((style) => rgbEqual(style.color, color)).slice(0, 3);
}

function variableSuggestions(color: { r: number; g: number; b: number }, variables: ColorVariableCandidate[]) {
  return variables
    .map((variable) => {
      const modes = variable.values.filter((v) => rgbEqual(v.color, color)).map((v) => v.mode);
      if (!modes.length) return null;
      return {
        id: variable.id,
        name: variable.name,
        collection: variable.collection,
        modes,
        allModes: modes.length === variable.modes.length,
      };
    })
    .filter((v): v is NonNullable<typeof v> => !!v)
    .sort((a, b) => Number(b.allModes) - Number(a.allModes) || a.name.localeCompare(b.name) || a.collection.localeCompare(b.collection))
    .slice(0, 3);
}

function textStyleSuggestions(node: any, styles: TextStyleCandidate[]): TextStyleCandidate[] {
  const fontName = node && node.fontName;
  const fontSize = Number(node && node.fontSize);
  if (!fontName || typeof fontName !== "object" || typeof fontName.family !== "string" || typeof fontName.style !== "string") return [];
  if (!Number.isFinite(fontSize)) return [];
  return styles
    .filter((style) => style.fontName.family === fontName.family && style.fontName.style === fontName.style && Math.abs(style.fontSize - fontSize) < 0.01)
    .slice(0, 3);
}

function nearestOnScale(value: number, scale: number[] | null, multiple: number): number {
  if (scale && scale.length) {
    return scale.reduce((best, candidate) => (Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best), scale[0]);
  }
  return multiple * Math.round(value / multiple);
}

export async function runAudit(ctx: any, params: Json = {}): Promise<Json> {
  const t0 = Date.now();
  const root: any = params.rootNodeId
    ? await ctx.getNodeByIdAsync(String(params.rootNodeId))
    : ctx.currentPage;
  if (!root) throw new Error("audit root not found: " + params.rootNodeId);
  if (root.removed === true) throw new Error(`audit root ${root.id} has been removed`);

  const requested = params.rules === undefined ? DEFAULT_RULES.slice() : params.rules;
  if (!Array.isArray(requested) || !requested.length) throw new Error("rules must be a non-empty array");
  const active = requested.map(String);
  for (const rule of active) {
    if (!RULES[rule]) throw new Error(`unknown audit rule "${rule}". Available: ${Object.keys(RULES).join(", ")}`);
  }
  const ruleSet = new Set(active);
  const warnings: string[] = [];
  const suggestionsEnabled = params.suggest !== false;
  const needsPaintSuggestions = suggestionsEnabled && (ruleSet.has("hardcoded-fill") || ruleSet.has("hardcoded-stroke"));
  const paintStyles = needsPaintSuggestions ? await loadPaintStyles(ctx, warnings) : [];
  const colorVariables = needsPaintSuggestions ? await loadColorVariables(ctx, warnings) : [];
  const textStyles = suggestionsEnabled && ruleSet.has("unstyled-text") ? await loadTextStyles(ctx, warnings) : [];
  const suggestionCounts = { paintStyles: 0, colorVariables: 0, textStyles: 0 };
  const spacingScale = normalizeScale(params.spacingScale, "spacingScale");
  const radiusScale = normalizeScale(params.radiusScale, "radiusScale");
  const spacingMultiple = params.spacingMultiple === undefined ? 4 : Number(params.spacingMultiple);
  const radiusMultiple = params.radiusMultiple === undefined ? 4 : Number(params.radiusMultiple);
  if (!Number.isFinite(spacingMultiple) || spacingMultiple <= 0) throw new Error("spacingMultiple must be > 0");
  if (!Number.isFinite(radiusMultiple) || radiusMultiple <= 0) throw new Error("radiusMultiple must be > 0");

  const includeHidden = params.includeHidden === true;
  const maxNodes = Math.max(1, Math.min(Number(params.maxNodes ?? 2000), 10000));
  const maxFindings = Math.max(1, Math.min(Number(params.maxFindings ?? 200), 5000));

  const counts = { error: 0, warning: 0, info: 0, total: 0 };
  const byRule: Record<string, number> = {};
  const findings: Json[] = [];
  let findingsTruncated = 0;
  let nodesScanned = 0;
  let truncated = false;
  const keyed = new Map<string, any[]>();

  const add = (rule: string, node: any, detail: string, extra: Json = {}) => {
    const severity = RULES[rule].severity;
    counts[severity as "error" | "warning" | "info"]++;
    counts.total++;
    byRule[rule] = (byRule[rule] || 0) + 1;
    if (findings.length >= maxFindings) {
      findingsTruncated++;
      return;
    }
    findings.push({
      rule,
      severity,
      nodeId: node.id,
      nodeKey: nodeKey(node),
      name: node.name,
      type: node.type,
      path: pathOf(node),
      detail,
      ...extra,
    });
  };

  const visit = async (node: any, builtRoot: any) => {
    if (truncated) return;
    if (!includeHidden && node.visible === false) return;
    nodesScanned++;
    if (nodesScanned > maxNodes) {
      truncated = true;
      return;
    }
    const ownBuild = buildId(node);
    const activeBuild = ownBuild ? node : builtRoot;

    if (ruleSet.has("duplicate-key")) {
      const k = nodeKey(node);
      if (k) {
        const list = keyed.get(k) || [];
        list.push(node);
        keyed.set(k, list);
      }
    }
    if (ruleSet.has("unkeyed-node") && activeBuild && node.id !== activeBuild.id) {
      if (!nodeKey(node)) add("unkeyed-node", node, `inside built tree "${activeBuild.name}"; add a key or edit through figma_patch`);
    }
    if (ruleSet.has("default-name") && DEFAULT_NAME.test(String(node.name || ""))) {
      add("default-name", node, `layer name "${node.name}" is a Figma default`);
    }
    if (ruleSet.has("hardcoded-fill") && Array.isArray(node.fills) && node.fills.length) {
      const styleId = node.fillStyleId;
      const styleBound = typeof styleId === "string" && styleId.length > 0;
      const varBound = node.fills.some((p: any) => p && p.boundVariables && p.boundVariables.color);
      if (!styleBound && !varBound) {
        const solid = visibleSolid(node.fills, ctx, node.opacity);
        if (solid && solid.opacity > 0.001) {
          const paintMatches = solid.opacity >= 0.999 ? paintSuggestions(solid.color, paintStyles) : [];
          const variableMatches = variableSuggestions(solid.color, colorVariables);
          if (paintMatches.length) suggestionCounts.paintStyles++;
          if (variableMatches.length) suggestionCounts.colorVariables++;
          add("hardcoded-fill", node, `fill ${solid.hex} is a literal, not a paint style or variable`, {
            value: solid.hex,
            ...(paintMatches.length || variableMatches.length
              ? { suggestions: { ...(paintMatches.length ? { paintStyles: paintMatches } : {}), ...(variableMatches.length ? { colorVariables: variableMatches } : {}) } }
              : {}),
          });
        }
      }
    }
    if (ruleSet.has("hardcoded-stroke") && Array.isArray(node.strokes) && node.strokes.length) {
      const styleId = node.strokeStyleId;
      const styleBound = typeof styleId === "string" && styleId.length > 0;
      const varBound = node.strokes.some((p: any) => p && p.boundVariables && p.boundVariables.color);
      if (!styleBound && !varBound) {
        const solid = visibleSolid(node.strokes, ctx, node.opacity);
        if (solid && solid.opacity > 0.001) {
          const paintMatches = solid.opacity >= 0.999 ? paintSuggestions(solid.color, paintStyles) : [];
          const variableMatches = variableSuggestions(solid.color, colorVariables);
          if (paintMatches.length) suggestionCounts.paintStyles++;
          if (variableMatches.length) suggestionCounts.colorVariables++;
          add("hardcoded-stroke", node, `stroke ${solid.hex} is a literal, not a paint style or variable`, {
            value: solid.hex,
            ...(paintMatches.length || variableMatches.length
              ? { suggestions: { ...(paintMatches.length ? { paintStyles: paintMatches } : {}), ...(variableMatches.length ? { colorVariables: variableMatches } : {}) } }
              : {}),
          });
        }
      }
    }
    if (node.type === "TEXT") {
      if (ruleSet.has("unstyled-text")) {
        const styleId = node.textStyleId;
        if (!(typeof styleId === "string" && styleId.length > 0)) {
          const textMatches = textStyleSuggestions(node, textStyles);
          if (textMatches.length) suggestionCounts.textStyles++;
          add("unstyled-text", node, "text has no local text style", {
            ...(textMatches.length ? { suggestions: { textStyles: textMatches } } : {}),
          });
        }
      }
      if (ruleSet.has("empty-text") && typeof node.characters === "string" && node.characters.trim() === "") {
        add("empty-text", node, "visible text layer has no characters");
      }
      if (ruleSet.has("placeholder-text") && typeof node.characters === "string" && PLACEHOLDER.test(node.characters)) {
        add("placeholder-text", node, `copy looks like placeholder: "${node.characters.slice(0, 80)}"`);
      }
      if (ruleSet.has("contrast") && (!node.blendMode || node.blendMode === "NORMAL" || node.blendMode === "PASS_THROUGH")) {
        const fg = visibleSolid(node.fills, ctx, node.opacity);
        const bg = effectiveBackground(node, ctx);
        if (fg && bg) {
          // A translucent fill is not its own colour on screen: composite it
          // over the background before measuring, or 50% white on black reads
          // as pure white and passes a contrast it does not have.
          const shown = fg.opacity < 0.999 ? composite(fg.color, fg.opacity, bg.color) : fg.color;
          const shownHex = cssColor(shown);
          const raw = contrastRaw(shown, bg.color);
          const ratio = round(raw);
          const large = isLargeText(node);
          const threshold = large ? 3 : 4.5;
          // Compare the unrounded ratio: 4.497 must not become a passing 4.5.
          if (raw < threshold) {
            add(
              "contrast",
              node,
              `contrast ${ratio}:1 (${shownHex} on ${bg.hex}) is below ${large ? "3:1 for large text" : "4.5:1 for normal text"}`,
              {
                ratio,
                threshold,
                foreground: shownHex,
                foregroundOpacity: round(fg.opacity),
                background: bg.hex,
                backgroundSource: bg.source,
                largeText: large,
              },
            );
          }
        }
      }
    }
    if (node.type === "INSTANCE" && ruleSet.has("detached-instance")) {
      try {
        const main = await node.getMainComponentAsync();
        if (!main) add("detached-instance", node, "instance has no main component; it is detached");
      } catch (e) {
        add("detached-instance", node, `main component is unreachable: ${errMsg(e)}`);
      }
    }
    if (ruleSet.has("hardcoded-effect") && Array.isArray(node.effects) && node.effects.length) {
      const styleId = node.effectStyleId;
      const styleBound = typeof styleId === "string" && styleId.length > 0;
      const effects = node.effects.filter((e: any) => e && e.visible !== false && e.type !== "NONE");
      if (!styleBound && effects.length) {
        add("hardcoded-effect", node, `${effects.length} visible effect(s) are literals, not an effect style`, {
          effects: effects.map((e: any) => String(e.type)),
        });
      }
    }
    if (ruleSet.has("spacing") && node.layoutMode && node.layoutMode !== "NONE") {
      const values: Array<[string, any]> = [
        ["itemSpacing", node.itemSpacing],
        ["counterAxisSpacing", node.counterAxisSpacing],
        ["paddingTop", node.paddingTop],
        ["paddingRight", node.paddingRight],
        ["paddingBottom", node.paddingBottom],
        ["paddingLeft", node.paddingLeft],
      ];
      for (const [name, value] of values) {
        if (value === null || value === undefined || isMixed(value, ctx)) continue;
        if (offScale(Number(value), spacingScale, spacingMultiple)) {
          const numeric = Number(value);
          const nearest = nearestOnScale(numeric, spacingScale, spacingMultiple);
          add("spacing", node, `${name} ${value} is off the spacing scale`, {
            property: name,
            value: numeric,
            nearest,
            delta: round(nearest - numeric),
          });
        }
      }
    }
    if (ruleSet.has("radius") && node.cornerRadius !== undefined && !isMixed(node.cornerRadius, ctx) && typeof node.cornerRadius === "number") {
      if (offScale(node.cornerRadius, radiusScale, radiusMultiple)) {
        const nearest = nearestOnScale(node.cornerRadius, radiusScale, radiusMultiple);
        add("radius", node, `cornerRadius ${node.cornerRadius} is off the radius scale`, {
          value: node.cornerRadius,
          nearest,
          delta: round(nearest - node.cornerRadius),
        });
      }
    }
    for (const child of node.children || []) await visit(child, activeBuild);
  };

  await visit(root, buildId(root) ? root : null);

  if (ruleSet.has("duplicate-key")) {
    for (const [key, nodes] of keyed) {
      if (nodes.length < 2) continue;
      for (const node of nodes) {
        add("duplicate-key", node, `key "${key}" is shared by ${nodes.length} nodes: ${nodes.map((n) => n.id).join(", ")}`, {
          duplicateKey: key,
          duplicateNodeIds: nodes.map((n) => n.id),
        });
      }
    }
  }

  if (truncated) warnings.push(`node limit ${maxNodes} reached; the report covers the first ${maxNodes} visible nodes`);
  if (findingsTruncated) warnings.push(`${findingsTruncated} more findings were counted but not listed (maxFindings ${maxFindings})`);

  return {
    schema: AUDIT_SCHEMA,
    scope: { id: root.id, name: root.name, type: root.type },
    rules: active.map((id) => ({ id, ...RULES[id] })),
    nodesScanned,
    truncated,
    includeHidden,
    counts,
    byRule,
    findings,
    findingsTruncated,
    suggestions: { enabled: suggestionsEnabled, ...suggestionCounts },
    warnings,
    ms: { audit: Date.now() - t0 },
  };
}
