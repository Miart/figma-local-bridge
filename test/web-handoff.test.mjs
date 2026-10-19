// Unit tests for the web handoff arithmetic in plugin/exports.ts.
//
// A handoff bundle is consumed by someone who did not watch the document being
// read. The fixtures therefore encode the ways a plausible-looking bundle lies:
// a colour token named after a paint style that is bound to two different
// values, a text style averaged over ranges that have no single font, a font
// assumed to exist on the reader's machine, a preview that is not the size its
// manifest predicts. Every one of those either gets a distinct name or is
// named as missing in the README — the tests pin that down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffFontWeight, handoffSlug, webHandoff } from "../plugin/exports.mjs";

// ---------------------------------------------------------------- fixtures

const color = (r, g, b, a = 1) => ({ r: r / 255, g: g / 255, b: b / 255, a });

const frame = { id: "1:1", name: "Page/Home", type: "FRAME", width: 320, height: 200 };
const previews = [
  { scale: 1, width: 320, height: 200, basis: "boundingBox" },
  { scale: 2, width: 640, height: 400, basis: "boundingBox" },
];

const root = (extra = {}) => ({
  id: "1:1",
  parentId: null,
  depth: 0,
  name: "Page/Home",
  type: "FRAME",
  visible: true,
  box: { x: 0, y: 0, width: 320, height: 200 },
  ...extra,
});

const baseText = () => ({
  characters: "Hello",
  font: { family: "Inter", style: "Bold" },
  fontSize: 32,
  lineHeight: { unit: "PIXELS", value: 40 },
  letterSpacing: { unit: "PIXELS", value: 0 },
  align: "LEFT",
  color: color(17, 17, 17),
});

const textNode = (extra = {}) => ({
  id: "1:2",
  parentId: "1:1",
  depth: 1,
  name: "Title",
  type: "TEXT",
  visible: true,
  box: { x: 16, y: 12, width: 288, height: 40 },
  fillStyle: "Text/Primary",
  textStyle: "Heading/H1",
  text: baseText(),
  ...extra,
});

const frameNode = (id, extra = {}) => ({
  id,
  parentId: "1:1",
  depth: 1,
  name: "Frame " + id,
  type: "FRAME",
  visible: true,
  box: { x: 0, y: 0, width: 100, height: 100 },
  ...extra,
});

const bundle = (nodes, extra = {}) =>
  webHandoff({
    frame,
    nodes: [root(), ...nodes],
    scale: 2,
    previews,
    rev: 7,
    ...extra,
  });

// ---------------------------------------------------------------- spec + tokens

test("handoff: one styled text node produces a spec, colour token, text class and README", () => {
  const b = bundle([textNode()]);

  assert.equal(b.spec.schema, "figma-web-handoff-spec/v1");
  assert.equal(b.spec.source.nodeId, "1:1");
  assert.equal(b.spec.source.rev, 7);
  assert.equal(b.spec.space.units, "px");
  assert.equal(b.spec.nodes.length, 2);
  assert.deepEqual(b.spec.nodes[1].box, { x: 16, y: 12, width: 288, height: 40 });
  assert.equal(b.spec.nodes[1].text.font.family, "Inter");
  assert.equal(b.spec.nodes[1].text.font.weight, 700);
  assert.equal(b.spec.nodes[1].text.token, "text-primary");
  assert.equal(b.spec.nodes[1].text.styleToken, "heading-h1");
  assert.deepEqual(b.spec.nodes[1].styles, { fill: "Text/Primary", text: "Heading/H1" });

  assert.equal(b.tokens.schema, "figma-web-handoff-tokens/v1");
  assert.equal(b.tokens.colors["text-primary"].value, "#111111");
  assert.equal(b.tokens.colors["text-primary"].uses, 1);
  assert.equal(b.tokens.colors["text-primary"].cssVar, "--color-text-primary");
  assert.equal(b.tokens.text["heading-h1"].size, 32);
  assert.equal(b.tokens.text["heading-h1"].font.weight, 700);
  assert.equal(b.tokens.fonts["inter-bold"].weight, 700);

  assert.match(b.css, /--color-text-primary: #111111;/);
  assert.match(b.css, /--font-family-inter: "Inter", sans-serif;/);
  assert.match(b.css, /--font-weight-inter-bold: 700;/);
  assert.match(b.css, /\.heading-h1 \{/);
  assert.match(b.css, /font-size: 32px;/);
  assert.match(b.css, /line-height: 40px;/);
  assert.match(b.css, /text-align: left;/);

  assert.match(b.readme, /not production HTML/);
  assert.match(b.readme, /preview\.png/);
  assert.match(b.readme, /preview@2x\.png/);
  assert.deepEqual(b.counts, { nodes: 2, colors: 1, fonts: 1, textStyles: 1, spacing: 0 });
});

test("handoff: the same colour used twice is one token", () => {
  const b = bundle([textNode(), textNode({ id: "1:3", name: "Subtitle" })]);
  assert.equal(Object.keys(b.tokens.colors).length, 1);
  assert.equal(b.tokens.colors["text-primary"].uses, 2);
  assert.equal(b.tokens.colors["text-primary"].value, "#111111");
});

test("handoff: alpha is part of the token identity and survives into CSS", () => {
  const half = textNode({ text: { ...baseText(), color: color(17, 17, 17, 0.5) } });
  const solid = textNode({ id: "1:3", name: "Solid", fillStyle: "Text/Solid", text: baseText() });
  const b = bundle([half, solid]);

  assert.equal(Object.keys(b.tokens.colors).length, 2);
  assert.equal(b.tokens.colors["text-primary"].value, "rgba(17, 17, 17, 0.5)");
  assert.equal(b.tokens.colors["text-primary"].alpha, 0.5);
  assert.equal(b.tokens.colors["text-solid"].value, "#111111");
  assert.match(b.css, /--color-text-primary: rgba\(17, 17, 17, 0.5\);/);
});

test("handoff: one paint style bound to two colours does not get to name both", () => {
  const red = textNode({ id: "1:2", text: { ...baseText(), color: color(255, 0, 0) } });
  const blue = textNode({ id: "1:3", name: "Blue", text: { ...baseText(), color: color(0, 0, 255) } });
  const b = bundle([red, blue]);

  assert.deepEqual(Object.keys(b.tokens.colors), ["text-primary", "color-2"]);
  assert.match(b.warnings.join(" "), /paint style name\(s\) are bound to more than one colour/);
  assert.match(b.warnings.join(" "), /collided/);
});

test("handoff: two style names that slug to the same token are disambiguated, not merged", () => {
  const a = textNode({ id: "1:2", fillStyle: "Primary/500", text: { ...baseText(), color: color(1, 2, 3) } });
  const b = textNode({ id: "1:3", name: "Other", fillStyle: "Primary 500", text: { ...baseText(), color: color(4, 5, 6) } });
  const out = bundle([a, b]);

  assert.deepEqual(Object.keys(out.tokens.colors), ["primary-500", "color-2"]);
  assert.equal(out.tokens.colors["primary-500"].value, "#010203");
  assert.equal(out.tokens.colors["color-2"].value, "#040506");
  assert.match(out.warnings.join(" "), /collided/);
});

// ---------------------------------------------------------------- text + fonts

test("handoff: font style names map to CSS weights, and an unknown one is said out loud", () => {
  assert.equal(handoffFontWeight("Regular"), 400);
  assert.equal(handoffFontWeight("Semi Bold"), 600);
  assert.equal(handoffFontWeight("Bold Italic"), 700);
  assert.equal(handoffFontWeight("Cyrillic Display"), null);

  const b = bundle([textNode({ text: { ...baseText(), font: { family: "Inter", style: "Cyrillic Display" } } })]);
  const font = b.tokens.fonts["inter-cyrillic-display"];
  assert.equal(font.weight, undefined);
  assert.match(b.warnings.join(" "), /no CSS weight mapping/);
  assert.doesNotMatch(b.css, /font-weight: undefined/);
  assert.doesNotMatch(b.css, /font-weight: var\(\)/);
});

test("handoff: mixed text keeps segments instead of inventing one style", () => {
  const mixed = textNode({
    id: "1:3",
    name: "Mixed",
    textStyle: null,
    text: {
      characters: "Hi there",
      mixed: true,
      align: "LEFT",
      segments: [
        { characters: "Hi ", font: { family: "Inter", style: "Bold" }, fontSize: 32, color: color(17, 17, 17) },
        { characters: "there", font: { family: "Inter", style: "Regular" }, fontSize: 16, color: color(0, 0, 255) },
      ],
    },
  });
  const b = bundle([mixed]);
  const node = b.spec.nodes[1];

  assert.equal(node.text.mixed, true);
  assert.equal(node.text.segments.length, 2);
  assert.equal(node.text.segments[1].font.style, "Regular");
  assert.equal(node.text.segments[1].fontSize, 16);
  assert.equal(node.text.styleToken, undefined);
  assert.equal(b.counts.textStyles, 0);
  assert.equal(Object.keys(b.tokens.fonts).length, 2);
  assert.match(b.warnings.join(" "), /mix fonts/);
});

test("handoff: a missing font stays in the tokens and is named in the README", () => {
  const b = bundle([textNode()], { missingFonts: ["Inter Bold"] });
  assert.equal(b.tokens.fonts["inter-bold"].weight, 700);
  assert.match(b.warnings.join(" "), /could not be loaded: Inter Bold/);
  assert.match(b.readme, /could not be loaded: Inter Bold/);
  assert.match(b.readme, /will substitute/);
});

test("handoff: a font the time-boxed check could not confirm is called unchecked, not present", () => {
  const b = bundle([textNode()], { uncheckedFonts: ["Stolzl Medium"] });
  assert.equal(b.tokens.fonts["inter-bold"].weight, 700);
  assert.match(b.warnings.join(" "), /not confirmed within the check's time budget: Stolzl Medium/);
  assert.match(b.readme, /whether this machine can render them is unknown/);
  assert.doesNotMatch(b.warnings.join(" "), /could not be loaded/);
});

test("handoff: percent line-height and letter-spacing keep their units", () => {
  const b = bundle([
    textNode({
      text: { ...baseText(), lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PERCENT", value: 5 }, align: "CENTER" },
    }),
  ]);
  assert.match(b.css, /line-height: 120%;/);
  assert.match(b.css, /letter-spacing: 5%;/);
  assert.match(b.css, /text-align: center;/);
});

test("handoff: text case and decoration reach both the spec and the class", () => {
  const b = bundle([textNode({ text: { ...baseText(), textCase: "UPPER", textDecoration: "UNDERLINE" } })]);
  assert.equal(b.spec.nodes[1].text.textCase, "UPPER");
  assert.equal(b.spec.nodes[1].text.textDecoration, "UNDERLINE");
  assert.equal(b.tokens.text["heading-h1"].textCase, "UPPER");
  assert.equal(b.tokens.text["heading-h1"].textDecoration, "UNDERLINE");
  assert.match(b.css, /text-transform: uppercase;/);
  assert.match(b.css, /text-decoration: underline;/);
});

// ---------------------------------------------------------------- spacing + paints

test("handoff: spacing is deduplicated and sorted, and negative spacing is not a token", () => {
  const b = bundle([
    frameNode("1:2", { layout: { mode: "VERTICAL", itemSpacing: 16, padding: { top: 8, right: 8, bottom: 8, left: 8 } } }),
    frameNode("1:3", { layout: { mode: "HORIZONTAL", itemSpacing: 4, padding: { top: 0, right: 0, bottom: 0, left: 0 } } }),
    frameNode("1:4", { layout: { mode: "HORIZONTAL", itemSpacing: -2, padding: { top: 0, right: 0, bottom: 0, left: 0 } } }),
    frameNode("1:5", { layout: { mode: "VERTICAL", itemSpacing: 16, padding: { top: 8, right: 8, bottom: 8, left: 8 } } }),
  ]);

  assert.deepEqual(Object.keys(b.tokens.spacing), ["space-4", "space-8", "space-16"]);
  assert.equal(b.tokens.spacing["space-16"], 16);
  assert.match(b.css, /--space-16: 16px;/);
  assert.match(b.warnings.join(" "), /negative spacing/);
});

test("handoff: gradients, images and effects are data, never invented colour tokens", () => {
  const b = bundle([
    frameNode("1:2", {
      type: "RECTANGLE",
      effects: [{ type: "DROP_SHADOW", radius: 8, offset: [0, 2], color: "#00000033" }],
      fills: [
        {
          type: "GRADIENT_LINEAR",
          stops: [
            { at: 0, color: color(255, 0, 0) },
            { at: 1, color: color(0, 0, 255) },
          ],
          opacity: 1,
        },
        { type: "IMAGE", imageHash: "abc123", scaleMode: "FILL" },
      ],
    }),
  ]);
  const node = b.spec.nodes[1];

  assert.equal(Object.keys(b.tokens.colors).length, 0);
  assert.equal(node.fills[0].type, "GRADIENT_LINEAR");
  assert.equal(node.fills[0].stops.length, 2);
  assert.equal(node.fills[0].stops[1].color, "#0000ff");
  assert.equal(node.fills[1].imageHash, "abc123");
  assert.equal(node.effects[0].type, "DROP_SHADOW");
  assert.match(b.warnings.join(" "), /gradient fill/);
  assert.match(b.warnings.join(" "), /image fill/);
  assert.match(b.warnings.join(" "), /carry effects/);
});

test("handoff: hidden, rotated, masked and empty nodes are flagged, not dropped", () => {
  const b = bundle([
    frameNode("1:2", { type: "RECTANGLE", visible: false, rotation: 15, isMask: true, box: null }),
  ]);
  const node = b.spec.nodes[1];

  assert.equal(b.spec.nodes.length, 2);
  assert.equal(node.visible, false);
  assert.equal(node.rotation, 15);
  assert.equal(node.mask, true);
  assert.equal(node.box, null);
  assert.match(b.warnings.join(" "), /hidden node/);
  assert.match(b.warnings.join(" "), /rotated/);
  assert.match(b.warnings.join(" "), /masks/);
  assert.match(b.warnings.join(" "), /no box/);
});

// ---------------------------------------------------------------- previews + determinism

test("handoff: a preview that is not the size its scale predicts is reported", () => {
  const b = webHandoff({
    frame,
    nodes: [root()],
    scale: 2,
    previews: [
      { scale: 1, width: 320, height: 200, basis: "boundingBox" },
      { scale: 2, width: 600, height: 400, basis: "nodeBox" },
    ],
    rev: 7,
  });

  assert.match(b.warnings.join(" "), /the 2x preview is 600x400/);
  assert.match(b.warnings.join(" "), /own box rather than its bounding box/);
});

test("handoff: a missing 1x preview is named, not silently assumed", () => {
  const b = webHandoff({ frame, nodes: [root()], scale: 2, previews: [{ scale: 2, width: 640, height: 400 }], rev: 7 });
  assert.match(b.warnings.join(" "), /no 1x preview/);
});

test("handoff: the bundle is deterministic for the same facts", () => {
  assert.deepEqual(bundle([textNode()]), bundle([textNode()]));
});

test("handoff: slugs are CSS-safe and non-Latin names fall back to the caller's", () => {
  assert.equal(handoffSlug("Brand / Primary 500"), "brand-primary-500");
  assert.equal(handoffSlug("Заголовок"), "");
  assert.equal(handoffSlug("——"), "");
});
