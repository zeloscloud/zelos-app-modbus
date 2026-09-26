/** Catalog / snapshot / watch-row fixtures shared by the register-table and
 *  register-picker tests. Kept in one place so both suites describe the same
 *  imaginary power meter. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";

import type { ModbusDeviceEntry, ModbusSnapshot, RegisterEntry, SnapshotValue } from "@/lib/types";
import type { NamedWatchRow, RawWatchRow, WatchRow } from "@/lib/watch-store";

/** A holding-register float by default; `path` is derived from event + name so
 *  callers never have to keep the two in sync. */
export function register(overrides: Partial<RegisterEntry> = {}): RegisterEntry {
  const event = overrides.event ?? "power";
  const name = overrides.name ?? "total";
  return {
    name,
    event,
    path: `${event}/${name}`,
    address: 12,
    type: "holding",
    datatype: "float32",
    unit: "kW",
    scale: 1,
    description: "",
    writable: true,
    byte_order: "big",
    rate: 1,
    ...overrides,
  };
}

export function snapshot(
  values: Record<string, SnapshotValue>,
  capturedAtUnixMs = 1_700_000_000_000,
): ModbusSnapshot {
  return {
    device: "meter_panel/unit1",
    connection: "meter_panel",
    connected: true,
    transport: "tcp",
    endpoint: "127.0.0.1:502",
    unit_id: 1,
    poll_count: 42,
    address_base: 1,
    captured_at_unix_ms: capturedAtUnixMs,
    requested_rate: 1,
    achieved_rate: 1,
    overload_pct: 0,
    tiers: [{ requested_rate: 1, achieved_rate: 1, overload_pct: 0, blocks: 1 }],
    successful_reads: 42,
    failed_reads: 0,
    demoted: false,
    retry_in_s: null,
    values,
    success: true,
  };
}

/** A `list_devices` row: unit1 of a mapped TCP meter by default. */
export function deviceEntry(overrides: Partial<ModbusDeviceEntry> = {}): ModbusDeviceEntry {
  return {
    name: "meter_panel/unit1",
    connection: "meter_panel",
    device: "unit1",
    unit_id: 1,
    transport: "tcp",
    endpoint: "127.0.0.1:5020",
    connected: true,
    trace_path: "Modbus/meter_panel/unit1",
    map_name: "power_meter",
    address_base: 1,
    register_count: 24,
    rate: 1,
    requested_rate: 1,
    achieved_rate: 1,
    overload_pct: 0,
    tiers: [],
    successful_reads: 0,
    failed_reads: 0,
    demoted: false,
    retry_in_s: null,
    write_mode: "auto",
    ...overrides,
  };
}

/** Ids only have to be unique within one render, so a counter beats a uuid here:
 *  a failing assertion prints `named-3`, not a hex smear. */
let nextId = 0;

/** One named row, optionally carrying a persisted write draft. */
export function namedRow(
  path: string,
  extra: { draft?: string; device?: string } = {},
): NamedWatchRow {
  return {
    id: `named-${(nextId += 1)}`,
    kind: "named",
    agent: "localhost:2300",
    device: extra.device ?? "meter_panel/unit1",
    path,
    ...(extra.draft === undefined ? {} : { draft: extra.draft }),
  };
}

/** Named rows in the order given — the table renders insertion order. */
export function watchRows(paths: readonly string[], device = "meter_panel/unit1"): WatchRow[] {
  return paths.map((path) => namedRow(path, { device }));
}

/** A raw row, defaulting to the shape "Add raw row" creates. */
export function rawRow(overrides: Partial<Omit<RawWatchRow, "id" | "kind">> = {}): RawWatchRow {
  return {
    id: `raw-${(nextId += 1)}`,
    kind: "raw",
    agent: "localhost:2300",
    device: "meter_panel/unit1",
    address: "1",
    base: 1,
    table: "holding",
    datatype: "uint16",
    byte_order: "big",
    ...overrides,
  };
}

/** The table only passes the bridge through to the read/write helpers. Left
 *  bare, every call resolves to `{}` — which those helpers reject — which is all
 *  the tests that never fire a read or a write need.
 *
 *  Pass `onExecute` to answer `actions.execute` for real: it receives the Modbus
 *  action path (`Modbus/write_named_register`) plus its params and returns the
 *  action's `result` payload, which the stub wraps in the `status: "done"`
 *  envelope the extension sends. */
export function bridgeStub(
  onExecute?: (action: string, params: Record<string, unknown>) => unknown,
): BridgeTransport {
  return {
    mode: "standalone",
    invoke: (_method: string, payload?: unknown) => {
      if (onExecute === undefined) return Promise.resolve({});
      const { action, params } = (payload ?? {}) as {
        action?: string;
        params?: Record<string, unknown>;
      };
      return Promise.resolve({ status: "done", result: onExecute(action ?? "", params ?? {}) });
    },
    getSnapshot: () => Promise.resolve({}),
    on: () => () => {},
    destroy: () => {},
  } as unknown as BridgeTransport;
}
