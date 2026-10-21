/**
 * Read-only Motion commands: style catalogue and node inspection.
 *
 * These never write and are registered even when the bridge is in read-only
 * mode. A build without the Beta API gets MOTION_UNAVAILABLE, never an empty
 * catalogue that looks like a working document.
 */
import {
  clean, customStyles, figmaStyles, identity, motionApi, readState, resolveNode,
  type Json,
} from "./motion-core";

function playhead(figma: any): { value: number | null; warning?: string } {
  try {
    const v = motionApi(figma).playheadPosition;
    return { value: typeof v === "number" && Number.isFinite(v) ? v : null };
  } catch (e: any) {
    if (e && e.code) throw e;
    return { value: null, warning: `playhead position could not be read (${String(e && e.message ? e.message : e)})` };
  }
}

export async function motionStyles(figma: any): Promise<Json> {
  const styles = figmaStyles(figma);
  const custom = await customStyles(figma);
  const head = playhead(figma);
  const warnings = [custom.warning, head.warning].filter(Boolean);

  return {
    schema: "motion-styles-v1",
    available: true,
    playheadPosition: head.value,
    figmaStyles: styles.map((s: any) => ({
      styleId: s.styleId,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      ...(s.props ? { props: clean(s.props) } : {}),
    })),
    customAvailable: custom.available,
    customStyles: custom.styles
      .filter((s: any) => s && s.type === "CUSTOM_ANIMATION")
      .map((s: any) => ({
        styleId: s.id,
        id: s.id,
        key: s.key,
        name: s.name,
        entries: (s.animationEntries || []).map((e: any) => clean(e)),
      })),
    counts: {
      figma: styles.length,
      custom: custom.styles.filter((s: any) => s && s.type === "CUSTOM_ANIMATION").length,
    },
    warnings,
  };
}

export async function motionInspect(figma: any, p: Json): Promise<Json> {
  // Probe figma.motion before resolving the node: if the API is absent, the
  // answer must name that, not "node has no animationStyles".
  motionApi(figma);
  const node = await resolveNode(figma, p);
  const state = readState(node);
  const head = playhead(figma);

  return {
    schema: "motion-inspect-v1",
    node: identity(node),
    playheadPosition: head.value,
    animationStyles: state.animationStyles,
    manualKeyframeTracks: state.manualKeyframeTracks,
    animations: state.animations,
    timelines: state.timelines,
    capabilities: {
      animationStyles: Array.isArray(node.animationStyles),
      applyAnimationStyle: typeof node.applyAnimationStyle === "function",
      removeAnimationStyle: typeof node.removeAnimationStyle === "function",
      manualKeyframes: typeof node.applyManualKeyframeTrack === "function",
      timelineDuration: typeof node.setTimelineDuration === "function",
    },
    ...(head.warning ? { warnings: [head.warning] } : {}),
  };
}
