// The session key of an unsaved file is a contract between plugin runs: an
// agent that read the key must still be able to use it after the panel reloads.
// Minted per run, it went stale on every reload and every call with it came
// back refused (the daemon does not guess which file a request means). The
// shipped module is what these tests load, not a copy — see plugin/build.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_SLOT, sessionKey } from "../plugin/session-key.mjs";

/** A document that only remembers pluginData, like figma.root does. */
const document = (stored = {}) => ({
  data: { ...stored },
  getPluginData(key) {
    return this.data[key] ?? "";
  },
  setPluginData(key, value) {
    this.data[key] = value;
  },
});

test("one open document keeps one key across plugin runs", () => {
  const doc = document();
  let minted = 0;
  const makeKey = () => `unsaved-mint${++minted}`.padEnd(16, "0");

  const first = sessionKey(doc, makeKey); // the run that mints it
  const second = sessionKey(doc, makeKey); // the next reload, same document

  assert.equal(second, first, "a reload must not hand out a different key");
  assert.equal(minted, 1, "the second run minted a second key");
});

test("the key is stored on the document, not held in the run", () => {
  const doc = document();
  const key = sessionKey(doc, () => "unsaved-abcd1234");
  assert.equal(doc.data[KEY_SLOT], key);
  assert.equal(key, "unsaved-abcd1234");
});

test("a stored key wins over a fresh mint", () => {
  const doc = document({ [KEY_SLOT]: "unsaved-stored00" });
  assert.equal(sessionKey(doc, () => "unsaved-fresh000"), "unsaved-stored00");
});

test("two documents get two different keys", () => {
  const a = sessionKey(document(), () => "unsaved-aaaa0000");
  const b = sessionKey(document(), () => "unsaved-bbbb1111");
  assert.notEqual(a, b);
});

test("the default mint always produces a full 8-character key", () => {
  // Math.random() can print short fractions ("0.i"), and a key that is quieter
  // than it looks is what the padEnd is for.
  for (let i = 0; i < 200; i++) {
    assert.match(sessionKey(document()), /^unsaved-[a-z0-9]{8}$/);
  }
});
