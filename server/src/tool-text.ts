/**
 * Text for a tool result.
 *
 * Small replies stay pretty-printed: they are read by a person looking at the
 * transcript. Large replies are serialized compactly, because there the added
 * whitespace is not readability — it is bytes on the wire and tokens in the
 * caller's context. A measured 235 KB index became 343 KB when pretty-printed,
 * a 46% increase for no information.
 *
 * The threshold is deliberately above ordinary tool replies (plans, errors,
 * counts) and below the big readers (design context, build specs, indexes).
 */
const PRETTY_LIMIT = 128 * 1024;

export function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  const compact = JSON.stringify(value);
  if (compact === undefined) return "null";
  return compact.length > PRETTY_LIMIT ? compact : JSON.stringify(value, null, 2);
}
