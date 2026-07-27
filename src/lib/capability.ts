/** Modbus discovery + per-agent capability — pure functions. No React, no IO.
 *
 *  Discovery model:
 *  1. `extensions.list` tells us which agents have the Modbus extension
 *     installed and what its run state is.
 *  2. `actions.list` tells us which `modbus/<method>` paths are registered.
 *     Every method lives in one global namespace and takes an `interface`
 *     parameter, so the whole REQUIRED_MODBUS_METHODS set should be present on
 *     any healthy extension — a gap means the extension is too old.
 *  3. `modbus/list_interfaces` (one call per agent, after #1 and #2 confirm the
 *     extension is up) returns the configured interfaces. Each entry is a
 *     usable target by definition; per-interface health (connected, poll
 *     counters) comes from the 1 Hz snapshot, not from discovery.
 *
 *  Top-level disabled cases are only the things that aren't per-agent:
 *  workspace not LIVE, or zero agents reachable at all. */

import type { ExtensionEntry } from "@zeloscloud/app-extension-sdk";

import {
  MIN_MODBUS_EXTENSION_VERSION,
  MODBUS_EXTENSION_INSTALL_IDS,
  REQUIRED_MODBUS_METHODS,
  modbusActionPath,
  type ModbusInterfaceEntry,
  type WorkspaceModeKind,
} from "./types";

export type AgentStatusKind =
  | "ready"
  | "extension-missing"
  | "extension-stopped"
  /** Running, but `actions.list` is missing methods this app needs. */
  | "extension-outdated"
  /** Running with the full action set, and `list_interfaces` returned zero. */
  | "no-interfaces"
  /** Extension is up + actions registered, but the discovery RPC hasn't
   *  resolved yet. The UI renders a placeholder header while this loads. */
  | "discovering-interfaces";

export interface AgentStatus {
  agent: string;
  kind: AgentStatusKind;
  /** Present when an extension entry was found, regardless of its run state. */
  extension?: ExtensionEntry;
  /** Present only when `kind === "ready"`. */
  interfaces?: readonly ModbusInterfaceEntry[];
  /** Present only when `kind === "extension-outdated"` — the bare method names
   *  whose action paths were absent. */
  missingMethods?: readonly string[];
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
  /** Interfaces per agent from `modbus/list_interfaces` (one call per agent the
   *  hook is willing to query). `undefined` means "not yet fetched"; `[]` means
   *  "fetched, zero interfaces configured". */
  interfacesByAgent: Record<string, ModbusInterfaceEntry[] | undefined> | null;
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
        input.interfacesByAgent?.[agent],
      ),
    );
  return { kind: "ready", agents };
}

/** Per-agent status computation. Pure. */
export function resolveAgentStatus(
  agent: string,
  extensions: readonly ExtensionEntry[],
  actionPaths: readonly string[],
  /** Interfaces returned by `modbus/list_interfaces` on this agent, or
   *  `undefined` if the RPC hasn't completed yet. */
  interfaces: readonly ModbusInterfaceEntry[] | undefined,
): AgentStatus {
  // Match any known install ID (marketplace canonical OR `local.*` aliases the
  // install-local CLI assigns). Different install methods, same extension.
  const ext = extensions.find((e) => MODBUS_EXTENSION_INSTALL_IDS.has(e.id));
  if (!ext) {
    return { agent, kind: "extension-missing" };
  }
  if (ext.state !== "running") {
    return { agent, kind: "extension-stopped", extension: ext };
  }

  // Confirm every required action path is registered. A gap means the extension
  // predates the actions this app drives (or didn't finish registering) — not
  // that the interfaces are misconfigured.
  const actionSet = new Set(actionPaths);
  const missing: string[] = [];
  for (const method of REQUIRED_MODBUS_METHODS) {
    if (!actionSet.has(modbusActionPath(method))) missing.push(method);
  }
  if (missing.length > 0) {
    return { agent, kind: "extension-outdated", extension: ext, missingMethods: missing };
  }

  // Action set is good. Now we need the interface list.
  if (interfaces === undefined) {
    return { agent, kind: "discovering-interfaces", extension: ext };
  }
  if (interfaces.length === 0) {
    return { agent, kind: "no-interfaces", extension: ext };
  }

  return { agent, kind: "ready", extension: ext, interfaces };
}

/** Short text label for the agent's status, used in chips + tooltips. */
export function statusLabel(status: AgentStatus): string {
  switch (status.kind) {
    case "ready": {
      const n = status.interfaces?.length ?? 0;
      return `ready (${n} interface${n === 1 ? "" : "s"})`;
    }
    case "extension-missing":
      return "Modbus extension not installed";
    case "extension-stopped":
      return `Modbus extension ${status.extension?.state ?? "stopped"}`;
    case "extension-outdated":
      return `missing actions: ${status.missingMethods?.join(", ") ?? "unknown"}`;
    case "no-interfaces":
      return "no interfaces configured";
    case "discovering-interfaces":
      return "discovering interfaces…";
  }
}

/** One-line fix-it copy per failing status. `null` for healthy/in-flight
 *  states, which need no remediation. */
export function remediation(status: AgentStatus): string | null {
  switch (status.kind) {
    case "extension-missing":
      return "Install the Modbus extension from the marketplace, or run `zelos extensions install-local <path-to-zelos-extension-modbus>` and Refresh.";
    case "extension-stopped":
      return `Start it with the button above, via the desktop's extensions panel, or run \`zelos extensions start ${status.extension?.id ?? "local.modbus"}\`.`;
    case "extension-outdated":
      return `Update the Modbus extension to ${MIN_MODBUS_EXTENSION_VERSION}+ — this app needs actions the installed version does not register.`;
    case "no-interfaces":
      return "The extension is running but has no interfaces configured. Add one in the extension's config, then Refresh.";
    case "ready":
    case "discovering-interfaces":
      return null;
  }
}
