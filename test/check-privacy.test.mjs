import test from "node:test";
import assert from "node:assert/strict";
import { scanDenylist, scanText } from "../scripts/check-privacy.mjs";

const kinds = (findings) => findings.map((f) => f.kind);

test("privacy scan: flags real home paths, e-mail addresses, keys and tokens", () => {
  const text = [
    "const home = '/Users/local/Projects/example/secret.fig';",
    "contact: user@example.test",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "figd_abcdefghijklmnopqrstuvwxyz123456",
    "FIGMA_CLOUD_TOKEN=abcdefghijklmnopqrstuvwxyz",
  ].join("\n");
  const findings = scanText(text, { denylist: [] });
  assert.deepEqual(kinds(findings), [
    "absolute-home-path",
    "email-address",
    "private-key",
    "github-token",
    "figma-token",
    "configured-secret",
  ]);
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3, 4, 5, 6]);
});

test("privacy scan: allows the placeholders this repository documents", () => {
  const text = [
    "/Users/example/Library/Application Support/Figma Local Bridge/app",
    "/Users/me/project",
    "/Users/A & B/Figma <Bridge>",
    "/home/user/project",
    "C:\\Users\\example\\project",
    "tester@example.com",
    "git@github.com:Miart/figma-local-bridge.git",
    "const key = 'ghp_example-placeholder-not-a-token';",
  ].join("\n");
  assert.deepEqual(scanText(text, { denylist: [] }), []);
});

test("privacy scan: denylist matches identifiers and separator variants", () => {
  const denylist = [
    "Blocked One",
    "BlockedTwo",
    "BlockedThree",
    "BlockedFour",
    "BlockedFive",
    "BlockedSix",
    "BlockedSeven",
  ];
  const text = [
    "const blockedOne = 1;",
    "const blocked_one = 1;",
    "const BlockedOne = 1;",
    "const blockedTwo = 1;",
    "const blocked_two = 1;",
    "const blockedThree = 1;",
    "const blocked_four = 1;",
    "const blockedFive = 1;",
    "const blockedSix = 1;",
    "const blocked_seven = 1;",
  ].join("\n");
  const findings = scanText(text, { denylist });
  assert.deepEqual(findings.map((f) => f.kind), Array(10).fill("denylisted-term"));
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(findings.every((f) => !/blocked/i.test(f.detail)));
});

test("privacy scan: a single-word term does not match across spaces", () => {
  assert.deepEqual(scanText("b lo ck ed", { denylist: ["Blocked"] }), []);
});

test("privacy scan: denylist-only mode checks scanner sources too", () => {
  const findings = scanDenylist("const blockedOne = 1;", {
    denylist: ["Blocked One"], file: "scripts/check-privacy.mjs",
  });
  assert.deepEqual(kinds(findings), ["denylisted-term"]);
});

test("privacy scan: a local denylist catches configured terms", () => {
  const text = "We tested this against Blocked One and the Blocked Two file.";
  const findings = scanText(text, { denylist: ["Blocked One", "Blocked Two"], file: "docs/note.md" });
  assert.deepEqual(kinds(findings), ["denylisted-term", "denylisted-term"]);
  assert.deepEqual(findings.map((f) => f.file), ["docs/note.md", "docs/note.md"]);
  assert.deepEqual(findings.map((f) => f.line), [1, 1]);
});
