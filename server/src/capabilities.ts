/**
 * What this server can honestly do in the current process.
 *
 * Local mode drives the Figma Desktop Plugin API through a localhost WebSocket.
 * An optional, explicitly opted-in adapter can read Figma files over the public
 * REST API; it is read-only and has its own credential and transport limits.
 * Figma's hosted AI, file-creation, shader, generative plugin and Weave services
 * are not proxied and must not be presented as if they were. `figma_ping`
 * returns this report so an agent can choose the right tool without trying a
 * cloud-only one first.
 */
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { CLOUD_READ_AREAS, CLOUD_TOOL_NAMES, type CloudConfig } from "./cloud.js";

/** Features the official remote Figma MCP can reach through Figma's cloud. */
export const CLOUD_FEATURES = [
  "create_new_file",
  "generate_figma_design",
  "generate_diagram",
  "generate_image",
  "html_to_figma",
  "send_code_to_figma",
  "create_generative_plugin",
  "update_generative_plugin",
  "create_shader",
  "update_shader",
  "weave_list_tools",
  "weave_get_tool_inputs",
  "weave_upload_asset",
  "weave_run_tool",
  "weave_get_tool_run_output",
  "weave_cancel_tool_run",
  "weave_find_model",
  "weave_run_model",
  "weave_get_model_run_output",
] as const;

export interface ModeCapabilities {
  read: boolean;
  write: boolean;
  destructive: boolean;
}

export interface CapabilityReport {
  server: { name: string; version: string };
  local: {
    transport: "stdio";
    plugin: "Figma Desktop";
    mode: "read-only" | "write" | "write+destructive";
    read: boolean;
    write: boolean;
    destructive: boolean;
  };
  cloud: {
    /** True when the optional REST adapter is registered in this process. */
    available: boolean;
    /** Whether a credential is present, even if the adapter is switched off. */
    configured: boolean;
    mode: "read-only" | null;
    tokenType: "pat" | "oauth" | null;
    tools: string[];
    reads: string[];
    reason: string;
    /** Figma-hosted features that even this adapter does not proxy. */
    features: string[];
  };
}

/** Build the report from the environment flags that registered the tools. */
export function capabilitiesReport(caps: ModeCapabilities, cloud?: CloudConfig): CapabilityReport {
  const mode = !caps.write ? "read-only" : caps.destructive ? "write+destructive" : "write";
  const cloudOn = Boolean(cloud?.enabled);
  return {
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    local: {
      transport: "stdio",
      plugin: "Figma Desktop",
      mode,
      read: caps.read,
      write: caps.write,
      destructive: caps.destructive,
    },
    cloud: {
      available: cloudOn,
      configured: Boolean(cloud?.configured),
      mode: cloudOn ? "read-only" : null,
      tokenType: cloud?.tokenKind ?? null,
      tools: cloudOn ? [...CLOUD_TOOL_NAMES] : [],
      reads: cloudOn ? [...CLOUD_READ_AREAS] : [],
      reason:
        cloud?.reason ??
        "No cloud adapter is configured. Set FIGMA_CLOUD=1 and FIGMA_CLOUD_TOKEN (PAT) or FIGMA_CLOUD_OAUTH_TOKEN (OAuth) to enable read-only Figma REST access.",
      features: [...CLOUD_FEATURES],
    },
  };
}
