/** Client-side Modbus value codec for raw (arbitrary-address) rows, whose words
 *  the extension returns undecoded.
 *
 *  A port of `zelos_extension_modbus/client.py` (`_reorder_registers`,
 *  `decode_value`, `encode_value`), so a raw read of a mapped address agrees with
 *  that register's named read. Two divergences: an unscaled 64-bit integer stays
 *  a `bigint` all the way to the UI, and an out-of-range encode names the range. */

import {
  BIT_REGISTER_TYPES,
  MODBUS_DATATYPES,
  BYTE_ORDERS,
  REGISTER_TYPES,
  type ByteOrder,
  type ModbusDatatype,
  type RegisterTableType,
} from "./types";
import { errorMessage } from "./utils";

/** A value decoded off the wire. `bigint` only for unscaled 64-bit integers. */
export type DecodedValue = number | boolean | bigint;

/** Number of 16-bit words each datatype occupies. */
const WORD_COUNTS: Readonly<Record<ModbusDatatype, number>> = {
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
 *  extension's action schema declares `maximum=125` for every table, so this is
 *  the tighter of the two. Nothing in the app can exceed it — a row reads one
 *  value, so at most four words — but it is what the mock host validates
 *  against, and what any future multi-value read has to respect. */
export const MAX_READ_COUNT = 125;

const FLOAT32_MAX = 3.4028234663852886e38;

export function wordCount(datatype: ModbusDatatype): number {
  return WORD_COUNTS[datatype];
}

/** The three wire-enum guards take `unknown`: they screen both a `<select>`
 *  value and a field off unvalidated localStorage. */
export function isModbusDatatype(value: unknown): value is ModbusDatatype {
  return typeof value === "string" && (MODBUS_DATATYPES as readonly string[]).includes(value);
}

export function isByteOrder(value: unknown): value is ByteOrder {
  return typeof value === "string" && (BYTE_ORDERS as readonly string[]).includes(value);
}

export function isRegisterTableType(value: unknown): value is RegisterTableType {
  return typeof value === "string" && (REGISTER_TYPES as readonly string[]).includes(value);
}

/** Bit tables carry booleans, one per address — no word decode, no datatype. */
export function isBitTable(table: RegisterTableType): boolean {
  return BIT_REGISTER_TYPES.has(table);
}

/** Modbus only writes two of the four tables: holding registers (FC6/FC16) and
 *  coils (FC5). Input registers and discrete inputs are read-only by protocol,
 *  whatever the device claims. */
export function isWritableTable(table: RegisterTableType): boolean {
  return table === "holding" || table === "coil";
}

/** Does this register carry a single bit? Either the table says so, or a word
 *  register was mapped as `bool`. The write editor turns into a switch for both. */
export function isBooleanRegister(table: RegisterTableType, datatype: ModbusDatatype): boolean {
  return isBitTable(table) || datatype === "bool";
}

/** Map wire words to and from big-endian (ABCD) words; its own inverse.
 *
 *  For bytes A (most significant) to D: big = AB CD, little = DC BA, big_swap =
 *  CD AB, little_swap = BA DC, extended the same way to 64 bits. A single word is
 *  never reordered. */
export function reorderWords(words: readonly number[], byteOrder: ByteOrder): number[] {
  if (words.length <= 1 || byteOrder === "big") return [...words];
  if (byteOrder === "big_swap") return [...words].reverse();
  if (byteOrder === "little_swap") return words.map(swapBytes);
  return [...words].reverse().map(swapBytes);
}

function swapBytes(word: number): number {
  return ((word & 0xff) << 8) | ((word >> 8) & 0xff);
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
  const a = lo * scale;
  const b = hi * scale;
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

/** Decode raw words into a typed, scaled value.
 *
 *  Floats and scaled integers decode to a number; an unscaled integer stays
 *  exact, a 64-bit one as a `bigint`. */
export function decodeValue(
  words: readonly number[],
  datatype: ModbusDatatype,
  scale = 1,
  byteOrder: ByteOrder = "big",
): DecodedValue {
  if (datatype === "bool") return Boolean(at(words, 0));
  const need = wordCount(datatype);
  if (words.length < need) {
    throw new Error(`${datatype} needs ${need} word(s) to decode, got ${words.length}`);
  }
  const view = wordsToView(reorderWords(words.slice(0, need), byteOrder));
  let raw: number | bigint;
  switch (datatype) {
    case "uint16":
      raw = view.getUint16(0);
      break;
    case "int16":
      raw = view.getInt16(0);
      break;
    case "uint32":
      raw = view.getUint32(0);
      break;
    case "int32":
      raw = view.getInt32(0);
      break;
    case "float32":
      raw = view.getFloat32(0);
      break;
    case "float64":
      raw = view.getFloat64(0);
      break;
    case "uint64":
      raw = view.getBigUint64(0);
      break;
    case "int64":
      raw = view.getBigInt64(0);
      break;
  }
  return scale === 1 ? raw : applyScale(Number(raw), scale);
}

/** `raw * scale`, except that a 1/n scale divides by n: 2305 / 10 is exact where
 *  2305 * 0.1 is not. */
function applyScale(raw: number, scale: number): number {
  const inverse = Math.abs(scale) > 0 && Math.abs(scale) < 1 ? Math.round(1 / scale) : 0;
  if (inverse !== 0 && Math.abs(inverse * scale - 1) < 1e-12) return raw / inverse;
  return raw * scale;
}

/** Encode a typed value into raw words: divided by the scale, integers rounded to
 *  nearest (halves up), then reordered. Out of range throws. */
export function encodeValue(
  value: number | boolean | bigint,
  datatype: ModbusDatatype,
  scale = 1,
  byteOrder: ByteOrder = "big",
): number[] {
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
        const n = roundHalfUp(scaled);
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
    return { ok: false, error: errorMessage(e) };
  }
}

/** Integer datatypes hold whole raw counts and nothing else. */
const INTEGER_DATATYPES: ReadonlySet<ModbusDatatype> = new Set<ModbusDatatype>([
  "bool",
  "uint16",
  "int16",
  "uint32",
  "int32",
  "uint64",
  "int64",
]);

const SIXTY_FOUR_BIT: ReadonlySet<ModbusDatatype> = new Set<ModbusDatatype>(["uint64", "int64"]);

/** Largest integer JSON can carry without losing a digit. */
const MAX_EXACT_JSON_INT = BigInt(Number.MAX_SAFE_INTEGER);

/** How a write reaches the device, which decides what it can carry.
 *
 *  - `json`: a named write hands the extension a JSON number and lets it encode.
 *    Above 2^53 that number is already wrong by the time the agent sees it.
 *  - `words`: a raw write is encoded to 16-bit words here, so a `bigint`
 *    round-trips exactly and the datatype's full range is expressible. */
export type WriteWire = "json" | "words";

/** One pass over what the user typed into a write editor: the value to send, or
 *  the reason it can't be sent. Both come from here, so the inline error and the
 *  refusal to write can't disagree — and neither can the codec, which is what
 *  {@link validateWriteValue} asks. An empty draft is neither valid nor an error. */
export function parseWriteDraft(
  draft: string,
  datatype: ModbusDatatype,
  scale: number,
  wire: WriteWire = "words",
): { value: number | bigint | null; error: string | null } {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return { value: null, error: null };

  // A 64-bit integer only survives as a BigInt, and only when nothing scales it.
  if (SIXTY_FOUR_BIT.has(datatype) && scale === 1 && /^[+-]?\d+$/.test(trimmed)) {
    const big = BigInt(trimmed);
    if (wire === "json" && (big > MAX_EXACT_JSON_INT || big < -MAX_EXACT_JSON_INT)) {
      return {
        value: null,
        error: `a named write goes over JSON, which can't carry more than ${MAX_EXACT_JSON_INT} exactly — use a raw row for this`,
      };
    }
    const verdict = validateWriteValue(big, datatype, scale);
    return verdict.ok ? { value: big, error: null } : { value: null, error: verdict.error };
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { value: null, error: "not a number" };
  const verdict = validateWriteValue(parsed, datatype, scale);
  if (!verdict.ok) return { value: null, error: verdict.error };
  const step = stepError(parsed, datatype, scale);
  if (step !== null) return { value: null, error: step };
  return { value: parsed, error: null };
}

/** Refuse a draft the encoder would round, naming what it would write instead,
 *  with the extension's tolerance: exact in raw counts, up to float error in
 *  `value / scale`. A draft the scale makes whole (`100.5` at `×0.1`) passes. */
function stepError(value: number, datatype: ModbusDatatype, scale: number): string | null {
  if (!INTEGER_DATATYPES.has(datatype)) return null;
  const steps = scale === 1 ? value : value / scale;
  const error = Math.abs(steps - Math.floor(steps + 0.5));
  if (error <= Math.max(1e-9, 4 * Number.EPSILON * Math.abs(steps))) return null;
  const writable = decodeValue(encodeValue(value, datatype, scale), datatype, scale);
  return `${formatDecodedValue(value)} is not a whole ${datatype} step — nearest writable value is ${formatDecodedValue(writable)}`;
}

// ─── Formatting / parsing helpers ───────────────────────────────────────────

/** `[0x4048, 0xf5c3]` → `"0x4048 0xf5c3"`. */
export function formatWordsHex(words: readonly number[]): string {
  return words.map((w) => `0x${(w & 0xffff).toString(16).padStart(4, "0")}`).join(" ");
}

/** `101` at base 1 → `"101 (0x0064)"`: the decimal address in the device's
 *  numbering, and the 0-based wire address in hex, as datasheets print it. */
export function formatAddress(address: number, base: number): string {
  return `${address} (0x${(address - base).toString(16).padStart(4, "0")})`;
}

/** A user-entered address in the device's numbering, as {@link formatAddress}
 *  prints it: decimal (`"101"`) is in the device's numbering, and hex (`"0x64"`)
 *  is the 0-based wire address. Null for anything that isn't a whole decimal in
 *  `[0, 65536]` or a hex wire address in `[0, 0xffff]`. */
export function parseAddress(input: string, base: number): number | null {
  const text = input.trim();
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    const wire = Number.parseInt(text.slice(2), 16);
    return wire <= 0xffff ? wire + base : null;
  }
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return value <= 0x10000 ? value : null;
}

/** Can this value be printed, and offered back as a write default?
 *
 *  Two things fail that test and mean the same thing to a user: `null`, which is
 *  what the extension sends when a value isn't JSON-representable, and a
 *  non-finite number, which is what a client-side decode of the same words
 *  produces. Neither is a missing sample — the read happened. */
export function isRepresentable(
  value: DecodedValue | string | null,
): value is DecodedValue | string {
  return value !== null && (typeof value !== "number" || Number.isFinite(value));
}

/** Display form for a decoded value. Booleans read as ON/OFF (the wire idiom
 *  for coils); 64-bit integers stay strings so nothing is rounded on the way
 *  to the DOM. */
export function formatDecodedValue(value: DecodedValue | string): string {
  if (typeof value === "string") return value;
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

/** Nearest whole number, halves up, as the extension's `math.floor(x + 0.5)`;
 *  `-0` normalized to `0`. */
function roundHalfUp(x: number): number {
  const n = Math.floor(x + 0.5);
  return n === 0 ? 0 : n;
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
  return scale === 1 ? n : n / scale;
}

function scaledBigInt(
  value: number | boolean | bigint,
  datatype: ModbusDatatype,
  scale: number,
): bigint {
  const scaled =
    typeof value === "bigint" && scale === 1
      ? value
      : BigInt(roundHalfUp(scaledNumber(value, datatype, scale)));
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
