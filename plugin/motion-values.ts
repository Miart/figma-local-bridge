/**
 * Validation for Motion keyframe fields and values.
 *
 * This module knows the shapes but touches no document. Keeping it apart from
 * the read/write commands means a bad keyframe is refused before a transaction
 * is opened, and the rules can be unit-tested without a Figma stub.
 */
import {
  EFFECT_FIELDS, EASING_TYPES, PROPERTY_FIELDS, VALUE_TYPES,
  canonical, clean, fail, finite,
  type Json,
} from "./motion-core";

const isObject = (v: any): boolean => !!v && typeof v === "object" && !Array.isArray(v);

function num(v: any, path: string): number {
  if (!finite(v)) fail("MOTION_INVALID", `${path} must be a finite number`);
  return v;
}

function color(v: any, path: string): Json {
  if (!isObject(v)) fail("MOTION_INVALID", `${path} must be { r, g, b, a }`);
  for (const k of ["r", "g", "b", "a"]) {
    const c = num(v[k], `${path}.${k}`);
    if (c < 0 || c > 1) fail("MOTION_INVALID", `${path}.${k} must be between 0 and 1`);
  }
  return { r: v.r, g: v.g, b: v.b, a: v.a };
}

export function normalizeValue(v: any, path = "value"): Json {
  if (!isObject(v)) fail("MOTION_INVALID", `${path} must be a keyframe value object`);
  if (!VALUE_TYPES.has(v.type)) {
    fail("MOTION_INVALID", `${path}.type must be one of ${[...VALUE_TYPES].join(", ")}`);
  }
  switch (v.type) {
    case "FLOAT":
      return { type: "FLOAT", value: num(v.value, `${path}.value`) };
    case "COLOR":
      return { type: "COLOR", value: color(v.value, `${path}.value`) };
    case "TEXT_DATA":
      if (typeof v.value !== "string") fail("MOTION_INVALID", `${path}.value must be a string`);
      return { type: "TEXT_DATA", value: v.value };
    case "VECTOR": {
      if (!isObject(v.value)) fail("MOTION_INVALID", `${path}.value must be { x, y }`);
      return { type: "VECTOR", value: { x: num(v.value.x, `${path}.value.x`), y: num(v.value.y, `${path}.value.y`) } };
    }
    case "BOOL":
      if (typeof v.value !== "boolean") fail("MOTION_INVALID", `${path}.value must be a boolean`);
      return { type: "BOOL", value: v.value };
    case "CIRCLE": {
      if (!isObject(v.value)) fail("MOTION_INVALID", `${path}.value must be { x, y, radius }`);
      return {
        type: "CIRCLE",
        value: {
          x: num(v.value.x, `${path}.value.x`),
          y: num(v.value.y, `${path}.value.y`),
          radius: num(v.value.radius, `${path}.value.radius`),
        },
      };
    }
    case "LINE": {
      if (!isObject(v.value)) fail("MOTION_INVALID", `${path}.value must be { x, y, x2, y2 }`);
      return {
        type: "LINE",
        value: {
          x: num(v.value.x, `${path}.value.x`),
          y: num(v.value.y, `${path}.value.y`),
          x2: num(v.value.x2, `${path}.value.x2`),
          y2: num(v.value.y2, `${path}.value.y2`),
        },
      };
    }
    case "CIRCLE_POINT": {
      if (!isObject(v.value)) fail("MOTION_INVALID", `${path}.value must be { x, y, radius, angle }`);
      return {
        type: "CIRCLE_POINT",
        value: {
          x: num(v.value.x, `${path}.value.x`),
          y: num(v.value.y, `${path}.value.y`),
          radius: num(v.value.radius, `${path}.value.radius`),
          angle: num(v.value.angle, `${path}.value.angle`),
        },
      };
    }
    case "COLOR_POINT": {
      if (!isObject(v.value)) fail("MOTION_INVALID", `${path}.value must be { x, y, color }`);
      return {
        type: "COLOR_POINT",
        value: {
          x: num(v.value.x, `${path}.value.x`),
          y: num(v.value.y, `${path}.value.y`),
          color: color(v.value.color, `${path}.value.color`),
        },
      };
    }
  }
  return fail("MOTION_INVALID", `${path}.type is not supported`);
}

export function normalizeEasing(e: any, path = "easing"): Json | undefined {
  if (e === undefined) return undefined;
  if (!isObject(e)) fail("MOTION_INVALID", `${path} must be a MotionEasing object`);
  if (e.type === "VARIABLE_ALIAS") {
    if (typeof e.id !== "string" || !e.id) fail("MOTION_INVALID", `${path}.id must be a variable id`);
    return { type: "VARIABLE_ALIAS", id: e.id };
  }
  if (!EASING_TYPES.has(e.type)) {
    fail("MOTION_INVALID", `${path}.type must be one of ${[...EASING_TYPES].join(", ")}`);
  }
  if (e.type === "CUSTOM_CUBIC_BEZIER") {
    const b = e.easingFunctionCubicBezier;
    if (!isObject(b)) fail("MOTION_INVALID", `${path} needs easingFunctionCubicBezier { x1, y1, x2, y2 }`);
    return {
      type: e.type,
      easingFunctionCubicBezier: {
        x1: num(b.x1, `${path}.easingFunctionCubicBezier.x1`),
        y1: num(b.y1, `${path}.easingFunctionCubicBezier.y1`),
        x2: num(b.x2, `${path}.easingFunctionCubicBezier.x2`),
        y2: num(b.y2, `${path}.easingFunctionCubicBezier.y2`),
      },
    };
  }
  if (e.type === "CUSTOM_SPRING") {
    const s = e.easingFunctionSpring;
    if (!isObject(s)) fail("MOTION_INVALID", `${path} needs easingFunctionSpring { bounce }`);
    const bounce = num(s.bounce, `${path}.easingFunctionSpring.bounce`);
    if (bounce < 0 || bounce > 1) fail("MOTION_INVALID", `${path}.easingFunctionSpring.bounce must be 0..1`);
    return { type: e.type, easingFunctionSpring: { bounce } };
  }
  return { type: e.type };
}

export function normalizeField(field: any): Json {
  if (!isObject(field)) fail("MOTION_INVALID", "field must be a KeyframeField object");
  if (field.type === "PROPERTY") {
    if (typeof field.name !== "string" || !PROPERTY_FIELDS.has(field.name)) {
      fail("MOTION_INVALID", `field.name must be one of ${[...PROPERTY_FIELDS].join(", ")}`);
    }
    return { type: "PROPERTY", name: field.name };
  }
  if (field.type !== "INDEXED_ITEM") fail("MOTION_INVALID", "field.type must be PROPERTY or INDEXED_ITEM");
  if (!["fills", "strokes", "effects"].includes(field.collection)) {
    fail("MOTION_INVALID", "field.collection must be fills, strokes or effects");
  }
  if (!Number.isInteger(field.index) || field.index < 0) {
    fail("MOTION_INVALID", "field.index must be an integer >= 0");
  }
  const base = { type: "INDEXED_ITEM", collection: field.collection, index: field.index };
  if (field.collection !== "effects") {
    if (field.field !== undefined) fail("MOTION_INVALID", "field.field is only valid for an effect");
    if (field.propertyId !== undefined) {
      if (typeof field.propertyId !== "string" || !field.propertyId) {
        fail("MOTION_INVALID", "field.propertyId must be a non-empty string");
      }
      return { ...base, propertyId: field.propertyId };
    }
    return base;
  }
  if (field.field !== undefined && field.propertyId !== undefined) {
    fail("MOTION_INVALID", "an effect field is either field or propertyId, not both");
  }
  if (field.field !== undefined) {
    if (typeof field.field !== "string" || !EFFECT_FIELDS.has(field.field)) {
      fail("MOTION_INVALID", `field.field must be one of ${[...EFFECT_FIELDS].join(", ")}`);
    }
    return { ...base, field: field.field };
  }
  if (typeof field.propertyId !== "string" || !field.propertyId) {
    fail("MOTION_INVALID", "an effect needs field or propertyId");
  }
  return { ...base, propertyId: field.propertyId };
}

export function normalizeTrack(raw: any): Json {
  if (!isObject(raw)) fail("MOTION_INVALID", "track must be { baseValue?, keyframes }");
  if (!Array.isArray(raw.keyframes) || raw.keyframes.length < 1) {
    fail("MOTION_INVALID", "track.keyframes must contain at least one keyframe");
  }
  if (raw.keyframes.length > 1000) fail("MOTION_INVALID", "track.keyframes is capped at 1000");
  const positions = new Set<number>();
  const keyframes = raw.keyframes.map((k: any, i: number) => {
    if (!isObject(k)) fail("MOTION_INVALID", `track.keyframes[${i}] must be an object`);
    const timelinePosition = num(k.timelinePosition, `track.keyframes[${i}].timelinePosition`);
    if (timelinePosition < 0) fail("MOTION_INVALID", `track.keyframes[${i}].timelinePosition must be >= 0`);
    if (positions.has(timelinePosition)) {
      fail("MOTION_INVALID", `two keyframes share timelinePosition ${timelinePosition}`);
    }
    positions.add(timelinePosition);
    const value = normalizeValue(k.value, `track.keyframes[${i}].value`);
    const easing = normalizeEasing(k.easing, `track.keyframes[${i}].easing`);
    const out: Json = { timelinePosition, value };
    if (typeof k.id === "string" && k.id) out.id = k.id;
    if (easing !== undefined) out.easing = easing;
    return out;
  });
  keyframes.sort((a: Json, b: Json) => a.timelinePosition - b.timelinePosition);
  const type = keyframes[0].value.type;
  for (const k of keyframes) {
    if (k.value.type !== type) fail("MOTION_INVALID", "all keyframes in one track must use the same value type");
  }
  const baseValue = raw.baseValue === undefined ? undefined : normalizeValue(raw.baseValue, "track.baseValue");
  if (baseValue !== undefined && baseValue.type !== type) {
    fail("MOTION_INVALID", "track.baseValue must use the same type as the keyframes");
  }
  return {
    ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
    ...(baseValue === undefined ? {} : { baseValue }),
    keyframes,
  };
}

export function trackFor(node: any, field: Json): Json | null {
  const all = node && node.manualKeyframeTracks;
  if (!all) return null;
  if (field.type === "PROPERTY") return all[field.name] ?? null;
  const entry = all[field.collection] && all[field.collection][field.index];
  if (!entry) return null;
  if (field.collection === "effects") {
    if (field.field) return entry[field.field] ?? null;
    if (field.propertyId) return (entry.properties && entry.properties[field.propertyId]) || null;
    return null;
  }
  if (field.propertyId) return (entry.properties && entry.properties[field.propertyId]) || null;
  // A paint binding may be either a whole-paint track or a properties map.
  // Without a propertyId only the whole-paint track answers this field.
  return Array.isArray(entry.keyframes) ? entry : null;
}

const same = (a: any, b: any): boolean => canonical(a) === canonical(b);
const near = (a: any, b: any): boolean => finite(a) && finite(b) && Math.abs(a - b) <= 1e-6;

function sameEasing(want: any, have: any): boolean {
  if (!want || !have || want.type !== have.type) return false;
  if (want.type === "VARIABLE_ALIAS") return want.id === have.id;
  if (want.type === "CUSTOM_CUBIC_BEZIER") {
    const a = want.easingFunctionCubicBezier;
    const b = have.easingFunctionCubicBezier;
    return !!a && !!b && near(a.x1, b.x1) && near(a.y1, b.y1) && near(a.x2, b.x2) && near(a.y2, b.y2);
  }
  if (want.type === "CUSTOM_SPRING") {
    return !!want.easingFunctionSpring && !!have.easingFunctionSpring &&
      near(want.easingFunctionSpring.bounce, have.easingFunctionSpring.bounce);
  }
  return true;
}

/** Throw unless the live manual track is the one the plan described. */
export function verifyTrack(node: any, field: Json, track: Json): Json {
  const after = trackFor(node, field);
  if (!after) fail("MOTION_VERIFY_FAILED", "the manual keyframe track is missing after the write");
  if (track.id && after.id !== track.id) {
    fail("MOTION_VERIFY_FAILED", `track id read back as ${after.id}, expected ${track.id}`);
  }
  if (track.baseValue !== undefined && !same(after.baseValue, track.baseValue)) {
    fail("MOTION_VERIFY_FAILED", "the baseValue read back differs from the plan");
  }
  if (!Array.isArray(after.keyframes)) {
    fail("MOTION_VERIFY_FAILED", "the manual track read back without a keyframe array");
  }
  const got = after.keyframes.slice().sort((a: Json, b: Json) => a.timelinePosition - b.timelinePosition);
  if (got.length !== track.keyframes.length) {
    fail("MOTION_VERIFY_FAILED", `expected ${track.keyframes.length} keyframes, read back ${got.length}`);
  }
  for (let i = 0; i < track.keyframes.length; i++) {
    const want = track.keyframes[i];
    const have = got[i];
    if (Math.abs(have.timelinePosition - want.timelinePosition) > 1e-6) {
      fail("MOTION_VERIFY_FAILED", `keyframe ${i} moved from ${want.timelinePosition}s to ${have.timelinePosition}s`);
    }
    if (!same(have.value, want.value)) fail("MOTION_VERIFY_FAILED", `keyframe ${i} value differs after the write`);
    if (want.id && have.id !== want.id) fail("MOTION_VERIFY_FAILED", `keyframe ${i} id differs after the write`);
    if (want.easing && !sameEasing(want.easing, have.easing)) {
      fail("MOTION_VERIFY_FAILED", `keyframe ${i} easing differs after the write`);
    }
  }
  return clean(after);
}
