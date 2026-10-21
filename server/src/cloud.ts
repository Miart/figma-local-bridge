/**
 * Optional read-only access to Figma's public REST API.
 *
 * The local bridge never needs this module: it is registered only when the
 * process is explicitly opted in with FIGMA_CLOUD=1 *and* a token is present.
 * It exists for the questions the open file cannot answer — a file that is not
 * open in Figma Desktop, or a node from a file the user has not opened yet.
 *
 * Two rules keep it honest:
 *
 *   - it only exposes documented GET endpoints, so it cannot claim to create a
 *     file, generate a design or run Weave;
 *   - every Figma failure keeps its HTTP meaning (401, 403, 429, ...) and the
 *     token is never put in a URL, an error message or a tool reply;
 *   - the one local write is an explicitly requested image download, and it
 *     never touches the Figma document.
 */
import { SERVER_VERSION } from "./version.js";

export const CLOUD_TOOL_NAMES = [
  "figma_cloud_ping",
  "figma_cloud_get_file",
  "figma_cloud_get_nodes",
  "figma_cloud_get_image",
  "figma_cloud_download_image",
] as const;

export const CLOUD_READ_AREAS = ["file", "nodes", "images"] as const;

export const CLOUD_DEFAULT_BASE = "https://api.figma.com";
export const CLOUD_DEFAULT_TIMEOUT_MS = 30_000;
export const CLOUD_DEFAULT_MAX_BYTES = 8_000_000;
export const CLOUD_DEFAULT_IMAGE_MAX_BYTES = 10_000_000;
export const CLOUD_DEFAULT_DOWNLOAD_TOTAL_BYTES = 50_000_000;
export const CLOUD_MAX_DOWNLOAD_NODES = 20;

export type CloudTokenKind = "pat" | "oauth";

export interface CloudConfig {
  /** True only when the adapter is opted in, a token is present and the config is valid. */
  enabled: boolean;
  /** Whether a credential is present, even if the adapter is switched off. */
  configured: boolean;
  tokenKind: CloudTokenKind | null;
  /** Kept out of every serialised reply; CloudClient reads it directly. */
  token: string | null;
  apiBase: string;
  timeoutMs: number;
  /** True only with FIGMA_CLOUD_INSECURE=1; allows localhost image downloads over HTTP. */
  allowLocalHttp: boolean;
  reason: string;
}

const LOCAL_HTTP_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Read the opt-in switch, one credential and the transport limits.
 *
 * A token alone is deliberately not enough: editors often keep several API
 * tokens in the environment, and a bridge that silently starts sending design
 * data to a cloud service because one of them is named FIGMA_* would be a worse
 * default than an extra `FIGMA_CLOUD=1`.
 */
export function readCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const flag = (env.FIGMA_CLOUD || "").trim().toLowerCase();
  const optedIn = flag === "1" || flag === "true";
  const pat = (env.FIGMA_CLOUD_TOKEN || "").trim();
  const oauth = (env.FIGMA_CLOUD_OAUTH_TOKEN || "").trim();
  const configured = Boolean(pat || oauth);

  let apiBase = CLOUD_DEFAULT_BASE;
  let reason = "";

  const rawBase = (env.FIGMA_CLOUD_API_BASE || "").trim();
  if (rawBase) {
    try {
      const url = new URL(rawBase);
      if (url.username || url.password) throw new Error("must not contain credentials");
      if (url.search || url.hash) throw new Error("must not contain a query or fragment");
      const localHttp = url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname);
      if (url.protocol !== "https:" && !(localHttp && env.FIGMA_CLOUD_INSECURE === "1")) {
        throw new Error("must use https (set FIGMA_CLOUD_INSECURE=1 only for a localhost test server)");
      }
      url.pathname = trimSlash(url.pathname);
      apiBase = trimSlash(url.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reason = `FIGMA_CLOUD_API_BASE is invalid: ${message}.`;
    }
  }

  let timeoutMs = CLOUD_DEFAULT_TIMEOUT_MS;
  const rawTimeout = (env.FIGMA_CLOUD_TIMEOUT_MS || "").trim();
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
      reason = "FIGMA_CLOUD_TIMEOUT_MS must be an integer from 1000 to 120000.";
    } else {
      timeoutMs = parsed;
    }
  }

  let tokenKind: CloudTokenKind | null = null;
  let token: string | null = null;
  if (pat && oauth) {
    reason = "Set only one of FIGMA_CLOUD_TOKEN (PAT) and FIGMA_CLOUD_OAUTH_TOKEN (OAuth access token).";
  } else if (oauth) {
    tokenKind = "oauth";
    token = oauth;
  } else if (pat) {
    tokenKind = "pat";
    token = pat;
  }

  if (!reason) {
    if (!optedIn) {
      reason =
        flag === "0" || flag === "false"
          ? "Cloud adapter disabled by FIGMA_CLOUD=0."
          : "Cloud adapter is off. Set FIGMA_CLOUD=1 and a token to enable read-only Figma REST access.";
    } else if (!configured) {
      reason =
        "Cloud adapter is on but no credential is set. Use FIGMA_CLOUD_TOKEN (PAT) or FIGMA_CLOUD_OAUTH_TOKEN (OAuth access token).";
    } else if (!tokenKind || !token) {
      reason = "Cloud adapter has no usable credential.";
    }
  }

  const enabled = Boolean(optedIn && configured && tokenKind && token && !reason);
  return {
    enabled,
    configured,
    tokenKind,
    token,
    apiBase,
    timeoutMs,
    allowLocalHttp: env.FIGMA_CLOUD_INSECURE === "1",
    reason: enabled ? "Read-only Figma REST adapter enabled; no Figma writes are exposed." : reason,
  };
}

export type CloudErrorCode =
  | "CLOUD_NOT_CONFIGURED"
  | "CLOUD_UNAUTHORIZED"
  | "CLOUD_FORBIDDEN"
  | "CLOUD_NOT_FOUND"
  | "CLOUD_BAD_REQUEST"
  | "CLOUD_RATE_LIMITED"
  | "CLOUD_UPSTREAM"
  | "CLOUD_TIMEOUT"
  | "CLOUD_UNREACHABLE"
  | "CLOUD_RESPONSE_TOO_LARGE"
  | "CLOUD_BAD_RESPONSE"
  | "CLOUD_DOWNLOAD_BLOCKED"
  | "CLOUD_BAD_IMAGE"
  | "CLOUD_DOWNLOAD_FAILED";

export interface CloudErrorInfo {
  code: CloudErrorCode;
  message: string;
  status?: number;
  requestId?: string;
  retryAfterSeconds?: number;
  maxBytes?: number;
  bytes?: number;
}

export class CloudError extends Error {
  readonly code: CloudErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly maxBytes?: number;
  readonly bytes?: number;

  constructor(
    code: CloudErrorCode,
    message: string,
    extra: Omit<CloudErrorInfo, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.status = extra.status;
    this.requestId = extra.requestId;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.maxBytes = extra.maxBytes;
    this.bytes = extra.bytes;
  }

  toJSON(): CloudErrorInfo {
    const out: CloudErrorInfo = { code: this.code, message: this.message };
    if (this.status !== undefined) out.status = this.status;
    if (this.requestId !== undefined) out.requestId = this.requestId;
    if (this.retryAfterSeconds !== undefined) out.retryAfterSeconds = this.retryAfterSeconds;
    if (this.maxBytes !== undefined) out.maxBytes = this.maxBytes;
    if (this.bytes !== undefined) out.bytes = this.bytes;
    return out;
  }
}

export interface CloudFileRequest {
  fileKey: string;
  nodeIds?: string[];
  depth?: number;
  version?: string;
  geometry?: boolean;
  pluginData?: "shared" | "all";
  maxBytes: number;
}

export interface CloudNodesRequest extends CloudFileRequest {
  nodeIds: string[];
}

export interface CloudImageRequest {
  fileKey: string;
  nodeIds: string[];
  format: "png" | "jpg" | "svg" | "pdf";
  scale?: number;
  svgOutlineText?: boolean;
  svgIncludeId?: boolean;
  svgIncludeNodeId?: boolean;
  svgSimplifyStroke?: boolean;
  contentsOnly?: boolean;
  useAbsoluteBounds?: boolean;
  version?: string;
  maxBytes: number;
}

export interface CloudResponse<T = unknown> {
  data: T;
  url: string;
  bytes: number;
  requestId?: string;
}

export interface CloudDownload {
  /** The signed URL Figma returned; kept internal and never serialised in full. */
  url: string;
  data: Buffer;
  bytes: number;
  contentType?: string;
  status: number;
  requestId?: string;
}

type QueryValue = string | number | undefined;

function redact(text: string, token: string | null): string {
  return token ? text.split(token).join("[redacted]") : text;
}

function apiMessage(body: string): string {
  const raw = body.trim().slice(0, 2_000);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["err", "message", "error"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
    }
  } catch {
    // A proxy or an outage can return HTML; a short text excerpt is still useful.
  }
  return raw.replace(/\s+/g, " ").slice(0, 500);
}

function statusCode(status: number): CloudErrorCode {
  if (status === 400) return "CLOUD_BAD_REQUEST";
  if (status === 401) return "CLOUD_UNAUTHORIZED";
  if (status === 403) return "CLOUD_FORBIDDEN";
  if (status === 404) return "CLOUD_NOT_FOUND";
  if (status === 429) return "CLOUD_RATE_LIMITED";
  return "CLOUD_UPSTREAM";
}

export class CloudClient {
  readonly config: CloudConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: CloudConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    if (!config.enabled || !config.token || !config.tokenKind) {
      throw new CloudError("CLOUD_NOT_CONFIGURED", config.reason || "Cloud adapter is not configured.");
    }
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async me(): Promise<CloudResponse<Record<string, unknown>>> {
    return this.request("/v1/me", {}, 1_000_000);
  }

  getFile(req: CloudFileRequest): Promise<CloudResponse> {
    return this.request(`/v1/files/${encodeURIComponent(req.fileKey)}`, this.fileQuery(req), req.maxBytes);
  }

  getNodes(req: CloudNodesRequest): Promise<CloudResponse> {
    return this.request(
      `/v1/files/${encodeURIComponent(req.fileKey)}/nodes`,
      this.fileQuery(req),
      req.maxBytes,
    );
  }

  /**
   * Download the bytes behind a URL returned by getImage().
   *
   * The Figma token is never sent here: the URL is a signed object-store URL,
   * not the REST API. Only https is accepted, except for a localhost mock when
   * FIGMA_CLOUD_INSECURE=1. Redirects are refused rather than followed, and the
   * body is capped while it is read.
   */
  async downloadImage(rawUrl: string, maxBytes: number): Promise<CloudDownload> {
    const url = this.parseImageUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "image/*,application/pdf;q=0.9",
          "User-Agent": `figma-local-bridge/${SERVER_VERSION}`,
        },
        signal: controller.signal,
        redirect: "manual",
      });

      const requestId =
        res.headers.get("x-amz-request-id") ||
        res.headers.get("x-request-id") ||
        undefined;

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        throw new CloudError(
          "CLOUD_DOWNLOAD_BLOCKED",
          `Image download redirected${location ? ` to ${urlHost(location)}` : ""}; redirects are not followed.`,
          { status: res.status, requestId },
        );
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new CloudError(
          statusCode(res.status),
          `Image download ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`,
          { status: res.status, requestId },
        );
      }

      const declared = Number(res.headers.get("content-length") || 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new CloudError(
          "CLOUD_RESPONSE_TOO_LARGE",
          `Image download is ${declared} bytes, over the ${maxBytes}-byte limit; lower the scale or raise maxBytes.`,
          { maxBytes, bytes: declared, requestId },
        );
      }

      const reader = res.body?.getReader();
      const chunks: Buffer[] = [];
      let received = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new CloudError(
              "CLOUD_RESPONSE_TOO_LARGE",
              `Image download exceeded ${maxBytes} bytes; lower the scale or raise maxBytes.`,
              { maxBytes, bytes: received, requestId },
            );
          }
          chunks.push(Buffer.from(value));
        }
      }
      const buffer = Buffer.concat(chunks, received);
      return {
        url: url.toString(),
        data: buffer,
        bytes: buffer.byteLength,
        contentType: res.headers.get("content-type") || undefined,
        status: res.status,
        requestId,
      };
    } catch (err) {
      if (err instanceof CloudError) throw err;
      if (controller.signal.aborted) {
        throw new CloudError(
          "CLOUD_TIMEOUT",
          `Image download timed out after ${this.config.timeoutMs}ms.`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new CloudError(
        "CLOUD_UNREACHABLE",
        `Image download failed: ${redact(message.slice(0, 500), this.config.token)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  getImage(req: CloudImageRequest): Promise<CloudResponse> {
    const query: Record<string, QueryValue> = {
      ids: req.nodeIds.join(","),
      format: req.format,
      scale: req.scale,
      version: req.version,
      svg_outline_text: bool(req.svgOutlineText),
      svg_include_id: bool(req.svgIncludeId),
      svg_include_node_id: bool(req.svgIncludeNodeId),
      svg_simplify_stroke: bool(req.svgSimplifyStroke),
      contents_only: bool(req.contentsOnly),
      use_absolute_bounds: bool(req.useAbsoluteBounds),
    };
    return this.request(`/v1/images/${encodeURIComponent(req.fileKey)}`, query, req.maxBytes);
  }

  private parseImageUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new CloudError("CLOUD_BAD_RESPONSE", "Figma returned an invalid image URL.");
    }
    if (url.username || url.password) {
      throw new CloudError("CLOUD_DOWNLOAD_BLOCKED", "Image URL contains credentials; refusing to use it.");
    }
    const localHttp =
      this.config.allowLocalHttp && LOCAL_HTTP_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !localHttp) {
      throw new CloudError(
        "CLOUD_DOWNLOAD_BLOCKED",
        "Image URL must use https (plain http is allowed only for localhost with FIGMA_CLOUD_INSECURE=1).",
      );
    }
    return url;
  }

  private fileQuery(req: CloudFileRequest): Record<string, QueryValue> {
    return {
      ids: req.nodeIds?.join(","),
      depth: req.depth,
      version: req.version,
      geometry: req.geometry ? "paths" : undefined,
      plugin_data: req.pluginData,
    };
  }

  private async request<T>(
    path: string,
    query: Record<string, QueryValue>,
    maxBytes: number,
  ): Promise<CloudResponse<T>> {
    const url = new URL(this.config.apiBase + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `figma-local-bridge/${SERVER_VERSION}`,
    };
    if (this.config.tokenKind === "pat") headers["X-Figma-Token"] = this.config.token!;
    else headers.Authorization = `Bearer ${this.config.token!}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
        // Never hand a credential to a redirected host. Figma's API does not
        // redirect read endpoints; a redirect is a configuration error here.
        redirect: "error",
      });

      const requestId =
        res.headers.get("x-figma-request-id") ||
        res.headers.get("x-request-id") ||
        undefined;

      const declared = Number(res.headers.get("content-length") || 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new CloudError(
          "CLOUD_RESPONSE_TOO_LARGE",
          `Figma REST response is ${declared} bytes, over the ${maxBytes}-byte limit; narrow it with nodeIds/depth or raise maxBytes.`,
          { maxBytes, bytes: declared, requestId },
        );
      }

      // Stream the body so a chunked response cannot bypass the limit by
      // omitting Content-Length. arrayBuffer() would buffer the whole thing
      // first, which is exactly the failure this cap is meant to prevent.
      const reader = res.body?.getReader();
      const chunks: Buffer[] = [];
      let received = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new CloudError(
              "CLOUD_RESPONSE_TOO_LARGE",
              `Figma REST response exceeded ${maxBytes} bytes; narrow it with nodeIds/depth or raise maxBytes.`,
              { maxBytes, bytes: received, requestId },
            );
          }
          chunks.push(Buffer.from(value));
        }
      }
      const buffer = Buffer.concat(chunks, received);

      const text = buffer.toString("utf8");
      if (!res.ok) {
        const detail = redact(apiMessage(text), this.config.token);
        const retryAfter = Number(res.headers.get("retry-after") || "");
        throw new CloudError(
          statusCode(res.status),
          `Figma REST ${res.status}${detail ? `: ${detail}` : ""}`,
          {
            status: res.status,
            requestId,
            retryAfterSeconds:
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
          },
        );
      }

      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        throw new CloudError(
          "CLOUD_BAD_RESPONSE",
          `Figma REST returned ${res.status} with a non-JSON body (${buffer.byteLength} bytes).`,
          { status: res.status, requestId },
        );
      }
      return { data, url: url.toString(), bytes: buffer.byteLength, requestId };
    } catch (err) {
      if (err instanceof CloudError) throw err;
      if (controller.signal.aborted) {
        throw new CloudError(
          "CLOUD_TIMEOUT",
          `Figma REST request timed out after ${this.config.timeoutMs}ms.`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new CloudError(
        "CLOUD_UNREACHABLE",
        `Figma REST request failed: ${redact(message.slice(0, 500), this.config.token)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function bool(value: boolean | undefined): "true" | "false" | undefined {
  return value === undefined ? undefined : value ? "true" : "false";
}

function urlHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "an invalid URL";
  }
}
