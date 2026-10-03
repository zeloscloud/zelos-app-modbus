/** Typed wrapper over the generic `actions.*` bridge method.
 *
 *  Why a wrapper: the SDK facade takes freeform JSON; this file pins the Modbus
 *  action paths and parameter shapes so callers can't pass the wrong action name
 *  or drop required fields. The translation is intentionally thin — no caching,
 *  no retries, no debouncing. Let TanStack Query own those.
 *
 *  Wire model: the Modbus extension exposes a single global action namespace
 *  (`Modbus/get_snapshot`, `Modbus/write_coil`, …). Every per-device action
 *  carries a `device` parameter (`<connection>/<device>`) naming the target;
 *  device discovery is via {@link listDevices}.
 *
 *  Failure model: the extension signals most failures *inside* a successful
 *  action envelope — status stays `"done"` and the payload is
 *  `{error: "...", success: false}`. Hard failures (bad params, exception in the
 *  handler) come back as status `"error"`/`"fail"` with an
 *  `ActionExecutionError: …` string. {@link unwrap} raises on both. */

import { actions, type BridgeTransport } from "@zeloscloud/app-extension-sdk";

import {
  MODBUS_METHODS,
  modbusActionPath,
  type ListDevicesResult,
  type ListRegistersResult,
  type ModbusActionResult,
  type ModbusErrorPayload,
  type ModbusMethodName,
  type ModbusSnapshot,
  type NamedRegisterResult,
  type RawReadResult,
  type RegisterTableType,
  type WriteCoilResult,
  type WriteOutcome,
  type WriteRegistersResult,
  type WriteSingleRegisterResult,
} from "./types";

/** Every device the extension currently has configured on the named agent.
 *  The capability resolver consumes this to enumerate ready targets. */
export async function listDevices(
  bridge: BridgeTransport,
  agent: string,
): Promise<ListDevicesResult> {
  return call<ListDevicesResult>(bridge, agent, MODBUS_METHODS.listDevices, {});
}

/** Last-polled value cache for one device. No device I/O — safe at 1 Hz even
 *  on a slow RTU link. */
export async function getSnapshot(
  bridge: BridgeTransport,
  agent: string,
  device: string,
): Promise<ModbusSnapshot> {
  return call<ModbusSnapshot>(bridge, agent, MODBUS_METHODS.getSnapshot, { device });
}

/** Register catalog for one device. Only changes when the extension restarts
 *  with a different map. */
export async function listRegisters(
  bridge: BridgeTransport,
  agent: string,
  device: string,
): Promise<ListRegistersResult> {
  return call<ListRegistersResult>(bridge, agent, MODBUS_METHODS.listRegisters, {
    device,
  });
}

/** On-demand device read of one mapped register. Decoded + scaled by the
 *  extension, so no client-side codec involvement. */
export async function readNamedRegister(
  bridge: BridgeTransport,
  agent: string,
  device: string,
  /** `"<event>/<name>"`. */
  name: string,
): Promise<NamedRegisterResult> {
  return call<NamedRegisterResult>(bridge, agent, MODBUS_METHODS.readNamedRegister, {
    device,
    name,
  });
}

export async function writeNamedRegister(
  bridge: BridgeTransport,
  agent: string,
  device: string,
  name: string,
  value: number,
): Promise<NamedRegisterResult> {
  return call<NamedRegisterResult>(bridge, agent, MODBUS_METHODS.writeNamedRegister, {
    device,
    name,
    value,
  });
}

/** Raw range read. `count` is a number of ADDRESSES (words for holding/input,
 *  bits for coil/discrete_input) — the caller multiplies by the datatype's word
 *  count. Values come back undecoded. */
export async function readRegister(
  bridge: BridgeTransport,
  agent: string,
  device: string,
  params: { address: number; reg_type: RegisterTableType; count: number },
): Promise<RawReadResult> {
  return call<RawReadResult>(bridge, agent, MODBUS_METHODS.readRegister, {
    device,
    ...params,
  });
}

/** FC6 — one raw holding-register word. */
export async function writeSingleRegister(
  bridge: BridgeTransport,
  agent: string,
  device: string,
  address: number,
  value: number,
): Promise<WriteSingleRegisterResult> {
  return call<WriteSingleRegisterResult>(bridge, agent, MODBUS_METHODS.writeSingleRegister, {
    device,
    address,
    value,
  });
}

/** FC16 — multiple raw holding-register words. The action takes the values as a
 *  COMMA-SEPARATED STRING (it is declared as a text field), not an array. */
export async function writeRegisters(
  bridge: BridgeTransport,
  agent: string,
  device: string,
  address: number,
  values: readonly number[],
): Promise<WriteRegistersResult> {
  return call<WriteRegistersResult>(bridge, agent, MODBUS_METHODS.writeRegisters, {
    device,
    address,
    values: values.map((v) => String(v)).join(","),
  });
}

/** FC5 — one coil. The action takes `"ON"`/`"OFF"`, not a boolean. */
export async function writeCoil(
  bridge: BridgeTransport,
  agent: string,
  device: string,
  address: number,
  value: boolean,
): Promise<WriteCoilResult> {
  return call<WriteCoilResult>(bridge, agent, MODBUS_METHODS.writeCoil, {
    device,
    address,
    value: value ? "ON" : "OFF",
  });
}

// ─── Internals ──────────────────────────────────────────────────────────────

/** A Modbus action that didn't work, with the pieces of the failure kept apart
 *  instead of flattened into prose: the message stays exactly what it always
 *  was, and the failure UX gets fields to read rather than a string to scrape. */
export class ModbusActionError extends Error {
  /** Action name, e.g. `write_named_register`. */
  readonly method: string;
  /** The envelope's status, or null when the envelope resolved and the payload
   *  itself reported `success: false`. */
  readonly status: string | null;
  /** Whatever the agent said about the cause, if it said anything. */
  readonly detail: string | null;
  /** A failed write's outcome: `unknown` may have landed, `refused` did not. */
  readonly outcome: WriteOutcome | null;

  constructor(
    method: string,
    status: string | null,
    detail: string | null,
    outcome: WriteOutcome | null = null,
  ) {
    super(
      status === null
        ? `Modbus ${method} failed: ${detail ?? "the extension reported success: false"}`
        : `Modbus ${method} failed: status=${status}${detail === null ? "" : `, ${detail}`}`,
    );
    this.name = "ModbusActionError";
    this.method = method;
    this.status = status;
    this.detail = detail;
    this.outcome = outcome;
  }
}

async function call<T>(
  bridge: BridgeTransport,
  agent: string,
  method: ModbusMethodName,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await actions.execute<T>(bridge, {
    agent,
    action: modbusActionPath(method),
    params,
  });
  return unwrap(res, method);
}

function unwrap<T>(res: ModbusActionResult<T>, method: string): T {
  if (res.status !== "pass" && res.status !== "done") {
    throw new ModbusActionError(method, res.status, resultDetail(res.result));
  }
  // The extension's own failure channel: a resolved action whose payload says
  // `success: false`. Treat it exactly like a failed status.
  if (res.result !== null && typeof res.result === "object") {
    const payload = res.result as ModbusErrorPayload;
    if (payload.success === false) {
      throw new ModbusActionError(
        method,
        null,
        typeof payload.error === "string" ? payload.error : null,
        payload.outcome ?? null,
      );
    }
  }
  return res.result;
}

/** Pull whatever detail we can off a failed `result` — agents emit different
 *  shapes (a `{reason}` object, a raw string, or just the error dict). Falling
 *  back to JSON.stringify keeps the surface useful when the shape is unfamiliar
 *  so bug reports include the actual failure. */
function resultDetail(result: unknown): string | null {
  if (result !== null && typeof result === "object") {
    if ("error" in result) return nonEmpty(String((result as { error: unknown }).error));
    if ("reason" in result) return nonEmpty(String((result as { reason: unknown }).reason));
    try {
      return nonEmpty(JSON.stringify(result) ?? "");
    } catch {
      return null;
    }
  }
  if (typeof result === "string") return nonEmpty(result);
  return null;
}

function nonEmpty(text: string): string | null {
  return text.length > 0 ? text : null;
}
