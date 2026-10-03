/** Discovery + per-agent capability — pure-function tests. */

import type { ExtensionEntry } from "@zeloscloud/app-extension-sdk";
import { describe, expect, it } from "vitest";

import {
  discoverModbus,
  groupByConnection,
  remediation,
  resolveAgentStatus,
  type DiscoverInputs,
} from "./capability";
import { MODBUS_EXTENSION_ID, REQUIRED_MODBUS_METHODS, modbusActionPath } from "./types";
import { deviceEntry } from "@/components/__tests__/register-fixtures";

const runningExt: ExtensionEntry = {
  id: MODBUS_EXTENSION_ID,
  name: "Modbus",
  version: "0.1.6",
  state: "running",
};

const localInstallExt: ExtensionEntry = {
  id: "local.modbus",
  name: "Modbus",
  version: "0.1.6",
  state: "running",
};

const localRepoInstallExt: ExtensionEntry = {
  ...localInstallExt,
  id: "local.zelos-extension-modbus",
};

const stoppedExt: ExtensionEntry = { ...runningExt, state: "stopped" };

const meter = deviceEntry();

const probe = deviceEntry({
  name: "dev_ttyUSB0/probe",
  connection: "dev_ttyUSB0",
  device: "probe",
  unit_id: 3,
  transport: "rtu",
  endpoint: "/dev/ttyUSB0@9600",
  map_name: null,
  register_count: 0,
});

/** The full set of action paths a healthy Modbus extension registers. */
function allRequiredActionPaths(): string[] {
  return REQUIRED_MODBUS_METHODS.map((m) => modbusActionPath(m));
}

function baseDiscoveryInput(overrides: Partial<DiscoverInputs> = {}): DiscoverInputs {
  return {
    workspaceModeKind: "LIVE",
    extensionsByAgent: { "localhost:2300": [runningExt] },
    actionsByAgent: { "localhost:2300": allRequiredActionPaths() },
    devicesByAgent: { "localhost:2300": [meter] },
    ...overrides,
  };
}

// ─── Per-agent resolver ─────────────────────────────────────────────────────

describe("resolveAgentStatus", () => {
  it("returns ready when the extension runs, actions are registered, and list_devices reports at least one device", () => {
    const status = resolveAgentStatus("localhost:2300", [runningExt], allRequiredActionPaths(), [
      meter,
    ]);
    expect(status.kind).toBe("ready");
    expect(status.extension).toBe(runningExt);
    expect(status.devices?.map((d) => d.name)).toEqual(["meter_panel/unit1"]);
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
    // Something answered for this agent — just nothing of ours.
    expect(resolveAgentStatus("a:1", [], ["can-tx/send"], undefined)).toEqual({
      agent: "a:1",
      kind: "extension-missing",
    });
  });

  it("returns nothing-registered when the agent answered with nothing at all", () => {
    // The host inserts empty results for an agent it can't reach; telling the
    // user to install an extension there would be a guess.
    expect(resolveAgentStatus("a:1", [], [], undefined)).toEqual({
      agent: "a:1",
      kind: "nothing-registered",
    });
    expect(remediation({ agent: "a:1", kind: "nothing-registered" })).toMatch(/may be unreachable/);
  });

  it("returns extension-starting while a running extension has registered nothing", () => {
    // Every Start passes through this. It is not an old extension.
    const status = resolveAgentStatus("a:1", [runningExt], ["can-tx/send"], undefined);
    expect(status).toMatchObject({ kind: "extension-starting", extension: runningExt });
    expect(status.missingMethods).toBeUndefined();
    expect(remediation(status)).toBeNull();
  });

  it("returns extension-stopped when the extension exists but is not running", () => {
    expect(resolveAgentStatus("a:1", [stoppedExt], [], undefined)).toMatchObject({
      agent: "a:1",
      kind: "extension-stopped",
      extension: stoppedExt,
    });
  });

  it("picks the running install over a stopped sibling, in either listed order", () => {
    const stoppedLocal: ExtensionEntry = { ...localInstallExt, state: "stopped" };
    for (const exts of [
      [stoppedLocal, runningExt],
      [runningExt, stoppedLocal],
    ]) {
      const status = resolveAgentStatus("a:1", exts, allRequiredActionPaths(), [meter]);
      expect(status.kind).toBe("ready");
      expect(status.extension).toBe(runningExt);
      expect(status.ambiguousInstalls).toBeUndefined();
    }
  });

  it("names both installs when two run, preferring the one meeting the version floor", () => {
    // A 0.1.5 install (`modbus/`) beside a 0.1.6 one (`Modbus/`). The old one
    // sorts first by id, so only the version floor moves the pick.
    const oldLocal: ExtensionEntry = { ...localInstallExt, version: "0.1.5" };
    const paths = ["modbus/read_register", ...allRequiredActionPaths()];
    for (const exts of [
      [oldLocal, runningExt],
      [runningExt, oldLocal],
    ]) {
      const status = resolveAgentStatus("a:1", exts, paths, [meter]);
      expect(status.kind).toBe("ready");
      expect(status.extension).toBe(runningExt);
      expect(status.ambiguousInstalls?.map((e) => e.id)).toEqual([
        "local.modbus",
        MODBUS_EXTENSION_ID,
      ]);
    }
  });

  it("returns extension-outdated for a pre-0.1.6 extension, listing the missing methods", () => {
    // Lowercase `modbus/` namespace: outdated, not forever "starting".
    const legacy = ["modbus/list_interfaces", "modbus/get_snapshot", "modbus/read_register"];
    const status = resolveAgentStatus("a:1", [runningExt], legacy, undefined);
    expect(status.kind).toBe("extension-outdated");
    expect(status.missingMethods).toEqual(REQUIRED_MODBUS_METHODS);
  });

  it("prefers extension-outdated over the device list (a stale action set is the real problem)", () => {
    const status = resolveAgentStatus("a:1", [runningExt], ["modbus/read_register"], [meter]);
    expect(status.kind).toBe("extension-outdated");
  });

  it("returns extension-starting when only standalone actions are listed", () => {
    // The agent lists an installed extension's standalone actions before its
    // live session registers; a fresh 0.1.6 start is not outdated.
    const standalone = ["scan_device", "verify_map", "auto_config", "list_serial_ports"].map(
      modbusActionPath,
    );
    const status = resolveAgentStatus("a:1", [runningExt], standalone, undefined);
    expect(status.kind).toBe("extension-starting");
  });

  it("returns discovery-failed when list_devices itself failed", () => {
    const status = resolveAgentStatus(
      "a:1",
      [runningExt],
      allRequiredActionPaths(),
      undefined,
      "connection refused",
    );
    expect(status).toMatchObject({ kind: "discovery-failed", error: "connection refused" });
    // Not "still loading": a persistent failure has to stop looking in-flight.
    expect(remediation(status)).toMatch(/connection refused/);
  });

  it("returns discovering-devices while list_devices is in flight", () => {
    const status = resolveAgentStatus("a:1", [runningExt], allRequiredActionPaths(), undefined);
    expect(status.kind).toBe("discovering-devices");
    expect(status.devices).toBeUndefined();
  });

  it("returns no-devices when list_devices resolves empty", () => {
    const status = resolveAgentStatus("a:1", [runningExt], allRequiredActionPaths(), []);
    expect(status.kind).toBe("no-devices");
    expect(status.missingMethods).toBeUndefined();
  });

  it("carries every device through, in the order the extension reported them", () => {
    const status = resolveAgentStatus("a:1", [runningExt], allRequiredActionPaths(), [
      meter,
      probe,
    ]);
    expect(status.devices?.map((d) => d.name)).toEqual(["meter_panel/unit1", "dev_ttyUSB0/probe"]);
    expect(status.devices?.[1]?.map_name).toBeNull();
  });
});

describe("groupByConnection", () => {
  it("groups devices under their connection, keeping list_devices order", () => {
    const unit2 = { ...meter, name: "meter_panel/unit2", device: "unit2", unit_id: 2 };
    const groups = groupByConnection([meter, probe, unit2]);
    expect(
      groups.map((g) => [g.connection, g.transport, g.endpoint, g.devices.map((d) => d.device)]),
    ).toEqual([
      ["meter_panel", "tcp", "127.0.0.1:5020", ["unit1", "unit2"]],
      ["dev_ttyUSB0", "rtu", "/dev/ttyUSB0@9600", ["probe"]],
    ]);
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
        actionsByAgent: {
          "localhost:2300": allRequiredActionPaths(),
          "remote:2300": ["can-tx/send"],
        },
        devicesByAgent: { "localhost:2300": [meter] },
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
        devicesByAgent: { "localhost:2300": [meter] },
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
        baseDiscoveryInput({ extensionsByAgent: {}, actionsByAgent: {}, devicesByAgent: {} }),
      ),
    ).toEqual({ kind: "disabled", reason: "no-agents-connected" });
  });

  it("treats null fan-outs as in-flight (no agents yet, so no-agents-connected)", () => {
    expect(
      discoverModbus(
        baseDiscoveryInput({
          extensionsByAgent: null,
          actionsByAgent: null,
          devicesByAgent: null,
        }),
      ),
    ).toEqual({ kind: "disabled", reason: "no-agents-connected" });
  });
});

// ─── Remediation ────────────────────────────────────────────────────────────

describe("remediation", () => {
  it("has no copy for healthy or in-flight agents", () => {
    expect(remediation({ agent: "a", kind: "ready", devices: [meter] })).toBeNull();
    expect(remediation({ agent: "a", kind: "discovering-devices" })).toBeNull();
  });

  it("names the version floor when the extension is too old", () => {
    const copy = remediation({
      agent: "a",
      kind: "extension-outdated",
      missingMethods: ["get_snapshot"],
    });
    expect(copy).toMatch(/0\.1\.6\+/);
  });

  it("suggests install-local and start commands", () => {
    expect(remediation({ agent: "a", kind: "extension-missing" })).toMatch(/install-local/);
    expect(remediation({ agent: "a", kind: "extension-stopped", extension: stoppedExt })).toMatch(
      /zelos extensions start zeloscloud\.zelos-extension-modbus/,
    );
  });

  it("explains an empty device list", () => {
    expect(remediation({ agent: "a", kind: "no-devices" })).toMatch(/no devices configured/i);
  });
});
