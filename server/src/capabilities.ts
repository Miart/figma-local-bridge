/**
 * What this server can honestly do in the current process.
 *
 * The bridge is local-only: it drives the Figma Desktop Plugin API through a
 * localhost WebSocket. Figma's hosted AI, file-creation, shader, generative
 * plugin and Weave services are not proxied and must not be presented as if
 * they were. `figma_ping` returns this report so an agent can choose the right
 * tool without trying a cloud-only one first.
 */
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

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
    available: false;
    reason: string;
    features: string[];
  };
}

/** Build the report from the environment flags that registered the tools. */
export function capabilitiesReport(caps: ModeCapabilities): CapabilityReport {
  const mode = !caps.write ? "read-only" : caps.destructive ? "write+destructive" : "write";
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
      available: false,
      reason:
        "Local Plugin API only: Figma-hosted AI, file creation, shaders, generative plugins and Weave are not proxied or simulated. Use the official remote Figma MCP or the Figma UI for those.",
      features: [...CLOUD_FEATURES],
    },
  };
}
