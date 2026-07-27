/** localStorage-backed raw-access rows, plus the pure "what would this row do"
 *  planner.
 *
 *  A raw row is a saved arbitrary-address operation: read N typed values from an
 *  address, or write one typed value to an address. Rows are local-only — the
 *  agent doesn't know about them — and survive reloads, so a bench setup stays
 *  put between sessions. Results are deliberately NOT persisted; a stale readout
 *  from yesterday is worse than an empty one.
 *
 *  Address is stored as the STRING the user typed (`"100"` or `"0x64"`) and
 *  parsed at execute time, so the field round-trips through an edit without
 *  rewriting the user's preferred notation. */

import {
  MAX_READ_COUNT,
  encodeValue,
  isBitTable,
  parseAddress,
  readWordCount,
  wordCount,
} from "./codec";
import type { ByteOrder, ModbusDatatype, RegisterTableType } from "./types";

const STORAGE_KEY = "zelos-app-modbus.raw-rows.v1";

export type RawRowMode = "read" | "write";
/** A raw write goes to a holding register (words, FC6/FC16) or a coil (bit, FC5). */
export type RawWriteTarget = "register" | "coil";

export interface RawRow {
  /** Stable local id. Generated client-side so localStorage owns identity. */
  id: string;
  agent: string;
  interface: string;
  mode: RawRowMode;
  /** As typed — decimal or `0x` hex. */
  address: string;
  /** READ: which Modbus table to read from. */
  table: RegisterTableType;
  /** WRITE: register (words) or coil (single bit). */
  target: RawWriteTarget;
  datatype: ModbusDatatype;
  byte_order: ByteOrder;
  scale: number;
  /** READ: how many VALUES to read (words = count × datatype word count). */
  count: number;
  /** WRITE: the physical value, as typed. `ON`/`OFF` for coils. */
  value: string;
}

export type NewRawRow = Omit<RawRow, "id">;

export function defaultRawRow(agent: string, iface: string, mode: RawRowMode): NewRawRow {
  return {
    agent,
    interface: iface,
    mode,
    address: "0",
    table: "holding",
    target: "register",
    datatype: "uint16",
    byte_order: "big",
    scale: 1,
    count: 1,
    value: mode === "write" ? "0" : "",
  };
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `raw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createRow(input: NewRawRow): RawRow {
  return { ...input, id: generateId() };
}

export function loadRows(): RawRow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Trust the shape — these are our own writes — but discard rows that are
    // obviously malformed so a bad localStorage entry can't crash the UI.
    return parsed.filter(isRawRowish) as RawRow[];
  } catch {
    return [];
  }
}

export function saveRows(rows: readonly RawRow[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Storage quota exceeded / disabled — silently drop; the UI still shows the
    // in-memory rows until the page is reloaded.
  }
}

function isRawRowish(row: unknown): boolean {
  if (row === null || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.agent === "string" &&
    typeof r.interface === "string" &&
    (r.mode === "read" || r.mode === "write")
  );
}

/** Human label for a row, used in toasts and copy-details payloads. */
export function rawRowLabel(row: RawRow): string {
  if (row.mode === "read") {
    const suffix = isBitTable(row.table) ? "" : ` ${row.datatype}`;
    return `read ${row.table} @ ${row.address} ×${row.count}${suffix}`;
  }
  const what = row.target === "coil" ? "coil" : `holding ${row.datatype}`;
  return `write ${what} @ ${row.address}`;
}

// ─── Planning (pure) ───────────────────────────────────────────────────────

export interface RawReadPlan {
  kind: "read";
  address: number;
  table: RegisterTableType;
  /** Number of VALUES the user asked for. */
  count: number;
  /** Addresses to request — `count` for bit tables, `count × words` otherwise. */
  addressCount: number;
  /** Words per decoded value (1 for bit tables). */
  stride: number;
}

export type RawWritePlan =
  | { kind: "coil"; address: number; on: boolean }
  | { kind: "words"; address: number; words: number[] };

export type RawPlan = { ok: true; plan: RawReadPlan | RawWritePlan } | { ok: false; error: string };

/** Turn a stored row into the exact request to issue, or the reason it can't be
 *  issued. Every validation the UI shows lives here so the inline error and the
 *  wire call can never disagree. */
export function planRawRow(row: RawRow): RawPlan {
  const address = parseAddress(row.address);
  if (address === null) {
    return { ok: false, error: `Address "${row.address}" is not a value in 0…65535 (dec or 0x)` };
  }

  if (row.mode === "read") {
    if (!Number.isInteger(row.count) || row.count < 1) {
      return { ok: false, error: "Count must be a whole number of at least 1" };
    }
    const bits = isBitTable(row.table);
    const addressCount = readWordCount(row.table, row.datatype, row.count);
    if (addressCount > MAX_READ_COUNT) {
      return {
        ok: false,
        error: `That reads ${addressCount} addresses; a single request is capped at ${MAX_READ_COUNT}`,
      };
    }
    if (address + addressCount - 1 > 65535) {
      return { ok: false, error: "The read runs past address 65535" };
    }
    return {
      ok: true,
      plan: {
        kind: "read",
        address,
        table: row.table,
        count: row.count,
        addressCount,
        stride: bits ? 1 : wordCount(row.datatype),
      },
    };
  }

  if (row.target === "coil") {
    const on = parseBoolInput(row.value);
    if (on === null)
      return { ok: false, error: `Coil value must be ON or OFF (got "${row.value}")` };
    return { ok: true, plan: { kind: "coil", address, on } };
  }

  const value = Number(row.value.trim());
  if (row.value.trim().length === 0 || !Number.isFinite(value)) {
    return { ok: false, error: `Value "${row.value}" is not a number` };
  }
  let words: number[];
  try {
    words = encodeValue(value, row.datatype, row.scale, row.byte_order);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (address + words.length - 1 > 65535) {
    return { ok: false, error: "The write runs past address 65535" };
  }
  return { ok: true, plan: { kind: "words", address, words } };
}

/** Accepts the notations a user might type for a coil: ON/OFF, true/false, 1/0. */
export function parseBoolInput(input: string): boolean | null {
  const text = input.trim().toLowerCase();
  if (["on", "true", "1"].includes(text)) return true;
  if (["off", "false", "0"].includes(text)) return false;
  return null;
}
