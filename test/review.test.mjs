import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA,
  diffFindings,
  dropReview,
  findingKey,
  findingSignature,
  listReviews,
  nextSteps,
  readReview,
  resolveReviewId,
  reviewStatus,
  saveReview,
  storeKey,
} from "../server/dist/review.js";

function finding(over = {}) {
  return {
    rule: "hardcoded-fill", severity: "error", nodeId: "1:2", nodeKey: "card/bg",
    name: "Bg", type: "RECTANGLE", path: "Card / Bg", detail: "fill #ffffff", value: "#ffffff",
    ...over,
  };
}

function record(over = {}) {
  return {
    schema: SCHEMA,
    id: "20261021-120000-card",
    fileKey: "FILEKEY",
    createdAt: "2026-10-21T12:00:00.000Z",
    node: { id: "1:2", name: "Card", type: "FRAME" },
    scale: 1,
    rev: { screenshot: 7, audit: 7, inspect: 7 },
    image: { file: "20261021-120000-card.png", width: 10, height: 10, bytes: 3, sha256: "abc" },
    audit: {
      schema: "audit-v2",
      params: { rules: ["hardcoded-fill"], includeHidden: false, suggest: true, maxFindings: 200, maxNodes: 2000 },
      findings: [finding()],
      counts: { error: 1, warning: 0, info: 0, total: 1 },
      byRule: { "hardcoded-fill": 1 },
    },
    fingerprint: { hash: "fp-a", appearanceHash: "a", geometryHash: "g", childrenHash: "c" },
    warnings: [],
    ...over,
  };
}

test("finding identity uses a stable key; duplicate-key findings keep the node id", () => {
  assert.equal(findingKey(finding()), "hardcoded-fill|key:card/bg");
  assert.equal(findingKey(finding({ nodeKey: "" })), "hardcoded-fill|id:1:2");
  assert.equal(findingKey(finding({ rule: "duplicate-key", nodeKey: "dup" })), "duplicate-key|key:dup|node:1:2");
  assert.equal(findingKey(finding({ property: "itemSpacing" })), "hardcoded-fill|key:card/bg|property:itemSpacing");
  assert.equal(findingSignature(finding({ path: "Other / Path", nodeId: "9:9" })), findingSignature(finding()));
  assert.notEqual(findingSignature(finding({ value: "#000000" })), findingSignature(finding()));
});

test("diffFindings separates new, resolved and changed findings", () => {
  const before = [
    finding(),
    finding({ rule: "contrast", nodeId: "1:3", nodeKey: "card/title", detail: "contrast 2.1:1" }),
    finding({ rule: "default-name", severity: "info", nodeId: "1:4", nodeKey: "card/box" }),
  ];
  const after = [
    finding({ detail: "fill #000000", value: "#000000" }),
    finding({ rule: "placeholder-text", nodeId: "1:5", nodeKey: "card/body", detail: "Lorem ipsum" }),
    finding({ rule: "default-name", severity: "info", nodeId: "1:4", nodeKey: "card/box" }),
  ];
  const delta = diffFindings(before, after);
  assert.equal(delta.added.length, 1);
  assert.equal(delta.added[0].finding.rule, "placeholder-text");
  assert.equal(delta.resolved.length, 1);
  assert.equal(delta.resolved[0].finding.rule, "contrast");
  assert.equal(delta.changed.length, 1);
  assert.equal(delta.changed[0].before.value, "#ffffff");
  assert.equal(delta.changed[0].after.value, "#000000");
  assert.equal(delta.unchanged, 1);
});

test("a new problem or a size change is a regression; resolved problems are an improvement", () => {
  const base = { visualIdentical: true, sizeMismatch: false, fingerprintEqual: true, added: [], resolved: [], changed: [] };
  assert.equal(reviewStatus(base), "unchanged");
  assert.equal(reviewStatus({ ...base, visualIdentical: false }), "changed");
  assert.equal(reviewStatus({ ...base, fingerprintEqual: false }), "changed");
  assert.equal(reviewStatus({ ...base, changed: [{}] }), "changed");
  assert.equal(reviewStatus({ ...base, added: [finding()] }), "regressed");
  assert.equal(reviewStatus({ ...base, added: [finding({ severity: "info" })] }), "changed");
  assert.equal(reviewStatus({ ...base, sizeMismatch: true }), "regressed");
  assert.equal(reviewStatus({ ...base, resolved: [finding()] }), "improved");
  assert.equal(reviewStatus({ ...base, resolved: [finding({ severity: "info" })] }), "changed");
});

test("next steps name the new problem, the changed value, the truncation and the visual diff", () => {
  const steps = nextSteps({
    status: "regressed",
    added: [finding()],
    resolved: [finding({ rule: "contrast", severity: "warning" })],
    changedCount: 1,
    visualIdentical: false,
    sizeMismatch: true,
    fingerprintEqual: false,
    baselineTruncated: true,
    currentTruncated: false,
  });
  const all = steps.join("\n");
  assert.match(all, /different sizes/);
  assert.match(all, /Fix 1 new error\/warning/);
  assert.match(all, /Resolved: contrast/);
  assert.match(all, /1 finding\(s\) changed in place/);
  assert.match(all, /truncated/);
  assert.match(all, /pixels changed/);
  assert.match(all, /structure changed/);
});

test("the review store saves, lists, resolves and drops a bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "flb-review-"));
  const rec = record();
  const path = saveReview(dir, rec);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).id, rec.id);
  assert.equal(readReview(dir, "FILEKEY", rec.id).node.id, "1:2");
  assert.equal(listReviews(dir, "FILEKEY").length, 1);
  assert.equal(resolveReviewId(dir, "FILEKEY", "20261021"), rec.id);
  assert.equal(resolveReviewId(dir, "FILEKEY", "latest"), rec.id);

  // The image and diff are local files that drop removes with the JSON.
  const sub = join(dir, storeKey("FILEKEY"));
  writeFileSync(join(sub, rec.image.file), "png");
  writeFileSync(join(sub, `${rec.id}-diff.png`), "diff");
  const dropped = dropReview(dir, "FILEKEY", "latest");
  assert.equal(dropped.files.length, 3);
  assert.equal(listReviews(dir, "FILEKEY").length, 0);
});

test("a review id or file key cannot walk out of the store", () => {
  assert.equal(storeKey("../outside"), "outside");
  assert.equal(storeKey("../../outside"), "outside");
  assert.equal(storeKey("FILE key/1"), "FILE-key-1");
});
