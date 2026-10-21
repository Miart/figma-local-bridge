import test from "node:test";
import assert from "node:assert/strict";
import { scanText } from "../scripts/check-privacy.mjs";

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

test("privacy scan: a local denylist catches company and project names", () => {
  const text = "We tested this against Blocked One and the Blocked Two file.";
  const findings = scanText(text, { denylist: ["Blocked One", "Blocked Two"], file: "docs/note.md" });
  assert.deepEqual(kinds(findings), ["denylisted-term", "denylisted-term"]);
  assert.deepEqual(findings.map((f) => f.file), ["docs/note.md", "docs/note.md"]);
  assert.deepEqual(findings.map((f) => f.line), [1, 1]);
});
