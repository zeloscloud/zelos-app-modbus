/** Catalog / snapshot / watch-row fixtures shared by the register-table and
 *  register-picker tests. Kept in one place so both suites describe the same
 *  imaginary power meter. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";

import type { ModbusSnapshot, RegisterEntry, SnapshotValue } from "@/lib/types";
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
    poll_interval: null,
    ...overrides,
  };
}

export function snapshot(
  values: Record<string, SnapshotValue>,
  capturedAtUnixMs = 1_700_000_000_000,
): ModbusSnapshot {
  return {
    interface: "meter",
    connected: true,
    transport: "tcp",
    connection: "127.0.0.1:502",
    unit_id: 1,
    poll_count: 42,
    error_count: 0,
    captured_at_unix_ms: capturedAtUnixMs,
    values,
    success: true,
  };
}

/** Ids only have to be unique within one render, so a counter beats a uuid here:
 *  a failing assertion prints `named-3`, not a hex smear. */
let nextId = 0;

/** One named row, optionally carrying a persisted write draft. */
export function namedRow(
  path: string,
  extra: { draft?: string; iface?: string } = {},
): NamedWatchRow {
  return {
    id: `named-${(nextId += 1)}`,
    kind: "named",
    agent: "localhost:2300",
    interface: extra.iface ?? "meter",
    path,
    ...(extra.draft === undefined ? {} : { draft: extra.draft }),
  };
}

/** Named rows in the order given — the table renders insertion order. */
export function watchRows(paths: readonly string[], iface = "meter"): WatchRow[] {
  return paths.map((path) => namedRow(path, { iface }));
}

/** A raw row, defaulting to the shape "Add raw row" creates. */
export function rawRow(overrides: Partial<Omit<RawWatchRow, "id" | "kind">> = {}): RawWatchRow {
  return {
    id: `raw-${(nextId += 1)}`,
    kind: "raw",
    agent: "localhost:2300",
    interface: "meter",
    address: "0",
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
 *  action path (`modbus/write_named_register`) plus its params and returns the
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
