/**
 * Monotonic count of calls the plugin has completed.
 *
 * Shared rather than kept in code.ts so any tool can stamp its result with the
 * document state it actually observed. Screenshots need this most: Figma's
 * exporter happily returns a cached image after the document has changed, and
 * there is no Plugin API call to invalidate it. Two identical screenshots with
 * a different rev therefore prove the bytes are stale rather than proving the
 * edit was a no-op — a distinction that is otherwise invisible.
 */
let n = 0;

/** Advance the counter and return the new value. */
export function bump(): number {
  return ++n;
}

/** The value an in-flight call should stamp its result with. */
export function current(): number {
  return n;
}