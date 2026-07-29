/** The failure surface: a typed action error keeps its pieces apart, and the
 *  toast description reads the same as it always has — the fields are a better
 *  source for it, not a different one. */

import { describe, expect, it } from "vitest";

import { humanizeActionError } from "./errors";
import { ModbusActionError } from "./modbus-bridge";

describe("ModbusActionError", () => {
  it("reads as one sentence, with the pieces still addressable", () => {
    const failed = new ModbusActionError("read_register", "fail", "Address 70000 out of range");
    expect(failed.message).toBe(
      "Modbus read_register failed: status=fail, Address 70000 out of range",
    );
    expect(failed).toMatchObject({
      name: "ModbusActionError",
      method: "read_register",
      status: "fail",
      detail: "Address 70000 out of range",
    });
    expect(failed).toBeInstanceOf(Error);
  });

  it("drops the comma when there was no detail to give", () => {
    expect(new ModbusActionError("get_snapshot", "error", null).message).toBe(
      "Modbus get_snapshot failed: status=error",
    );
  });

  it("reads differently for the extension's in-band failure channel", () => {
    // status: null means the envelope resolved and the payload said success: false.
    expect(new ModbusActionError("write_coil", null, "unit_id out of range").message).toBe(
      "Modbus write_coil failed: unit_id out of range",
    );
    expect(new ModbusActionError("write_coil", null, null).message).toBe(
      "Modbus write_coil failed: the extension reported success: false",
    );
  });
});

describe("humanizeActionError", () => {
  it("strips the Python framing an agent wraps around its own message", () => {
    const framed = new ModbusActionError(
      "write_named_register",
      "fail",
      "Execution error: Python execution failed: ActionExecutionError: unit_id out of range.",
    );
    expect(humanizeActionError(framed)).toBe("unit_id out of range.");
  });

  it("falls back to the dispatcher's framing when that is all there is", () => {
    const framed = new ModbusActionError("read_register", "fail", "Execution error: timed out");
    expect(humanizeActionError(framed)).toBe("timed out");
  });

  it("shows a clean in-band detail exactly as the extension wrote it", () => {
    // The toast title already says which action failed; repeating it in the
    // description would push the part that matters out of view.
    const bare = new ModbusActionError("write_coil", null, "unit_id out of range");
    expect(humanizeActionError(bare)).toBe("unit_id out of range");
    const notWritable = new ModbusActionError(
      "write_named_register",
      null,
      "Register 'inputs/firmware_version' is not writable (type: input)",
    );
    expect(humanizeActionError(notWritable)).toBe(
      "Register 'inputs/firmware_version' is not writable (type: input)",
    );
  });

  it("falls back to the whole message when a typed failure has no detail", () => {
    expect(humanizeActionError(new ModbusActionError("get_snapshot", "error", null))).toBe(
      "Modbus get_snapshot failed: status=error",
    );
  });

  it("still reads a foreign error, string-parsing and all", () => {
    expect(humanizeActionError(new Error("ActionExecutionError: boom"))).toBe("boom");
    expect(humanizeActionError(new Error("something else"))).toBe("something else");
    expect(humanizeActionError("a bare string")).toBe("a bare string");
  });
});
