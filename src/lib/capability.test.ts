/** Discovery + per-agent capability — pure-function tests. */

import type { ExtensionEntry } from "@zeloscloud/app-extension-sdk";
import { describe, expect, it } from "vitest";

import {
  discoverModbus,
  remediation,
  resolveAgentStatus,
  statusLabel,
  type DiscoverInputs,
} from "./capability";
import {
  MODBUS_EXTENSION_ID,
  REQUIRED_MODBUS_METHODS,
  modbusActionPath,
  type ModbusInterfaceEntry,
} from "./types";

const runningExt: ExtensionEntry = {
  id: MODBUS_EXTENSION_ID,
  name: "Modbus",
  version: "0.1.5",
  state: "running",
};

const localInstallExt: ExtensionEntry = {
  id: "local.modbus",
  name: "Modbus",
  version: "0.1.5",
  state: "running",
};

const localRepoInstallExt: ExtensionEntry = {
  ...localInstallExt,
  id: "local.zelos-extension-modbus",
};

const stoppedExt: ExtensionEntry = { ...runningExt, state: "stopped" };

const meter: ModbusInterfaceEntry = {
  name: "meter",
  transport: "tcp",
  connected: true,
  connection: "127.0.0.1:5020",
  unit_id: 1,
  source: "config",
  map_name: "power_meter",
  register_count: 24,
  poll_interval: 1,
  write_mode: "auto",
};

const probe: ModbusInterfaceEntry = {
  ...meter,
  name: "probe",
  transport: "rtu",
  connection: "/dev/ttyUSB0@9600",
  map_name: null,
  register_count: 0,
};

/** The full set of action paths a healthy Modbus extension registers. */
function allRequiredActionPaths(): string[] {
  return REQUIRED_MODBUS_METHODS.map((m) => modbusActionPath(m));
}

function baseDiscoveryInput(overrides: Partial<DiscoverInputs> = {}): DiscoverInputs {
  return {
    workspaceModeKind: "LIVE",
    extensionsByAgent: { "localhost:2300": [runningExt] },
    actionsByAgent: { "localhost:2300": allRequiredActionPaths() },
    interfacesByAgent: { "localhost:2300": [meter] },
    ...overrides,
  };
}

// ─── Per-agent resolver ─────────────────────────────────────────────────────

describe("resolveAgentStatus", () => {
  it("returns ready when the extension runs, actions are registered, and list_interfaces reports at least one interface", () => {
    const status = resolveAgentStatus("localhost:2300", [runningExt], allRequiredActionPaths(), [
      meter,
    ]);
    expect(status.kind).toBe("ready");
    expect(status.extension).toBe(runningExt);
    expect(status.interfaces?.map((i) => i.name)).toEqual(["meter"]);
  });

  it("recognizes both local-install ID aliases", () => {
    for (const ext of [localInstallExt, localRepoInstallExt]) {
      const status = resolveAgentStatus("a:1", [ext], allRequiredActionPaths(), [meter]);
      expect(status.kind).toBe("ready");
      expect(status.extension).toBe(ext);
    }
  });

  it("ignores unrelated extensions on the same agent", () => {
    const other: ExtensionEntry = {
      id: "zeloscloud.zelos-extension-can",
      name: "CAN",
      version: "0.1.12",
      state: "running",
    };
    expect(resolveAgentStatus("a:1", [other], allRequiredActionPaths(), [meter]).kind).toBe(
      "extension-missing",
    );
  });

  it("returns extension-missing when no Modbus extension is installed", () => {
    expect(resolveAgentStatus("a:1", [], [], undefined)).toEqual({
      agent: "a:1",
      kind: "extension-missing",
    });
  });

  it("returns extension-stopped when the extension exists but is not running", () => {
    expect(resolveAgentStatus("a:1", [stoppedExt], [], undefined)).toMatchObject({
      agent: "a:1",
      kind: "extension-stopped",
      extension: stoppedExt,
    });
  });

  it("returns extension-outdated, listing the missing methods", () => {
    // A 0.1.4-era extension: the pre-existing actions, none of the new ones.
    const legacy = [
      modbusActionPath("read_register"),
      modbusActionPath("write_single_register"),
      modbusActionPath("write_registers"),
      modbusActionPath("write_coil"),
      modbusActionPath("read_named_register"),
      modbusActionPath("write_named_register"),
      modbusActionPath("get_status"),
      modbusActionPath("list_writable_registers"),
    ];
    const status = resolveAgentStatus("a:1", [runningExt], legacy, undefined);
    expect(status.kind).toBe("extension-outdated");
    expect(status.missingMethods).toEqual(["list_interfaces", "get_snapshot", "list_registers"]);
  });

  it("prefers extension-outdated over the interface list (a stale action set is the real problem)", () => {
    const status = resolveAgentStatus("a:1", [runningExt], [], [meter]);
    expect(status.kind).toBe("extension-outdated");
    expect(status.missingMethods).toEqual([...REQUIRED_MODBUS_METHODS]);
  });

  it("returns discovering-interfaces while list_interfaces is in flight", () => {
    const status = resolveAgentStatus("a:1", [runningExt], allRequiredActionPaths(), undefined);
    expect(status.kind).toBe("discovering-interfaces");
    expect(status.interfaces).toBeUndefined();
  });

  it("returns no-interfaces when list_interfaces resolves empty", () => {
    const status = resolveAgentStatus("a:1", [runningExt], allRequiredActionPaths(), []);
    expect(status.kind).toBe("no-interfaces");
    expect(status.missingMethods).toBeUndefined();
  });

  it("carries every interface through, in the order the extension reported them", () => {
    const status = resolveAgentStatus("a:1", [runningExt], allRequiredActionPaths(), [
      meter,
      probe,
    ]);
    expect(status.interfaces?.map((i) => i.name)).toEqual(["meter", "probe"]);
    expect(status.interfaces?.[1]?.map_name).toBeNull();
  });
});

// ─── Discovery (top-level) ──────────────────────────────────────────────────

describe("discoverModbus", () => {
  it("returns ready with one agent when the only connected agent is ready", () => {
    const disc = discoverModbus(baseDiscoveryInput());
    expect(disc.kind).toBe("ready");
    if (disc.kind === "ready") {
      expect(disc.agents.map((a) => a.agent)).toEqual(["localhost:2300"]);
      expect(disc.agents[0]?.kind).toBe("ready");
    }
  });

  it("returns ready with multiple agents (mixed statuses), sorted by address", () => {
    const disc = discoverModbus(
      baseDiscoveryInput({
        extensionsByAgent: { "localhost:2300": [runningExt], "remote:2300": [] },
        actionsByAgent: { "localhost:2300": allRequiredActionPaths(), "remote:2300": [] },
        interfacesByAgent: { "localhost:2300": [meter] },
      }),
    );
    expect(disc.kind).toBe("ready");
    if (disc.kind === "ready") {
      expect(disc.agents.map((a) => ({ a: a.agent, k: a.kind }))).toEqual([
        { a: "localhost:2300", k: "ready" },
        { a: "remote:2300", k: "extension-missing" },
      ]);
    }
  });

  it("unions agent keys across both fan-outs (either source can be first)", () => {
    const disc = discoverModbus(
      baseDiscoveryInput({
        extensionsByAgent: { "localhost:2300": [runningExt], "remote:2300": [stoppedExt] },
        actionsByAgent: { "localhost:2300": allRequiredActionPaths(), "alt:2300": [] },
        interfacesByAgent: { "localhost:2300": [meter] },
      }),
    );
    expect(disc.kind).toBe("ready");
    if (disc.kind === "ready") {
      expect(disc.agents.map((a) => a.agent)).toEqual([
        "alt:2300",
        "localhost:2300",
        "remote:2300",
      ]);
    }
  });

  it("disabled: not-live when workspace mode is not LIVE", () => {
    for (const mode of ["NONE", "TRACE", "TRACEPATH"] as const) {
      expect(discoverModbus(baseDiscoveryInput({ workspaceModeKind: mode }))).toEqual({
        kind: "disabled",
        reason: "not-live",
      });
    }
  });

  it("disabled: no-agents-connected when no agents are present in either fan-out", () => {
    expect(
      discoverModbus(
        baseDiscoveryInput({ extensionsByAgent: {}, actionsByAgent: {}, interfacesByAgent: {} }),
      ),
    ).toEqual({ kind: "disabled", reason: "no-agents-connected" });
  });

  it("treats null fan-outs as in-flight (no agents yet, so no-agents-connected)", () => {
    expect(
      discoverModbus(
        baseDiscoveryInput({
          extensionsByAgent: null,
          actionsByAgent: null,
          interfacesByAgent: null,
        }),
      ),
    ).toEqual({ kind: "disabled", reason: "no-agents-connected" });
  });
});

// ─── Labels + remediation ───────────────────────────────────────────────────

describe("statusLabel", () => {
  it("renders interface counts for ready agents", () => {
    expect(statusLabel({ agent: "a", kind: "ready", interfaces: [meter] })).toBe(
      "ready (1 interface)",
    );
    expect(statusLabel({ agent: "a", kind: "ready", interfaces: [meter, probe] })).toBe(
      "ready (2 interfaces)",
    );
  });

  it("renders each failure kind", () => {
    expect(statusLabel({ agent: "a", kind: "extension-missing" })).toBe(
      "Modbus extension not installed",
    );
    expect(statusLabel({ agent: "a", kind: "extension-stopped", extension: stoppedExt })).toBe(
      "Modbus extension stopped",
    );
    expect(
      statusLabel({ agent: "a", kind: "extension-outdated", missingMethods: ["get_snapshot"] }),
    ).toBe("missing actions: get_snapshot");
    expect(statusLabel({ agent: "a", kind: "no-interfaces" })).toBe("no interfaces configured");
    expect(statusLabel({ agent: "a", kind: "discovering-interfaces" })).toBe(
      "discovering interfaces…",
    );
  });
});

describe("remediation", () => {
  it("has no copy for healthy or in-flight agents", () => {
    expect(remediation({ agent: "a", kind: "ready", interfaces: [meter] })).toBeNull();
    expect(remediation({ agent: "a", kind: "discovering-interfaces" })).toBeNull();
  });

  it("names the version floor when the extension is too old", () => {
    const copy = remediation({
      agent: "a",
      kind: "extension-outdated",
      missingMethods: ["get_snapshot"],
    });
    expect(copy).toMatch(/0\.1\.5\+/);
  });

  it("suggests install-local and start commands", () => {
    expect(remediation({ agent: "a", kind: "extension-missing" })).toMatch(/install-local/);
    expect(remediation({ agent: "a", kind: "extension-stopped", extension: stoppedExt })).toMatch(
      /zelos extensions start zeloscloud\.zelos-extension-modbus/,
    );
  });

  it("explains an empty interface list", () => {
    expect(remediation({ agent: "a", kind: "no-interfaces" })).toMatch(/no interfaces configured/i);
  });
});
