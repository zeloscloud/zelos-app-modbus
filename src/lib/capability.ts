/** Modbus discovery + per-agent capability — pure functions. No React, no IO.
 *
 *  Discovery model:
 *  1. `extensions.list` tells us which agents have the Modbus extension
 *     installed and what its run state is.
 *  2. `actions.list` tells us which `Modbus/<method>` paths are registered.
 *     Every method lives in one global namespace and takes a `device`
 *     parameter, so the whole REQUIRED_MODBUS_METHODS set should be present on
 *     any healthy extension — a gap means the extension is too old.
 *  3. `Modbus/list_devices` (one call per agent, after #1 and #2 confirm the
 *     extension is up) returns the configured devices. Each entry is a usable
 *     target by definition; per-device health (connected, poll counters) comes
 *     from the 1 Hz snapshot, not from discovery.
 *
 *  Top-level disabled cases are only the things that aren't per-agent:
 *  workspace not LIVE, or zero agents reachable at all. */

import type { ExtensionEntry } from "@zeloscloud/app-extension-sdk";

import {
  MIN_MODBUS_EXTENSION_VERSION,
  MODBUS_EXTENSION_INSTALL_IDS,
  REQUIRED_MODBUS_METHODS,
  modbusActionPath,
  type ModbusDeviceEntry,
  type WorkspaceModeKind,
} from "./types";

/** Pre-0.2.0 extensions registered under lowercase `modbus/`. */
const LEGACY_MODBUS_ACTION_PREFIX = "modbus/";

export type AgentStatusKind =
  | "ready"
  /** Neither fan-out reported anything for this agent — not even a non-Modbus
   *  extension or action. The host inserts an empty result for an agent it can't
   *  reach, so this is "no answer", not "no extension". */
  | "nothing-registered"
  | "extension-missing"
  | "extension-stopped"
  /** Running, required actions not all registered, no legacy paths: the live
   *  session is still coming up. A moment after Start, every install looks
   *  like this. */
  | "extension-starting"
  /** Running, a legacy lowercase `modbus/` path registered, and one this app
   *  needs is missing. That really is an old extension. */
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
  /** Present only when `kind === "extension-outdated"` — the bare method names
   *  whose action paths were absent. */
  missingMethods?: readonly string[];
  /** Present only when `kind === "discovery-failed"`. */
  error?: string;
  /** Every Modbus install running on this agent, set only when more than one
   *  is. Action paths never name an install, so which one serves `Modbus/` is
   *  unknowable, while Start/Stop targets only `extension`. */
  ambiguousInstalls?: readonly ExtensionEntry[];
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
  /** Devices per agent from `Modbus/list_devices` (one call per agent the hook
   *  is willing to query). `undefined` means "not yet fetched"; `[]` means
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
  /** Devices returned by `Modbus/list_devices` on this agent, or `undefined`
   *  if the RPC hasn't completed yet. */
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
  // Sorted by id: `extensions.list` order is not a contract, and Start/Stop
  // must not retarget between refreshes.
  const installs = extensions
    .filter((e) => MODBUS_EXTENSION_INSTALL_IDS.has(e.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (installs.length === 0) {
    return { agent, kind: "extension-missing" };
  }
  // Prefer running over stopped, then one meeting the version floor.
  const running = installs.filter((e) => e.state === "running");
  const ext = running.find((e) => meetsMinVersion(e.version)) ?? running[0] ?? installs[0]!;
  if (running.length === 0) {
    return { agent, kind: "extension-stopped", extension: ext };
  }
  const status = resolveRunningStatus(agent, ext, actionPaths, devices, deviceError);
  return running.length > 1 ? { ...status, ambiguousInstalls: running } : status;
}

/** Status for an agent whose Modbus extension is up. `ext` is the entry the
 *  lifecycle controls act on. */
function resolveRunningStatus(
  agent: string,
  ext: ExtensionEntry,
  actionPaths: readonly string[],
  devices: readonly ModbusDeviceEntry[] | undefined,
  deviceError: string | undefined,
): AgentStatus {
  // Required set incomplete. Only a legacy lowercase `modbus/` path proves an
  // old extension; otherwise it is still coming up. The agent lists standalone
  // actions (`Modbus/scan_device`, ...) before the live session registers, so
  // "some `Modbus/` paths present" does not mean outdated.
  const actionSet = new Set(actionPaths);
  const missing = REQUIRED_MODBUS_METHODS.filter((m) => !actionSet.has(modbusActionPath(m)));
  if (missing.length > 0) {
    return actionPaths.some((path) => path.startsWith(LEGACY_MODBUS_ACTION_PREFIX))
      ? { agent, kind: "extension-outdated", extension: ext, missingMethods: missing }
      : { agent, kind: "extension-starting", extension: ext };
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

/** `major.minor.patch` >= MIN_MODBUS_EXTENSION_VERSION; suffixes ignored. */
function meetsMinVersion(version: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const have = parse(version);
  const need = parse(MIN_MODBUS_EXTENSION_VERSION);
  for (let i = 0; i < need.length; i++) {
    const h = have[i] ?? 0;
    if (h !== need[i]) return h > need[i]!;
  }
  return true;
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
      return `Update the Modbus extension to ${MIN_MODBUS_EXTENSION_VERSION}+ — this app needs actions the installed version does not register.`;
    case "no-devices":
      return "The extension is running but has no devices configured. Add one in the extension's config, then Refresh.";
    // Nothing to fix in either: one is healthy, two are in flight.
    case "ready":
    case "extension-starting":
    case "discovering-devices":
      return null;
  }
}

export interface ConnectionGroup {
  connection: string;
  transport: ModbusDeviceEntry["transport"];
  endpoint: string;
  devices: ModbusDeviceEntry[];
}

/** Devices grouped by connection, both in `list_devices` order. */
export function groupByConnection(devices: readonly ModbusDeviceEntry[]): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>();
  for (const d of devices) {
    const group = groups.get(d.connection);
    if (group) group.devices.push(d);
    else
      groups.set(d.connection, {
        connection: d.connection,
        transport: d.transport,
        endpoint: d.endpoint,
        devices: [d],
      });
  }
  return [...groups.values()];
}
