/** Raw-row store: localStorage round-trip, malformed tolerance, and the pure
 *  request planner (address parsing, read caps, encode failures). */

import { beforeEach, describe, expect, it } from "vitest";

import {
  createRow,
  defaultRawRow,
  loadRows,
  parseBoolInput,
  planRawRow,
  rawRowLabel,
  saveRows,
  type NewRawRow,
  type RawRow,
} from "./raw-store";

const STORAGE_KEY = "zelos-app-modbus.raw-rows.v1";

beforeEach(() => {
  window.localStorage.clear();
});

function readRow(overrides: Partial<RawRow> = {}): RawRow {
  return createRow({ ...defaultRawRow("localhost:2300", "meter", "read"), ...overrides });
}

function writeRow(overrides: Partial<RawRow> = {}): RawRow {
  return createRow({ ...defaultRawRow("localhost:2300", "meter", "write"), ...overrides });
}

// ─── Store ─────────────────────────────────────────────────────────────────

describe("createRow / defaultRawRow", () => {
  it("assigns a non-empty id and keeps the input fields", () => {
    const row = readRow({ address: "0x64", count: 2, datatype: "float32" });
    expect(row.id).toBeTruthy();
    expect(row.agent).toBe("localhost:2300");
    expect(row.interface).toBe("meter");
    expect(row.address).toBe("0x64");
    expect(row.count).toBe(2);
  });

  it("generates unique ids across calls", () => {
    expect(readRow().id).not.toBe(readRow().id);
  });

  it("defaults a write row to a value of 0 and a read row to no value", () => {
    expect(defaultRawRow("a", "b", "write").value).toBe("0");
    expect(defaultRawRow("a", "b", "read").value).toBe("");
  });
});

describe("loadRows / saveRows", () => {
  it("round-trips rows through localStorage", () => {
    const a = readRow({ address: "100", datatype: "float32", count: 3 });
    const b = writeRow({ address: "0x10", target: "coil", value: "ON" });
    saveRows([a, b]);
    expect(loadRows()).toEqual([a, b]);
  });

  it("returns [] when storage is empty", () => {
    expect(loadRows()).toEqual([]);
  });

  it("filters out malformed entries instead of crashing", () => {
    const good = readRow();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        good,
        { agent: "missing-id" },
        null,
        "string-not-object",
        { id: "x", agent: "a", interface: "i", mode: "not-a-real-mode" },
        { id: "y", agent: "a", mode: "read" },
      ]),
    );
    expect(loadRows()).toEqual([good]);
  });

  it("returns [] when the stored value isn't JSON-parsable", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadRows()).toEqual([]);
  });

  it("returns [] when the stored value isn't an array", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows: [] }));
    expect(loadRows()).toEqual([]);
  });
});

describe("rawRowLabel", () => {
  it("describes a word read", () => {
    expect(rawRowLabel(readRow({ address: "0x64", count: 2, datatype: "float32" }))).toBe(
      "read holding @ 0x64 ×2 float32",
    );
  });

  it("omits the datatype for bit tables", () => {
    expect(rawRowLabel(readRow({ table: "coil", address: "3", count: 4 }))).toBe(
      "read coil @ 3 ×4",
    );
  });

  it("describes writes by target", () => {
    expect(rawRowLabel(writeRow({ address: "10", target: "coil" }))).toBe("write coil @ 10");
    expect(rawRowLabel(writeRow({ address: "10", datatype: "int32" }))).toBe(
      "write holding int32 @ 10",
    );
  });
});

// ─── Planner: reads ────────────────────────────────────────────────────────

describe("planRawRow (read)", () => {
  it("parses decimal and hex addresses", () => {
    const dec = planRawRow(readRow({ address: "100" }));
    expect(dec.ok && dec.plan.kind === "read" && dec.plan.address).toBe(100);
    const hex = planRawRow(readRow({ address: "0x64" }));
    expect(hex.ok && hex.plan.kind === "read" && hex.plan.address).toBe(100);
  });

  it("multiplies count by the datatype word count", () => {
    const plan = planRawRow(readRow({ datatype: "float32", count: 3 }));
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.plan.kind === "read") {
      expect(plan.plan.addressCount).toBe(6);
      expect(plan.plan.stride).toBe(2);
      expect(plan.plan.count).toBe(3);
    }
  });

  it("reads one address per value on bit tables", () => {
    const plan = planRawRow(readRow({ table: "coil", datatype: "float32", count: 8 }));
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.plan.kind === "read") {
      expect(plan.plan.addressCount).toBe(8);
      expect(plan.plan.stride).toBe(1);
    }
  });

  it("rejects an unparseable address", () => {
    const plan = planRawRow(readRow({ address: "beef" }));
    expect(plan).toEqual({
      ok: false,
      error: 'Address "beef" is not a value in 0…65535 (dec or 0x)',
    });
  });

  it("rejects a non-positive or fractional count", () => {
    expect(planRawRow(readRow({ count: 0 })).ok).toBe(false);
    expect(planRawRow(readRow({ count: -1 })).ok).toBe(false);
    expect(planRawRow(readRow({ count: 1.5 })).ok).toBe(false);
  });

  it("rejects a read wider than a single request", () => {
    const ok = planRawRow(readRow({ datatype: "uint16", count: 125 }));
    expect(ok.ok).toBe(true);
    const tooWide = planRawRow(readRow({ datatype: "uint16", count: 126 }));
    expect(tooWide.ok).toBe(false);
    if (!tooWide.ok) expect(tooWide.error).toMatch(/capped at 125/);
    // 63 × float32 = 126 words, also over the cap.
    expect(planRawRow(readRow({ datatype: "float32", count: 63 })).ok).toBe(false);
  });

  it("rejects a read that runs past the address space", () => {
    const plan = planRawRow(readRow({ address: "65535", datatype: "uint32", count: 1 }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/past address 65535/);
    // Exactly reaching the last address is fine.
    expect(planRawRow(readRow({ address: "65534", datatype: "uint32", count: 1 })).ok).toBe(true);
  });
});

// ─── Planner: writes ───────────────────────────────────────────────────────

describe("planRawRow (write)", () => {
  it("encodes a single-word write", () => {
    const plan = planRawRow(writeRow({ address: "100", datatype: "uint16", value: "1234" }));
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.plan.kind === "words") {
      expect(plan.plan.address).toBe(100);
      expect(plan.plan.words).toEqual([1234]);
    }
  });

  it("encodes a multi-word write with scale and byte order", () => {
    const plan = planRawRow(
      writeRow({ address: "110", datatype: "float32", byte_order: "big_swap", value: "3.14" }),
    );
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.plan.kind === "words") {
      expect(plan.plan.words).toEqual([0xf5c3, 0x4048]);
    }
  });

  it("applies the scale before encoding", () => {
    const plan = planRawRow(writeRow({ datatype: "uint16", scale: 0.1, value: "100" }));
    expect(plan.ok && plan.plan.kind === "words" && plan.plan.words).toEqual([1000]);
  });

  it("surfaces the codec's range error", () => {
    const plan = planRawRow(writeRow({ datatype: "uint16", value: "70000" }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/out of range/);
  });

  it("rejects a non-numeric or empty value", () => {
    expect(planRawRow(writeRow({ value: "" })).ok).toBe(false);
    expect(planRawRow(writeRow({ value: "abc" })).ok).toBe(false);
    expect(planRawRow(writeRow({ value: "  " })).ok).toBe(false);
  });

  it("plans a coil write from ON/OFF", () => {
    const on = planRawRow(writeRow({ target: "coil", address: "3", value: "ON" }));
    expect(on.ok && on.plan.kind === "coil" && on.plan.on).toBe(true);
    const off = planRawRow(writeRow({ target: "coil", address: "3", value: "off" }));
    expect(off.ok && off.plan.kind === "coil" && off.plan.on).toBe(false);
  });

  it("rejects a coil value it can't read as boolean", () => {
    const plan = planRawRow(writeRow({ target: "coil", value: "maybe" }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/must be ON or OFF/);
  });

  it("rejects a multi-word write that runs past the address space", () => {
    expect(planRawRow(writeRow({ address: "65535", datatype: "uint32", value: "1" })).ok).toBe(
      false,
    );
  });
});

describe("parseBoolInput", () => {
  it.each(["ON", "on", "true", "TRUE", "1", " on "])("reads %j as true", (input) => {
    expect(parseBoolInput(input)).toBe(true);
  });

  it.each(["OFF", "off", "false", "0", " off "])("reads %j as false", (input) => {
    expect(parseBoolInput(input)).toBe(false);
  });

  it.each(["", "yes", "no", "2"])("rejects %j", (input) => {
    expect(parseBoolInput(input)).toBeNull();
  });
});

// ─── Type-level guard: NewRawRow really is the row minus its id ─────────────

describe("NewRawRow", () => {
  it("becomes a RawRow by adding an id", () => {
    const input: NewRawRow = defaultRawRow("a:1", "iface", "read");
    const row: RawRow = createRow(input);
    expect(Object.keys(row).sort()).toEqual([...Object.keys(input), "id"].sort());
  });
});
