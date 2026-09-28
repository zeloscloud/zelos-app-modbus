/** Wire shapes shared by the bridge wrapper, mock host, and capability resolver.
 *
 *  Kept hand-maintained — the agent extension does not yet emit ts-rs bindings
 *  for these shapes. Until it does, the app fixtures and the agent serializer
 *  must stay in lock-step here.
 *
 *  Field naming follows the wire: snake_case. The extension's Python action
 *  signatures + return dicts use snake_case; the app's TS interfaces mirror
 *  that so the JSON round-trips without translation. */

import type { AppBridgeWorkspaceInfo } from "@zeloscloud/app-extension-sdk";

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
 *  single global namespace: every method is `Modbus/<method>` and takes a
 *  `device` parameter (`<connection>/<device>`, the registry key) to select the
 *  target. Use {@link modbusActionPath} to build a full path. */
export const MODBUS_METHODS = {
  listDevices: "list_devices",
  getSnapshot: "get_snapshot",
  getStatus: "get_status",
  listRegisters: "list_registers",
  readNamedRegister: "read_named_register",
  writeNamedRegister: "write_named_register",
  readRegister: "read_register",
  writeSingleRegister: "write_single_register",
  writeRegisters: "write_registers",
  writeCoil: "write_coil",
} as const;

export type ModbusMethodName = (typeof MODBUS_METHODS)[keyof typeof MODBUS_METHODS];

/** Action paths every running Modbus extension must surface before the app
 *  considers it ready. The `Modbus/` namespace and `list_devices` land in
 *  extension 0.1.6. A missing entry means "extension too old", not
 *  "misconfigured". */
export const REQUIRED_MODBUS_METHODS: readonly ModbusMethodName[] = [
  MODBUS_METHODS.listDevices,
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
export const MIN_MODBUS_EXTENSION_VERSION = "0.1.6";

/** Namespace every Modbus action path sits under. */
export const MODBUS_ACTION_PREFIX = "Modbus/";

/** Build the full action path for a given method. */
export function modbusActionPath(method: ModbusMethodName | string): string {
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

/** A catalog register's datatype. `string` spans several registers and is
 *  decoded extension-side only: never raw, never writable. */
export type RegisterDatatype = ModbusDatatype | "string";

export const BYTE_ORDERS = ["big", "little", "big_swap", "little_swap"] as const;
export type ByteOrder = (typeof BYTE_ORDERS)[number];

export type ModbusTransport = "tcp" | "rtu";

/** Per-device address base. User-facing addresses (map entries and raw action
 *  params) are in this base; the extension subtracts it to get the wire address.
 *  1 (holding "1" = wire 0) unless the map sets `address_base: 0`. */
export type AddressBase = 0 | 1;

/** Workspace mode as reported by the host bridge — taken straight from the SDK
 *  rather than restated here, because it is the SDK's bridge shape and not a
 *  frozen Python wire shape like everything else in this file. It stays an open
 *  union (0.2.0 widened `workspace.modeKind`), so any unrecognized future mode is
 *  simply not "LIVE" and disables actions. */
export type WorkspaceModeKind = AppBridgeWorkspaceInfo["modeKind"];

// ─── Modbus/list_devices ────────────────────────────────────────────────────

/** One device (unit ID) on one connection. Devices on a connection share its
 *  link, endpoint and connected state. */
export interface ModbusDeviceEntry extends PollHealth {
  /** Registry key `<connection>/<device>`: exactly what the `device` param takes. */
  name: string;
  /** Connection name (a TCP endpoint or serial port). */
  connection: string;
  /** Device name, unique within its connection. */
  device: string;
  unit_id: number;
  transport: ModbusTransport;
  /** `host:port` (TCP) or `port@baud` (RTU). */
  endpoint: string;
  connected: boolean;
  /** Trace path, e.g. `Modbus/10_0_0_5/unit1`; null before the trace is set up. */
  trace_path: string | null;
  /** Register-map name; null while `map_pending`, after a failed discovery
   *  (`error`), or when the device runs raw-only. */
  map_name: string | null;
  /** 1 for a device with no map. */
  address_base: AddressBase;
  register_count: number;
  /** Default requested poll rate in SECONDS. */
  rate: number;
  write_mode: string;
  /** Raw (address) writes enabled (`advanced.allow_raw_writes`). Raw reads never
   *  need it. */
  raw_writes: boolean;
}

/** One poll tier: the blocks sharing a requested rate. */
export interface PollTier {
  /** Seconds. */
  requested_rate: number;
  /** Seconds; measured mean read interval, null until measured. */
  achieved_rate: number | null;
  /** `100 * (achieved / requested - 1)`, floored at 0; null until measured. */
  overload_pct: number | null;
  blocks: number;
}

/** Poll health, shared by `get_snapshot`, `get_status` and `list_devices` rows.
 *  The headline rate fields describe the WORST tier: highest `overload_pct`
 *  among measured tiers, or the fastest tier while none is measured. */
export interface PollHealth {
  /** Seconds; the worst tier's requested rate, null when nothing is polled. */
  requested_rate: number | null;
  /** Seconds; the worst tier's measured mean read interval, null until measured
   *  and while the link is down. */
  achieved_rate: number | null;
  /** The worst tier's `100 * (achieved / requested - 1)`, floored at 0; null
   *  until measured. */
  overload_pct: number | null;
  /** Every polled tier, sorted by `requested_rate`. */
  tiers: PollTier[];
  /** Reads that returned data. */
  successful_reads: number;
  /** Reads that failed; a timeout counts, and so does each read missed while
   *  the link is down. */
  failed_reads: number;
  /** True while the device is skipped after consecutive timeouts. */
  demoted: boolean;
  /** Seconds until the next probe while demoted, else null. */
  retry_in_s: number | null;
  /** Blocks the device refused with an illegal-address exception: not polled,
   *  retried every 10 min. */
  refused: RefusedBlock[];
  /** Why the device is not polling (register map discovery failed), else null. */
  error: string | null;
  /** Register map still being discovered (e.g. SunSpec). */
  map_pending: boolean;
}

export interface RefusedBlock {
  /** E.g. `"holding 40001-40010"`, in the map's address base. */
  range: string;
  /** Modbus exception code (2 or 3). */
  code: number;
  retry_in_s: number;
}

export interface ListDevicesResult {
  devices: ModbusDeviceEntry[];
  count: number;
  success: boolean;
}

// ─── Modbus/get_snapshot ────────────────────────────────────────────────────

/** A named register's decoded value; `string` only for a `string` register. */
export type NamedValue = number | boolean | string | null;

export interface SnapshotValue {
  /** `null` when the polled value isn't representable in JSON: the extension
   *  sanitizes non-finite floats (a NaN or ±Inf straight off the wire — e.g. a
   *  float32 of all ones from an unpopulated sensor) to null at the action
   *  boundary rather than failing the whole snapshot. The poll succeeded; only
   *  the number is unusable. */
  value: NamedValue;
  /** Unix epoch ms, agent clock, of the poll that produced this value. */
  ts_ms: number;
}

/** Last-polled cache — no device I/O. Registers that were never polled (or
 *  have `rate: 0`) are absent from `values` entirely. */
export interface ModbusSnapshot extends PollHealth {
  /** `<connection>/<device>`. */
  device: string;
  /** Connection name. */
  connection: string;
  connected: boolean;
  transport: ModbusTransport;
  endpoint: string;
  unit_id: number;
  address_base: AddressBase;
  poll_count: number;
  captured_at_unix_ms: number;
  /** Keyed by register path (`"<event>/<name>"`). */
  values: Record<string, SnapshotValue>;
  success: boolean;
}

// ─── Modbus/list_registers ──────────────────────────────────────────────────

export interface RegisterEntry {
  name: string;
  event: string;
  /** `"<event>/<name>"` — the key used by snapshots and named read/write. */
  path: string;
  address: number;
  type: RegisterTableType;
  datatype: RegisterDatatype;
  unit: string;
  scale: number;
  description: string;
  writable: boolean;
  byte_order: ByteOrder;
  /** Effective requested poll rate in seconds, already resolved against the
   *  device default. `0` means not polled (never appears in a snapshot). */
  rate: number;
}

export interface ListRegistersResult {
  registers: RegisterEntry[];
  count: number;
  map_name: string | null;
  success: boolean;
}

// ─── Named register read/write ──────────────────────────────────────────────

/** A write's result (OPC UA Good/Bad/Uncertain): `unknown` = no response, so the
 *  write may have landed; read back before retrying. */
export type WriteOutcome = "ok" | "refused" | "unknown";

/** Decoded + scaled extension-side. `value` is null when the read failed. */
export interface NamedRegisterResult {
  name: string;
  address: number;
  type: RegisterTableType;
  datatype: RegisterDatatype;
  /** `null` alongside `success: true` is a successful read of a value JSON can't
   *  carry — a sanitized non-finite float, exactly as in {@link SnapshotValue}.
   *  It is not a failure, and not the same thing as "never read". */
  value: NamedValue;
  unit: string;
  /** Writes only. */
  outcome?: WriteOutcome | undefined;
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
  outcome: WriteOutcome;
  success: boolean;
}

export interface WriteRegistersResult {
  address: number;
  values: number[];
  count: number;
  /** Always 16 (FC16). */
  function_code: number;
  outcome: WriteOutcome;
  success: boolean;
}

export interface WriteCoilResult {
  address: number;
  value: boolean;
  outcome: WriteOutcome;
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
  /** Write actions only. */
  outcome?: WriteOutcome;
}
