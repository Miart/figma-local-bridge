import { z } from "zod";

/**
 * Which connected Figma file a tool call targets.
 *
 * With one file connected it can be omitted — every call lands there. With
 * several, omitting it is REFUSED before anything is sent, because guessing
 * would silently edit the wrong file; the refusal lists the connected files
 * and `figma_ping` returns the same list.
 *
 * The value is the Figma fileKey for a saved file (`figma_whoami` shows it),
 * or the session key the plugin minted for a file that was never saved.
 */
export const fileKeyParam = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Which connected Figma file to use: its fileKey (figma_whoami) or, when omitted, the only connected file. " +
      "Required once more than one file is connected; figma_ping lists them.",
  );
