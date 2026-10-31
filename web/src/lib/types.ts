/** Wire shapes of the Modbus extension's actions, hand-maintained and snake_case
 *  like the Python return dicts, so the JSON round-trips without translation. */

import type { AppBridgeWorkspaceInfo } from "@zeloscloud/app-extension-sdk";

/** Marketplace-canonical Modbus agent extension ID. */
export const MODBUS_EXTENSION_ID = "zeloscloud.zelos-extension-modbus";

/** Every install ID the agent might surface for the Modbus extension.
 *
 *  `extensions.list` reports the INSTALL ID, which depends on how the user got
 *  the extension onto the agent. Marketplace installs use the canonical id;
 *  `zelos extensions install-local` prefixes `local.` and uses the manifest
 *  `name` slug (so `name = "Modbus"` → `local.modbus`). The capability
 *  resolver treats any of these as "the Modbus extension is present". */
export const MODBUS_EXTENSION_INSTALL_IDS: ReadonlySet<string> = new Set([
  MODBUS_EXTENSION_ID,
  "local.modbus",
]);

/** Action names the Modbus extension registers under `Modbus/`. Every one but
 *  `list_devices` takes a `device` parameter (`<connection>/<device>`). */
export const MODBUS_METHODS = {
  listDevices: "list_devices",
  getSnapshot: "get_snapshot",
  listRegisters: "list_registers",
  readNamedRegister: "read_named_register",
  writeNamedRegister: "write_named_register",
  readRegister: "read_register",
  writeSingleRegister: "write_single_register",
  writeRegisters: "write_registers",
  writeCoil: "write_coil",
} as const;

export type ModbusMethodName = (typeof MODBUS_METHODS)[keyof typeof MODBUS_METHODS];

/** Every action this app drives; a running extension missing one is too old. */
export const REQUIRED_MODBUS_METHODS: readonly ModbusMethodName[] = Object.values(MODBUS_METHODS);

export const MODBUS_ACTION_PREFIX = "Modbus/";

export function modbusActionPath(method: ModbusMethodName): string {
  return `${MODBUS_ACTION_PREFIX}${method}`;
}

// ─── Protocol enums (wire = snake_case strings) ─────────────────────────────

/** Modbus table a register lives in. `coil` / `discrete_input` are
 *  bit-addressable (one address each, boolean values, no word decode). */
export const REGISTER_TYPES = ["holding", "input", "coil", "discrete_input"] as const;
export type RegisterTableType = (typeof REGISTER_TYPES)[number];

/** Bit-addressable tables — values come back as booleans, not 16-bit words. */
export const BIT_REGISTER_TYPES: ReadonlySet<RegisterTableType> = new Set<RegisterTableType>([
  "coil",
  "discrete_input",
]);

export const MODBUS_DATATYPES = [
  "bool",
  "uint16",
  "int16",
  "uint32",
  "int32",
  "float32",
  "uint64",
  "int64",
  "float64",
] as const;
export type ModbusDatatype = (typeof MODBUS_DATATYPES)[number];

export const BYTE_ORDERS = ["big", "little", "big_swap", "little_swap"] as const;
export type ByteOrder = (typeof BYTE_ORDERS)[number];

type ModbusTransport = "tcp" | "rtu";

/** Workspace mode as reported by the host bridge — taken straight from the SDK
 *  rather than restated here, because it is the SDK's bridge shape and not a
 *  frozen Python wire shape like everything else in this file. It stays an open
 *  union (0.2.0 widened `workspace.modeKind`), so any unrecognized future mode is
 *  simply not "LIVE" and disables actions. */
export type WorkspaceModeKind = AppBridgeWorkspaceInfo["modeKind"];

// ─── Modbus/list_devices ────────────────────────────────────────────────────

export interface ModbusDeviceEntry {
  /** `<connection>/<device>`: the value the `device` action parameter takes. */
  name: string;
  transport: ModbusTransport;
  /** `host:port` (TCP) or `port@baud` (RTU). */
  endpoint: string;
  connected: boolean;
  unit_id: number;
  /** Numbering of every address the actions take and return: 1 (default) or 0. */
  address_base: number;
  /** Register-map name, or null without a map (raw only, or auto-scanned). */
  map_name: string | null;
  /** Registers in the map plus any auto-scan has found. */
  register_count: number;
  /** Default poll rate in seconds; 0 = not polled. */
  rate: number;
  write_mode: string;
  /** Whether the raw (address) write actions are allowed. */
  raw_writes: boolean;
}

export interface ListDevicesResult {
  devices: ModbusDeviceEntry[];
  count: number;
  success: boolean;
}

// ─── Modbus/get_snapshot ────────────────────────────────────────────────────

/** A decoded value. `null` is a value JSON can't carry (a NaN or ±Inf off the
 *  wire), which the extension sanitizes at the action boundary. */
export type WireValue = number | boolean | string | null;

export interface SnapshotValue {
  value: WireValue;
  /** Unix epoch ms, agent clock, of the poll that produced this value. */
  ts_ms: number;
}

/** Last-polled cache, no device I/O. Registers never polled or read are absent. */
export interface ModbusSnapshot {
  device: string;
  connected: boolean;
  poll_count: number;
  successful_reads: number;
  failed_reads: number;
  captured_at_unix_ms: number;
  /** Keyed by register path (`"<event>/<name>"`). */
  values: Record<string, SnapshotValue>;
  success: boolean;
}

// ─── Modbus/list_registers ──────────────────────────────────────────────────

/** A map register's datatype: a raw-row datatype, or a string spanning several words. */
type RegisterDatatype = ModbusDatatype | "string";

export interface RegisterEntry {
  name: string;
  event: string;
  /** `"<event>/<name>"`: the key used by snapshots and named read/write. */
  path: string;
  /** In the device's address base. */
  address: number;
  type: RegisterTableType;
  datatype: RegisterDatatype;
  unit: string;
  scale: number;
  description: string;
  writable: boolean;
  byte_order: ByteOrder;
  /** Effective poll rate in seconds; 0 = not polled (never in a snapshot). */
  rate: number;
}

export interface ListRegistersResult {
  registers: RegisterEntry[];
  count: number;
  map_name: string | null;
  success: boolean;
}

// ─── Named register read/write ──────────────────────────────────────────────

/** Decoded and scaled extension-side. */
export interface NamedRegisterResult {
  name: string;
  address: number;
  type: RegisterTableType;
  datatype: RegisterDatatype;
  value: WireValue;
  unit: string;
  success: boolean;
}

// ─── Raw (arbitrary-address) read/write ─────────────────────────────────────

/** Raw words (or bits for the bit tables) — no decode, no scale. */
export interface RawReadResult {
  address: number;
  type: RegisterTableType;
  count: number;
  values: number[] | boolean[];
  success: boolean;
}

export interface WriteSingleRegisterResult {
  address: number;
  value: number;
  /** Always 6 (FC6). */
  function_code: number;
  success: boolean;
}

export interface WriteRegistersResult {
  address: number;
  values: number[];
  count: number;
  /** Always 16 (FC16). */
  function_code: number;
  success: boolean;
}

export interface WriteCoilResult {
  address: number;
  value: boolean;
  success: boolean;
}

// ─── Action envelope ────────────────────────────────────────────────────────

export interface ModbusActionResult<T = unknown> {
  status: "pass" | "fail" | "done" | string;
  result: T;
}

/** Most Modbus action failures come back as status `"done"` with a
 *  `{error, success: false}` payload rather than a failed status, so the
 *  bridge wrapper has to inspect the result body too. */
export interface ModbusErrorPayload {
  error?: string;
  success?: boolean;
}
