/** Wire shapes shared by the bridge wrapper, mock host, and capability resolver.
 *
 *  Kept hand-maintained — the agent extension does not yet emit ts-rs bindings
 *  for these shapes. Until it does, the app fixtures and the agent serializer
 *  must stay in lock-step here.
 *
 *  Field naming follows the wire: snake_case. The extension's Python action
 *  signatures + return dicts use snake_case; the app's TS interfaces mirror
 *  that so the JSON round-trips without translation. */

/** Marketplace-canonical Modbus agent extension ID. The app's manifest
 *  `requires` block pins to this same value. */
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
  "local.zelos-extension-modbus",
]);

/** Bare method names exposed by the Modbus extension. The on-wire surface is a
 *  single global namespace: every method is `modbus/<method>` and takes an
 *  `interface` parameter (the registry key) to select which client to operate
 *  on. Use {@link modbusActionPath} to build a full path. */
export const MODBUS_METHODS = {
  listInterfaces: "list_interfaces",
  getSnapshot: "get_snapshot",
  listRegisters: "list_registers",
  readNamedRegister: "read_named_register",
  writeNamedRegister: "write_named_register",
  readRegister: "read_register",
  writeSingleRegister: "write_single_register",
  writeRegisters: "write_registers",
  writeCoil: "write_coil",
  /** Legacy status action. Superseded by `get_snapshot`, which returns the same
   *  counters plus cached values in one round-trip — the app never calls it. */
  getStatus: "get_status",
} as const;

export type ModbusMethodName = (typeof MODBUS_METHODS)[keyof typeof MODBUS_METHODS];

/** Action paths every running Modbus extension must surface before the app
 *  considers it ready. `list_interfaces`, `get_snapshot` and the enriched
 *  `list_registers` land in extension 0.1.5; the rest have existed since
 *  0.1.x. A missing entry means "extension too old", not "misconfigured". */
export const REQUIRED_MODBUS_METHODS: readonly ModbusMethodName[] = [
  MODBUS_METHODS.listInterfaces,
  MODBUS_METHODS.getSnapshot,
  MODBUS_METHODS.listRegisters,
  MODBUS_METHODS.readNamedRegister,
  MODBUS_METHODS.writeNamedRegister,
  MODBUS_METHODS.readRegister,
  MODBUS_METHODS.writeSingleRegister,
  MODBUS_METHODS.writeRegisters,
  MODBUS_METHODS.writeCoil,
];

/** First extension release carrying the required action set. Used in
 *  remediation copy only — the action-path check above is the real guard. */
export const MIN_MODBUS_EXTENSION_VERSION = "0.1.5";

/** Build the full action path for a given method. */
export function modbusActionPath(method: ModbusMethodName | string): string {
  return `modbus/${method}`;
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

export type ModbusTransport = "tcp" | "rtu";

/** Workspace mode as reported by the host bridge. Open union mirroring the
 *  SDK's forward-compat shape (0.2.0 widened `workspace.modeKind`) — any
 *  unrecognized future mode is simply not "LIVE" and disables actions. */
export type WorkspaceModeKind = "NONE" | "LIVE" | "TRACEPATH" | "TRACE" | (string & {});

// ─── modbus/list_interfaces ─────────────────────────────────────────────────

export interface ModbusInterfaceEntry {
  /** Registry key — exactly the value the `interface` action param accepts. */
  name: string;
  transport: ModbusTransport;
  connected: boolean;
  /** Human-readable endpoint: `host:port` (TCP) or `port@baud` (RTU). */
  connection: string;
  unit_id: number;
  /** Where the interface came from (config file / discovery). */
  source: string;
  /** Register-map name, or null when the interface runs raw-only. */
  map_name: string | null;
  register_count: number;
  /** Default poll cadence in SECONDS. */
  poll_interval: number;
  write_mode: string;
}

export interface ListInterfacesResult {
  interfaces: ModbusInterfaceEntry[];
  count: number;
  success: boolean;
}

// ─── modbus/get_snapshot ────────────────────────────────────────────────────

export interface SnapshotValue {
  value: number | boolean;
  /** Unix epoch ms, agent clock, of the poll that produced this value. */
  ts_ms: number;
}

/** Last-polled cache — no device I/O. Registers that were never polled (or
 *  have `poll_interval: 0`) are absent from `values` entirely. */
export interface ModbusSnapshot {
  interface: string;
  connected: boolean;
  transport: ModbusTransport;
  connection: string;
  unit_id: number;
  poll_count: number;
  error_count: number;
  captured_at_unix_ms: number;
  /** Keyed by register path (`"<event>/<name>"`). */
  values: Record<string, SnapshotValue>;
  success: boolean;
}

// ─── modbus/list_registers ──────────────────────────────────────────────────

export interface RegisterEntry {
  name: string;
  event: string;
  /** `"<event>/<name>"` — the key used by snapshots and named read/write. */
  path: string;
  address: number;
  type: RegisterTableType;
  datatype: ModbusDatatype;
  unit: string;
  scale: number;
  description: string;
  writable: boolean;
  byte_order: ByteOrder;
  /** Seconds. `null` inherits the interface default; `0` disables polling
   *  (the register will never appear in a snapshot). */
  poll_interval: number | null;
}

export interface ListRegistersResult {
  registers: RegisterEntry[];
  count: number;
  map_name: string | null;
}

// ─── Named register read/write ──────────────────────────────────────────────

/** Decoded + scaled extension-side. `value` is null when the read failed. */
export interface NamedRegisterResult {
  name: string;
  address: number;
  type: RegisterTableType;
  datatype: ModbusDatatype;
  value: number | boolean | null;
  unit: string;
  success: boolean;
}

// ─── Raw (arbitrary-address) read/write ─────────────────────────────────────

/** Raw words (or bits for the bit tables) — no decode, no scale. */
export interface RawReadResult {
  address: number;
  type: RegisterTableType;
  count: number;
  values: number[] | boolean[] | null;
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
