/** Modbus discovery and per-agent capability, as pure functions.
 *
 *  `extensions.list` says whether the extension is installed and running,
 *  `actions.list` whether it registers every `Modbus/<method>` this app drives,
 *  and `Modbus/list_devices` which devices it has configured. Only workspace mode
 *  and "no agents at all" disable the whole tab. */

import type { ExtensionEntry } from "@zeloscloud/app-extension-sdk";

import {
  MODBUS_ACTION_PREFIX,
  MODBUS_EXTENSION_INSTALL_IDS,
  REQUIRED_MODBUS_METHODS,
  modbusActionPath,
  type ModbusDeviceEntry,
  type WorkspaceModeKind,
} from "./types";

type AgentStatusKind =
  | "ready"
  /** Neither fan-out reported anything for this agent — not even a non-Modbus
   *  extension or action. The host inserts an empty result for an agent it can't
   *  reach, so this is "no answer", not "no extension". */
  | "nothing-registered"
  | "extension-missing"
  | "extension-stopped"
  /** Running, but not one `Modbus/*` path is registered yet — the extension is
   *  still coming up. A moment after Start, every install looks like this. */
  | "extension-starting"
  /** Running, and either serves this app's methods under another name (an older
   *  release) or registers some `Modbus/*` paths but lacks one this app needs. */
  | "extension-outdated"
  /** Running with the full action set, and `list_devices` returned zero. */
  | "no-devices"
  /** Extension is up + actions registered, but the discovery RPC hasn't
   *  resolved yet. The UI renders a placeholder header while this loads. */
  | "discovering-devices"
  /** `list_devices` itself failed. Distinct from "still loading", which never
   *  ends on its own. */
  | "discovery-failed";

export interface AgentStatus {
  agent: string;
  kind: AgentStatusKind;
  /** Present when an extension entry was found, regardless of its run state. */
  extension?: ExtensionEntry;
  /** Present only when `kind === "ready"`. */
  devices?: readonly ModbusDeviceEntry[];
  /** Set when `kind === "extension-outdated"` and some `Modbus/*` paths are
   *  registered — the bare method names whose action paths were absent. */
  missingMethods?: readonly string[];
  /** Present only when `kind === "discovery-failed"`. */
  error?: string;
}

export type TopLevelDisabledReason = "not-live" | "no-agents-connected";

export type ModbusDiscovery =
  | { kind: "ready"; agents: readonly AgentStatus[] }
  | { kind: "disabled"; reason: TopLevelDisabledReason };

export interface DiscoverInputs {
  /** Workspace mode reported by the bridge snapshot. */
  workspaceModeKind: WorkspaceModeKind;
  /** Installed extensions per agent from `extensions.list` (fan-out). */
  extensionsByAgent: Record<string, ExtensionEntry[]> | null;
  /** Action paths per agent from `actions.list` (fan-out). */
  actionsByAgent: Record<string, string[]> | null;
  /** Devices per agent from `Modbus/list_devices` (one call per agent the
   *  hook is willing to query). `undefined` means "not yet fetched"; `[]` means
   *  "fetched, zero devices configured". */
  devicesByAgent: Record<string, ModbusDeviceEntry[] | undefined> | null;
  /** Message per agent whose `list_devices` failed, so a persistent failure
   *  reads as failed rather than as forever-loading. */
  deviceErrorsByAgent?: Record<string, string | undefined> | null;
}

/** Top-level discovery: builds the agent list + status, or returns a disabled
 *  reason for cases that aren't per-agent (workspace mode, zero agents). */
export function discoverModbus(input: DiscoverInputs): ModbusDiscovery {
  if (input.workspaceModeKind !== "LIVE") {
    return { kind: "disabled", reason: "not-live" };
  }
  // Union of agent addresses across both fan-outs — either source can be the
  // first to learn about an agent depending on registration race.
  const addrs = new Set<string>();
  if (input.extensionsByAgent) Object.keys(input.extensionsByAgent).forEach((a) => addrs.add(a));
  if (input.actionsByAgent) Object.keys(input.actionsByAgent).forEach((a) => addrs.add(a));

  if (addrs.size === 0) {
    return { kind: "disabled", reason: "no-agents-connected" };
  }

  const agents: AgentStatus[] = [...addrs]
    .sort()
    .map((agent) =>
      resolveAgentStatus(
        agent,
        input.extensionsByAgent?.[agent] ?? [],
        input.actionsByAgent?.[agent] ?? [],
        input.devicesByAgent?.[agent],
        input.deviceErrorsByAgent?.[agent],
      ),
    );
  return { kind: "ready", agents };
}

/** Per-agent status computation. Pure. */
export function resolveAgentStatus(
  agent: string,
  extensions: readonly ExtensionEntry[],
  actionPaths: readonly string[],
  /** Devices returned by `Modbus/list_devices` on this agent, or
   *  `undefined` if the RPC hasn't completed yet. */
  devices: readonly ModbusDeviceEntry[] | undefined,
  /** Why `list_devices` failed, if it did. */
  deviceError?: string | undefined,
): AgentStatus {
  // Both fan-outs empty means the agent said nothing at all, which is what the
  // host reports for an agent it couldn't reach. Claiming the extension is
  // missing (and telling the user to install it) would be a guess.
  if (extensions.length === 0 && actionPaths.length === 0) {
    return { agent, kind: "nothing-registered" };
  }

  // Match any known install ID (marketplace canonical OR `local.*` aliases the
  // install-local CLI assigns). Different install methods, same extension.
  const ext = extensions.find((e) => MODBUS_EXTENSION_INSTALL_IDS.has(e.id));
  if (!ext) {
    return { agent, kind: "extension-missing" };
  }
  if (ext.state !== "running") {
    return { agent, kind: "extension-stopped", extension: ext };
  }

  // Every Start passes through "starting" for a moment: the process is up and
  // has registered nothing yet.
  if (!actionPaths.some((path) => path.startsWith(MODBUS_ACTION_PREFIX))) {
    return servesModbusMethodsElsewhere(actionPaths)
      ? { agent, kind: "extension-outdated", extension: ext }
      : { agent, kind: "extension-starting", extension: ext };
  }

  const actionSet = new Set(actionPaths);
  const missing = REQUIRED_MODBUS_METHODS.filter((m) => !actionSet.has(modbusActionPath(m)));
  if (missing.length > 0) {
    return { agent, kind: "extension-outdated", extension: ext, missingMethods: missing };
  }

  // Action set is good. Now we need the device list.
  if (deviceError !== undefined) {
    return { agent, kind: "discovery-failed", extension: ext, error: deviceError };
  }
  if (devices === undefined) {
    return { agent, kind: "discovering-devices", extension: ext };
  }
  if (devices.length === 0) {
    return { agent, kind: "no-devices", extension: ext };
  }

  return { agent, kind: "ready", extension: ext, devices };
}

function servesModbusMethodsElsewhere(actionPaths: readonly string[]): boolean {
  const methods = new Set<string>(REQUIRED_MODBUS_METHODS);
  return actionPaths.some(
    (p) => !p.startsWith(MODBUS_ACTION_PREFIX) && methods.has(p.slice(p.lastIndexOf("/") + 1)),
  );
}

/** One-line fix-it copy per failing status. `null` for healthy/in-flight
 *  states, which need no remediation. */
export function remediation(status: AgentStatus): string | null {
  switch (status.kind) {
    case "nothing-registered":
      return "No extensions or actions visible on this agent — it may be unreachable.";
    case "discovery-failed":
      return `Could not list this agent's devices${status.error ? `: ${status.error}` : ""}. Check the extension's logs and its device config, then Refresh.`;
    case "extension-missing":
      return "Install the Modbus extension from the marketplace, or run `zelos extensions install-local <path-to-zelos-extension-modbus>` and Refresh.";
    case "extension-stopped":
      return `Start it with the button above, via the desktop's extensions panel, or run \`zelos extensions start ${status.extension?.id ?? "local.modbus"}\`.`;
    case "extension-outdated":
      return status.missingMethods
        ? "Update the Modbus extension — this app needs actions the installed version does not register."
        : "Update the Modbus extension to 0.1.6 or later, then Refresh.";
    case "no-devices":
      return "The extension is running but has no devices configured. Add one in the extension's config, then Refresh.";
    // Nothing to fix in either: one is healthy, two are in flight.
    case "ready":
    case "extension-starting":
    case "discovering-devices":
      return null;
  }
}
