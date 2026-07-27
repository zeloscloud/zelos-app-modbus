/** Client-side Modbus value codec for arbitrary-address (raw) access.
 *
 *  Named registers are decoded/encoded extension-side (`read_named_register` /
 *  `write_named_register`). For raw reads and writes the extension hands us
 *  undecoded 16-bit words, so the app has to do the type handling itself.
 *
 *  This file is a 1:1 port of `zelos_extension_modbus/client.py`
 *  (`_reorder_registers`, `decode_value`, `encode_value`) so that a raw read of
 *  a mapped address agrees with the same register's named read. The quirks are
 *  ported deliberately:
 *
 *  - Word-granular reordering only. Byte order inside a word is never touched,
 *    and a single-word value is never reordered (`len(regs) <= 1` short-circuit).
 *    `big_swap`/`little_swap` only have defined permutations for 2- and 4-word
 *    values; other lengths pass through unchanged.
 *  - Scaled INTEGER results are truncated: Python does `int(raw * scale)`, so
 *    `decode_value([1005], "uint16", scale=0.1)` is `100`, not `100.5`. Float
 *    datatypes keep their fraction.
 *  - Encoding divides by the scale and truncates toward zero before packing
 *    (`int(value / scale)`), with a `scale == 0` guard that uses the value as-is.
 *
 *  Deliberate divergences from the Python source, both documented at their
 *  implementation site:
 *
 *  1. 64-bit integers are assembled/packed through `BigInt`, and an unscaled
 *     decode returns that `BigInt` exactly. Python routes every integer decode
 *     through `int(value * scale)` — a float multiply even at `scale = 1.0` —
 *     so it silently loses precision above 2^53. Values below 2^53 agree.
 *  2. Out-of-range encodes throw instead of wrapping. Python's `uint16` branch
 *     masks with `& 0xFFFF` (70000 → 4464) and the others raise `struct.error`;
 *     refusing the write is the safer behavior for a UI and matches what the
 *     inline validators tell the user. In-range values encode identically. */

import {
  BIT_REGISTER_TYPES,
  MODBUS_DATATYPES,
  BYTE_ORDERS,
  type ByteOrder,
  type ModbusDatatype,
  type RegisterTableType,
} from "./types";

/** A value decoded off the wire. `bigint` only for unscaled 64-bit integers. */
export type DecodedValue = number | boolean | bigint;

/** Number of 16-bit words each datatype occupies. */
export const WORD_COUNTS: Readonly<Record<ModbusDatatype, number>> = {
  bool: 1,
  uint16: 1,
  int16: 1,
  uint32: 2,
  int32: 2,
  float32: 2,
  uint64: 4,
  int64: 4,
  float64: 4,
};

/** Largest `count` the extension's `read_register` action accepts.
 *
 *  The Modbus protocol allows 125 words but 2000 bits per request; the
 *  extension's action schema declares `maximum=125` for every table, so the
 *  app clamps to the tighter of the two rather than issuing a request the
 *  extension may reject. */
export const MAX_READ_COUNT = 125;

const FLOAT32_MAX = 3.4028234663852886e38;

export function wordCount(datatype: ModbusDatatype): number {
  return WORD_COUNTS[datatype];
}

export function isModbusDatatype(value: string): value is ModbusDatatype {
  return (MODBUS_DATATYPES as readonly string[]).includes(value);
}

export function isByteOrder(value: string): value is ByteOrder {
  return (BYTE_ORDERS as readonly string[]).includes(value);
}

/** Bit tables carry booleans, one per address — no word decode, no datatype. */
export function isBitTable(table: RegisterTableType): boolean {
  return BIT_REGISTER_TYPES.has(table);
}

/** Word-granular reorder, exactly as `_reorder_registers` does it.
 *
 *  The Python helper ignores its `for_decode` flag, so encode and decode share
 *  one permutation. Every defined permutation is an involution, which is what
 *  makes encode → decode round-trip for all four orders. */
export function reorderWords(words: readonly number[], byteOrder: ByteOrder): number[] {
  if (words.length <= 1) return [...words];
  const regs = [...words];
  switch (byteOrder) {
    case "big":
      // Standard Modbus: AB CD (no change).
      return regs;
    case "little":
      // Full little endian: DC BA (reverse all).
      return regs.reverse();
    case "big_swap":
      // Big endian with word swap: CD AB (swap pairs).
      if (regs.length === 2) return [at(regs, 1), at(regs, 0)];
      if (regs.length === 4) return [at(regs, 1), at(regs, 0), at(regs, 3), at(regs, 2)];
      return regs;
    case "little_swap":
      // Little endian with word swap: BA DC.
      if (regs.length === 2) return [at(regs, 1), at(regs, 0)];
      if (regs.length === 4) return [at(regs, 3), at(regs, 2), at(regs, 1), at(regs, 0)];
      return regs;
  }
}

/** Raw (pre-scale) range for a datatype. 64-bit integers use `bigint` bounds
 *  because their extremes are not representable as exact doubles. */
export function rawRange(datatype: ModbusDatatype): {
  min: number | bigint;
  max: number | bigint;
} {
  switch (datatype) {
    case "bool":
      return { min: 0, max: 1 };
    case "uint16":
      return { min: 0, max: 65535 };
    case "int16":
      return { min: -32768, max: 32767 };
    case "uint32":
      return { min: 0, max: 4294967295 };
    case "int32":
      return { min: -2147483648, max: 2147483647 };
    case "float32":
      return { min: -FLOAT32_MAX, max: FLOAT32_MAX };
    case "uint64":
      return { min: 0n, max: 18446744073709551615n };
    case "int64":
      return { min: -9223372036854775808n, max: 9223372036854775807n };
    case "float64":
      return { min: -Number.MAX_VALUE, max: Number.MAX_VALUE };
  }
}

/** Physical (post-scale) range, as plain numbers, for input hints and bounds.
 *
 *  64-bit bounds go through `Number()` and are therefore approximate — the
 *  authoritative check is {@link encodeValue}, which works in `BigInt`. */
export function physicalRange(
  datatype: ModbusDatatype,
  scale: number,
): { min: number; max: number } {
  const raw = rawRange(datatype);
  const lo = Number(raw.min);
  const hi = Number(raw.max);
  if (!Number.isFinite(scale) || scale === 0) return { min: lo, max: hi };
  const a = lo * scale;
  const b = hi * scale;
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

/** Decode raw words into a typed, scaled value.
 *
 *  Mirrors `decode_value`: reorder → assemble big-endian → apply scale, with
 *  integer datatypes truncated toward zero after scaling. */
export function decodeValue(
  words: readonly number[],
  datatype: ModbusDatatype,
  scale = 1,
  byteOrder: ByteOrder = "big",
): DecodedValue {
  const regs = reorderWords(words, byteOrder);
  if (datatype === "bool") {
    return Boolean(at(regs, 0));
  }
  const need = wordCount(datatype);
  if (regs.length < need) {
    throw new Error(`${datatype} needs ${need} word(s) to decode, got ${regs.length}`);
  }
  const view = wordsToView(regs.slice(0, need));
  switch (datatype) {
    case "uint16":
      return truncScaled(view.getUint16(0), scale);
    case "int16":
      return truncScaled(view.getInt16(0), scale);
    case "uint32":
      return truncScaled(view.getUint32(0), scale);
    case "int32":
      return truncScaled(view.getInt32(0), scale);
    case "float32":
      return view.getFloat32(0) * scale;
    case "float64":
      return view.getFloat64(0) * scale;
    case "uint64":
    case "int64": {
      const raw = datatype === "uint64" ? view.getBigUint64(0) : view.getBigInt64(0);
      // Divergence (1): keep full precision when there is nothing to scale.
      // Python's `int(raw * 1.0)` would round-trip through a double here.
      if (scale === 1) return raw;
      return truncScaled(Number(raw), scale);
    }
  }
}

/** Encode a typed value into raw words (scale applied, then byte order).
 *
 *  Mirrors `encode_value`, except that values outside the datatype's raw range
 *  throw before any word is produced — see divergence (2) in the file header. */
export function encodeValue(
  value: number | boolean | bigint,
  datatype: ModbusDatatype,
  scale = 1,
  byteOrder: ByteOrder = "big",
): number[] {
  // `bool` ignores the scale entirely, exactly as the Python branch does
  // (`regs = [1 if value else 0]` uses the unscaled value).
  if (datatype === "bool") return [value ? 1 : 0];

  const need = wordCount(datatype);
  const buffer = new ArrayBuffer(need * 2);
  const view = new DataView(buffer);

  if (datatype === "uint64" || datatype === "int64") {
    const scaled = scaledBigInt(value, datatype, scale);
    if (datatype === "uint64") view.setBigUint64(0, scaled);
    else view.setBigInt64(0, scaled);
  } else {
    const scaled = scaledNumber(value, datatype, scale);
    switch (datatype) {
      case "uint16":
      case "int16":
      case "uint32":
      case "int32": {
        const n = truncToward0(scaled);
        assertInRange(n, datatype);
        if (datatype === "uint16") view.setUint16(0, n);
        else if (datatype === "int16") view.setInt16(0, n);
        else if (datatype === "uint32") view.setUint32(0, n);
        else view.setInt32(0, n);
        break;
      }
      case "float32":
        // DataView silently saturates to ±Infinity; Python raises OverflowError.
        // Refuse rather than write 0x7F800000 behind the user's back.
        if (Math.abs(scaled) > FLOAT32_MAX) {
          throw rangeError(scaled, datatype);
        }
        view.setFloat32(0, scaled);
        break;
      case "float64":
        view.setFloat64(0, scaled);
        break;
    }
  }

  const words: number[] = [];
  for (let i = 0; i < need; i++) words.push(view.getUint16(i * 2));
  return reorderWords(words, byteOrder);
}

/** Would {@link encodeValue} accept this value? Used by the inline write
 *  editors so the message the user sees is the message the codec would throw. */
export function validateWriteValue(
  value: number | boolean | bigint,
  datatype: ModbusDatatype,
  scale: number,
): { ok: true } | { ok: false; error: string } {
  try {
    encodeValue(value, datatype, scale);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Formatting / parsing helpers ───────────────────────────────────────────

/** `[0x4048, 0xf5c3]` → `"0x4048 0xf5c3"`. */
export function formatWordsHex(words: readonly number[]): string {
  return words.map((w) => `0x${(w & 0xffff).toString(16).padStart(4, "0")}`).join(" ");
}

/** `100` → `"100 (0x0064)"` — decimal is what users type, hex is what device
 *  documentation prints. */
export function formatAddress(address: number): string {
  return `${address} (0x${address.toString(16).padStart(4, "0")})`;
}

/** Parse a user-entered address, accepting decimal (`"100"`) or hex
 *  (`"0x64"`, `"0X64"`). Returns null for anything that isn't a whole address
 *  in `[0, 65535]`. */
export function parseAddress(input: string): number | null {
  const text = input.trim();
  if (text.length === 0) return null;
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    value = Number.parseInt(text.slice(2), 16);
  } else if (/^[0-9]+$/.test(text)) {
    value = Number.parseInt(text, 10);
  } else {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 65535) return null;
  return value;
}

/** Display form for a decoded value. Booleans read as ON/OFF (the wire idiom
 *  for coils); 64-bit integers stay strings so nothing is rounded on the way
 *  to the DOM. */
export function formatDecodedValue(value: DecodedValue): string {
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  if (typeof value === "bigint") return value.toString();
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toString();
  // Six decimals is plenty for scaled sensor values and keeps float32 noise
  // (e.g. 3.1400001049041748) out of the table.
  return Number(value.toFixed(6)).toString();
}

/** Words needed for `count` values of `datatype` in `table`. Bit tables read
 *  one address per value regardless of datatype. */
export function readWordCount(
  table: RegisterTableType,
  datatype: ModbusDatatype,
  count: number,
): number {
  return isBitTable(table) ? count : count * wordCount(datatype);
}

// ─── Internals ──────────────────────────────────────────────────────────────

/** Indexed read that satisfies `noUncheckedIndexedAccess` without `!`. */
function at(words: readonly number[], index: number): number {
  const value = words[index];
  if (value === undefined) throw new Error(`word index ${index} out of bounds`);
  return value;
}

function wordsToView(words: readonly number[]): DataView {
  const view = new DataView(new ArrayBuffer(words.length * 2));
  words.forEach((w, i) => view.setUint16(i * 2, w & 0xffff));
  return view;
}

/** `int(x)` semantics — truncate toward zero, normalizing `-0` to `0` so
 *  strict-equality assertions and React keys behave. */
function truncToward0(x: number): number {
  const t = Math.trunc(x);
  return t === 0 ? 0 : t;
}

function truncScaled(raw: number, scale: number): number {
  return truncToward0(raw * scale);
}

function scaledNumber(
  value: number | boolean | bigint,
  datatype: ModbusDatatype,
  scale: number,
): number {
  const n = typeof value === "bigint" ? Number(value) : typeof value === "boolean" ? +value : value;
  if (!Number.isFinite(n)) {
    throw new Error(`${datatype} value must be a finite number, got ${String(value)}`);
  }
  // `scale == 0` guard mirrors Python: an unset/zero scale writes the value as-is.
  return scale !== 0 && Number.isFinite(scale) ? n / scale : n;
}

function scaledBigInt(
  value: number | boolean | bigint,
  datatype: ModbusDatatype,
  scale: number,
): bigint {
  let scaled: bigint;
  if (typeof value === "bigint" && (scale === 1 || scale === 0)) {
    scaled = value;
  } else {
    scaled = BigInt(truncToward0(scaledNumber(value, datatype, scale)));
  }
  assertInRange(scaled, datatype);
  return scaled;
}

function assertInRange(value: number | bigint, datatype: ModbusDatatype): void {
  const { min, max } = rawRange(datatype);
  const below = typeof value === "bigint" ? value < BigInt(min) : value < Number(min);
  const above = typeof value === "bigint" ? value > BigInt(max) : value > Number(max);
  if (below || above) throw rangeError(value, datatype);
}

function rangeError(value: number | bigint, datatype: ModbusDatatype): Error {
  const { min, max } = rawRange(datatype);
  return new Error(
    `${datatype} register value ${String(value)} is out of range [${String(min)}, ${String(max)}]`,
  );
}
