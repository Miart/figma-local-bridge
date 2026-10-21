/**
 * One source for the server name and version.
 *
 * `index.ts` puts these on the MCP handshake, and `figma_ping` puts them in the
 * capability report. Keeping them here means a release bump cannot leave one
 * of the two claiming the previous version.
 */
export const SERVER_NAME = "figma-local-bridge";
export const SERVER_VERSION = "0.31.0";
