// Unit tests for the checkpoint store and the diff that decides whether a
// rebuild worked. No Figma, no daemon: fixtures and a temp directory.
//
// The diff is the honesty mechanism of figma_checkpoint — "restored" means this
// function found no differences — so the cases under test are the ones where a
// sloppy comparison would report a match that is not one.
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SCHEMA, assertEnvelope, canonical, checkpointsDir, checkpointId, digest, diffDumps, dropCheckpoint,
  ENV_DIR, filePath, listCheckpoints, listFilesWithCheckpoints, readCheckpoint, resolveId, saveCheckpoint,
  storeKey, summarize,
} from "../server/dist/checkpoint.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; process.stdout.write(`PASS  ${name}\n`); }
  else { fail++; process.stdout.write(`FAIL  ${name}${detail ? "  — " + detail : ""}\n`); }
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e.message ?? e); } };

const node = (over = {}) => ({
  type: "FRAME", name: "Card",
  state: { pos: [10, 20], size: [100, 50], fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] },
  ...over,
});
const child = (over = {}) => node({ type: "RECTANGLE", name: "bg", state: { pos: [0, 0], size: [10, 10] }, ...over });
const env = (dump = node()) => ({ schema: SCHEMA, capturedAt: "2026-10-19T12:00:00.000Z", rev: 7, file: { key: "FILEKEY", name: "Test" }, root: { id: "1:2", name: "Card", type: "FRAME" }, nodes: 1, dump });

// ---------------------------------------------------------------- canonical / digest

{
  check("canonical: key order does not matter", canonical({ a: 1, b: { c: 2, d: 3 } }) === canonical({ b: { d: 3, c: 2 }, a: 1 }));
  check("canonical: undefined is dropped, not stringified", canonical({ a: 1, b: undefined }) === '{"a":1}');
  const a = digest(node());
  const b = digest(node({ state: { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], size: [100, 50], pos: [10, 20] } }));
  check("digest: same content in a different key order is the same digest", a === b);
  check("digest: different content is a different digest", a !== digest(node({ name: "Other" })));
  check("digest: it names its algorithm", /^sha256:[0-9a-f]{16}$/.test(a));
}

// ---------------------------------------------------------------- the envelope contract

{
  check("envelope: a matching schema passes", assertEnvelope(env()).dump.name === "Card");
  const bad = throws(() => assertEnvelope({ schema: "checkpoint-v2", dump: node() }));
  check("envelope: a different schema is refused by name", /schema "checkpoint-v2"/.test(bad) && /out of step/.test(bad));
  const empty = throws(() => assertEnvelope({ schema: SCHEMA }));
  check("envelope: no dump tree is refused", /no dump tree/.test(empty));
  const junk = throws(() => assertEnvelope(null));
  check("envelope: nothing at all is refused", /no checkpoint/.test(junk));
}

// ---------------------------------------------------------------- the diff

{
  const d = diffDumps(node(), node());
  check("diff: two identical dumps are identical", d.identical && d.total === 0 && d.differences.length === 0);
}

{
  const a = node();
  const b = node({ state: { ...node().state, size: [100, 50.005] } });
  check("diff: a hundredth is not a difference (float round-trip)", diffDumps(a, b).identical);
  const c = node({ state: { ...node().state, size: [100, 50.05] } });
  const d = diffDumps(a, c);
  check("diff: a real size change is a difference, with the field path", !d.identical && d.differences[0].path === "$.state.size[1]");
  check("diff: it carries both values", d.differences[0].before === 50 && d.differences[0].after === 50.05);
}

{
  const a = node({ children: [child()] });
  const b = node({ children: [child({ name: "background" })] });
  const d = diffDumps(a, b);
  check("diff: a renamed child is reported by path", d.total === 1 && d.differences[0].path === "$.children[0].name");
  const e = diffDumps(a, node({ children: [child(), child()] }));
  check("diff: an extra child changes the count", e.differences.some((x) => x.path === "$.children.length" && x.before === 1 && x.after === 2));
}

{
  const a = node();
  const b = node({ state: { ...node().state } });
  delete b.state.fills;
  const d = diffDumps(a, b);
  check("diff: a field that vanished is marked absent, not silently null", d.differences[0].absent === "after" && d.differences[0].path === "$.state.fills");
  const e = diffDumps(b, a);
  check("diff: the same in the other direction", e.differences[0].absent === "before");
}

{
  // meta records what checkpoint-v1 does NOT restore. Comparing it would report
  // the known losses on every restore and bury the unknown ones.
  const a = node({ meta: { bindings: ["fills"], styles: ["fill"] } });
  const b = node();
  check("diff: meta is not compared", diffDumps(a, b).identical);
}

{
  // The #suffix is Figma's unique property id; addComponentProperty assigns a
  // new one on every rebuild. It is a named loss, so it must not turn a correct
  // rebuild into a non-identical diff. The display name and definition content
  // still have to match, and references must point at the same name.
  const defs = {
    "Label#1:2": { type: "TEXT", defaultValue: "Play" },
    "Visible#3:4": { type: "BOOLEAN", defaultValue: true },
  };
  const refs = { characters: "Label#1:2", visible: "Visible#3:4" };
  const a = node({ state: { ...node().state, componentPropertyDefinitions: defs, componentPropertyReferences: refs } });
  const b = node({ state: { ...node().state,
    componentPropertyDefinitions: {
      "Visible#9:1": { type: "BOOLEAN", defaultValue: true },
      "Label#8:7": { type: "TEXT", defaultValue: "Play" },
    },
    componentPropertyReferences: { visible: "Visible#9:1", characters: "Label#8:7" },
  } });
  const c = node({ state: { ...node().state,
    componentPropertyDefinitions: { ...defs, "Label#1:2": { type: "TEXT", defaultValue: "Stop" } },
    componentPropertyReferences: refs,
  } });
  check("diff: component property ids are ignored, but definitions and references are not",
    diffDumps(a, b).identical && !diffDumps(a, c).identical);
}

{
  const many = node({ state: { ...node().state, a: 1, b: 2, c: 3 } });
  const other = node({ state: { ...node().state, a: 9, b: 9, c: 9 } });
  const d = diffDumps(many, other, { limit: 2 });
  check("diff: the limit truncates the list but keeps the total", d.truncated && d.differences.length === 2 && d.total === 3);
}

{
  const a = node({ state: { ...node().state, size: [10, 10], text: { characters: "AB", runs: 3 } } });
  const b = node({ state: { ...node().state, size: [20, 30], pos: [0, 0], text: { characters: "AB" } } });
  const d = diffDumps(a, b);
  check("diff: a run count that vanished is a difference", d.differences.some((x) => x.path === "$.state.text.runs" && x.absent === "after"));
  check("diff: the notes explain the differences checkpoint-v1 knows about",
    d.notes.some((n) => /HUG/.test(n)) && d.notes.some((n) => /per-run/.test(n)) && d.notes.some((n) => /position/.test(n)),
    JSON.stringify(d.notes));
}

// ---------------------------------------------------------------- the summary

{
  const dump = node({
    children: [
      child({ name: "pic", state: { pos: [0, 0], size: [4, 4], fills: [{ type: "IMAGE", imageHash: "abc" }] } }),
      node({ type: "TEXT", name: "label", state: { text: { characters: "PLAY", font: { family: "Inter", style: "Bold" }, runs: 2 } } }),
      node({ type: "TEXT", name: "mixed", state: { text: { characters: "AB", font: "mixed" } } }),
      node({ type: "INSTANCE", name: "btn", state: {}, meta: {
        bindings: ["fills"],
        variableBindings: { opacity: { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } },
        variableModes: { "VariableCollectionId:1:1": "1:0" },
      } }),
      node({ type: "BOOLEAN_OPERATION", name: "Union", state: {}, unsupported: "cannot" }),
    ],
  });
  const s = summarize(dump);
  check("summary: counts nodes and depth", s.nodes === 6 && s.maxDepth === 1);
  check("summary: counts by type", s.byType.FRAME === 1 && s.byType.TEXT === 2 && s.byType.RECTANGLE === 1);
  check("summary: counts image fills and instances", s.images === 1 && s.instances === 1);
  check("summary: counts characters and fonts", s.characters === 6 && s.fonts.join(",") === "Inter Bold");
  check("summary: names the losses the caller must expect",
    s.multiRunTexts === 1 && s.mixedFonts === 1 && s.metaOnly === 1 &&
    s.variableBindings === 1 && s.variableModes === 1 &&
    s.unsupported.length === 1 && s.unsupported[0].path === "$.children[4]");
}

// ---------------------------------------------------------------- the store

const dir = mkdtempSync(join(tmpdir(), "flb-checkpoints-"));
const record = (id, savedAt, fileKey = "FILEKEY") => ({
  id, fileKey, savedAt, schema: SCHEMA, saveRev: 7,
  digest: digest(node()), summary: summarize(node()), envelope: env(),
});

{
  check("storeKey: a real key passes through", storeKey("fL9aBcD2eF") === "fL9aBcD2eF");
  check("storeKey: a session key passes through", storeKey("unsaved-268ptfwu") === "unsaved-268ptfwu");
  const escape = storeKey("../../etc/passwd");
  check("storeKey: a path cannot walk out of the directory", escape === "etc-passwd" && !escape.includes("/") && !escape.includes(".."));
  const spaces = storeKey("a b\\c:d");
  check("storeKey: anything else is folded", spaces === "a-b-c-d");
  check("storeKey: an unusable key is refused", /not usable/.test(throws(() => storeKey("..."))));
}

{
  const now = new Date(2026, 9, 19, 14, 12, 30);
  check("checkpointId: readable and sortable", checkpointId("Splash Frame", now) === "20261019-141230-splash-frame");
  check("checkpointId: a name with nothing usable still yields an id", checkpointId("***", now) === "20261019-141230");
}

{
  const a = record("20261019-120001-splash", "2026-10-19T12:00:01.000Z");
  const b = record("20261019-120002-card", "2026-10-19T12:00:02.000Z");
  const pathA = saveCheckpoint(dir, a);
  saveCheckpoint(dir, b);
  check("store: the file is named after the key and the id", pathA === join(dir, "FILEKEY", "20261019-120001-splash.json") && existsSync(pathA));
  check("store: written atomically (no temp file left behind)", !readdirSync(join(dir, "FILEKEY")).some((n) => n.endsWith(".tmp")));

  const read = readCheckpoint(dir, "FILEKEY", "20261019-120001-splash");
  check("store: it reads back", read.digest === a.digest && read.envelope.dump.name === "Card");
  const missing = throws(() => readCheckpoint(dir, "FILEKEY", "nope"));
  check("store: a missing id fails with the list of what IS there", /no checkpoint "nope"/.test(missing) && /20261019-120001-splash/.test(missing));

  const listed = listCheckpoints(dir, "FILEKEY");
  check("store: listing is newest first", listed.map((c) => c.id).join(",") === "20261019-120002-card,20261019-120001-splash");
  check("store: nothing stored is an empty list, not an error", listCheckpoints(dir, "OTHERKEY").length === 0);

  writeFileSync(join(dir, "FILEKEY", "junk.json"), "{ not json");
  check("store: a file that is not a checkpoint is skipped, not fatal", listCheckpoints(dir, "FILEKEY").length === 2);

  check("store: latest resolves to the newest", resolveId(dir, "FILEKEY", undefined) === "20261019-120002-card");
  check("store: an exact id resolves", resolveId(dir, "FILEKEY", "20261019-120001-splash") === "20261019-120001-splash");
  check("store: a unique prefix resolves", resolveId(dir, "FILEKEY", "20261019-120001") === "20261019-120001-splash");
  const ambiguous = throws(() => resolveId(dir, "FILEKEY", "20261019"));
  check("store: an ambiguous prefix lists the candidates", /matches 2 checkpoints/.test(ambiguous));
  check("store: an unknown id lists what is there", /no checkpoint "zz"/.test(throws(() => resolveId(dir, "FILEKEY", "zz"))));

  const files = listFilesWithCheckpoints(dir);
  check("store: it can list every file that has checkpoints", files.length === 1 && files[0].fileKey === "FILEKEY" && files[0].count === 2);

  const dropped = dropCheckpoint(dir, "FILEKEY", "20261019-120002-card");
  check("store: dropping removes the file", dropped.endsWith(".json") && listCheckpoints(dir, "FILEKEY").length === 1);
  check("store: dropping an unknown id fails loudly", /no checkpoint/.test(throws(() => dropCheckpoint(dir, "FILEKEY", "zz"))));
  check("store: an id cannot escape the file key directory", /no checkpoint|not usable/.test(throws(() => dropCheckpoint(dir, "FILEKEY", "../../x")) ?? "x"));
}

{
  const previous = process.env[ENV_DIR];
  process.env[ENV_DIR] = dir;
  check("checkpointsDir: the environment can move the store (tests never touch a real home dir)", checkpointsDir() === dir);
  if (previous === undefined) delete process.env[ENV_DIR];
  else process.env[ENV_DIR] = previous;
  check("checkpointsDir: the default lives next to the daemon info", checkpointsDir().endsWith(join(".local", "share", "opencode", "figma-bridge-checkpoints")));
  check("filePath: the path is key then id", filePath("/x", "K", "I") === join("/x", "K", "I.json"));
}

rmSync(dir, { recursive: true, force: true });

process.stdout.write(`\ncheckpoint-store.test: ${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
