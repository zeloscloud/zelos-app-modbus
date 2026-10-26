/** The row-view layer: what a row shows, decided once here so both cells and
 *  both row kinds agree. The rendering of each state is asserted against the DOM
 *  in `components/__tests__/RegisterTable.test.tsx`; this covers the decisions. */

import { describe, expect, it } from "vitest";

import {
  namedValueState,
  namedWriteModel,
  rawValueState,
  rawWriteModel,
  resolveValue,
  sameValueState,
  stalenessThresholdMs,
  typeSummary,
  writeDefault,
  type ValueState,
} from "./row-view";
import type { ModbusSnapshot, RegisterEntry } from "./types";
import type { RawWatchRow } from "./watch-store";

const CAPTURED = 1_700_000_000_000;

function reg(overrides: Partial<RegisterEntry> = {}): RegisterEntry {
  return {
    name: "total",
    event: "power",
    path: "power/total",
    address: 12,
    type: "holding",
    datatype: "float32",
    unit: "kW",
    scale: 1,
    description: "",
    writable: true,
    byte_order: "big",
    poll_interval: null,
    ...overrides,
  };
}

function raw(overrides: Partial<Omit<RawWatchRow, "id" | "kind">> = {}): RawWatchRow {
  return {
    id: "r1",
    kind: "raw",
    agent: "localhost:2300",
    interface: "meter",
    address: "0",
    table: "holding",
    datatype: "uint16",
    byte_order: "big",
    ...overrides,
  };
}

function snapshot(values: ModbusSnapshot["values"]): ModbusSnapshot {
  return {
    interface: "meter",
    connected: true,
    transport: "tcp",
    connection: "127.0.0.1:502",
    unit_id: 1,
    poll_count: 1,
    error_count: 0,
    captured_at_unix_ms: CAPTURED,
    values,
    success: true,
  };
}

const FRESH = { thresholdMs: 3000, snapshotCapturedAt: CAPTURED, polled: true };

describe("namedValueState", () => {
  it("is `never` with nothing resolved", () => {
    expect(namedValueState(null, FRESH)).toEqual({ kind: "never" });
  });

  it("carries a resolved value and its source", () => {
    expect(namedValueState({ value: 3.4, ts_ms: CAPTURED, source: "poll" }, FRESH)).toEqual({
      kind: "value",
      value: 3.4,
      source: "poll",
      stale: false,
    });
  });

  it("is `unrepresentable` for a sample the wire couldn't carry", () => {
    expect(namedValueState({ value: null, ts_ms: CAPTURED, source: "poll" }, FRESH)).toEqual({
      kind: "unrepresentable",
    });
  });

  it("marks a polled value older than the threshold stale", () => {
    const old = { value: 3.4, ts_ms: CAPTURED - 60_000, source: "poll" as const };
    expect(namedValueState(old, FRESH)).toMatchObject({ stale: true });
  });

  it("never calls an on-demand read stale — it is as fresh as it just was", () => {
    const read = { value: 3.4, ts_ms: Date.now() - 60_000, source: "read" as const };
    expect(namedValueState(read, FRESH)).toMatchObject({ stale: false });
  });

  it("can't be stale on a register nothing polls", () => {
    const old = { value: 3.4, ts_ms: CAPTURED - 60_000, source: "poll" as const };
    expect(namedValueState(old, { ...FRESH, polled: false })).toMatchObject({ stale: false });
  });

  it("can't judge staleness before a snapshot has been captured", () => {
    const old = { value: 3.4, ts_ms: CAPTURED - 60_000, source: "poll" as const };
    expect(namedValueState(old, { ...FRESH, snapshotCapturedAt: null })).toMatchObject({
      stale: false,
    });
  });
});

describe("rawValueState", () => {
  it("is `never` before the row has been read", () => {
    expect(rawValueState(null)).toEqual({ kind: "never" });
  });

  it("keeps the raw words as the value's context", () => {
    expect(rawValueState({ value: 3.14, words_hex: "0x4048 0xf5c3" })).toEqual({
      kind: "value",
      value: 3.14,
      source: "read",
      stale: false,
      context: "0x4048 0xf5c3",
    });
  });

  it("omits the context on a bit read, which has no words", () => {
    expect(rawValueState({ value: true, words_hex: null })).toEqual({
      kind: "value",
      value: true,
      source: "read",
      stale: false,
    });
  });

  it("keeps the words when the decode is unprintable — that is the diagnosis", () => {
    expect(rawValueState({ value: Number.NaN, words_hex: "0xffff 0xffff" })).toEqual({
      kind: "unrepresentable",
      context: "0xffff 0xffff",
    });
  });
});

describe("writeDefault", () => {
  it("offers a printable value back as the placeholder", () => {
    expect(writeDefault({ kind: "value", value: 3.4, stale: false, source: "poll" })).toBe(3.4);
    expect(writeDefault({ kind: "value", value: true, stale: false, source: "read" })).toBe(true);
  });

  it("offers nothing for a missing or unprintable sample", () => {
    expect(writeDefault({ kind: "never" })).toBeNull();
    expect(writeDefault({ kind: "unrepresentable" })).toBeNull();
  });

  it("offers nothing for a 64-bit integer the editor can't hold", () => {
    const state: ValueState = { kind: "value", value: 2n ** 60n, stale: false, source: "read" };
    expect(writeDefault(state)).toBeNull();
  });
});

describe("sameValueState", () => {
  const value: ValueState = { kind: "value", value: 1, stale: false, source: "poll" };

  it("sees through the fresh object a poll builds every tick", () => {
    expect(sameValueState(value, { ...value })).toBe(true);
  });

  it("notices the value, the staleness, the source and the context changing", () => {
    expect(sameValueState(value, { ...value, value: 2 })).toBe(false);
    expect(sameValueState(value, { ...value, stale: true })).toBe(false);
    expect(sameValueState(value, { ...value, source: "read" })).toBe(false);
    expect(sameValueState(value, { ...value, context: "0x0001" })).toBe(false);
  });

  it("notices the kind changing, and matches two of a kind that carry nothing", () => {
    expect(sameValueState(value, { kind: "never" })).toBe(false);
    expect(sameValueState({ kind: "never" }, { kind: "never" })).toBe(true);
    expect(sameValueState({ kind: "unrepresentable" }, { kind: "unrepresentable" })).toBe(true);
    expect(
      sameValueState({ kind: "unrepresentable" }, { kind: "unrepresentable", context: "0x1" }),
    ).toBe(false);
  });
});

describe("namedWriteModel", () => {
  it("offers a numeric editor for a writable word register", () => {
    expect(namedWriteModel(reg({ datatype: "int16", scale: 0.1, unit: "°C" }))).toEqual({
      kind: "numeric",
      datatype: "int16",
      scale: 0.1,
      unit: "°C",
      // The extension encodes a named write, so the value crosses as JSON.
      wire: "json",
    });
  });

  it("offers a switch for a coil, and for a word register mapped as bool", () => {
    expect(namedWriteModel(reg({ type: "coil", datatype: "bool" })).kind).toBe("switch");
    expect(namedWriteModel(reg({ type: "holding", datatype: "bool" })).kind).toBe("switch");
  });

  it("blames the protocol when the table itself can't be written", () => {
    expect(namedWriteModel(reg({ type: "input", writable: false }))).toEqual({
      kind: "readonly",
      why: "input registers are read-only",
    });
  });

  it("blames the map when a writable table carries a read-only register", () => {
    // Holding registers are writable by protocol — this one is off-limits
    // because the map says so, which is a different thing to fix.
    expect(namedWriteModel(reg({ type: "holding", writable: false }))).toEqual({
      kind: "readonly",
      why: "this register is marked read-only in the map",
    });
  });
});

describe("rawWriteModel", () => {
  it("offers an unscaled, unitless numeric editor on a holding address", () => {
    expect(rawWriteModel(raw({ datatype: "uint32" }))).toEqual({
      kind: "numeric",
      datatype: "uint32",
      scale: 1,
      unit: "",
      // Raw words are built here, so nothing has to survive a JSON number.
      wire: "words",
    });
  });

  it("offers a switch on a coil", () => {
    expect(rawWriteModel(raw({ table: "coil", datatype: "bool" })).kind).toBe("switch");
  });

  it("refuses the two tables Modbus can't write", () => {
    expect(rawWriteModel(raw({ table: "input" }))).toEqual({
      kind: "readonly",
      why: "input registers are read-only",
    });
    expect(rawWriteModel(raw({ table: "discrete_input", datatype: "bool" })).kind).toBe("readonly");
  });
});

describe("resolveValue", () => {
  const snap = snapshot({ "power/total": { value: 1, ts_ms: 500 } });

  it("returns null when neither source has the path", () => {
    expect(resolveValue("power/factor", snap, {})).toBeNull();
  });

  it("uses the snapshot when there is no on-demand read", () => {
    expect(resolveValue("power/total", snap, {})).toEqual({
      source: "poll",
      value: 1,
      ts_ms: 500,
    });
  });

  it("keeps the read until the poll reports something newer than it overtook", () => {
    // Read taken against the ts_ms 500 sample: that sample is not news.
    const overlay = { "power/total": { value: 2, supersedes: 500 } };
    expect(resolveValue("power/total", snap, overlay)).toEqual({ source: "read", value: 2 });
  });

  it("hands the row back to the poll on the first strictly newer sample", () => {
    const overlay = { "power/total": { value: 2, supersedes: 500 } };
    const newer = snapshot({ "power/total": { value: 3, ts_ms: 501 } });
    expect(resolveValue("power/total", newer, overlay)).toEqual({
      source: "poll",
      value: 3,
      ts_ms: 501,
    });
  });

  it("holds on an equal timestamp — the same sample re-served is not an update", () => {
    // The poll re-reports what it had; without the strict comparison the row
    // would flip back to the pre-read value on the next tick.
    const overlay = { "power/total": { value: 2, supersedes: 500 } };
    const same = snapshot({ "power/total": { value: 1, ts_ms: 500 } });
    expect(resolveValue("power/total", same, overlay)?.source).toBe("read");
  });

  it("ignores an agent clock that jumped backwards", () => {
    // A backwards step is not a new sample, however far back it goes — the old
    // browser-clock comparison would have handed the row over here.
    const overlay = { "power/total": { value: 2, supersedes: 500 } };
    const behind = snapshot({ "power/total": { value: 9, ts_ms: 400 } });
    expect(resolveValue("power/total", behind, overlay)?.source).toBe("read");
  });

  it("holds a read taken with nothing polled until any sample arrives", () => {
    const overlay = { "setpoints/energy_reset": { value: 7, supersedes: null } };
    // Nothing polls it: the read is all there will ever be.
    expect(resolveValue("setpoints/energy_reset", snap, overlay)).toEqual({
      source: "read",
      value: 7,
    });
    // The moment the register does start appearing in snapshots, the poll wins.
    const nowPolled = snapshot({ "setpoints/energy_reset": { value: 8, ts_ms: 1 } });
    expect(resolveValue("setpoints/energy_reset", nowPolled, overlay)?.source).toBe("poll");
  });

  it("serves a read when there is no snapshot at all", () => {
    const overlay = { "power/total": { value: 2, supersedes: null } };
    expect(resolveValue("power/total", undefined, overlay)).toEqual({ source: "read", value: 2 });
  });
});

describe("stalenessThresholdMs", () => {
  it("uses ~3× the register's own interval", () => {
    expect(stalenessThresholdMs(2, 10)).toBe(6_000);
  });

  it("falls back to the interface interval when the register inherits", () => {
    expect(stalenessThresholdMs(null, 4)).toBe(12_000);
  });

  it("never drops below 1.5 s", () => {
    expect(stalenessThresholdMs(0.1, 10)).toBe(1_500);
  });

  it("falls back to a fixed cutoff when polling is disabled or nonsense", () => {
    expect(stalenessThresholdMs(0, 0)).toBe(5_000);
    expect(stalenessThresholdMs(Number.NaN, Number.NaN)).toBe(5_000);
  });
});

describe("typeSummary", () => {
  it("is the bare datatype when there is nothing to annotate", () => {
    expect(typeSummary(reg({ datatype: "float32" }))).toBe("float32");
  });

  it("annotates a byte order other than big", () => {
    expect(typeSummary(reg({ datatype: "float32", byte_order: "big_swap" }))).toBe(
      "float32 big_swap",
    );
  });

  it("annotates a scale other than 1", () => {
    expect(typeSummary(reg({ datatype: "int16", scale: 0.1 }))).toBe("int16 ×0.1");
  });

  it("keeps both annotations, byte order first", () => {
    expect(typeSummary(reg({ datatype: "int32", byte_order: "little", scale: 0.01 }))).toBe(
      "int32 little ×0.01",
    );
  });

  it("leaves the table and the unit to their own columns", () => {
    expect(typeSummary(reg({ type: "coil", datatype: "bool", unit: "kW" }))).toBe("bool");
  });
});
