import test from "node:test";
import assert from "node:assert/strict";
import { runTokens, TOKEN_SCHEMA } from "../plugin/tokens.mjs";

function makeCtx() {
  let cseq = 0;
  let vseq = 0;
  let mseq = 0;
  const collections = [];
  const variables = [];
  const metrics = { commits: 0, undos: 0 };

  const findCollection = (id) => collections.find((c) => c.id === id) || null;

  function makeCollection(name, modes = ["Mode 1"]) {
    const c = {
      id: `C:${++cseq}`,
      name,
      modes: [],
      defaultModeId: null,
      addMode(modeName) {
        const modeId = `M:${++mseq}`;
        this.modes.push({ modeId, name: modeName });
        return modeId;
      },
      renameMode(modeId, modeName) {
        const mode = this.modes.find((m) => m.modeId === modeId);
        if (!mode) throw new Error(`no mode ${modeId}`);
        mode.name = modeName;
      },
    };
    for (const modeName of modes) c.addMode(modeName);
    c.defaultModeId = c.modes[0]?.modeId ?? null;
    collections.push(c);
    return c;
  }

  function makeVariable(collection, name, resolvedType, valuesByMode = {}, description = "") {
    const v = {
      id: `V:${++vseq}`,
      name,
      variableCollectionId: collection.id,
      resolvedType,
      description,
      valuesByMode: structuredClone(valuesByMode),
      removed: false,
      setValueForMode(modeId, value) {
        if (ctx.failValueWrites) return;
        this.valuesByMode[modeId] = structuredClone(value);
      },
      remove() {
        this.removed = true;
        const at = variables.indexOf(this);
        if (at >= 0) variables.splice(at, 1);
      },
    };
    variables.push(v);
    return v;
  }

  const ctx = {
    root: { name: "Token test file" },
    fileKey: "FILEKEY",
    metrics,
    failValueWrites: false,
    commitUndo() { metrics.commits++; },
    triggerUndo() { metrics.undos++; },
    addCollection: makeCollection,
    addVariable: makeVariable,
    variables: {
      async getLocalVariableCollectionsAsync() { return [...collections]; },
      async getLocalVariablesAsync() { return variables.filter((v) => !v.removed); },
      async getVariableByIdAsync(id) { return variables.find((v) => v.id === id) || null; },
      async getVariableCollectionByIdAsync(id) { return findCollection(id); },
      list() { return variables.filter((v) => !v.removed); },
      createVariableCollection(name) { return makeCollection(name, ["Mode 1"]); },
      createVariable(name, collection, resolvedType) {
        return makeVariable(collection, name, resolvedType, {});
      },
      createVariableAlias(variable) {
        return { type: "VARIABLE_ALIAS", id: variable.id };
      },
    },
  };
  return ctx;
}

const params = (document, extra = {}) => ({
  action: "import",
  document,
  collection: "Tokens",
  mode: "Light",
  ...extra,
});

function variable(ctx, collection, name) {
  return ctx.variables.list().find((v) => v.variableCollectionId === collection.id && v.name === name) || null;
}

function nativeDoc(collections) {
  return { schema: TOKEN_SCHEMA, collections };
}

const dtcg = () => ({
  color: {
    $type: "color",
    bg: { $value: "#112233" },
    fg: { $value: "{color.bg}" },
  },
  space: {
    $type: "dimension",
    sm: { $value: "4px" },
  },
  label: {
    $type: "string",
    $value: "Play",
  },
  visible: {
    $type: "boolean",
    $value: true,
  },
  family: {
    $type: "fontFamily",
    $value: ["Inter", "Arial"],
  },
});

test("export writes every mode and keeps aliases as aliases", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light", "Dark"]);
  const bg = ctx.addVariable(theme, "color/bg", "COLOR", {
    [theme.modes[0].modeId]: { r: 1, g: 1, b: 1 },
    [theme.modes[1].modeId]: { r: 0, g: 0, b: 0 },
  }, "page background");
  ctx.addVariable(theme, "color/fg", "COLOR", {
    [theme.modes[0].modeId]: { type: "VARIABLE_ALIAS", id: bg.id },
    [theme.modes[1].modeId]: { type: "VARIABLE_ALIAS", id: bg.id },
  });

  const out = await runTokens(ctx, { action: "export" });
  assert.equal(out.schema, TOKEN_SCHEMA);
  assert.equal(out.counts.collections, 1);
  assert.equal(out.counts.variables, 2);
  const [collection] = out.document.collections;
  assert.equal(collection.name, "Theme");
  assert.deepEqual(collection.modes, ["Light", "Dark"]);
  assert.equal(collection.defaultMode, "Light");
  const exportedBg = collection.variables.find((v) => v.name === "color/bg");
  assert.equal(exportedBg.type, "COLOR");
  assert.equal(exportedBg.description, "page background");
  assert.equal(exportedBg.values.Light, "#ffffff");
  assert.equal(exportedBg.values.Dark, "#000000");
  const exportedFg = collection.variables.find((v) => v.name === "color/fg");
  assert.deepEqual(exportedFg.values.Light, { alias: { collection: "Theme", name: "color/bg" } });
});

test("DTCG dry run creates a collection, modes and values without writing", async () => {
  const ctx = makeCtx();
  const out = await runTokens(ctx, params(dtcg()));
  assert.equal(out.status, "dry_run");
  assert.equal(out.blocking.length, 0);
  assert.deepEqual(out.summary.variables, { create: 6, update: 0, delete: 0, unchanged: 0 });
  assert.ok(out.summary.collections.create === 1);
  assert.ok(out.warnings.some((w) => /px/.test(w)));
  assert.ok(out.warnings.some((w) => /fontFamily/.test(w)));
  const collections = await ctx.variables.getLocalVariableCollectionsAsync();
  assert.equal(collections.length, 0);
  const create = out.changes.find((c) => c.kind === "variable" && c.name === "color/bg");
  assert.deepEqual(create.values, { Light: { before: null, after: "#112233" } });
  const aliasChange = out.changes.find((c) => c.kind === "variable" && c.name === "color/fg");
  assert.deepEqual(aliasChange.values.Light.after, { alias: { collection: "Tokens", name: "color/bg" } });
});

test("apply creates values, aliases and descriptions, then verifies the read-back", async () => {
  const ctx = makeCtx();
  const dry = await runTokens(ctx, params(dtcg()));
  const out = await runTokens(ctx, {
    ...params(dtcg()),
    dryRun: false,
    expectedFingerprint: dry.fingerprint,
  });
  assert.equal(out.status, "applied");
  assert.equal(out.verification.ok, true);
  assert.ok(ctx.metrics.commits >= 2);
  assert.equal(ctx.metrics.undos, 0);

  const collection = (await ctx.variables.getLocalVariableCollectionsAsync())[0];
  assert.equal(collection.name, "Tokens");
  assert.equal(collection.modes[0].name, "Light");
  const bg = variable(ctx, collection, "color/bg");
  const fg = variable(ctx, collection, "color/fg");
  assert.equal(bg.resolvedType, "COLOR");
  assert.deepEqual(bg.valuesByMode[collection.modes[0].modeId], { r: 0x11 / 255, g: 0x22 / 255, b: 0x33 / 255 });
  assert.deepEqual(fg.valuesByMode[collection.modes[0].modeId], { type: "VARIABLE_ALIAS", id: bg.id });
  assert.equal(variable(ctx, collection, "space/sm").valuesByMode[collection.modes[0].modeId], 4);
  assert.equal(variable(ctx, collection, "label").valuesByMode[collection.modes[0].modeId], "Play");
  assert.equal(variable(ctx, collection, "visible").valuesByMode[collection.modes[0].modeId], true);
  assert.equal(variable(ctx, collection, "family").valuesByMode[collection.modes[0].modeId], "Inter, Arial");
});

test("export -> diff round trips with no changes", async () => {
  const ctx = makeCtx();
  const dry = await runTokens(ctx, params(dtcg()));
  await runTokens(ctx, { ...params(dtcg()), dryRun: false, expectedFingerprint: dry.fingerprint });
  const exported = await runTokens(ctx, { action: "export" });
  const diff = await runTokens(ctx, { action: "diff", document: exported.document });
  assert.equal(diff.status, "diff");
  assert.equal(diff.blocking.length, 0);
  assert.deepEqual(diff.summary.variables, { create: 0, update: 0, delete: 0, unchanged: 6 });
  assert.equal(diff.changes.length, 0);
});

test("import updates a value and a description without touching the identity", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  const mode = theme.modes[0].modeId;
  const bg = ctx.addVariable(theme, "color/bg", "COLOR", { [mode]: { r: 1, g: 1, b: 1 } }, "old");
  const id = bg.id;
  const doc = nativeDoc([{
    name: "Theme",
    modes: ["Light"],
    variables: [
      { name: "color/bg", type: "COLOR", description: "new", values: { Light: "#ff0000" } },
    ],
  }]);
  const dry = await runTokens(ctx, params(doc));
  assert.deepEqual(dry.summary.variables, { create: 0, update: 1, delete: 0, unchanged: 0 });
  const out = await runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint });
  assert.equal(out.status, "applied");
  assert.equal(bg.id, id);
  assert.equal(bg.description, "new");
  assert.deepEqual(bg.valuesByMode[mode], { r: 1, g: 0, b: 0 });
});

test("a different target file is refused even when its variables happen to match", async () => {
  const ctx = makeCtx();
  const dry = await runTokens(ctx, params(dtcg()));
  ctx.fileKey = "ANOTHER-FILE";
  const out = await runTokens(ctx, { ...params(dtcg()), dryRun: false, expectedFingerprint: dry.fingerprint });
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "TOKENS_PLAN_CHANGED");
  assert.equal(ctx.metrics.commits, 0);
});

test("a changed fingerprint is refused before any write", async () => {
  const ctx = makeCtx();
  const doc = nativeDoc([{
    name: "Theme", modes: ["Light"], variables: [
      { name: "color/bg", type: "COLOR", values: { Light: "#ffffff" } },
    ],
  }]);
  const dry = await runTokens(ctx, params(doc));
  const theme = ctx.addCollection("Theme", ["Light"]);
  ctx.addVariable(theme, "unrelated", "FLOAT", { [theme.modes[0].modeId]: 1 });
  const commits = ctx.metrics.commits;
  const out = await runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint });
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "TOKENS_PLAN_CHANGED");
  assert.equal(ctx.metrics.commits, commits);
  assert.equal((await ctx.variables.getLocalVariablesAsync()).length, 1);
});

test("a type change is blocking and apply refuses before writing", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  ctx.addVariable(theme, "size", "FLOAT", { [theme.modes[0].modeId]: 4 });
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "size", type: "COLOR", values: { Light: "#ffffff" } },
  ] }]);
  const dry = await runTokens(ctx, params(doc));
  assert.ok(dry.blocking.some((b) => /cannot change a variable's type/.test(b)));
  await assert.rejects(
    () => runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint }),
    /TOKENS_IMPORT_BLOCKED.*cannot change a variable's type/,
  );
  assert.equal(ctx.metrics.commits, 0);
});

test("missing alias targets are blocking", async () => {
  const ctx = makeCtx();
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "fg", type: "COLOR", values: { Light: { alias: { collection: "Theme", name: "missing" } } } },
  ] }]);
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /alias target "Theme\/missing" does not exist/.test(b)));
});

test("an alias type mismatch is blocking", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  ctx.addVariable(theme, "size", "FLOAT", { [theme.modes[0].modeId]: 4 });
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "fg", type: "COLOR", values: { Light: { alias: { collection: "Theme", name: "size" } } } },
  ] }]);
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /is FLOAT, but this variable is COLOR/.test(b)));
});

test("an alias cycle is blocking", async () => {
  const ctx = makeCtx();
  const doc = {
    color: {
      $type: "color",
      a: { $value: "{color.b}" },
      b: { $value: "{color.a}" },
    },
  };
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /alias cycle/.test(b)));
});

test("prune needs explicit destructive permission and deletes only named collections", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  const keep = ctx.addVariable(theme, "keep", "COLOR", { [theme.modes[0].modeId]: { r: 1, g: 0, b: 0 } });
  const drop = ctx.addVariable(theme, "drop", "FLOAT", { [theme.modes[0].modeId]: 2 });
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "keep", type: "COLOR", values: { Light: "#ff0000" } },
  ] }]);
  const guarded = await runTokens(ctx, params(doc, { prune: true }));
  assert.ok(guarded.blocking.some((b) => /allowDestructive:true/.test(b)));
  assert.equal(ctx.metrics.commits, 0);

  const dry = await runTokens(ctx, params(doc, { prune: true, allowDestructive: true }));
  assert.deepEqual(dry.summary.variables, { create: 0, update: 0, delete: 1, unchanged: 1 });
  const out = await runTokens(ctx, {
    ...params(doc, { prune: true, allowDestructive: true }),
    dryRun: false,
    expectedFingerprint: dry.fingerprint,
  });
  assert.equal(out.status, "applied");
  assert.equal(variable(ctx, theme, "keep").id, keep.id);
  assert.equal(variable(ctx, theme, "drop"), null);
  assert.ok(drop.removed);
});

test("prune refuses a target another variable still aliases", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  const target = ctx.addVariable(theme, "old", "COLOR", { [theme.modes[0].modeId]: { r: 0, g: 0, b: 0 } });
  ctx.addVariable(theme, "fg", "COLOR", { [theme.modes[0].modeId]: { type: "VARIABLE_ALIAS", id: target.id } });
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "fg", type: "COLOR", values: { Light: "#ffffff" } },
  ] }]);
  const out = await runTokens(ctx, params(doc, { prune: true, allowDestructive: true }));
  assert.ok(out.blocking.some((b) => /alias target; update or remove that alias first/.test(b)));
});

test("a second import of the same document is a no-op and writes nothing", async () => {
  const ctx = makeCtx();
  const dry = await runTokens(ctx, params(dtcg()));
  await runTokens(ctx, { ...params(dtcg()), dryRun: false, expectedFingerprint: dry.fingerprint });
  const before = ctx.metrics.commits;
  const again = await runTokens(ctx, params(dtcg()));
  assert.deepEqual(again.summary.variables, { create: 0, update: 0, delete: 0, unchanged: 6 });
  const out = await runTokens(ctx, { ...params(dtcg()), dryRun: false, expectedFingerprint: again.fingerprint });
  assert.equal(out.status, "noop");
  assert.equal(ctx.metrics.commits, before);
});

test("a mode the document does not manage is preserved on an existing variable", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light", "Dark"]);
  const [light, dark] = theme.modes.map((m) => m.modeId);
  const bg = ctx.addVariable(theme, "bg", "COLOR", {
    [light]: { r: 1, g: 1, b: 1 },
    [dark]: { r: 0, g: 0, b: 0 },
  });
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "bg", type: "COLOR", values: { Light: "#ffffff" } },
  ] }]);
  const dry = await runTokens(ctx, params(doc));
  assert.equal(dry.summary.collections.extraModes, 1);
  assert.deepEqual(dry.summary.variables, { create: 0, update: 0, delete: 0, unchanged: 1 });
  const out = await runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint });
  assert.equal(out.status, "noop");
  assert.deepEqual(bg.valuesByMode[dark], { r: 0, g: 0, b: 0 });
});

test("a missing FLOAT is not silently equal to zero", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  ctx.addVariable(theme, "gap", "FLOAT", { [theme.modes[0].modeId]: null });
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "gap", type: "FLOAT", values: { Light: 0 } },
  ] }]);
  const dry = await runTokens(ctx, params(doc));
  assert.deepEqual(dry.summary.variables, { create: 0, update: 1, delete: 0, unchanged: 0 });
  const out = await runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint });
  assert.equal(out.status, "applied");
});

test("a new mode is created and the existing variable gets its value", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  const mode = theme.modes[0].modeId;
  const bg = ctx.addVariable(theme, "color/bg", "COLOR", { [mode]: { r: 1, g: 1, b: 1 } });
  const doc = nativeDoc([{ name: "Theme", modes: ["Light", "Dark"], variables: [
    { name: "color/bg", type: "COLOR", values: { Light: "#ffffff", Dark: "#000000" } },
  ] }]);
  const dry = await runTokens(ctx, params(doc));
  assert.equal(dry.summary.collections.modesCreate, 1);
  assert.equal(dry.summary.variables.update, 1);
  const out = await runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint });
  assert.equal(out.status, "applied");
  assert.equal(theme.modes.length, 2);
  assert.deepEqual(bg.valuesByMode[theme.modes[1].modeId], { r: 0, g: 0, b: 0 });
});

test("a new variable in a collection with an unmanaged mode fills that mode from the default", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light", "HighContrast"]);
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "new", type: "COLOR", values: { Light: "#00ff00" } },
  ] }]);
  const dry = await runTokens(ctx, params(doc));
  const create = dry.changes.find((c) => c.kind === "variable" && c.name === "new");
  assert.deepEqual(create.fillsUnmanagedModes, ["HighContrast"]);
  await runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint });
  assert.deepEqual(variable(ctx, theme, "new").valuesByMode[theme.modes[1].modeId], { r: 0, g: 1, b: 0 });
});

test("a verification failure is rolled back and named", async () => {
  const ctx = makeCtx();
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "size", type: "FLOAT", values: { Light: 4 } },
  ] }]);
  const dry = await runTokens(ctx, params(doc));
  ctx.failValueWrites = true;
  await assert.rejects(
    () => runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint }),
    /TOKENS_VERIFICATION_FAILED.*rolled back/,
  );
  assert.ok(ctx.metrics.undos > 0);
});

test("unsupported DTCG token types are blocking, never silently dropped", async () => {
  const ctx = makeCtx();
  const doc = { shadow: { $type: "shadow", $value: { color: "#000000" } } };
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /\$type "shadow" is not supported/.test(b)));
});

test("export does not turn an invalid colour into black", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  ctx.addVariable(theme, "bad", "COLOR", { [theme.modes[0].modeId]: { r: 0, g: 0, b: 0, a: 2 } });
  const out = await runTokens(ctx, { action: "export" });
  assert.ok(out.warnings.some((w) => /not an RGBA colour/.test(w)));
  assert.equal(out.document.collections[0].variables[0].values.Light, null);
});

test("DTCG type names are matched case-insensitively", async () => {
  const ctx = makeCtx();
  const doc = {
    color: { $type: "Color", bg: { $value: "#112233" } },
    space: { $type: "Dimension", sm: { $value: { value: 4, unit: "PX" } } },
  };
  const dry = await runTokens(ctx, params(doc));
  assert.equal(dry.blocking.length, 0);
  assert.ok(dry.warnings.some((w) => /unitless FLOAT/.test(w)));
  const out = await runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint });
  assert.equal(out.status, "applied");
});

test("export names unsupported variable types instead of pretending they synced", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  ctx.addVariable(theme, "easing", "EASING", { [theme.modes[0].modeId]: { type: "EASING", easingFunction: "EASE_IN" } });
  const out = await runTokens(ctx, { action: "export" });
  assert.equal(out.counts.skipped, 1);
  assert.ok(out.warnings.some((w) => /EASING/.test(w)));
  assert.equal(out.document.collections[0].variables.length, 0);
});

test("native validation rejects a missing mode value and a bad alias", async () => {
  const ctx = makeCtx();
  const doc = nativeDoc([{
    name: "Theme", modes: ["Light", "Dark"], variables: [
      { name: "color/bg", type: "COLOR", values: { Light: "#ffffff" } },
      { name: "bad", type: "COLOR", values: { Light: { alias: "Theme/color/bg" }, Dark: "#000000" } },
    ],
  }]);
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /missing mode "Dark"/.test(b)));
  assert.ok(out.blocking.some((b) => /alias must be \{alias:\{collection,name\}\}/.test(b)));
});

test("maxChanges truncates the preview but keeps complete counts", async () => {
  const ctx = makeCtx();
  const variables = Array.from({ length: 6 }, (_, i) => ({
    name: `size/${i}`, type: "FLOAT", values: { Light: i },
  }));
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables }]);
  const out = await runTokens(ctx, params(doc, { maxChanges: 2 }));
  assert.equal(out.summary.variables.create, 6);
  assert.equal(out.summary.changes, 7); // collection + 6 variables
  assert.equal(out.changes.length, 2);
  assert.equal(out.summary.truncated, true);
});

test("a new collection cannot claim a second mode as its default", async () => {
  const ctx = makeCtx();
  const doc = nativeDoc([{
    name: "Theme", modes: ["Light", "Dark"], defaultMode: "Dark",
    variables: [{ name: "bg", type: "COLOR", values: { Light: "#ffffff", Dark: "#000000" } }],
  }]);
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /first mode is its default/.test(b)));
});

test("a remote alias is refused instead of being rebound to a local name", async () => {
  const ctx = makeCtx();
  const doc = nativeDoc([{
    name: "Theme", modes: ["Light"], variables: [{
      name: "fg", type: "COLOR",
      values: { Light: { alias: { collection: "Remote library", name: "text", remote: true } } },
    }],
  }]);
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /remote\/library alias needs its live variable id/.test(b)));
});

test("an unsupported type is blocking even when the value is an alias", async () => {
  const ctx = makeCtx();
  const doc = {
    color: { $type: "color", bg: { $value: "#ffffff" } },
    shadow: { $type: "shadow", $value: "{color.bg}" },
  };
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /\$type "shadow" is not supported/.test(b)));
});

test("duplicate local collection names are refused instead of creating a third", async () => {
  const ctx = makeCtx();
  ctx.addCollection("Theme", ["Light"]);
  ctx.addCollection("Theme", ["Light"]);
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [] }]);
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /more than one local collection is named "Theme"/.test(b)));
});

test("duplicate local variable names are refused instead of creating another", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  ctx.addVariable(theme, "bg", "COLOR", { [theme.modes[0].modeId]: { r: 1, g: 1, b: 1 } });
  ctx.addVariable(theme, "bg", "COLOR", { [theme.modes[0].modeId]: { r: 0, g: 0, b: 0 } });
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [
    { name: "bg", type: "COLOR", values: { Light: "#ffffff" } },
  ] }]);
  const out = await runTokens(ctx, params(doc));
  assert.ok(out.blocking.some((b) => /more than one local variable in "Theme" is named "bg"/.test(b)));
});

test("a remote alias is exported as remote and named, not guessed at", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  const remoteCollection = { id: "R:1", name: "Library", modes: [] };
  const remote = ctx.addVariable(remoteCollection, "text", "COLOR", {});
  ctx.variables.getVariableCollectionByIdAsync = async (id) => (id === "R:1" ? remoteCollection : null);
  ctx.addVariable(theme, "fg", "COLOR", {
    [theme.modes[0].modeId]: { type: "VARIABLE_ALIAS", id: remote.id },
  });
  const out = await runTokens(ctx, { action: "export" });
  const fg = out.document.collections[0].variables.find((v) => v.name === "fg");
  assert.deepEqual(fg.values.Light, { alias: { collection: "Library", name: "text", remote: true, id: remote.id } });
  assert.ok(out.warnings.some((w) => /remote\/library collection/.test(w)));
});

function remoteAliasFixture() {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  const remoteCollection = { id: "R:1", name: "Library", modes: [] };
  const remote = ctx.addVariable(remoteCollection, "text", "COLOR", {});
  ctx.variables.getVariableCollectionByIdAsync = async (id) => (id === "R:1" ? remoteCollection : null);
  return { ctx, theme, remote };
}

test("an unreadable alias target round-trips as a remote id, not a local name", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  ctx.addVariable(theme, "fg", "COLOR", {
    [theme.modes[0].modeId]: { type: "VARIABLE_ALIAS", id: "MISSING:1" },
  });
  const exported = await runTokens(ctx, { action: "export" });
  const fg = exported.document.collections[0].variables.find((v) => v.name === "fg");
  assert.deepEqual(fg.values.Light, { alias: { variableId: "MISSING:1", remote: true } });
  const diff = await runTokens(ctx, { action: "diff", document: exported.document });
  assert.equal(diff.blocking.length, 0);
  assert.deepEqual(diff.summary.variables, { create: 0, update: 0, delete: 0, unchanged: 1 });
});

test("an unchanged remote alias round-trips through export and diff", async () => {
  const { ctx, theme, remote } = remoteAliasFixture();
  ctx.addVariable(theme, "fg", "COLOR", {
    [theme.modes[0].modeId]: { type: "VARIABLE_ALIAS", id: remote.id },
  });
  const exported = await runTokens(ctx, { action: "export" });
  const diff = await runTokens(ctx, { action: "diff", document: exported.document });
  assert.equal(diff.blocking.length, 0);
  assert.deepEqual(diff.summary.variables, { create: 0, update: 0, delete: 0, unchanged: 1 });
});

test("a remote alias cannot be created or changed by name", async () => {
  const ctx = makeCtx();
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [{
    name: "fg", type: "COLOR",
    values: { Light: { alias: { collection: "Library", name: "text", remote: true, id: "R:1" } } },
  }] }]);
  const dry = await runTokens(ctx, params(doc));
  assert.ok(dry.blocking.some((b) => /remote\/library alias .* cannot be bound by name/.test(b)));

  const ctx2 = makeCtx();
  const theme = ctx2.addCollection("Theme", ["Light"]);
  ctx2.addVariable(theme, "fg", "COLOR", { [theme.modes[0].modeId]: { r: 1, g: 1, b: 1 } });
  const changed = await runTokens(ctx2, params(doc));
  assert.ok(changed.blocking.some((b) => /only an existing identical alias can be preserved/.test(b)));
});

test("an unchanged remote alias is preserved while another value is written", async () => {
  const { ctx, theme, remote } = remoteAliasFixture();
  const fg = ctx.addVariable(theme, "fg", "COLOR", {
    [theme.modes[0].modeId]: { type: "VARIABLE_ALIAS", id: remote.id },
  });
  const doc = nativeDoc([{ name: "Theme", modes: ["Light"], variables: [{
    name: "fg", type: "COLOR",
    values: { Light: { alias: { collection: "Library", name: "text", remote: true, id: remote.id } } },
  }, {
    name: "bg", type: "COLOR", values: { Light: "#ffffff" },
  }] }]);
  const dry = await runTokens(ctx, params(doc));
  assert.equal(dry.blocking.length, 0);
  const out = await runTokens(ctx, { ...params(doc), dryRun: false, expectedFingerprint: dry.fingerprint });
  assert.equal(out.status, "applied");
  assert.deepEqual(fg.valuesByMode[theme.modes[0].modeId], { type: "VARIABLE_ALIAS", id: remote.id });
});

test("a new alias cannot point at a variable the same plan prunes", async () => {
  const ctx = makeCtx();
  const theme = ctx.addCollection("Theme", ["Light"]);
  ctx.addVariable(theme, "old", "COLOR", { [theme.modes[0].modeId]: { r: 0, g: 0, b: 0 } });
  const doc = nativeDoc([{
    name: "Theme", modes: ["Light"], variables: [{
      name: "fg", type: "COLOR",
      values: { Light: { alias: { collection: "Theme", name: "old" } } },
    }],
  }]);
  const out = await runTokens(ctx, params(doc, { prune: true, allowDestructive: true }));
  assert.ok(out.blocking.some((b) => /alias target Theme\/old is being pruned/.test(b)));
});
