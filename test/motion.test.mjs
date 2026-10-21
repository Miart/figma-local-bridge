import test from "node:test";
import assert from "node:assert/strict";
import { runMotion } from "../plugin/motion.mjs";

const FIELD = { type: "PROPERTY", name: "OPACITY" };

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

function makeNode() {
  let keyseq = 0;
  const node = {
    id: "1:2",
    name: "Card",
    type: "FRAME",
    animationStyles: [],
    manualKeyframeTracks: {},
    animations: {},
    timelines: [{ id: "TL:1", duration: 1.2 }],
    wrongDuration: false,
    wrongEasing: false,
    applyAnimationStyle(styleId, config = {}) {
      const id = `A:${++keyseq}`;
      const applied = {
        id,
        styleId,
        name: styleId === "S:1" ? "Fade" : "Custom",
        type: config.type === "CUSTOM" ? "CUSTOM" : "FIGMA",
        ...clone(config),
      };
      if (node.wrongDuration && applied.duration !== undefined) applied.duration += 1;
      this.animationStyles.push(applied);
      return id;
    },
    removeAnimationStyle(id) {
      const at = this.animationStyles.findIndex((s) => s.id === id);
      if (at < 0) throw new Error(`no applied style ${id}`);
      this.animationStyles.splice(at, 1);
    },
    applyManualKeyframeTrack(field, track) {
      if (field.type !== "PROPERTY") throw new Error("this stub only writes property tracks");
      this.manualKeyframeTracks[field.name] = {
        id: "T:1",
        baseValue: clone(track.baseValue),
        keyframes: track.keyframes.map((k, i) => ({
          id: k.id || `K:${i}`,
          timelinePosition: k.timelinePosition,
          value: clone(k.value),
          easing: node.wrongEasing && k.easing?.type === "CUSTOM_SPRING"
            ? { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.1 } }
            : clone(k.easing || { type: "LINEAR" }),
        })),
      };
    },
    removeManualKeyframeTrack(field) {
      if (field.type !== "PROPERTY") throw new Error("this stub only removes property tracks");
      delete this.manualKeyframeTracks[field.name];
    },
    setTimelineDuration(id, duration) {
      const timeline = this.timelines.find((t) => t.id === id);
      if (!timeline) throw new Error(`no timeline ${id}`);
      timeline.duration = duration;
    },
  };
  return node;
}

function makeFigma({ motion = true, node = makeNode() } = {}) {
  return {
    node,
    motion: motion
      ? {
          playheadPosition: 0.25,
          figmaAnimationStyles: () => [{ styleId: "S:1", name: "Fade", props: { duration: 0.6 } }],
        }
      : undefined,
    async getLocalCustomAnimationStylesAsync() {
      return [{
        id: "C:1",
        type: "CUSTOM_ANIMATION",
        name: "My custom",
        animationEntries: [{ id: "E:1", styleId: "S:1", name: "Fade", type: "FIGMA" }],
      }];
    },
    async getNodeByIdAsync(id) {
      return id === node.id ? node : null;
    },
    currentPage: { selection: [node] },
  };
}

function makeTransact() {
  const log = { writes: 0, rollbacks: 0 };
  return {
    log,
    async transact(fn) {
      let wrote = false;
      try {
        return await fn(() => { wrote = true; log.writes++; });
      } catch (err) {
        if (wrote) log.rollbacks++;
        throw err;
      }
    },
  };
}

test("a build without figma.motion fails with MOTION_UNAVAILABLE, not an empty catalogue", async () => {
  const figma = makeFigma({ motion: false });
  const t = makeTransact();
  await assert.rejects(runMotion(figma, "motion_styles", {}, t.transact), /MOTION_UNAVAILABLE/);
  await assert.rejects(runMotion(figma, "motion_inspect", { nodeId: "1:2" }, t.transact), /MOTION_UNAVAILABLE/);
  assert.equal(t.log.writes, 0);
});

test("styles lists Figma and custom styles with the playhead", async () => {
  const figma = makeFigma();
  const out = await runMotion(figma, "motion_styles", {}, makeTransact().transact);
  assert.equal(out.available, true);
  assert.equal(out.playheadPosition, 0.25);
  assert.equal(out.counts.figma, 1);
  assert.equal(out.counts.custom, 1);
  assert.equal(out.customAvailable, true);
  assert.equal(out.figmaStyles[0].styleId, "S:1");
  assert.equal(out.customStyles[0].id, "C:1");
  assert.equal(out.customStyles[0].entries[0].id, "E:1");
});

test("inspect reports the node state and which Motion methods exist", async () => {
  const figma = makeFigma();
  figma.node.animationStyles.push({ id: "A:9", styleId: "S:1", name: "Fade", type: "FIGMA", duration: 0.6 });
  const out = await runMotion(figma, "motion_inspect", { nodeId: "1:2" }, makeTransact().transact);
  assert.equal(out.node.id, "1:2");
  assert.equal(out.animationStyles[0].id, "A:9");
  assert.equal(out.timelines[0].id, "TL:1");
  assert.equal(out.capabilities.applyAnimationStyle, true);
  assert.equal(out.capabilities.manualKeyframes, true);
});

test("a missing custom-style API is named, not reported as an empty custom catalogue", async () => {
  const figma = makeFigma();
  delete figma.getLocalCustomAnimationStylesAsync;
  const out = await runMotion(figma, "motion_styles", {}, makeTransact().transact);
  assert.equal(out.customAvailable, false);
  assert.equal(out.counts.custom, 0);
  assert.match(out.warnings.join(" "), /custom animation styles/);
  await assert.rejects(
    runMotion(figma, "motion_apply_style", { nodeId: "1:2", styleId: "C:1" }, makeTransact().transact),
    /MOTION_UNAVAILABLE/,
  );
});

test("a node without Motion state fails as unavailable instead of reporting an empty object", async () => {
  const node = makeNode();
  delete node.animationStyles;
  const figma = makeFigma({ node });
  await assert.rejects(runMotion(figma, "motion_inspect", { nodeId: "1:2" }, makeTransact().transact), /MOTION_UNAVAILABLE/);
});

test("apply style is a dry run by default, then applies with the returned planId", async () => {
  const figma = makeFigma();
  const t = makeTransact();
  const args = { nodeId: "1:2", styleId: "S:1", duration: 0.6, props: { duration: 0.6 } };

  const dry = await runMotion(figma, "motion_apply_style", args, t.transact);
  assert.equal(dry.status, "dry_run");
  assert.equal(t.log.writes, 0);
  assert.equal(figma.node.animationStyles.length, 0);

  const applied = await runMotion(figma, "motion_apply_style", { ...args, dryRun: false, planId: dry.planId }, t.transact);
  assert.equal(applied.status, "applied");
  assert.equal(applied.appliedStyleId, "A:1");
  assert.equal(applied.appliedStyle.duration, 0.6);
  assert.equal(t.log.writes, 1);
  assert.equal(t.log.rollbacks, 0);
});

test("apply style refuses a planId from a different plan", async () => {
  const figma = makeFigma();
  const t = makeTransact();
  await assert.rejects(
    runMotion(figma, "motion_apply_style", { nodeId: "1:2", styleId: "S:1", dryRun: false, planId: "motion-other" }, t.transact),
    /MOTION_PLAN_MISMATCH/,
  );
  assert.equal(t.log.writes, 0);
});

test("a style that reads back with the wrong duration rolls back", async () => {
  const figma = makeFigma();
  figma.node.wrongDuration = true;
  const t = makeTransact();
  const args = { nodeId: "1:2", styleId: "S:1", duration: 0.6 };
  const dry = await runMotion(figma, "motion_apply_style", args, t.transact);
  await assert.rejects(
    runMotion(figma, "motion_apply_style", { ...args, dryRun: false, planId: dry.planId }, t.transact),
    /MOTION_VERIFY_FAILED/,
  );
  assert.equal(t.log.rollbacks, 1);
});

test("a custom style refuses a duration instead of dropping it", async () => {
  const figma = makeFigma();
  await assert.rejects(
    runMotion(figma, "motion_apply_style", { nodeId: "1:2", styleId: "C:1", duration: 0.6 }, makeTransact().transact),
    /does not take a duration/,
  );
});

test("custom easing parameters are part of the read-back, not just the easing type", async () => {
  const figma = makeFigma();
  figma.node.wrongEasing = true;
  const t = makeTransact();
  const args = {
    nodeId: "1:2",
    field: FIELD,
    track: {
      keyframes: [{
        timelinePosition: 0,
        value: { type: "FLOAT", value: 0 },
        easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.8 } },
      }],
    },
  };
  const dry = await runMotion(figma, "motion_set_keyframes", args, t.transact);
  await assert.rejects(
    runMotion(figma, "motion_set_keyframes", { ...args, dryRun: false, planId: dry.planId }, t.transact),
    /MOTION_VERIFY_FAILED/,
  );
  assert.equal(t.log.rollbacks, 1);
});

test("remove style is a no-op when the applied id is absent", async () => {
  const figma = makeFigma();
  const t = makeTransact();
  const dry = await runMotion(figma, "motion_remove_style", { nodeId: "1:2", appliedStyleId: "A:404" }, t.transact);
  assert.equal(dry.wouldChange, false);
  const applied = await runMotion(figma, "motion_remove_style", {
    nodeId: "1:2", appliedStyleId: "A:404", dryRun: false, planId: dry.planId,
  }, t.transact);
  assert.equal(applied.removed, false);
  assert.equal(t.log.writes, 0);
});

test("set keyframes validates, applies, and verifies every position/value/easing", async () => {
  const figma = makeFigma();
  const t = makeTransact();
  const args = {
    nodeId: "1:2",
    field: FIELD,
    track: {
      baseValue: { type: "FLOAT", value: 1 },
      keyframes: [
        { timelinePosition: 0, value: { type: "FLOAT", value: 0 } },
        { timelinePosition: 0.6, value: { type: "FLOAT", value: 1 }, easing: { type: "EASE_OUT" } },
      ],
    },
  };
  const dry = await runMotion(figma, "motion_set_keyframes", args, t.transact);
  assert.equal(dry.status, "dry_run");
  assert.equal(t.log.writes, 0);

  const applied = await runMotion(figma, "motion_set_keyframes", { ...args, dryRun: false, planId: dry.planId }, t.transact);
  assert.equal(applied.status, "applied");
  assert.equal(applied.readback.keyframes.length, 2);
  assert.equal(applied.readback.keyframes[1].easing.type, "EASE_OUT");
  assert.equal(figma.node.manualKeyframeTracks.OPACITY.keyframes[1].value.value, 1);
});

test("duplicate keyframe positions and mixed value types are refused before a transaction", async () => {
  const figma = makeFigma();
  const t = makeTransact();
  const duplicate = {
    nodeId: "1:2",
    field: FIELD,
    track: {
      keyframes: [
        { timelinePosition: 0.2, value: { type: "FLOAT", value: 0 } },
        { timelinePosition: 0.2, value: { type: "FLOAT", value: 1 } },
      ],
    },
  };
  await assert.rejects(runMotion(figma, "motion_set_keyframes", duplicate, t.transact), /share timelinePosition/);

  const mixed = {
    nodeId: "1:2",
    field: FIELD,
    track: {
      keyframes: [
        { timelinePosition: 0, value: { type: "FLOAT", value: 0 } },
        { timelinePosition: 0.5, value: { type: "BOOL", value: true } },
      ],
    },
  };
  await assert.rejects(runMotion(figma, "motion_set_keyframes", mixed, t.transact), /same value type/);
  assert.equal(t.log.writes, 0);
});

test("remove keyframes reports the current track and verifies its removal", async () => {
  const figma = makeFigma();
  const t = makeTransact();
  const setArgs = {
    nodeId: "1:2",
    field: FIELD,
    track: { keyframes: [{ timelinePosition: 0, value: { type: "FLOAT", value: 0 } }] },
  };
  const setDry = await runMotion(figma, "motion_set_keyframes", setArgs, t.transact);
  await runMotion(figma, "motion_set_keyframes", { ...setArgs, dryRun: false, planId: setDry.planId }, t.transact);

  const dry = await runMotion(figma, "motion_remove_keyframes", { nodeId: "1:2", field: FIELD }, t.transact);
  assert.equal(dry.wouldChange, true);
  const removed = await runMotion(figma, "motion_remove_keyframes", {
    nodeId: "1:2", field: FIELD, dryRun: false, planId: dry.planId,
  }, t.transact);
  assert.equal(removed.removed, true);
  assert.equal(figma.node.manualKeyframeTracks.OPACITY, undefined);
});

test("set duration checks the timeline id and verifies the readback", async () => {
  const figma = makeFigma();
  const t = makeTransact();
  const args = { nodeId: "1:2", timelineId: "TL:1", duration: 2.5 };
  const dry = await runMotion(figma, "motion_set_duration", args, t.transact);
  assert.equal(dry.status, "dry_run");
  const applied = await runMotion(figma, "motion_set_duration", { ...args, dryRun: false, planId: dry.planId }, t.transact);
  assert.equal(applied.status, "applied");
  assert.equal(applied.timeline.duration, 2.5);

  await assert.rejects(
    runMotion(figma, "motion_set_duration", { nodeId: "1:2", timelineId: "TL:404", duration: 1 }, t.transact),
    /MOTION_TIMELINE_NOT_FOUND/,
  );
});
