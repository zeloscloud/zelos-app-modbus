/** localStorage-backed rows for an interface's one register table, plus the pure
 *  "what request would this raw row issue" planners.
 *
 *  Two kinds of row share one list, one storage key and one insertion order:
 *
 *  - **named** rows are catalog registers the user picked. They store IDENTITY
 *    ONLY (`path`); address, table, datatype, unit, scale, word order,
 *    writability and poll interval are all joined live from `list_registers`, so
 *    a row can never show metadata the extension has since changed. A path that
 *    has disappeared from the map renders as an orphan the user can delete.
 *  - **raw** rows are arbitrary-address access. The agent knows nothing about
 *    them, so they carry their OWN metadata (address, table, datatype, word
 *    order) and their values are decoded client-side by `lib/codec`.
 *
 *  Rows persisted before raw rows existed have no `kind` and load as `named`, so
 *  an existing table survives the upgrade untouched.
 *
 *  `address` is stored as the STRING the user typed (`"100"` or `"0x64"`) and
 *  parsed at request time, so the field round-trips through an edit without
 *  rewriting the user's preferred notation.
 *
 *  Rows are local-only and survive reloads, so a bench setup stays put between
 *  sessions. Values are deliberately NOT persisted; a stale readout from
 *  yesterday is worse than an empty one. */

import {
  decodeValue,
  encodeValue,
  formatWordsHex,
  isBitTable,
  isByteOrder,
  isModbusDatatype,
  isRegisterTableType,
  isWritableTable,
  parseAddress,
  readWordCount,
  type DecodedValue,
} from "./codec";
import type { ByteOrder, ModbusDatatype, RawReadResult, RegisterTableType } from "./types";
import { errorMessage } from "./utils";

const STORAGE_KEY = "zelos-app-modbus.watch-rows.v1";

interface RowIdentity {
  /** Stable local id. Generated client-side so localStorage owns identity. */
  id: string;
  agent: string;
  interface: string;
  /** The write editor's text, kept as typed. Persisted so a row can act as a
   *  one-click preset: several rows on the same register, each holding the value
   *  it writes. Absent on rows saved before presets existed. */
  draft?: string;
}

export interface NamedWatchRow extends RowIdentity {
  kind: "named";
  /** Register path (`"<event>/<name>"`) — the join key into the catalog, and the
   *  same key snapshots and named read/write use. Duplicates are legitimate: two
   *  rows on one register are two presets. */
  path: string;
}

export interface RawWatchRow extends RowIdentity {
  kind: "raw";
  /** As typed — decimal or `0x` hex. */
  address: string;
  table: RegisterTableType;
  /** Bit tables are always `bool`; {@link patchRow} keeps that true. */
  datatype: ModbusDatatype;
  byte_order: ByteOrder;
}

export type WatchRow = NamedWatchRow | RawWatchRow;

/** `Omit` over a union has to distribute, or the discriminant is lost. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type NewWatchRow = WithoutId<WatchRow>;

/** An inline edit. `draft` applies to either kind of row; the rest describe a
 *  raw row's own metadata and are ignored on a named row, which owns none. */
export type RowPatch = { draft?: string } & Partial<
  Pick<RawWatchRow, "address" | "table" | "datatype" | "byte_order">
>;

export function defaultRawRow(agent: string, iface: string): NewWatchRow {
  return {
    kind: "raw",
    agent,
    interface: iface,
    address: "0",
    table: "holding",
    datatype: "uint16",
    byte_order: "big",
  };
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `watch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createRow(input: NewWatchRow): WatchRow {
  return { ...input, id: generateId() };
}

/** Apply an inline edit.
 *
 *  A named row only has a draft to edit — the raw fields in the patch describe
 *  metadata it doesn't own. A raw row also keeps its table and datatype coherent:
 *  a bit table can only carry `bool`, and leaving one for a word table restores a
 *  sane default rather than trying to read a `bool` out of a holding register.
 *
 *  The spread is safe under `exactOptionalPropertyTypes`: {@link RowPatch}'s
 *  fields are optional-and-never-`undefined`, so an absent field can't overwrite
 *  a present one with nothing. */
export function patchRow(row: WatchRow, patch: RowPatch): WatchRow {
  if (row.kind === "named") {
    return patch.draft === undefined ? row : { ...row, draft: patch.draft };
  }
  const next: RawWatchRow = { ...row, ...patch };
  if (isBitTable(next.table)) return { ...next, datatype: "bool" };
  if (next.datatype === "bool") return { ...next, datatype: "uint16" };
  return next;
}

/** Human label for a raw row, for failure toasts and copy-details payloads. */
export function rawRowLabel(row: RawWatchRow): string {
  const what = isBitTable(row.table) ? row.table : `${row.table} ${row.datatype}`;
  return `raw ${what} @ ${row.address}`;
}

/** What to call a row of either kind outside its table. */
export function rowLabel(row: WatchRow): string {
  return row.kind === "named" ? row.path : rawRowLabel(row);
}

export function loadRows(): WatchRow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Trust the shape — these are our own writes — but drop rows that are
    // obviously malformed so a bad localStorage entry can't crash the UI, and
    // drop a repeated id (first wins): React keys and every id-addressed edit
    // depend on uniqueness, and a duplicate would move two rows at once.
    const rows: WatchRow[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      const row = reviveRow(entry);
      if (row === null || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

export function saveRows(rows: readonly WatchRow[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Storage quota exceeded / disabled — silently drop; the UI still shows the
    // in-memory rows until the page is reloaded.
  }
}

/** One stored entry → a row, or null if it isn't usable. A row without a `kind`
 *  predates raw rows and is therefore named; a raw row falls back to the
 *  defaults for any field that no longer parses. */
function reviveRow(entry: unknown): WatchRow | null {
  if (entry === null || typeof entry !== "object") return null;
  const r = entry as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.agent !== "string" || typeof r.interface !== "string") {
    return null;
  }
  const identity: RowIdentity = {
    id: r.id,
    agent: r.agent,
    interface: r.interface,
    ...(typeof r.draft === "string" ? { draft: r.draft } : {}),
  };

  if (r.kind === "raw") {
    if (typeof r.address !== "string" || r.address.length === 0) return null;
    return patchRow(
      {
        ...identity,
        kind: "raw",
        address: r.address,
        table: isRegisterTableType(r.table) ? r.table : "holding",
        datatype: isModbusDatatype(r.datatype) ? r.datatype : "uint16",
        byte_order: isByteOrder(r.byte_order) ? r.byte_order : "big",
      },
      {},
    );
  }

  if (typeof r.path !== "string" || r.path.length === 0) return null;
  return { ...identity, kind: "named", path: r.path };
}

// ─── Planning (pure) ───────────────────────────────────────────────────────

export type Planned<T> = { ok: true; plan: T } | { ok: false; error: string };

export interface RawReadPlan {
  address: number;
  table: RegisterTableType;
  /** Addresses to request: one per bit, or the datatype's word count. */
  count: number;
}

/** Which call to make, decided here rather than at the call site: FC5 for a bit,
 *  FC6 for one word (matching the extension's own `auto` write mode), FC16 for
 *  more than one. */
export type RawWritePlan =
  | { kind: "coil"; address: number; on: boolean }
  | { kind: "single"; address: number; word: number }
  | { kind: "multi"; address: number; words: number[] };

/** One decoded readout of a raw row, plus the words it came from. */
export interface RawReadout {
  value: DecodedValue;
  /** Raw words in hex, for the value's tooltip. Null on the bit tables. */
  words_hex: string | null;
}

/** Why a table can't be written: Modbus itself forbids it. One sentence, one
 *  place — the planner refuses with it and the write cell explains itself with
 *  it. */
export function readOnlyReason(table: RegisterTableType): string {
  return `${table} registers are read-only`;
}

/** Why a writable *table* still can't be written here: the register map says so.
 *  A different fact from {@link readOnlyReason}, and a different fix (edit the
 *  map, not the protocol). */
export const MAP_READ_ONLY_REASON = "this register is marked read-only in the map";

/** Everything about a raw row that decides which device value it names. A readout
 *  taken before any of it changed is no longer about this row's target. */
export function rawTargetKey(row: RawWatchRow): string {
  return `${row.address}|${row.table}|${row.datatype}|${row.byte_order}`;
}

/** The single-value read a raw row stands for, or the reason it can't be
 *  issued. Every validation the UI shows lives here so the inline error and the
 *  wire call can never disagree. */
export function planRawRead(row: RawWatchRow): Planned<RawReadPlan> {
  const address = parseAddress(row.address);
  if (address === null) return { ok: false, error: addressError(row.address) };
  const count = readWordCount(row.table, row.datatype, 1);
  if (address + count - 1 > 65535) {
    return { ok: false, error: "The read runs past address 65535" };
  }
  return { ok: true, plan: { address, table: row.table, count } };
}

/** The write a raw row would issue for `value`: a coil bit, or the encoded words
 *  for its datatype and word order. Raw writes are unscaled, and a `bigint` is
 *  encoded exactly — client-side words never go through a JSON number. */
export function planRawWrite(
  row: RawWatchRow,
  value: number | boolean | bigint,
): Planned<RawWritePlan> {
  const address = parseAddress(row.address);
  if (address === null) return { ok: false, error: addressError(row.address) };
  if (!isWritableTable(row.table)) return { ok: false, error: readOnlyReason(row.table) };
  if (isBitTable(row.table)) {
    return {
      ok: true,
      plan: { kind: "coil", address, on: typeof value === "boolean" ? value : value !== 0 },
    };
  }

  const n = typeof value === "boolean" ? Number(value) : value;
  if (typeof n === "number" && !Number.isFinite(n)) {
    return { ok: false, error: `Value "${String(value)}" is not a number` };
  }
  let words: number[];
  try {
    words = encodeValue(n, row.datatype, 1, row.byte_order);
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
  if (address + words.length - 1 > 65535) {
    return { ok: false, error: "The write runs past address 65535" };
  }
  const [first] = words;
  if (words.length === 1 && first !== undefined) {
    return { ok: true, plan: { kind: "single", address, word: first } };
  }
  return { ok: true, plan: { kind: "multi", address, words } };
}

/** What a raw read response means for the row that asked, or a throw saying why
 *  it means nothing. The words→value decode lives here rather than in the row so
 *  the bit/word branch is testable without a bridge.
 *
 *  The response has to be exactly what was asked for. Too few words would decode
 *  garbage, too many means the answer isn't to this question, and a `null` or a
 *  string in the array would silently become 0 under `Number()` — the whole point
 *  of a raw read is that the words are the truth. */
export function interpretRawRead(row: RawWatchRow, res: RawReadResult): RawReadout {
  // `values` is number[] for the word tables and boolean[] for the bit tables.
  const values: Array<number | boolean> = res.values ?? [];
  if (isBitTable(row.table)) {
    if (values.length !== 1) throw new Error(`expected 1 bit, got ${values.length}`);
    const first = values[0];
    if (typeof first === "boolean") return { value: first, words_hex: null };
    if (typeof first === "number" && Number.isInteger(first)) {
      return { value: first !== 0, words_hex: null };
    }
    throw new Error(`the device returned a non-boolean bit (${String(first)})`);
  }

  const expected = readWordCount(row.table, row.datatype, 1);
  if (values.length !== expected) {
    throw new Error(`expected ${expected} word(s), got ${values.length}`);
  }
  const words = values.map((word) => {
    if (typeof word !== "number" || !Number.isInteger(word)) {
      throw new Error(`the device returned a non-numeric word (${String(word)})`);
    }
    return word;
  });
  return {
    value: decodeValue(words, row.datatype, 1, row.byte_order),
    words_hex: formatWordsHex(words),
  };
}

function addressError(address: string): string {
  return `Address "${address}" is not a value in 0…65535 (dec or 0x)`;
}
