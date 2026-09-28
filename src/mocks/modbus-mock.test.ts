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
const METER = "meter_panel/unit1";
const PROBE = "dev_ttyUSB0/probe";
const UNIT2 = "meter_panel/unit2";

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

  it("advertises the pre-0.1.6 namespace in the outdated scenario", async () => {
    const bridge = makeHost("extension-outdated");
    const paths = (await actions.list(bridge))[AGENT] ?? [];
    expect(paths).toContain("modbus/list_interfaces");
    expect(paths).not.toContain(modbusActionPath("list_devices"));
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

  it("reports two mapped units on one connection and a raw-only device on another", async () => {
    const bridge = makeHost("ready");
    const { devices, count } = await listDevices(bridge, AGENT);
    expect(count).toBe(3);
    expect(devices.map((d) => [d.name, d.connection, d.device, d.unit_id])).toEqual([
      [METER, "meter_panel", "unit1", 1],
      [UNIT2, "meter_panel", "unit2", 2],
      [PROBE, "dev_ttyUSB0", "probe", 3],
    ]);
    expect(devices[0]).toMatchObject({ map_name: "power_meter", endpoint: "127.0.0.1:5020" });
    expect(devices.map((d) => d.address_base)).toEqual([1, 0, 1]);
    expect(devices[2]).toMatchObject({ transport: "rtu", map_name: null, register_count: 0 });
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
    expect(l1).toMatchObject({ event: "voltage", datatype: "float32", unit: "V", writable: false });

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

  it("writes a coil through the named path", async () => {
    const bridge = makeHost("ready");
    await writeNamedRegister(bridge, AGENT, METER, "status/relay2", 1);
    expect((await readNamedRegister(bridge, AGENT, METER, "status/relay2")).value).toBe(true);
  });

  it("rejects a write to a read-only register with the payload's error text", async () => {
    const bridge = makeHost("ready");
    await expect(
      writeNamedRegister(bridge, AGENT, METER, "inputs/firmware_version", 1),
    ).rejects.toMatchObject({ message: /read-only/, outcome: "refused" });
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
    const words = (res.values ?? []) as number[];
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
    // Units sharing a connection are separate devices: unit2 is untouched.
    const other = await readRegister(bridge, AGENT, UNIT2, {
      address: 100,
      reg_type: "holding",
      count: 1,
    });
    expect(other.values).not.toEqual([4242]);
  });

  it("writes multiple words with FC16 (comma-separated wire format)", async () => {
    const bridge = makeHost("ready");
    const res = await writeRegisters(bridge, AGENT, METER, 113, [0xf5c3, 0x4048]);
    expect(res).toMatchObject({ count: 2, function_code: 16, outcome: "ok" });
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

  it("refuses raw writes the device has off, or onto a read-only mapped register", async () => {
    const bridge = makeHost("ready");
    await expect(writeSingleRegister(bridge, AGENT, UNIT2, 300, 1)).rejects.toMatchObject({
      message: /Raw writes are disabled/,
      outcome: "refused",
    });
    // 111-112 is calibration_factor, which the map leaves read-only.
    await expect(writeRegisters(bridge, AGENT, METER, 110, [1, 2])).rejects.toThrow(
      /Address 111 is read-only in the device map \(swapped_floats\/calibration_factor\)/,
    );
  });

  it("rejects a read the extension would refuse", async () => {
    const bridge = makeHost("ready");
    await expect(
      readRegister(bridge, AGENT, METER, { address: 1, reg_type: "holding", count: 126 }),
    ).rejects.toThrow(/out of range/);
  });

  it("serves raw access on the map-less device", async () => {
    const bridge = makeHost("ready");
    await writeSingleRegister(bridge, AGENT, PROBE, 7, 9);
    const back = await readRegister(bridge, AGENT, PROBE, {
      address: 7,
      reg_type: "holding",
      count: 1,
    });
    expect(back.values).toEqual([9]);
  });

  // voltage_high_limit sits at wire 100 (seed 253): unit1 is base 1, unit2 base 0.
  it("converts the device's address base to the wire, matching the map", async () => {
    const bridge = makeHost("ready");
    const read = async (device: string, address: number) =>
      (await readRegister(bridge, AGENT, device, { address, reg_type: "holding", count: 1 }))
        .values;
    expect(await read(METER, 101)).toEqual([253]);
    expect(await read(UNIT2, 100)).toEqual([253]);
    const named = async (device: string) =>
      (await listRegisters(bridge, AGENT, device)).registers.find(
        (r) => r.path === "setpoints/voltage_high_limit",
      )?.address;
    expect(await named(METER)).toBe(101);
    expect(await named(UNIT2)).toBe(100);

    // The extension's range check, in the device's base.
    await expect(
      readRegister(bridge, AGENT, PROBE, { address: 0, reg_type: "holding", count: 1 }),
    ).rejects.toThrow(/out of range 1…65536/);
    // A read may not run past the last wire address either.
    await expect(
      readRegister(bridge, AGENT, METER, { address: 65536, reg_type: "holding", count: 2 }),
    ).rejects.toThrow(/out of range/);
  });
});

describe("extension quirks the mock mirrors", () => {
  it("rejects a table name it doesn't know, as the extension's lookup raises", async () => {
    const bridge = makeHost("ready");
    await expect(
      readRegister(bridge, AGENT, METER, { address: 1, reg_type: "nonsense" as never, count: 2 }),
    ).rejects.toThrow(/unknown reg_type/);
  });

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
    expect((await listDevices(bridge, "remote:2300")).count).toBe(3);
  });
});
