/**
 * The identity an unsaved file answers to.
 *
 * figma.fileKey is undefined until a file is saved for the first time, so an
 * unsaved file needs a session key instead — and that key has to outlive the
 * plugin run that minted it. Minted per run, it changes on every panel reload,
 * every key an agent had just read goes stale, and every call carrying it is
 * refused: the daemon refuses to guess which file a request means, by design,
 * so a stale key is a red error rather than a wrong edit.
 *
 * The key therefore lives ON the document (`figma.root` pluginData), which both
 * the panel reload and the plugin being re-run leave intact, and which is
 * unique per open document. The document is unsaved by definition here, so the
 * stored string costs nothing; a file saved later answers to its real
 * figma.fileKey instead, from the next reload on.
 *
 * Deliberately free of `figma`: `root` is anything with get/setPluginData, so
 * the test can pin the contract — "a reload keeps the key" — with no Figma.
 */
export const KEY_SLOT = "figma-local-bridge.sessionKey";

export interface PluginDataHost {
  getPluginData(key: string): string;
  setPluginData(key: string, value: string): void;
}

/** 8 base36 characters, padded: a key that is shorter than it looks is a bug. */
const mint = () => "unsaved-" + Math.random().toString(36).slice(2, 10).padEnd(8, "0");

export function sessionKey(root: PluginDataHost, makeKey: () => string = mint): string {
  const stored = root.getPluginData(KEY_SLOT);
  if (stored) return stored;
  const key = makeKey();
  root.setPluginData(KEY_SLOT, key);
  return key;
}
