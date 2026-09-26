/** Row store: the named/raw union, its localStorage round-trip, tolerance of
 *  malformed and pre-union entries, the inline-edit coherence rule, and the pure
 *  request planners the raw rows are read and written through. */

import { beforeEach, describe, expect, it } from "vitest";

import {
  createRow,
  defaultRawRow,
  interpretRawRead,
  loadRows,
  patchRow,
  planRawRead,
  planRawWrite,
  rawRowLabel,
  rawTargetKey,
  readOnlyReason,
  saveRows,
  type NamedWatchRow,
  type NewWatchRow,
  type RawWatchRow,
  type WatchRow,
} from "./watch-store";
import type { RawReadResult } from "./types";

const STORAGE_KEY = "zelos-app-modbus.watch-rows.v2";

beforeEach(() => {
  window.localStorage.clear();
});

function named(overrides: Partial<Omit<NamedWatchRow, "id" | "kind">> = {}): NamedWatchRow {
  const row = createRow({
    kind: "named",
    agent: "localhost:2300",
    device: "meter",
    path: "power/total",
    ...overrides,
  });
  if (row.kind !== "named") throw new Error("expected a named row");
  return row;
}

function raw(overrides: Partial<Omit<RawWatchRow, "id" | "kind">> = {}): RawWatchRow {
  const row = createRow({ ...defaultRawRow("localhost:2300", "meter", 0), ...overrides });
  if (row.kind !== "raw") throw new Error("expected a raw row");
  return row;
}

// ─── Store ─────────────────────────────────────────────────────────────────

describe("createRow / defaultRawRow", () => {
  it("assigns a non-empty id and keeps the input fields", () => {
    const row = named({ path: "status/temperature" });
    expect(row.id).toBeTruthy();
    expect(row.agent).toBe("localhost:2300");
    expect(row.device).toBe("meter");
    expect(row.path).toBe("status/temperature");
  });

  it("generates unique ids across calls", () => {
    expect(named().id).not.toBe(named().id);
  });

  it("stores identity only on a named row — no register metadata to go stale", () => {
    expect(Object.keys(named()).sort()).toEqual(["agent", "device", "id", "kind", "path"]);
  });

  it("starts a raw row on holding / uint16 / big at the device's first address", () => {
    expect(defaultRawRow("a:1", "conn/unit1", 1)).toEqual({
      kind: "raw",
      agent: "a:1",
      device: "conn/unit1",
      address: "1",
      base: 1,
      table: "holding",
      datatype: "uint16",
      byte_order: "big",
    });
  });

  it("leaves a new row's write draft unset", () => {
    expect(named().draft).toBeUndefined();
    expect(raw().draft).toBeUndefined();
  });
});

describe("loadRows / saveRows", () => {
  it("round-trips both kinds of row through localStorage in insertion order", () => {
    const a = named({ path: "power/total" });
    const b = raw({ address: "0x64", datatype: "float32", byte_order: "big_swap" });
    const c = named({ path: "status/relay1" });
    saveRows([a, b, c]);
    expect(loadRows()).toEqual([a, b, c]);
  });

  it("round-trips a persisted write draft, which is what makes a row a preset", () => {
    const rows = [named({ path: "power/total", draft: "12.5" }), raw({ draft: "7" })];
    saveRows(rows);
    expect(loadRows().map((r) => r.draft)).toEqual(["12.5", "7"]);
  });

  it("returns [] when storage is empty", () => {
    expect(loadRows()).toEqual([]);
  });

  it("keeps rows for every (agent, device) — filtering happens in the UI", () => {
    saveRows([named({ agent: "a:1", device: "meter" }), raw({ device: "probe" })]);
    expect(loadRows()).toHaveLength(2);
  });

  it("falls back to the defaults for a raw row's unreadable fields", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "a",
          agent: "localhost:2300",
          device: "meter",
          kind: "raw",
          address: "10",
          base: 0,
          table: "nonsense",
          datatype: "float24",
          byte_order: "sideways",
        },
      ]),
    );
    expect(loadRows()[0]).toMatchObject({
      kind: "raw",
      address: "10",
      table: "holding",
      datatype: "uint16",
      byte_order: "big",
    });
  });

  it("re-applies the coherence rule on load, so a stored bit row can't carry a word type", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "a",
          agent: "localhost:2300",
          device: "meter",
          kind: "raw",
          address: "3",
          base: 0,
          table: "coil",
          datatype: "float32",
          byte_order: "big",
        },
      ]),
    );
    expect(loadRows()[0]).toMatchObject({ table: "coil", datatype: "bool" });
  });

  it("filters out malformed entries instead of crashing", () => {
    const good = named();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        good,
        { agent: "missing-id", device: "meter", path: "power/total" },
        null,
        "string-not-object",
        { id: "x", agent: "a", device: "i" },
        { id: "y", agent: "a", device: "i", path: "" },
        { id: "z", agent: "a", device: "i", path: 42 },
        { id: "w", agent: "a", device: "i", kind: "raw" },
        { id: "v", agent: "a", device: "i", kind: "raw", address: "" },
      ]),
    );
    expect(loadRows()).toEqual([good]);
  });

  it("drops a repeated id, keeping the first — ids address edits and React keys", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: "dup", agent: "a", device: "i", kind: "named", path: "power/total" },
        { id: "dup", agent: "a", device: "i", kind: "named", path: "power/factor" },
        { id: "other", agent: "a", device: "i", kind: "named", path: "status/temperature" },
      ]),
    );
    const rows = loadRows();
    expect(rows.map((r) => r.id)).toEqual(["dup", "other"]);
    expect(rows[0]).toMatchObject({ path: "power/total" });
  });

  it("returns [] when the stored value isn't JSON-parsable", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadRows()).toEqual([]);
  });

  it("returns [] when the stored value isn't an array", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows: [] }));
    expect(loadRows()).toEqual([]);
  });

  it("ignores rows written under a different store version", () => {
    window.localStorage.setItem(
      "zelos-app-modbus.watch-rows.v1",
      JSON.stringify([named({ path: "legacy/row" })]),
    );
    expect(loadRows()).toEqual([]);
  });
});

// ─── Inline edits ──────────────────────────────────────────────────────────

describe("patchRow", () => {
  it("records a write draft on either kind of row", () => {
    expect(patchRow(named(), { draft: "12.5" }).draft).toBe("12.5");
    expect(patchRow(raw(), { draft: "9" }).draft).toBe("9");
  });

  it("leaves a named row otherwise untouched — it owns no metadata to edit", () => {
    const row = named();
    expect(patchRow(row, { address: "99", table: "coil" })).toEqual(row);
  });

  it("commits a raw row's address, table, datatype and word order", () => {
    const row = raw();
    expect(patchRow(row, { address: "0x64" })).toMatchObject({ address: "0x64" });
    expect(patchRow(row, { datatype: "float32" })).toMatchObject({ datatype: "float32" });
    expect(patchRow(row, { byte_order: "little" })).toMatchObject({ byte_order: "little" });
    expect(patchRow(row, { table: "input" })).toMatchObject({ table: "input" });
  });

  it("forces bool when the table becomes a bit table", () => {
    const row = raw({ datatype: "float32" });
    expect(patchRow(row, { table: "coil" })).toMatchObject({ table: "coil", datatype: "bool" });
    expect(patchRow(row, { table: "discrete_input" })).toMatchObject({ datatype: "bool" });
  });

  it("ignores a datatype chosen for a bit table", () => {
    const coil = raw({ table: "coil", datatype: "bool" });
    expect(patchRow(coil, { datatype: "uint32" })).toMatchObject({ datatype: "bool" });
  });

  it("restores uint16 when a bit row moves to a word table", () => {
    const coil = raw({ table: "coil", datatype: "bool" });
    expect(patchRow(coil, { table: "holding" })).toMatchObject({
      table: "holding",
      datatype: "uint16",
    });
    expect(patchRow(coil, { table: "input" })).toMatchObject({ datatype: "uint16" });
  });

  it("keeps the draft while metadata changes around it", () => {
    const row = raw({ draft: "5" });
    expect(patchRow(row, { table: "coil" })).toMatchObject({ draft: "5", datatype: "bool" });
  });
});

describe("rawRowLabel", () => {
  it("names the table, the datatype and the address", () => {
    expect(rawRowLabel(raw({ address: "0x64", datatype: "float32" }))).toBe(
      "raw holding float32 @ 0x64",
    );
  });

  it("omits the datatype on a bit table, where there is only ever one", () => {
    expect(rawRowLabel(raw({ table: "coil", datatype: "bool", address: "3" }))).toBe(
      "raw coil @ 3",
    );
  });

  it("keeps the address exactly as the user typed it", () => {
    expect(rawRowLabel(raw({ address: "0X0A" }))).toContain("@ 0X0A");
  });
});

// ─── Planning: reads ───────────────────────────────────────────────────────

describe("planRawRead", () => {
  it("parses decimal and hex addresses", () => {
    expect(planRawRead(raw({ address: "100" }), 0)).toEqual({
      ok: true,
      plan: { address: 100, table: "holding", count: 1 },
    });
    const hex = planRawRead(raw({ address: "0x64" }), 0);
    expect(hex.ok && hex.plan.address).toBe(100);
  });

  it("asks for one address per word of the datatype", () => {
    const f32 = planRawRead(raw({ datatype: "float32" }), 0);
    expect(f32.ok && f32.plan.count).toBe(2);
    const i64 = planRawRead(raw({ datatype: "int64" }), 0);
    expect(i64.ok && i64.plan.count).toBe(4);
  });

  it("asks for a single address on a bit table", () => {
    const plan = planRawRead(raw({ table: "coil", datatype: "bool" }), 0);
    expect(plan.ok && plan.plan.count).toBe(1);
  });

  it("rejects an unparseable address", () => {
    expect(planRawRead(raw({ address: "beef" }), 0)).toEqual({
      ok: false,
      error: 'Address "beef" is not a value in 0…65535 (dec or 0x)',
    });
  });

  it("rejects a read that runs past the address space", () => {
    const over = planRawRead(raw({ address: "65535", datatype: "uint32" }), 0);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/past address 65535/);
    // Exactly reaching the last address is fine.
    expect(planRawRead(raw({ address: "65534", datatype: "uint32" }), 0).ok).toBe(true);
  });

  it("validates in the device's base and sends the address as typed", () => {
    expect(planRawRead(raw({ base: 1, address: "0" }), 1)).toEqual({
      ok: false,
      error: 'Address "0" is not a value in 1…65536 (dec or 0x)',
    });
    const top = planRawRead(raw({ base: 1, address: "65536" }), 1);
    expect(top.ok && top.plan.address).toBe(65536);
    const over = planRawRead(raw({ base: 1, address: "65536", datatype: "uint32" }), 1);
    expect(!over.ok && over.error).toMatch(/past address 65536/);
    const typed = planRawRead(raw({ base: 1, address: "40001" }), 1);
    expect(typed.ok && typed.plan.address).toBe(40001);
  });

  it("blocks a row whose address base no longer matches the device's", () => {
    const row = raw({ base: 1, address: "101" });
    const error = "address base changed 1->0; re-enter the address";
    expect(planRawRead(row, 0)).toEqual({ ok: false, error });
    expect(planRawWrite(row, 1, 0, "auto")).toEqual({ ok: false, error });
    // The base is part of the target, so a readout under the old base is dropped.
    expect(rawTargetKey(row)).not.toBe(rawTargetKey({ ...row, base: 0 }));
  });
});

// ─── Planning: writes ──────────────────────────────────────────────────────

describe("planRawWrite", () => {
  const write = (row: RawWatchRow, value: number | boolean) => planRawWrite(row, value, 0, "auto");

  it("picks FC6 for a single word, so the call site needs no function-code logic", () => {
    const plan = write(raw({ address: "100", datatype: "uint16" }), 1234);
    expect(plan).toEqual({ ok: true, plan: { kind: "single", address: 100, word: 1234 } });
  });

  it("picks FC16 for a multi-word write, in the row's word order", () => {
    const plan = write(raw({ address: "110", datatype: "float32", byte_order: "big_swap" }), 3.14);
    expect(plan.ok && plan.plan.kind === "multi" && plan.plan.words).toEqual([0xf5c3, 0x4048]);
  });

  it("sends one word as FC16 under the device's fc16 write mode, as client.py does", () => {
    const plan = planRawWrite(raw({ address: "100" }), 7, 0, "fc16");
    expect(plan).toEqual({ ok: true, plan: { kind: "multi", address: 100, words: [7] } });
  });

  it("writes raw values unscaled", () => {
    const plan = write(raw({ datatype: "uint16" }), 100);
    expect(plan.ok && plan.plan.kind === "single" && plan.plan.word).toBe(100);
  });

  it("surfaces the codec's range error rather than wrapping the value", () => {
    const plan = write(raw({ datatype: "uint16" }), 70000);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/out of range/);
  });

  it("rejects a value that isn't a finite number", () => {
    expect(write(raw(), Number.NaN).ok).toBe(false);
    expect(write(raw(), Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it("plans a coil write from a boolean", () => {
    const on = write(raw({ table: "coil", datatype: "bool", address: "3" }), true);
    expect(on).toEqual({ ok: true, plan: { kind: "coil", address: 3, on: true } });
    const off = write(raw({ table: "coil", datatype: "bool", address: "3" }), false);
    expect(off.ok && off.plan.kind === "coil" && off.plan.on).toBe(false);
  });

  it("refuses the two tables Modbus can't write, in the words the cell uses", () => {
    for (const table of ["input", "discrete_input"] as const) {
      const plan = write(raw({ table }), 1);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.error).toBe(readOnlyReason(table));
    }
    expect(readOnlyReason("input")).toBe("input registers are read-only");
  });

  it("rejects an unparseable address before it encodes anything", () => {
    expect(write(raw({ address: "" }), 1).ok).toBe(false);
  });

  it("rejects a multi-word write that runs past the address space", () => {
    expect(write(raw({ address: "65535", datatype: "uint32" }), 1).ok).toBe(false);
  });
});

// ─── Interpreting the response ─────────────────────────────────────────────

describe("interpretRawRead", () => {
  function response(values: number[] | boolean[] | null): RawReadResult {
    return { address: 0, type: "holding", count: 1, values, success: true };
  }

  it("decodes the words a word table returns, and keeps them as hex", () => {
    const out = interpretRawRead(raw({ datatype: "float32" }), response([0x4048, 0xf5c3]));
    expect(out.value).toBeCloseTo(3.14, 5);
    expect(out.words_hex).toBe("0x4048 0xf5c3");
  });

  it("decodes in the row's word order", () => {
    const swapped = interpretRawRead(
      raw({ datatype: "float32", byte_order: "big_swap" }),
      response([0xf5c3, 0x4048]),
    );
    expect(swapped.value).toBeCloseTo(3.14, 5);
  });

  it("reads a bit table as a boolean, with no words to show", () => {
    const on = interpretRawRead(raw({ table: "coil", datatype: "bool" }), response([true]));
    expect(on).toEqual({ value: true, words_hex: null });
    const off = interpretRawRead(raw({ table: "coil", datatype: "bool" }), response([false]));
    expect(off.value).toBe(false);
  });

  it("refuses a response with fewer words than the datatype needs", () => {
    expect(() => interpretRawRead(raw({ datatype: "float32" }), response([1]))).toThrow(
      "expected 2 word(s), got 1",
    );
    expect(() => interpretRawRead(raw({ datatype: "int64" }), response([1, 2, 3]))).toThrow(
      "expected 4 word(s), got 3",
    );
  });

  it("refuses a response with no values at all", () => {
    expect(() => interpretRawRead(raw(), response(null))).toThrow("expected 1 word(s), got 0");
    expect(() => interpretRawRead(raw({ table: "coil", datatype: "bool" }), response([]))).toThrow(
      "expected 1 bit, got 0",
    );
    expect(() =>
      interpretRawRead(raw({ table: "coil", datatype: "bool" }), response(null)),
    ).toThrow("expected 1 bit, got 0");
  });

  it("refuses a response with more words than were asked for", () => {
    // Not an answer to this question: decoding the first two would be a guess
    // about which two.
    expect(() => interpretRawRead(raw({ datatype: "float32" }), response([1, 2, 3]))).toThrow(
      "expected 2 word(s), got 3",
    );
    expect(() =>
      interpretRawRead(raw({ table: "coil", datatype: "bool" }), response([true, false])),
    ).toThrow("expected 1 bit, got 2");
  });

  it("refuses a word that isn't a number, instead of reading it as zero", () => {
    // `[null]` through `Number()` is 0 — a value the device never sent.
    const nulled = {
      address: 0,
      type: "holding" as const,
      count: 1,
      values: [null],
      success: true,
    };
    expect(() => interpretRawRead(raw(), nulled as unknown as RawReadResult)).toThrow(
      "the device returned a non-numeric word (null)",
    );
    const texty = { address: 0, type: "holding" as const, count: 1, values: ["12"], success: true };
    expect(() => interpretRawRead(raw(), texty as unknown as RawReadResult)).toThrow(
      "non-numeric word",
    );
  });

  it("reads a bit the device sent as 0/1 rather than a boolean", () => {
    const one = { address: 0, type: "coil" as const, count: 1, values: [1], success: true };
    expect(interpretRawRead(raw({ table: "coil", datatype: "bool" }), one)).toEqual({
      value: true,
      words_hex: null,
    });
  });

  it("hands back a non-finite decode as-is, for the value cell to explain", () => {
    // float32 of all ones is a NaN: a successful read of an unprintable value.
    const out = interpretRawRead(raw({ datatype: "float32" }), response([0xffff, 0xffff]));
    expect(Number.isNaN(out.value)).toBe(true);
    expect(out.words_hex).toBe("0xffff 0xffff");
  });
});

// ─── Type-level guard: NewWatchRow really is the row minus its id ────────────

describe("NewWatchRow", () => {
  it("becomes a WatchRow by adding an id", () => {
    const input: NewWatchRow = {
      kind: "named",
      agent: "a:1",
      device: "meter",
      path: "power/total",
    };
    const row: WatchRow = createRow(input);
    expect(Object.keys(row).sort()).toEqual([...Object.keys(input), "id"].sort());
  });

  it("keeps the discriminant, so a raw input can only make a raw row", () => {
    const row: WatchRow = createRow(defaultRawRow("a:1", "meter", 1));
    expect(row.kind).toBe("raw");
  });
});
