/** What a table row *shows*, worked out away from the JSX.
 *
 *  Two unions carry every decision the Value and Write cells make, so the cells
 *  render one prop each instead of re-deriving "is there a value, and can it be
 *  printed, and is it a bool, and is it writable" at both call sites:
 *
 *  - {@link ValueState} — never read / read but unprintable / a value, with the
 *    staleness verdict already applied.
 *  - {@link WriteModel} — read-only (and why) / a switch / a numeric editor (and
 *    what to validate against).
 *
 *  Named rows resolve theirs from the catalog entry plus the snapshot-and-overlay
 *  merge; raw rows from the stored row plus their own last readout. Neither cell
 *  knows which kind it is serving. */

import {
  isBooleanRegister,
  isRepresentable,
  isWritableTable,
  type DecodedValue,
  type WriteWire,
} from "./codec";
import type {
  ByteOrder,
  ModbusDatatype,
  ModbusSnapshot,
  RegisterEntry,
  RegisterTableType,
} from "./types";
import {
  MAP_READ_ONLY_REASON,
  readOnlyReason,
  type RawReadout,
  type RawWatchRow,
} from "./watch-store";

/** Staleness cutoff when the poll rate is unknown or disabled. */
const DEFAULT_STALE_MS = 5_000;

export const TABLE_LABELS: Record<RegisterTableType, string> = {
  holding: "holding",
  input: "input",
  coil: "coil",
  discrete_input: "discrete",
};

/** Device documentation writes byte order as a byte pattern, and it fits a table
 *  cell in a way `little_swap` never will. Same permutations as `reorderWords`. */
export const BYTE_ORDER_LABELS: Record<ByteOrder, string> = {
  big: "AB CD",
  little: "DC BA",
  big_swap: "CD AB",
  little_swap: "BA DC",
};

// ─── Value ──────────────────────────────────────────────────────────────────

export type ValueSource = "poll" | "read";

/** A sample that exists. `value: null` is a sample the wire couldn't carry (a
 *  sanitized non-finite float), which is not the same as having no sample.
 *
 *  Only a polled sample carries a timestamp, because only a polled sample can be
 *  compared with anything: `ts_ms` is agent-clock, and the only other agent-clock
 *  reading available is the snapshot's own `captured_at_unix_ms`. */
export type ResolvedValue =
  | { source: "poll"; value: number | boolean | null; ts_ms: number }
  | { source: "read"; value: number | boolean | null };

/** A value fetched on demand, and the poll sample it was taken against.
 *
 *  `supersedes` is the agent-clock `ts_ms` that `values[path]` held at the moment
 *  of the read, or null if the snapshot had no sample for the path yet. The poll
 *  takes the row back only once it reports something strictly newer than that —
 *  agent clock against agent clock. Stamping the read with `Date.now()` and
 *  comparing that to agent time was the bug: a browser running behind the agent
 *  would pin the row to its read for as long as the skew lasted. */
export interface OverlayEntry {
  value: number | boolean | null;
  supersedes: number | null;
}

export type Overlay = Readonly<Record<string, OverlayEntry>>;

/** Everything the Value cell needs, and nothing it has to work out.
 *
 *  `context` is whatever extra the row can say about the sample — the raw words
 *  behind it — and becomes the tooltip, alone or after the reason a value can't
 *  be shown. */
export type ValueState =
  | { kind: "never" }
  | { kind: "unrepresentable"; context?: string }
  | { kind: "value"; value: DecodedValue; stale: boolean; source: ValueSource; context?: string };

/** The on-demand read, until the poll produces something newer than the sample
 *  that read was taken against. */
export function resolveValue(
  path: string,
  snapshot: ModbusSnapshot | undefined,
  overlay: Overlay,
): ResolvedValue | null {
  const polled = snapshot?.values[path];
  const read = overlay[path];
  if (read !== undefined && !pollSupersedes(read, polled)) {
    return { source: "read", value: read.value };
  }
  if (polled !== undefined) return { source: "poll", value: polled.value, ts_ms: polled.ts_ms };
  return null;
}

function pollSupersedes(read: OverlayEntry, polled: { ts_ms: number } | undefined): boolean {
  if (polled === undefined) return false;
  // Nothing was polled when the read happened, so the first sample to arrive is
  // news — however it is stamped. A register with `rate: 0` never
  // produces one, which is exactly why the read has to hold there forever.
  if (read.supersedes === null) return true;
  // Strictly newer: the same sample the read was taken against is not an update,
  // and re-serving it would flicker the value back on every tick.
  return polled.ts_ms > read.supersedes;
}

/** The named row's merged sample as a state, staleness included. Only a polled
 *  value can be stale: an on-demand read is as fresh as the moment it landed. */
export function namedValueState(
  resolved: ResolvedValue | null,
  staleness: { thresholdMs: number; snapshotCapturedAt: number | null; polled: boolean },
): ValueState {
  if (resolved === null) return { kind: "never" };
  if (!isRepresentable(resolved.value)) return { kind: "unrepresentable" };
  return {
    kind: "value",
    value: resolved.value,
    source: resolved.source,
    stale:
      staleness.polled &&
      resolved.source === "poll" &&
      isStale(resolved.ts_ms, staleness.thresholdMs, staleness.snapshotCapturedAt),
  };
}

/** A raw row's own readout as a state. Nothing polls a raw row, so nothing about
 *  it can go stale — it is either read or not. */
export function rawValueState(readout: RawReadout | null): ValueState {
  if (readout === null) return { kind: "never" };
  const context = readout.words_hex === null ? {} : { context: readout.words_hex };
  if (!isRepresentable(readout.value)) return { kind: "unrepresentable", ...context };
  return { kind: "value", value: readout.value, source: "read", stale: false, ...context };
}

/** The value the write editor may offer as its placeholder. Nothing the user
 *  can't retype belongs there: no missing sample, no unrepresentable one, and no
 *  64-bit integer (the editor works in `number`). */
export function writeDefault(state: ValueState): number | boolean | null {
  if (state.kind !== "value" || typeof state.value === "bigint") return null;
  return state.value;
}

/** Cheap equality for a memoized row: the 1 Hz poll hands back a fresh sample
 *  object every tick, so the state has to be compared by field or every row
 *  re-renders on every tick. */
export function sameValueState(a: ValueState, b: ValueState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "value" && b.kind === "value") {
    return (
      a.value === b.value && a.stale === b.stale && a.source === b.source && a.context === b.context
    );
  }
  if (a.kind === "unrepresentable" && b.kind === "unrepresentable") return a.context === b.context;
  return true;
}

/** ~3× the register's poll rate, falling back to 5 s when the rate is unknown
 *  or polling is disabled. */
export function stalenessThresholdMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_STALE_MS;
  return Math.max(3 * seconds * 1000, 1500);
}

/** Both readings are the agent's clock — the sample's `ts_ms` and the snapshot's
 *  `captured_at_unix_ms`. The browser's clock never enters the comparison. */
function isStale(ts_ms: number, thresholdMs: number, snapshotCapturedAt: number | null): boolean {
  if (snapshotCapturedAt === null) return false;
  return snapshotCapturedAt - ts_ms > thresholdMs;
}

// ─── Write ──────────────────────────────────────────────────────────────────

/** What the Write cell offers for a row, and what to validate against.
 *
 *  `blind` is the honest state when the catalog is unreachable: a named write only
 *  needs the path and a number — the extension owns the encoding — so the editor
 *  stays usable, but nothing here knows the datatype to range-check against. */
export type WriteModel =
  | { kind: "readonly"; why: string }
  | { kind: "switch" }
  | { kind: "numeric"; datatype: ModbusDatatype; scale: number; unit: string; wire: WriteWire }
  | { kind: "blind" };

export function namedWriteModel(reg: RegisterEntry): WriteModel {
  if (!reg.writable) {
    // Two different facts, two different fixes: the protocol forbids writing this
    // table, or the map marks this particular register read-only.
    return {
      kind: "readonly",
      why: isWritableTable(reg.type) ? MAP_READ_ONLY_REASON : readOnlyReason(reg.type),
    };
  }
  if (isBooleanRegister(reg.type, reg.datatype)) return { kind: "switch" };
  // A named write is a JSON number the extension encodes.
  return {
    kind: "numeric",
    datatype: reg.datatype,
    scale: reg.scale,
    unit: reg.unit,
    wire: "json",
  };
}

export function rawWriteModel(row: RawWatchRow): WriteModel {
  if (!isWritableTable(row.table)) return { kind: "readonly", why: readOnlyReason(row.table) };
  if (isBooleanRegister(row.table, row.datatype)) return { kind: "switch" };
  // Raw values are unscaled, a bare address has no unit to hint at, and the words
  // are built here — so the datatype's full range is expressible.
  return { kind: "numeric", datatype: row.datatype, scale: 1, unit: "", wire: "words" };
}

// ─── Metadata ───────────────────────────────────────────────────────────────

/** The Type cell for a named row: the datatype, annotated with the byte order
 *  when it isn't `big` and the scale when it isn't 1 — `int16 ×0.1`. The table
 *  and the unit have their own columns, so neither appears here. */
export function typeSummary(reg: RegisterEntry): string {
  const parts: string[] = [reg.datatype];
  if (reg.byte_order !== "big") parts.push(reg.byte_order);
  if (reg.scale !== 1) parts.push(`×${reg.scale}`);
  return parts.join(" ");
}
