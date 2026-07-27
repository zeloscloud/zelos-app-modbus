/** Typed wrapper over the generic `actions.*` bridge method.
 *
 *  Why a wrapper: the SDK facade takes freeform JSON; this file pins the Modbus
 *  action paths and parameter shapes so callers can't pass the wrong action name
 *  or drop required fields. The translation is intentionally thin — no caching,
 *  no retries, no debouncing. Let TanStack Query own those.
 *
 *  Wire model: the Modbus extension exposes a single global action namespace
 *  (`modbus/get_snapshot`, `modbus/write_coil`, …). Every per-interface action
 *  carries an `interface` parameter naming the target client; interface
 *  discovery is via {@link listInterfaces}.
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
  type ListInterfacesResult,
  type ListRegistersResult,
  type ModbusActionResult,
  type ModbusErrorPayload,
  type ModbusMethodName,
  type ModbusSnapshot,
  type NamedRegisterResult,
  type RawReadResult,
  type RegisterTableType,
  type WriteCoilResult,
  type WriteRegistersResult,
  type WriteSingleRegisterResult,
} from "./types";

/** Names of every interface the extension currently has configured on the named
 *  agent. The capability resolver consumes this to enumerate ready targets. */
export async function listInterfaces(
  bridge: BridgeTransport,
  agent: string,
): Promise<ListInterfacesResult> {
  return call<ListInterfacesResult>(bridge, agent, MODBUS_METHODS.listInterfaces, {});
}

/** Last-polled value cache for one interface. No device I/O — safe at 1 Hz even
 *  on a slow RTU link. */
export async function getSnapshot(
  bridge: BridgeTransport,
  agent: string,
  iface: string,
): Promise<ModbusSnapshot> {
  return call<ModbusSnapshot>(bridge, agent, MODBUS_METHODS.getSnapshot, { interface: iface });
}

/** Register catalog for one interface. Only changes when the extension restarts
 *  with a different map. */
export async function listRegisters(
  bridge: BridgeTransport,
  agent: string,
  iface: string,
): Promise<ListRegistersResult> {
  return call<ListRegistersResult>(bridge, agent, MODBUS_METHODS.listRegisters, {
    interface: iface,
  });
}

/** On-demand device read of one mapped register. Decoded + scaled by the
 *  extension, so no client-side codec involvement. */
export async function readNamedRegister(
  bridge: BridgeTransport,
  agent: string,
  iface: string,
  /** `"<event>/<name>"`. */
  name: string,
): Promise<NamedRegisterResult> {
  return call<NamedRegisterResult>(bridge, agent, MODBUS_METHODS.readNamedRegister, {
    interface: iface,
    name,
  });
}

export async function writeNamedRegister(
  bridge: BridgeTransport,
  agent: string,
  iface: string,
  name: string,
  value: number,
): Promise<NamedRegisterResult> {
  return call<NamedRegisterResult>(bridge, agent, MODBUS_METHODS.writeNamedRegister, {
    interface: iface,
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
  iface: string,
  params: { address: number; reg_type: RegisterTableType; count: number },
): Promise<RawReadResult> {
  return call<RawReadResult>(bridge, agent, MODBUS_METHODS.readRegister, {
    interface: iface,
    ...params,
  });
}

/** FC6 — one raw holding-register word. */
export async function writeSingleRegister(
  bridge: BridgeTransport,
  agent: string,
  iface: string,
  address: number,
  value: number,
): Promise<WriteSingleRegisterResult> {
  return call<WriteSingleRegisterResult>(bridge, agent, MODBUS_METHODS.writeSingleRegister, {
    interface: iface,
    address,
    value,
  });
}

/** FC16 — multiple raw holding-register words. The action takes the values as a
 *  COMMA-SEPARATED STRING (it is declared as a text field), not an array. */
export async function writeRegisters(
  bridge: BridgeTransport,
  agent: string,
  iface: string,
  address: number,
  values: readonly number[],
): Promise<WriteRegistersResult> {
  return call<WriteRegistersResult>(bridge, agent, MODBUS_METHODS.writeRegisters, {
    interface: iface,
    address,
    values: values.map((v) => String(v)).join(","),
  });
}

/** FC5 — one coil. The action takes `"ON"`/`"OFF"`, not a boolean. */
export async function writeCoil(
  bridge: BridgeTransport,
  agent: string,
  iface: string,
  address: number,
  value: boolean,
): Promise<WriteCoilResult> {
  return call<WriteCoilResult>(bridge, agent, MODBUS_METHODS.writeCoil, {
    interface: iface,
    address,
    value: value ? "ON" : "OFF",
  });
}

// ─── Internals ──────────────────────────────────────────────────────────────

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
    throw new Error(`Modbus ${method} failed: status=${res.status}${detailSuffix(res.result)}`);
  }
  // The extension's own failure channel: a resolved action whose payload says
  // `success: false`. Treat it exactly like a failed status.
  if (res.result !== null && typeof res.result === "object") {
    const payload = res.result as ModbusErrorPayload;
    if (payload.success === false) {
      const detail = typeof payload.error === "string" ? payload.error : null;
      throw new Error(
        `Modbus ${method} failed: ${detail ?? "the extension reported success: false"}`,
      );
    }
  }
  return res.result;
}

/** Pull whatever detail we can off a failed `result` — agents emit different
 *  shapes (a `{reason}` object, a raw string, or just the error dict). Falling
 *  back to JSON.stringify keeps the surface useful when the shape is unfamiliar
 *  so bug reports include the actual failure. */
function detailSuffix(result: unknown): string {
  let detail: string | null = null;
  if (result !== null && typeof result === "object") {
    if ("error" in result) {
      detail = String((result as { error: unknown }).error);
    } else if ("reason" in result) {
      detail = String((result as { reason: unknown }).reason);
    } else {
      try {
        detail = JSON.stringify(result);
      } catch {
        // ignore
      }
    }
  } else if (typeof result === "string" && result.length > 0) {
    detail = result;
  }
  return detail ? `, ${detail}` : "";
}
