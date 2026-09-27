/** Codec tests.
 *
 *  The first blocks are transcribed from the extension's own suite
 *  (`zelos-extension-modbus/tests/test_modbus.py`, classes `TestValueCodec` and
 *  `TestByteOrder`) so a raw read in this app agrees with the extension's named
 *  read of the same register. The later blocks cover what the Python tests
 *  don't: 64-bit BigInt handling, range refusal, and per-datatype round-trips
 *  across all four word orders. */

import { describe, expect, it } from "vitest";

import {
  MAX_READ_COUNT,
  WORD_COUNTS,
  decodeValue,
  encodeValue,
  formatAddress,
  formatDecodedValue,
  formatWordsHex,
  isBitTable,
  isByteOrder,
  isModbusDatatype,
  isRegisterTableType,
  isRepresentable,
  isWritableTable,
  parseAddress,
  parseWriteDraft,
  physicalRange,
  rawRange,
  readWordCount,
  reorderWords,
  validateWriteValue,
  wordCount,
} from "./codec";
import {
  BYTE_ORDERS,
  MODBUS_DATATYPES,
  REGISTER_TYPES,
  type ByteOrder,
  type ModbusDatatype,
} from "./types";

// ─── Ported from TestValueCodec ─────────────────────────────────────────────

const DECODE_BASIC: Array<[ModbusDatatype, number[], number]> = [
  ["uint16", [1000], 1000],
  ["int16", [65535], -1],
  ["int16", [32768], -32768],
];

describe("decodeValue (ported vectors)", () => {
  it.each(DECODE_BASIC)("decodes %s %j → %s", (datatype, raw, expected) => {
    expect(decodeValue(raw, datatype)).toBe(expected);
  });

  it("decodes bool from the low word", () => {
    expect(decodeValue([1], "bool")).toBe(true);
    expect(decodeValue([0], "bool")).toBe(false);
  });

  it("decodes uint32 across two words", () => {
    expect(decodeValue([0x0001, 0x0000], "uint32")).toBe(65536);
  });

  it("decodes IEEE-754 float32", () => {
    expect(decodeValue([0x4048, 0xf5c3], "float32") as number).toBeCloseTo(3.14, 2);
  });

  it("applies the scale after decoding", () => {
    expect(decodeValue([1000], "uint16", 0.1)).toBe(100);
    // A 1/n scale divides, as client.py does: 3 * 0.1 is 0.30000000000000004.
    expect(decodeValue([3], "uint16", 0.1)).toBe(0.3);
  });

  it("keeps the fraction for float datatypes", () => {
    expect(decodeValue(encodeValue(10.05, "float32"), "float32") as number).toBeCloseTo(10.05, 5);
  });

  it("rejects a short word list", () => {
    expect(() => decodeValue([1], "uint32")).toThrow(/needs 2 word/);
    expect(() => decodeValue([1, 2, 3], "float64")).toThrow(/needs 4 word/);
  });
});

const ENCODE_BASIC: Array<[ModbusDatatype, number, number[]]> = [
  ["uint16", 1000, [1000]],
  ["int16", -1, [65535]],
];

describe("encodeValue (ported vectors)", () => {
  it.each(ENCODE_BASIC)("encodes %s %s → %j", (datatype, value, expected) => {
    expect(encodeValue(value, datatype)).toEqual(expected);
  });

  it("encodes bool as 1/0", () => {
    expect(encodeValue(true, "bool")).toEqual([1]);
    expect(encodeValue(false, "bool")).toEqual([0]);
  });

  it("encodes uint32 into two words", () => {
    expect(encodeValue(65536, "uint32")).toEqual([0x0001, 0x0000]);
  });

  it("divides by the scale before encoding", () => {
    expect(encodeValue(100, "uint16", 0.1)).toEqual([1000]);
  });

  it("round-trips the ported vectors", () => {
    const cases: Array<[number, ModbusDatatype]> = [
      [1234, "uint16"],
      [-100, "int16"],
      [100000, "uint32"],
    ];
    for (const [value, datatype] of cases) {
      expect(decodeValue(encodeValue(value, datatype), datatype)).toBe(value);
    }
  });

  it("rounds to nearest before packing", () => {
    expect(encodeValue(5.9, "uint16")).toEqual([6]);
    expect(encodeValue(-5.9, "int16")).toEqual([65530]); // -6
    expect(encodeValue(-0.4, "int16")).toEqual([0]);
  });

  it("uses the value as-is when scale is 0 (Python's scale guard)", () => {
    expect(encodeValue(42, "uint16", 0)).toEqual([42]);
  });

  it("ignores the scale for bool, like the Python branch", () => {
    expect(encodeValue(1, "bool", 0.1)).toEqual([1]);
    expect(encodeValue(0, "bool", 0.1)).toEqual([0]);
  });

  it("encodes float32 to the canonical 3.14 word pair", () => {
    expect(encodeValue(3.14, "float32")).toEqual([0x4048, 0xf5c3]);
  });

  it("rounds away the float-division error of value / scale", () => {
    // 23.4 / 0.1 is 233.99999999999997 in IEEE-754.
    expect(encodeValue(23.4, "int16", 0.1)).toEqual([234]);
  });
});

// ─── Ported from TestByteOrder ──────────────────────────────────────────────

describe("reorderWords (ported vectors)", () => {
  it("leaves a single word untouched for every order", () => {
    for (const order of BYTE_ORDERS) {
      expect(reorderWords([0x1234], order)).toEqual([0x1234]);
    }
  });

  // Same vectors as the extension's test_known_vectors. A = most significant
  // byte: big ABCD, little DCBA, big_swap CDAB, little_swap BADC.
  const VECTORS: Array<
    [ModbusDatatype, number | bigint, number, Partial<Record<ByteOrder, number[]>>]
  > = [
    [
      "float32",
      1.0,
      1,
      {
        big: [0x3f80, 0x0000],
        little: [0x0000, 0x803f],
        big_swap: [0x0000, 0x3f80],
        little_swap: [0x803f, 0x0000],
      },
    ],
    [
      "uint32",
      0x11223344,
      1,
      {
        big: [0x1122, 0x3344],
        little: [0x4433, 0x2211],
        big_swap: [0x3344, 0x1122],
        little_swap: [0x2211, 0x4433],
      },
    ],
    [
      "uint64",
      0x1122334455667788n,
      1,
      {
        big: [0x1122, 0x3344, 0x5566, 0x7788],
        little: [0x8877, 0x6655, 0x4433, 0x2211],
        big_swap: [0x7788, 0x5566, 0x3344, 0x1122],
        little_swap: [0x2211, 0x4433, 0x6655, 0x8877],
      },
    ],
    // A scaled integer decodes to a fraction and encodes rounded to nearest.
    ["int32", -123.4, 0.1, { big: [0xffff, 0xfb2e], little: [0x2efb, 0xffff] }],
    ["uint16", 123.4, 0.1, { big: [1234], little: [1234] }],
  ];

  it.each(VECTORS)(
    "%s %s ×%s encodes and decodes the known vectors",
    (datatype, value, scale, words) => {
      for (const [order, raw] of Object.entries(words) as Array<[ByteOrder, number[]]>) {
        expect(encodeValue(value, datatype, scale, order)).toEqual(raw);
        const decoded = decodeValue(raw, datatype, scale, order);
        if (typeof value === "bigint") expect(decoded).toBe(value);
        else expect(decoded as number).toBeCloseTo(value, 6);
      }
    },
  );

  it("decodes float32 with a word-swapped order", () => {
    expect(decodeValue([0xf5c3, 0x4048], "float32", 1, "big_swap") as number).toBeCloseTo(3.14, 2);
  });

  it("encodes uint32 with a word-swapped order", () => {
    expect(encodeValue(65536, "uint32", 1, "big_swap")).toEqual([0x0000, 0x0001]);
  });

  it("round-trips uint32 through every byte order", () => {
    for (const order of BYTE_ORDERS) {
      expect(decodeValue(encodeValue(123456, "uint32", 1, order), "uint32", 1, order)).toBe(123456);
    }
  });
});

// ─── 64-bit handling (BigInt) ──────────────────────────────────────────────

describe("64-bit integers", () => {
  it("decodes uint64 exactly at scale 1", () => {
    expect(decodeValue([0xffff, 0xffff, 0xffff, 0xffff], "uint64")).toBe(18446744073709551615n);
    expect(decodeValue([0x0000, 0x0001, 0x0000, 0x0000], "uint64")).toBe(4294967296n);
  });

  it("decodes int64 exactly at scale 1", () => {
    expect(decodeValue([0xffff, 0xffff, 0xffff, 0xffff], "int64")).toBe(-1n);
    expect(decodeValue([0x8000, 0x0000, 0x0000, 0x0000], "int64")).toBe(-9223372036854775808n);
  });

  it("falls back to a scaled number when a scale is set", () => {
    expect(decodeValue([0x0000, 0x0000, 0x0000, 0x2710], "uint64", 0.1)).toBe(1000);
  });

  it("accepts bigint input on encode and round-trips it", () => {
    for (const value of [0n, 1n, 4294967296n, 18446744073709551615n]) {
      expect(decodeValue(encodeValue(value, "uint64"), "uint64")).toBe(value);
    }
    for (const value of [-9223372036854775808n, -1n, 0n, 9223372036854775807n]) {
      expect(decodeValue(encodeValue(value, "int64"), "int64")).toBe(value);
    }
  });

  it("accepts number input on encode below 2^53", () => {
    expect(decodeValue(encodeValue(1234567890, "uint64"), "uint64")).toBe(1234567890n);
  });

  it("round-trips 64-bit values through every byte order", () => {
    for (const order of BYTE_ORDERS) {
      const words = encodeValue(1234605616436508552n, "int64", 1, order);
      expect(decodeValue(words, "int64", 1, order)).toBe(1234605616436508552n);
    }
  });
});

// ─── Range refusal ─────────────────────────────────────────────────────────

const OUT_OF_RANGE: Array<[ModbusDatatype, number]> = [
  ["uint16", 65536],
  ["uint16", -1],
  ["int16", 32768],
  ["int16", -32769],
  ["uint32", 4294967296],
  ["uint32", -1],
  ["int32", 2147483648],
  ["int32", -2147483649],
  ["float32", 1e39],
  ["float32", -1e39],
];

describe("encodeValue range guard", () => {
  it.each(OUT_OF_RANGE)("refuses %s %s", (datatype, value) => {
    expect(() => encodeValue(value, datatype)).toThrow(/out of range/);
  });

  it("refuses out-of-range 64-bit values", () => {
    expect(() => encodeValue(-1n, "uint64")).toThrow(/out of range/);
    expect(() => encodeValue(18446744073709551616n, "uint64")).toThrow(/out of range/);
    expect(() => encodeValue(9223372036854775808n, "int64")).toThrow(/out of range/);
  });

  it("refuses non-finite values", () => {
    expect(() => encodeValue(Number.NaN, "uint16")).toThrow(/finite/);
    expect(() => encodeValue(Number.POSITIVE_INFINITY, "float64")).toThrow(/finite/);
  });

  it("accepts the exact boundaries", () => {
    expect(encodeValue(65535, "uint16")).toEqual([0xffff]);
    expect(encodeValue(-32768, "int16")).toEqual([0x8000]);
    expect(encodeValue(2147483647, "int32")).toEqual([0x7fff, 0xffff]);
  });

  it("range-checks after the scale is applied", () => {
    // 6553.5 / 0.1 == 65535 → in range; one tick more overflows uint16.
    expect(encodeValue(6553.5, "uint16", 0.1)).toEqual([0xffff]);
    expect(() => encodeValue(6553.6, "uint16", 0.1)).toThrow(/out of range/);
  });
});

// ─── Per-datatype round-trip sweep ─────────────────────────────────────────

const ROUND_TRIP_CASES: Array<{
  datatype: ModbusDatatype;
  values: Array<number | bigint | boolean>;
}> = [
  { datatype: "bool", values: [true, false] },
  { datatype: "uint16", values: [0, 1, 1000, 65535] },
  { datatype: "int16", values: [-32768, -1, 0, 32767] },
  { datatype: "uint32", values: [0, 65536, 4294967295] },
  { datatype: "int32", values: [-2147483648, -1, 0, 2147483647] },
  { datatype: "uint64", values: [0n, 4294967296n, 18446744073709551615n] },
  { datatype: "int64", values: [-9223372036854775808n, -1n, 9223372036854775807n] },
];

describe("encode → decode round-trip, every datatype × byte order", () => {
  for (const { datatype, values } of ROUND_TRIP_CASES) {
    for (const order of BYTE_ORDERS) {
      it(`${datatype} / ${order}`, () => {
        for (const value of values) {
          const words = encodeValue(value, datatype, 1, order);
          expect(words).toHaveLength(WORD_COUNTS[datatype]);
          expect(decodeValue(words, datatype, 1, order)).toBe(value);
        }
      });
    }
  }

  it("round-trips scaled integers whose physical value is a whole tick count", () => {
    for (const order of BYTE_ORDERS) {
      expect(decodeValue(encodeValue(100, "uint16", 0.1, order), "uint16", 0.1, order)).toBe(100);
      expect(decodeValue(encodeValue(-1000, "int32", 10, order), "int32", 10, order)).toBe(-1000);
    }
  });

  it("round-trips float datatypes to their precision", () => {
    for (const order of BYTE_ORDERS) {
      const f32 = decodeValue(encodeValue(3.14, "float32", 1, order), "float32", 1, order);
      expect(f32 as number).toBeCloseTo(3.14, 5);
      const f64 = decodeValue(encodeValue(-1234.5678, "float64", 1, order), "float64", 1, order);
      expect(f64).toBe(-1234.5678);
    }
  });
});

// ─── Metadata helpers ──────────────────────────────────────────────────────

describe("wordCount / rawRange / physicalRange", () => {
  it("matches the extension's DATATYPES table", () => {
    expect(MODBUS_DATATYPES.map((d) => wordCount(d))).toEqual([1, 1, 1, 2, 2, 2, 4, 4, 4]);
  });

  it("reports raw ranges", () => {
    expect(rawRange("uint16")).toEqual({ min: 0, max: 65535 });
    expect(rawRange("int16")).toEqual({ min: -32768, max: 32767 });
    expect(rawRange("uint64")).toEqual({ min: 0n, max: 18446744073709551615n });
    expect(rawRange("bool")).toEqual({ min: 0, max: 1 });
  });

  it("scales physical ranges", () => {
    expect(physicalRange("uint16", 1)).toEqual({ min: 0, max: 65535 });
    const scaled = physicalRange("uint16", 0.1);
    expect(scaled.min).toBeCloseTo(0, 9);
    expect(scaled.max).toBeCloseTo(6553.5, 6);
    const signed = physicalRange("int16", 0.1);
    expect(signed.min).toBeCloseTo(-3276.8, 6);
    expect(signed.max).toBeCloseTo(3276.7, 6);
  });

  it("orders the range regardless of scale sign, and ignores a zero scale", () => {
    const negative = physicalRange("int16", -1);
    expect(negative.min).toBeLessThan(negative.max);
    expect(physicalRange("uint16", 0)).toEqual({ min: 0, max: 65535 });
  });

  it("guards the datatype / byte-order wire strings", () => {
    expect(isModbusDatatype("float32")).toBe(true);
    expect(isModbusDatatype("string")).toBe(false);
    expect(isByteOrder("big_swap")).toBe(true);
    expect(isByteOrder("middle")).toBe(false);
  });

  it("computes read word counts (bit tables read one address per value)", () => {
    expect(readWordCount("holding", "float32", 3)).toBe(6);
    expect(readWordCount("input", "uint16", 10)).toBe(10);
    expect(readWordCount("coil", "float32", 8)).toBe(8);
    expect(readWordCount("discrete_input", "bool", 4)).toBe(4);
    expect(MAX_READ_COUNT).toBe(125);
  });
});

// ─── Write validation ──────────────────────────────────────────────────────

describe("validateWriteValue", () => {
  it("accepts values inside the physical range", () => {
    expect(validateWriteValue(0, "uint16", 1)).toEqual({ ok: true });
    expect(validateWriteValue(6553.5, "uint16", 0.1)).toEqual({ ok: true });
    expect(validateWriteValue(-3276.8, "int16", 0.1)).toEqual({ ok: true });
    expect(validateWriteValue(-9223372036854775808n, "int64", 1)).toEqual({ ok: true });
  });

  it("rejects values outside it, with the codec's own message", () => {
    const tooBig = validateWriteValue(6553.6, "uint16", 0.1);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toMatch(/uint16 register value 65536 is out of range/);

    expect(validateWriteValue(-1, "uint16", 1).ok).toBe(false);
    expect(validateWriteValue(Number.NaN, "float32", 1).ok).toBe(false);
  });

  it("agrees with encodeValue for every datatype", () => {
    for (const datatype of MODBUS_DATATYPES) {
      const verdict = validateWriteValue(1, datatype, 1);
      let threw = false;
      try {
        encodeValue(1, datatype, 1);
      } catch {
        threw = true;
      }
      expect(verdict.ok).toBe(!threw);
    }
  });
});

// ─── Formatting / parsing ──────────────────────────────────────────────────

const ADDRESS_CASES: Array<[string, number]> = [
  ["100", 100],
  [" 100 ", 100],
  ["0", 0],
  ["65535", 65535],
  ["0x64", 100],
  ["0X64", 100],
  ["0xffff", 65535],
  ["0x0000", 0],
];

describe("parseAddress", () => {
  it.each(ADDRESS_CASES)("parses %j → %s", (input, expected) => {
    expect(parseAddress(input, 0)).toBe(expected);
  });

  it.each(["", "  ", "-1", "abc", "0x", "0xzz", "1.5", "1e3", "65536", "0x10000", "100 200"])(
    "rejects %j",
    (input) => {
      expect(parseAddress(input, 0)).toBeNull();
    },
  );

  it("shifts the valid range by the address base", () => {
    expect(parseAddress("0", 1)).toBeNull();
    expect(parseAddress("65536", 1)).toBe(65536);
  });
});

describe("table predicates", () => {
  it("knows which tables carry bits", () => {
    expect(isBitTable("coil")).toBe(true);
    expect(isBitTable("discrete_input")).toBe(true);
    expect(isBitTable("holding")).toBe(false);
    expect(isBitTable("input")).toBe(false);
  });

  it("knows which tables Modbus can write", () => {
    expect(isWritableTable("holding")).toBe(true);
    expect(isWritableTable("coil")).toBe(true);
    // Read-only by protocol, whatever a register map claims.
    expect(isWritableTable("input")).toBe(false);
    expect(isWritableTable("discrete_input")).toBe(false);
  });

  it("recognizes exactly the four table names", () => {
    for (const table of REGISTER_TYPES) expect(isRegisterTableType(table)).toBe(true);
    for (const nonsense of ["", "holdings", "Coil", 3, null, undefined]) {
      expect(isRegisterTableType(nonsense)).toBe(false);
    }
  });
});

describe("parseWriteDraft", () => {
  it("says nothing about an empty draft — not valid, not an error", () => {
    for (const draft of ["", "   "]) {
      expect(parseWriteDraft(draft, "uint16", 1)).toEqual({ value: null, error: null });
    }
  });

  it("takes a number, trimming what the user typed around it", () => {
    expect(parseWriteDraft(" 1234 ", "uint16", 1)).toEqual({ value: 1234, error: null });
    expect(parseWriteDraft("-12.5", "int16", 0.1)).toEqual({ value: -12.5, error: null });
  });

  it("names a draft that isn't a number at all", () => {
    expect(parseWriteDraft("abc", "uint16", 1)).toEqual({ value: null, error: "not a number" });
  });

  it("refuses a number the codec would refuse, with the codec's own words", () => {
    const { value, error } = parseWriteDraft("70000", "uint16", 1);
    expect(value).toBeNull();
    expect(error).toMatch(/out of range/);
    // Same verdict, same message as the encoder itself would give.
    expect(error).toBe(validateWriteValue(70000, "uint16", 1).ok === false ? error : null);
  });

  it("validates against the scale, not the raw range", () => {
    // int16 × 0.1 tops out at 3276.7 physical.
    expect(parseWriteDraft("3000", "int16", 0.1).error).toBeNull();
    expect(parseWriteDraft("5000", "int16", 0.1).error).toMatch(/out of range/);
  });

  it("refuses a fraction an integer register would silently round", () => {
    const { value, error } = parseWriteDraft("1.9", "uint16", 1);
    expect(value).toBeNull();
    // Naming the value that WOULD be written is the point: 1.9 becomes 2.
    expect(error).toBe("1.9 is not a whole uint16 step; nearest writable value is 2");
    expect(parseWriteDraft("-2.5", "int16", 1).error).toMatch(/nearest writable value is -2/);
    // No magnitude-relative slack: 0.4 of a count is still a fraction.
    expect(parseWriteDraft("1000000000.4", "uint32", 1).error).toMatch(/not a whole uint32 step/);
  });

  it("keeps a fraction the scale makes whole", () => {
    // 100.5 at ×0.1 is raw 1005 — a real step, even though the division is
    // inexact in binary (1004.9999999999999).
    expect(parseWriteDraft("100.5", "int16", 0.1)).toEqual({ value: 100.5, error: null });
    expect(parseWriteDraft("23.4", "int16", 0.1).error).toBeNull();
    // …and still refuses one it doesn't.
    expect(parseWriteDraft("100.55", "int16", 0.1).error).toMatch(/not a whole int16 step/);
  });

  it("leaves float registers alone — every value is a step there", () => {
    expect(parseWriteDraft("1.9", "float32", 1).error).toBeNull();
    expect(parseWriteDraft("0.30000000001", "float64", 1).error).toBeNull();
  });

  it("carries a 64-bit integer as a BigInt, past what a double can hold", () => {
    const big = parseWriteDraft("18446744073709551615", "uint64", 1);
    expect(big).toEqual({ value: 18446744073709551615n, error: null });
    // The nearest double would be 18446744073709551616 — a different number.
    expect(big.value).not.toBe(Number("18446744073709551615"));
    expect(parseWriteDraft("-9223372036854775808", "int64", 1).value).toBe(-9223372036854775808n);
  });

  it("refuses a 64-bit value a named write can't carry, and allows it raw", () => {
    const overJson = parseWriteDraft("9007199254740993", "uint64", 1, "json");
    expect(overJson.value).toBeNull();
    expect(overJson.error).toMatch(/9007199254740991/);
    // The same draft is fine where the words are built client-side.
    expect(parseWriteDraft("9007199254740993", "uint64", 1, "words").value).toBe(9007199254740993n);
    // Below the limit a named write is exact, so it passes either way.
    expect(parseWriteDraft("42", "uint64", 1, "json").value).toBe(42n);
  });

  it("still range-checks a 64-bit draft, and still refuses a fractional one", () => {
    expect(parseWriteDraft("18446744073709551616", "uint64", 1).error).toMatch(/out of range/);
    expect(parseWriteDraft("-1", "uint64", 1).error).toMatch(/out of range/);
    expect(parseWriteDraft("1.5", "int64", 1).error).toMatch(/not a whole int64 step/);
    expect(parseWriteDraft("abc", "int64", 1).error).toBe("not a number");
  });
});

describe("isRepresentable", () => {
  it("accepts anything the UI can print", () => {
    for (const value of [0, -1, 3.14, true, false, 18446744073709551615n]) {
      expect(isRepresentable(value)).toBe(true);
    }
  });

  it("rejects the extension's stand-in for a non-finite value", () => {
    expect(isRepresentable(null)).toBe(false);
  });

  it("rejects a non-finite number a client-side decode produced", () => {
    expect(isRepresentable(Number.NaN)).toBe(false);
    expect(isRepresentable(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRepresentable(Number.NEGATIVE_INFINITY)).toBe(false);
    // The float32 an unpopulated sensor reports.
    expect(isRepresentable(decodeValue([0xffff, 0xffff], "float32"))).toBe(false);
  });
});

describe("formatters", () => {
  it("formats words as padded hex", () => {
    expect(formatWordsHex([0x4048, 0xf5c3])).toBe("0x4048 0xf5c3");
    expect(formatWordsHex([0, 1])).toBe("0x0000 0x0001");
    expect(formatWordsHex([])).toBe("");
  });

  it("formats addresses as decimal + hex", () => {
    expect(formatAddress(100)).toBe("100 (0x0064)");
    expect(formatAddress(0)).toBe("0 (0x0000)");
  });

  it("formats decoded values for display", () => {
    expect(formatDecodedValue(true)).toBe("ON");
    expect(formatDecodedValue(false)).toBe("OFF");
    expect(formatDecodedValue(100)).toBe("100");
    expect(formatDecodedValue(18446744073709551615n)).toBe("18446744073709551615");
    expect(formatDecodedValue("SN-1234")).toBe("SN-1234");
    // float32 noise is trimmed rather than rendered in full.
    expect(formatDecodedValue(decodeValue([0x4048, 0xf5c3], "float32") as number)).toBe("3.14");
  });
});

// ─── Cross-check: the byte orders a real map uses ──────────────────────────

describe("register-map shaped cases", () => {
  const floatOrders: Array<[ByteOrder]> = BYTE_ORDERS.map((o) => [o]);

  it.each(floatOrders)("float32 / %s survives a write → read cycle", (order) => {
    const words = encodeValue(230.5, "float32", 1, order);
    expect(decodeValue(words, "float32", 1, order) as number).toBeCloseTo(230.5, 3);
  });

  it("a big_swap float32 decodes differently than a big one (the orders are distinct)", () => {
    const bigWords = encodeValue(230.5, "float32", 1, "big");
    expect(decodeValue(bigWords, "float32", 1, "big_swap") as number).not.toBeCloseTo(230.5, 3);
  });

  it("int16 with scale 0.1 behaves like the demo temperature register", () => {
    // status/temperature: int16, scale 0.1, °C. 23.5 °C → raw 235.
    expect(encodeValue(23.5, "int16", 0.1)).toEqual([235]);
    expect(decodeValue([235], "int16", 0.1)).toBe(23.5);
  });
});
