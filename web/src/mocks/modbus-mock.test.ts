/** Mock-host contract tests.
 *
 *  These drive the simulator through the real `lib/modbus-bridge` wrappers, so
 *  they cover the whole wire contract the app depends on: action paths, the
 *  `device` selector, in-band `{success: false}` failures, the snapshot's
 *  deliberate omission of unpolled registers, and raw words that decode through
 *  `lib/codec`. If the extension's shapes drift, these break before the UI does. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { actions, extensions } from "@zeloscloud/app-extension-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeValue } from "@/lib/codec";
import {
  getSnapshot,
  listDevices,
  listRegisters,
  readNamedRegister,
  readRegister,
  writeCoil,
  writeNamedRegister,
  writeRegisters,
  writeSingleRegister,
} from "@/lib/modbus-bridge";
import { resolveAgentStatus } from "@/lib/capability";
import { MODBUS_EXTENSION_ID, REQUIRED_MODBUS_METHODS, modbusActionPath } from "@/lib/types";

import { installedMockBridge } from "./mock-bridge";
import { STARTING_ACTIONS_MS, type MockScenario } from "./modbus-mock";

const AGENT = "localhost";
const METER = "meter_panel/meter";
const PROBE = "rs485/probe";

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
});

function makeHost(scenario: MockScenario = "ready"): BridgeTransport {
  const installed = installedMockBridge(scenario);
  teardown = installed.teardown;
  return installed.bridge;
}

describe("discovery surface", () => {
  it("lists the extension and the full action set when ready", async () => {
    const bridge = makeHost("ready");
    const installed = await extensions.list(bridge);
    expect(installed[AGENT]?.[0]).toMatchObject({ id: MODBUS_EXTENSION_ID, state: "running" });

    const paths = (await actions.list(bridge))[AGENT] ?? [];
    for (const method of REQUIRED_MODBUS_METHODS) {
      expect(paths).toContain(modbusActionPath(method));
    }
  });

  it("runs an extension that lacks an action in the outdated scenario", async () => {
    const bridge = makeHost("extension-outdated");
    const installed = (await extensions.list(bridge))[AGENT] ?? [];
    const paths = (await actions.list(bridge))[AGENT] ?? [];
    expect(installed[0]).toMatchObject({ state: "running" });
    expect(resolveAgentStatus(AGENT, installed, paths, undefined)).toMatchObject({
      kind: "extension-outdated",
      missingMethods: ["list_devices"],
    });
  });

  it("runs with no actions for a moment after start, then registers the full set", async () => {
    const bridge = makeHost("extension-stopped");
    expect((await actions.list(bridge))[AGENT]).toEqual([]);
    await extensions.start(bridge, { id: MODBUS_EXTENSION_ID, agent: AGENT });

    // The gap a real extension leaves between "running" and "registered": the
    // process is up, and `actions.list` still has nothing to say about it.
    expect((await extensions.list(bridge))[AGENT]?.[0]?.state).toBe("running");
    expect((await actions.list(bridge))[AGENT]).toEqual([]);
    expect(
      resolveAgentStatus(AGENT, (await extensions.list(bridge))[AGENT] ?? [], [], undefined).kind,
    ).toBe("extension-starting");

    // Once the window closes, everything is there.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + STARTING_ACTIONS_MS + 1);
    try {
      expect((await actions.list(bridge))[AGENT]).toContain(modbusActionPath("get_snapshot"));
    } finally {
      clock.mockRestore();
    }
  });

  it("reports a mapped device and a raw-only one", async () => {
    const bridge = makeHost("ready");
    const { devices, count } = await listDevices(bridge, AGENT);
    expect(count).toBe(2);
    expect(devices.map((i) => i.name)).toEqual([METER, PROBE]);
    expect(devices[0]).toMatchObject({
      map_name: "power_meter",
      address_base: 1,
      raw_writes: true,
    });
    expect(devices[1]).toMatchObject({
      transport: "rtu",
      map_name: null,
      register_count: 0,
      raw_writes: false,
    });
  });

  it("returns zero devices in the no-devices scenario", async () => {
    const bridge = makeHost("no-devices");
    expect((await listDevices(bridge, AGENT)).count).toBe(0);
  });
});

describe("register catalog", () => {
  it("carries the enriched fields the app needs", async () => {
    const bridge = makeHost("ready");
    const { registers, map_name } = await listRegisters(bridge, AGENT, METER);
    expect(map_name).toBe("power_meter");

    const l1 = registers.find((r) => r.path === "voltage/L1");
    expect(l1).toMatchObject({
      event: "voltage",
      address: 1,
      datatype: "float32",
      unit: "V",
      writable: false,
      rate: 1,
    });

    const temperature = registers.find((r) => r.path === "status/temperature");
    expect(temperature?.scale).toBe(0.1);
    expect(temperature?.description).toBeTruthy();

    const firmware = registers.find((r) => r.path === "inputs/firmware_version");
    expect(firmware?.writable).toBe(false);

    const unpolled = registers.find((r) => r.path === "setpoints/energy_reset");
    expect(unpolled?.rate).toBe(0);

    const swapped = registers.find((r) => r.path === "swapped_floats/calibration_factor");
    expect(swapped?.byte_order).toBe("big_swap");
  });
});

describe("snapshot", () => {
  it("serves cached values but omits registers that are never polled", async () => {
    const bridge = makeHost("ready");
    const snapshot = await getSnapshot(bridge, AGENT, METER);
    expect(snapshot.connected).toBe(true);
    expect(snapshot.poll_count).toBeGreaterThan(0);
    expect(snapshot.values["voltage/L1"]?.value).toBeCloseTo(230, 0);
    expect(snapshot.values["status/relay1"]?.value).toBe(true);
    expect(snapshot.values["setpoints/energy_reset"]).toBeUndefined();
  });

  it("sends a non-finite value as null, keeping the register in the snapshot", async () => {
    const bridge = makeHost("ready");
    const snapshot = await getSnapshot(bridge, AGENT, METER);
    const sanitized = snapshot.values["status/spare_sensor"];
    // Present (it was polled) but with nothing JSON can carry.
    expect(sanitized).toBeDefined();
    expect(sanitized?.value).toBeNull();
    expect(sanitized?.ts_ms).toBeGreaterThan(0);
  });
});

describe("named read/write", () => {
  it("reads an unpolled register on demand", async () => {
    const bridge = makeHost("ready");
    const res = await readNamedRegister(bridge, AGENT, METER, "setpoints/energy_reset");
    expect(res).toMatchObject({ address: 105, type: "holding", datatype: "uint32", value: 0 });
  });

  it("reads a NaN register as a successful null, not as a failure", async () => {
    const bridge = makeHost("ready");
    const res = await readNamedRegister(bridge, AGENT, METER, "status/spare_sensor");
    // `unwrap` would have thrown on success: false — this is a good read of a
    // value that has no JSON form.
    expect(res).toMatchObject({ address: 23, datatype: "float32", value: null, success: true });
  });

  it("persists a write and reflects it in later reads and snapshots", async () => {
    const bridge = makeHost("ready");
    await writeNamedRegister(bridge, AGENT, METER, "setpoints/voltage_high_limit", 249);
    const readBack = await readNamedRegister(bridge, AGENT, METER, "setpoints/voltage_high_limit");
    expect(readBack.value).toBe(249);
    const snapshot = await getSnapshot(bridge, AGENT, METER);
    expect(snapshot.values["setpoints/voltage_high_limit"]?.value).toBe(249);
  });

  it("round-trips a scaled int16", async () => {
    const bridge = makeHost("ready");
    // temperature is int16 × 0.1: 23.5 °C stores raw 235 and decodes back to 23.5.
    const res = await writeNamedRegister(bridge, AGENT, METER, "status/temperature", 23.5);
    expect(res.value).toBe(23.5);
    expect((await readNamedRegister(bridge, AGENT, METER, "status/temperature")).value).toBe(23.5);
  });

  it("writes a coil through the named path", async () => {
    const bridge = makeHost("ready");
    await writeNamedRegister(bridge, AGENT, METER, "status/relay2", 1);
    expect((await readNamedRegister(bridge, AGENT, METER, "status/relay2")).value).toBe(true);
  });

  it("rejects a write to a read-only register with the payload's error text", async () => {
    const bridge = makeHost("ready");
    await expect(
      writeNamedRegister(bridge, AGENT, METER, "inputs/firmware_version", 1),
    ).rejects.toThrow(/is read-only \(the device map does not mark it writable\)/);
  });

  it("rejects an unknown device and an unknown register", async () => {
    const bridge = makeHost("ready");
    await expect(getSnapshot(bridge, AGENT, "nope")).rejects.toThrow(/Device 'nope' not found/);
    await expect(readNamedRegister(bridge, AGENT, METER, "no/such")).rejects.toThrow(/not found/);
  });
});

describe("raw access", () => {
  it("returns words a client-side decode agrees with (big_swap float32)", async () => {
    const bridge = makeHost("ready");
    const res = await readRegister(bridge, AGENT, METER, {
      address: 111,
      reg_type: "holding",
      count: 2,
    });
    const words = res.values as number[];
    expect(words).toHaveLength(2);
    expect(decodeValue(words, "float32", 1, "big_swap") as number).toBeCloseTo(1.025, 5);
    // The same words decoded big-endian must NOT look like the value — proof the
    // simulator really stores swapped words rather than pre-swapping for us.
    expect(decodeValue(words, "float32", 1, "big") as number).not.toBeCloseTo(1.025, 3);
  });

  it("reads bit tables as booleans", async () => {
    const bridge = makeHost("ready");
    const res = await readRegister(bridge, AGENT, METER, {
      address: 1,
      reg_type: "coil",
      count: 3,
    });
    expect(res.values).toEqual([true, false, false]);
  });

  it("writes a single word with FC6 and reads it back", async () => {
    const bridge = makeHost("ready");
    const res = await writeSingleRegister(bridge, AGENT, METER, 101, 4242);
    expect(res.function_code).toBe(6);
    const back = await readRegister(bridge, AGENT, METER, {
      address: 101,
      reg_type: "holding",
      count: 1,
    });
    expect(back.values).toEqual([4242]);
  });

  it("writes multiple words with FC16 (comma-separated wire format)", async () => {
    const bridge = makeHost("ready");
    const res = await writeRegisters(bridge, AGENT, METER, 113, [0xf5c3, 0x4048]);
    expect(res).toMatchObject({ count: 2, function_code: 16 });
    const back = await readRegister(bridge, AGENT, METER, {
      address: 113,
      reg_type: "holding",
      count: 2,
    });
    expect(back.values).toEqual([0xf5c3, 0x4048]);
    // Which is 3.14 under the register's declared big_swap order.
    expect(decodeValue(back.values as number[], "float32", 1, "big_swap") as number).toBeCloseTo(
      3.14,
      4,
    );
  });

  it("writes a coil with ON/OFF and reads it back", async () => {
    const bridge = makeHost("ready");
    expect((await writeCoil(bridge, AGENT, METER, 3, true)).value).toBe(true);
    const back = await readRegister(bridge, AGENT, METER, {
      address: 3,
      reg_type: "coil",
      count: 1,
    });
    expect(back.values).toEqual([true]);
  });

  it("rejects a read the extension would refuse", async () => {
    const bridge = makeHost("ready");
    await expect(
      readRegister(bridge, AGENT, METER, { address: 1, reg_type: "holding", count: 126 }),
    ).rejects.toThrow(/outside 1-125/);
    await expect(
      readRegister(bridge, AGENT, METER, { address: 0, reg_type: "holding", count: 1 }),
    ).rejects.toThrow(/Address 0 \(count 1\) is outside 1-65536 \(address base 1\)/);
  });

  it("refuses a raw write that touches a register the map marks read-only", async () => {
    const bridge = makeHost("ready");
    await expect(writeRegisters(bridge, AGENT, METER, 110, [1, 2])).rejects.toThrow(
      "Address 111 is read-only in the device map (swapped_floats/calibration_factor)",
    );
  });

  it("reads the map-less device and refuses its writes while raw writes are off", async () => {
    const bridge = makeHost("ready");
    const read = await readRegister(bridge, AGENT, PROBE, {
      address: 7,
      reg_type: "holding",
      count: 1,
    });
    expect(read.values).toEqual([0]);
    await expect(writeSingleRegister(bridge, AGENT, PROBE, 7, 9)).rejects.toThrow(
      /Raw writes are disabled/,
    );
  });
});

describe("extension parsing the mock mirrors", () => {
  it("refuses a partly numeric word list, the way Python's int() does", async () => {
    const bridge = makeHost("ready");
    await expect(writeRegisters(bridge, AGENT, METER, 300, [1])).resolves.toBeTruthy();
    // `parseInt` would read "12abc" as 12 and write a word nobody asked for, so
    // the whole request is refused in-band instead.
    const res = await actions.execute(bridge, {
      agent: AGENT,
      action: modbusActionPath("write_registers"),
      params: { device: METER, address: 300, values: "12abc,3" },
    });
    expect(res.result).toMatchObject({ success: false, error: /comma-separated integers/ });
  });
});

describe("multi-agent scenario", () => {
  it("gives one ready agent and one without the extension", async () => {
    const bridge = makeHost("multi-agent");
    const installed = await extensions.list(bridge);
    expect(installed["localhost"]).toEqual([]);
    expect(installed["remote:2300"]?.[0]?.state).toBe("running");
    expect((await listDevices(bridge, "remote:2300")).count).toBe(2);
  });
});
