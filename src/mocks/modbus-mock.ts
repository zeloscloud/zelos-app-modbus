/** Standalone-mode mock host for `npm run dev`.
 *
 *  Wires `MockBridge.setInvokeHandler` to a small stateful Modbus simulator so
 *  the app exercises every capability state without a desktop host or a device.
 *
 *  The simulator keeps real device memory (word and bit tables) and drives it
 *  through this app's own codec, so a raw read decodes exactly like it would
 *  against hardware and writes persist into later snapshots and reads. The fake
 *  register map is modeled on the extension's `demo/power_meter.json`.
 *
 *  Memory is keyed by WIRE address. Everything the actions take or report is in
 *  the device's `address_base`, converted exactly as the extension does:
 *  `wire = address - base`. unit1 and the probe use base 1, unit2 base 0.
 *
 *  Action paths land as `Modbus/<method>` to match the real agent — a single
 *  global namespace with the target selected by the `device` parameter
 *  (`<connection>/<device>`). All wire fields are snake_case (mirroring the
 *  Python extension's idiom), and results come back as status `"done"`, with
 *  failures expressed in-band as `{error, success: false}` exactly as the
 *  extension does. */

import type { MockBridge } from "@zeloscloud/app-extension-sdk";

import {
  MAX_READ_COUNT,
  decodeValue,
  encodeValue,
  isBitTable,
  isRegisterTableType,
  maxAddress,
  wordCount,
} from "@/lib/codec";
import {
  MODBUS_EXTENSION_ID,
  MODBUS_ACTION_PREFIX,
  MODBUS_METHODS,
  REQUIRED_MODBUS_METHODS,
  modbusActionPath,
  type AddressBase,
  type ByteOrder,
  type ModbusDatatype,
  type ModbusDeviceEntry,
  type RegisterEntry,
  type RegisterTableType,
} from "@/lib/types";

export type MockScenario =
  | "ready"
  | "extension-missing"
  | "extension-stopped"
  | "extension-outdated"
  | "no-devices"
  | "multi-agent";

export interface MockHostOptions {
  /** Which capability state to simulate. `"multi-agent"` makes `remote:2300`
   *  ready and `localhost` (the local agent's key, as the real host reports it)
   *  missing the extension. */
  scenario?: MockScenario;
}

const TICK_MS = 1_000;

/** How long a freshly started extension runs with no actions registered. Longer
 *  than one 5 s discovery cycle, so the app has to render the state rather than
 *  blink past it. */
export const STARTING_ACTIONS_MS = 6_000;

/** Wire holding address of `status/spare_sensor`, the register that reads NaN. */
const NAN_ADDRESS = 22;

/** Action set advertised by `actions.list`: the current extension, a pre-0.1.6
 *  extension (lowercase `modbus/` namespace, per-interface actions), or nothing. */
type ActionSet = "full" | "legacy" | "none";

const LEGACY_ACTION_PATHS: string[] = [
  "modbus/list_interfaces",
  "modbus/get_status",
  "modbus/get_snapshot",
  "modbus/list_registers",
  "modbus/read_register",
  "modbus/write_single_register",
  "modbus/write_registers",
  "modbus/write_coil",
  "modbus/read_named_register",
  "modbus/write_named_register",
  "modbus/list_writable_registers",
];

// ─── Fake register map (power_meter shaped) ─────────────────────────────────

interface RegisterDef {
  event: string;
  name: string;
  /** Wire address; `list_registers` reports it in the device's base. */
  address: number;
  type?: RegisterTableType;
  datatype?: ModbusDatatype;
  unit?: string;
  scale?: number;
  byte_order?: ByteOrder;
  description?: string;
  /** Seconds; unset polls at the meter's default (1 s), `0` never polls. */
  rate?: number;
  /** Maps are read-only unless a register opts in, as in the extension. */
  writable?: boolean;
  /** Seed physical value written into device memory at boot. */
  seed?: number | boolean;
  /** Measurement registers get re-seeded on every tick; config ones don't, so
   *  writes to them stick. */
  live?: (t: number, index: number) => number;
}

const REGISTER_DEFS: RegisterDef[] = [
  // Three-phase measurements — float32 holding registers.
  ...phase("voltage", 0, "V", (t, i) => 230 + 4 * Math.sin(t / 7 + i) + i * 0.4),
  ...phase("current", 6, "A", (t, i) => 5 + 1.5 * Math.sin(t / 5 + i * 2) + i * 0.2),
  {
    event: "power",
    name: "total",
    address: 12,
    datatype: "float32",
    unit: "kW",
    live: (t) => 3.4 + 0.6 * Math.sin(t / 9),
  },
  {
    event: "power",
    name: "factor",
    address: 14,
    datatype: "float32",
    live: (t) => 0.95 + 0.03 * Math.sin(t / 11),
  },
  {
    event: "power",
    name: "frequency",
    address: 16,
    datatype: "float32",
    unit: "Hz",
    live: (t) => 50 + 0.05 * Math.sin(t / 3),
  },
  {
    event: "power",
    name: "energy",
    address: 18,
    datatype: "uint32",
    unit: "Wh",
    live: (t) => 120_000 + Math.floor(t * 3),
  },
  {
    event: "status",
    name: "temperature",
    address: 20,
    datatype: "int16",
    unit: "°C",
    scale: 0.1,
    description: "PCB temperature, 0.1 °C per raw count",
    live: (t) => 41 + 2 * Math.sin(t / 13),
  },
  {
    event: "status",
    name: "spare_sensor",
    address: 22,
    datatype: "float32",
    unit: "°C",
    description: "Unpopulated sensor input — the device reports NaN",
    // Seeded straight into memory as 0xffff 0xffff (see buildMeter): there is no
    // physical value to encode, which is the whole point of this register.
  },
  { event: "status", name: "relay1", address: 0, type: "coil", writable: true, seed: true },
  { event: "status", name: "relay2", address: 1, type: "coil", writable: true, seed: false },
  {
    event: "status",
    name: "alarm",
    address: 2,
    type: "coil",
    description: "Latched fault relay — clear it by writing OFF",
    writable: true,
    seed: false,
  },
  // Static identity: the slow (60 s) poll tier.
  {
    event: "inputs",
    name: "firmware_version",
    address: 0,
    type: "input",
    rate: 60,
    seed: 0x0104,
  },
  {
    event: "inputs",
    name: "serial_number",
    address: 1,
    type: "input",
    datatype: "uint32",
    rate: 60,
    seed: 220_417,
  },
  { event: "digital_inputs", name: "door_open", address: 0, type: "discrete_input", seed: false },
  {
    event: "digital_inputs",
    name: "external_fault",
    address: 1,
    type: "discrete_input",
    seed: false,
  },
  {
    event: "digital_inputs",
    name: "grid_connected",
    address: 2,
    type: "discrete_input",
    seed: true,
  },
  {
    event: "setpoints",
    name: "voltage_high_limit",
    address: 100,
    unit: "V",
    writable: true,
    seed: 253,
  },
  {
    event: "setpoints",
    name: "voltage_low_limit",
    address: 101,
    unit: "V",
    writable: true,
    seed: 207,
  },
  {
    event: "setpoints",
    name: "power_limit",
    address: 102,
    datatype: "int32",
    unit: "W",
    writable: true,
    seed: 5_000,
  },
  {
    event: "setpoints",
    name: "energy_reset",
    address: 104,
    datatype: "uint32",
    description: "Write any value to clear the energy counter; never polled",
    rate: 0,
    writable: true,
    seed: 0,
  },
  {
    event: "swapped_floats",
    name: "calibration_factor",
    address: 110,
    datatype: "float32",
    byte_order: "big_swap",
    seed: 1.025,
  },
  {
    event: "swapped_floats",
    name: "offset_value",
    address: 112,
    datatype: "float32",
    byte_order: "big_swap",
    writable: true,
    seed: -0.75,
  },
];

function phase(
  event: string,
  baseAddress: number,
  unit: string,
  live: (t: number, index: number) => number,
): RegisterDef[] {
  return ["L1", "L2", "L3"].map((name, i) => ({
    event,
    name,
    address: baseAddress + i * 2,
    datatype: "float32" as ModbusDatatype,
    unit,
    live: (t: number) => live(t, i),
  }));
}

function toEntry(def: RegisterDef, base: AddressBase): SimRegister {
  const type = def.type ?? "holding";
  return {
    name: def.name,
    event: def.event,
    path: `${def.event}/${def.name}`,
    address: def.address + base,
    type,
    datatype: def.datatype ?? (isBitTable(type) ? "bool" : "uint16"),
    unit: def.unit ?? "",
    scale: def.scale ?? 1,
    description: def.description ?? "",
    // Input registers and discrete inputs are read-only per the Modbus spec,
    // and the extension's Register dataclass forces that too.
    writable: def.writable === true && type !== "input" && type !== "discrete_input",
    byte_order: def.byte_order ?? "big",
    rate: def.rate ?? 1,
  };
}

// ─── Simulator state ───────────────────────────────────────────────────────

/** The simulated map has no `string` registers, so its memory codec applies. */
type SimRegister = RegisterEntry & { datatype: ModbusDatatype };

interface Memory {
  holding: Map<number, number>;
  input: Map<number, number>;
  coil: Map<number, boolean>;
  discrete_input: Map<number, boolean>;
}

interface SimDevice {
  entry: ModbusDeviceEntry;
  defs: RegisterDef[];
  registers: SimRegister[];
  memory: Memory;
  /** Last-polled cache — exactly what get_snapshot serves, `null` values and
   *  all. */
  values: Map<string, { value: number | boolean | null; ts_ms: number }>;
  poll_count: number;
  /** Auto-scan only: registers still to be found, one per tick. */
  scanQueue?: RegisterDef[];
}

interface SimAgent {
  address: string;
  extInstalled: boolean;
  extVersion: string;
  extState: "installed" | "running" | "stopped" | "failed";
  actionSet: ActionSet;
  /** While set and in the future, the extension is running but has registered
   *  nothing — the window every real Start passes through. */
  actionsReadyAt: number | null;
  /** Keyed by `<connection>/<device>`. */
  devices: Map<string, SimDevice>;
}

function emptyMemory(): Memory {
  return {
    holding: new Map(),
    input: new Map(),
    coil: new Map(),
    discrete_input: new Map(),
  };
}

function deviceEntry(
  connection: string,
  device: string,
  fields: Omit<
    ModbusDeviceEntry,
    | "name"
    | "connection"
    | "device"
    | "trace_path"
    | "connected"
    | "successful_reads"
    | "failed_reads"
    | "refused"
    | "error"
    | "map_pending"
  >,
): ModbusDeviceEntry {
  const name = `${connection}/${device}`;
  return {
    name,
    connection,
    device,
    connected: true,
    trace_path: `Modbus/${name}`,
    successful_reads: 0,
    failed_reads: 0,
    refused: [],
    error: null,
    map_pending: false,
    ...fields,
  };
}

/** A power meter on the shared TCP connection; each unit has its own memory. */
function buildMeter(unitId: number, base: AddressBase, rawWrites: boolean): SimDevice {
  const registers = REGISTER_DEFS.map((def) => toEntry(def, base));
  const dev: SimDevice = {
    entry: deviceEntry("meter_panel", `unit${unitId}`, {
      unit_id: unitId,
      transport: "tcp",
      endpoint: "127.0.0.1:5020",
      map_name: "power_meter",
      address_base: base,
      register_count: registers.length,
      rate: 1,
      write_mode: "auto",
      raw_writes: rawWrites,
      // Headline = the worst tier: the slow one lags more.
      requested_rate: 60,
      achieved_rate: 63,
      overload_pct: 5,
      tiers: [
        { requested_rate: 1, achieved_rate: 1.02, overload_pct: 2, blocks: 6 },
        { requested_rate: 60, achieved_rate: 63, overload_pct: 5, blocks: 1 },
      ],
      demoted: false,
      retry_in_s: null,
    }),
    defs: REGISTER_DEFS,
    registers,
    memory: emptyMemory(),
    values: new Map(),
    poll_count: 0,
  };
  // Seed device memory, then run one poll sweep so the first snapshot has values.
  // `registers[i]` is built from `REGISTER_DEFS[i]`, above.
  REGISTER_DEFS.forEach((def, i) => {
    const entry = registers[i];
    const seeded = def.live ? def.live(0, i) : def.seed;
    if (entry === undefined || seeded === undefined) return;
    writeMemory(dev, entry, seeded);
  });
  // status/spare_sensor: all-ones words, i.e. a float32 NaN. `writeMemory` can't
  // put one there (encoding NaN throws, correctly), so the words go in directly.
  dev.memory.holding.set(NAN_ADDRESS, 0xffff);
  dev.memory.holding.set(NAN_ADDRESS + 1, 0xffff);
  pollSweep(dev, Date.now());
  return dev;
}

/** A device on a second (serial) connection with no register map: the raw-only
 *  path. */
function buildProbe(): SimDevice {
  return {
    entry: deviceEntry("dev_ttyUSB0", "probe", {
      unit_id: 3,
      transport: "rtu",
      endpoint: "/dev/ttyUSB0@9600",
      map_name: null,
      // No map: the extension's default base.
      address_base: 1,
      register_count: 0,
      rate: 2,
      write_mode: "fc16",
      // Raw-only, so raw writes are the only writes it has.
      raw_writes: true,
      // No registers, so nothing is polled.
      requested_rate: null,
      achieved_rate: null,
      overload_pct: null,
      tiers: [],
      demoted: false,
      retry_in_s: null,
    }),
    defs: [],
    registers: [],
    memory: emptyMemory(),
    values: new Map(),
    poll_count: 0,
  };
}

/** A raw register as auto-scan traces it: its own event, one field named for
 *  its table (`hr_<addr>`, `ir_`, `coil_`, `di_`), read-only. `address` is in base 1, the no-map default. */
function scanned(
  type: RegisterTableType,
  address: number,
  live?: (t: number) => number,
): RegisterDef {
  const [event, field] = {
    holding: ["holding_registers", "hr"],
    input: ["input_registers", "ir"],
    coil: ["coils", "coil"],
    discrete_input: ["discrete_inputs", "di"],
  }[type];
  return {
    event: `${event}/${address}`,
    name: `${field}_${address}`,
    address: address - 1,
    type,
    ...(isBitTable(type) ? { seed: address % 2 === 1 } : { seed: address * 10 }),
    ...(live ? { live } : {}),
  };
}

/** A device with no map that auto-scans: it finds one register per tick, then
 *  reports the scan done. */
function buildScanner(): SimDevice {
  const scanQueue = [
    scanned("holding", 1, (t) => Math.round(500 + 50 * Math.sin(t / 3))),
    scanned("holding", 2),
    scanned("holding", 3),
    scanned("input", 1, (t) => Math.round(t) % 1000),
    scanned("input", 2),
    scanned("coil", 1),
    scanned("coil", 2),
    scanned("discrete_input", 1),
  ];
  return {
    entry: deviceEntry("dev_ttyUSB0", "scanner", {
      unit_id: 4,
      transport: "rtu",
      endpoint: "/dev/ttyUSB0@9600",
      map_name: null,
      address_base: 1,
      register_count: 0,
      rate: 1,
      write_mode: "auto",
      raw_writes: false,
      requested_rate: 1,
      achieved_rate: null,
      overload_pct: null,
      tiers: [],
      demoted: false,
      retry_in_s: null,
      auto_scan: { state: "scanning", table: "holding", found: 0, ignored: 0 },
    }),
    defs: [],
    registers: [],
    memory: emptyMemory(),
    values: new Map(),
    poll_count: 0,
    scanQueue,
  };
}

/** Find the next queued register: trace it, then report progress. */
function scanStep(dev: SimDevice): void {
  const def = dev.scanQueue?.shift();
  if (!def || !dev.scanQueue) return;
  const entry = toEntry(def, dev.entry.address_base);
  dev.defs.push(def);
  dev.registers.push(entry);
  if (def.seed !== undefined) writeMemory(dev, entry, def.seed);
  const next = dev.scanQueue[0];
  dev.entry.register_count = dev.registers.length;
  dev.entry.auto_scan = {
    state: next ? "scanning" : "done",
    table: next ? (next.type ?? "holding") : null,
    found: dev.registers.length,
    ignored: next ? 0 : 2,
  };
}

function buildAgent(address: string, scenario: MockScenario): SimAgent {
  const ready = (): SimAgent => ({
    address,
    extInstalled: true,
    extVersion: "0.1.6",
    extState: "running",
    actionSet: "full",
    actionsReadyAt: null,
    devices: new Map(
      [buildMeter(1, 1, true), buildMeter(2, 0, false), buildProbe(), buildScanner()].map(
        (d) => [d.entry.name, d] as const,
      ),
    ),
  });

  switch (scenario) {
    case "ready":
    case "multi-agent":
      return ready();
    case "extension-missing":
      return {
        address,
        extInstalled: false,
        extVersion: "0.0.0",
        extState: "installed",
        actionSet: "none",
        actionsReadyAt: null,
        devices: new Map(),
      };
    case "extension-stopped":
      return { ...ready(), extState: "stopped", actionSet: "none" };
    case "extension-outdated":
      return { ...ready(), extVersion: "0.1.5", actionSet: "legacy" };
    case "no-devices":
      return { ...ready(), devices: new Map() };
  }
}

// ─── Device memory helpers ─────────────────────────────────────────────────

/** A user-facing address in the device's base → the wire, or null when the
 *  `count` addresses from it leave the wire range (actions.py `_wire`). */
function toWire(dev: SimDevice, address: number, count = 1): number | null {
  const wire = address - dev.entry.address_base;
  return Number.isInteger(wire) && wire >= 0 && wire + count <= 0x10000 ? wire : null;
}

function addressRangeError(dev: SimDevice, address: unknown): string {
  const base = dev.entry.address_base;
  return `Address ${String(address)} out of range ${base}…${maxAddress(base)}`;
}

function writeMemory(dev: SimDevice, reg: SimRegister, value: number | boolean): void {
  const { memory } = dev;
  const wire = reg.address - dev.entry.address_base;
  if (isBitTable(reg.type)) {
    const table = reg.type === "coil" ? memory.coil : memory.discrete_input;
    table.set(wire, Boolean(value));
    return;
  }
  const words = encodeValue(value, reg.datatype, reg.scale, reg.byte_order);
  const table = reg.type === "input" ? memory.input : memory.holding;
  words.forEach((word, i) => table.set(wire + i, word));
}

/** Decode one register out of device memory, the way the extension does — and
 *  then sanitize it the way the extension's action boundary does: a non-finite
 *  float (an unpopulated sensor reading 0xffff 0xffff, say) has no JSON form, so
 *  it goes over the wire as `null` rather than failing the whole action. */
function readMemory(dev: SimDevice, reg: SimRegister): number | boolean | null {
  const { memory } = dev;
  const wire = reg.address - dev.entry.address_base;
  if (isBitTable(reg.type)) {
    const table = reg.type === "coil" ? memory.coil : memory.discrete_input;
    return table.get(wire) ?? false;
  }
  const table = reg.type === "input" ? memory.input : memory.holding;
  const words: number[] = [];
  for (let i = 0; i < wordCount(reg.datatype); i++) {
    words.push(table.get(wire + i) ?? 0);
  }
  const decoded = decodeValue(words, reg.datatype, reg.scale, reg.byte_order);
  const value = typeof decoded === "bigint" ? Number(decoded) : decoded;
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

function readRange(
  memory: Memory,
  type: RegisterTableType,
  address: number,
  count: number,
): number[] | boolean[] {
  if (isBitTable(type)) {
    const table = type === "coil" ? memory.coil : memory.discrete_input;
    const bits: boolean[] = [];
    for (let i = 0; i < count; i++) bits.push(table.get(address + i) ?? false);
    return bits;
  }
  const table = type === "input" ? memory.input : memory.holding;
  const words: number[] = [];
  for (let i = 0; i < count; i++) words.push(table.get(address + i) ?? 0);
  return words;
}

/** One poll cycle: refresh the last-polled cache for every register the
 *  device actually polls. `rate: 0` registers are skipped, so they
 *  never appear in a snapshot — the app has to read them on demand. */
function pollSweep(dev: SimDevice, now: number): void {
  for (const reg of dev.registers) {
    if (reg.rate === 0) continue;
    dev.values.set(reg.path, { value: readMemory(dev, reg), ts_ms: now });
  }
  dev.poll_count += 1;
  if (dev.registers.length > 0) dev.entry.successful_reads += 1;
}

/** Advance the simulated device: measurement registers move, configuration
 *  registers (setpoints, coils, calibration) keep whatever was written to them. */
function tick(dev: SimDevice, elapsedSeconds: number): void {
  scanStep(dev);
  dev.defs.forEach((def, i) => {
    const entry = dev.registers[i];
    if (!def.live || entry === undefined) return;
    writeMemory(dev, entry, def.live(elapsedSeconds, i));
  });
  pollSweep(dev, Date.now());
}

// ─── Install ───────────────────────────────────────────────────────────────

/** Install the mock invoke handler. Returns a teardown function. */
export function installModbusMockHost(bridge: MockBridge, opts: MockHostOptions = {}): () => void {
  const scenario: MockScenario = opts.scenario ?? "ready";
  const agents: SimAgent[] =
    scenario === "multi-agent"
      ? [buildAgent("localhost", "extension-missing"), buildAgent("remote:2300", "ready")]
      : [buildAgent("localhost", scenario)];

  const agentMap = new Map(agents.map((a) => [a.address, a]));
  const startedAt = Date.now();

  const timer = window.setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    for (const agent of agentMap.values()) {
      if (agent.extState !== "running") continue;
      for (const device of agent.devices.values()) tick(device, elapsed);
    }
  }, TICK_MS);

  bridge.setInvokeHandler(async (method, params) => {
    switch (method) {
      case "extensions.list":
        return buildExtensionsList(agentMap);
      case "extensions.start":
        return handleExtensionLifecycle(agentMap, params, "start", scenario);
      case "extensions.stop":
        return handleExtensionLifecycle(agentMap, params, "stop", scenario);
      case "actions.list":
        return buildActionsList(agentMap);
      case "actions.execute":
        return await handleActionExecute(agentMap, params);
      default:
        throw new Error(`mock-host: unknown method "${method}"`);
    }
  });

  return () => {
    window.clearInterval(timer);
    bridge.setInvokeHandler(null);
  };
}

function buildExtensionsList(agentMap: Map<string, SimAgent>) {
  const out: Record<
    string,
    Array<{ id: string; name: string; version: string; state: string }>
  > = {};
  for (const [addr, a] of agentMap) {
    out[addr] = a.extInstalled
      ? [{ id: MODBUS_EXTENSION_ID, name: "Modbus", version: a.extVersion, state: a.extState }]
      : [];
  }
  return out;
}

function buildActionsList(agentMap: Map<string, SimAgent>) {
  const out: Record<string, string[]> = {};
  for (const [addr, a] of agentMap) {
    // Running, but still inside its registration window: the process is up and
    // not one action exists yet.
    const starting = a.actionsReadyAt !== null && Date.now() < a.actionsReadyAt;
    out[addr] =
      a.actionSet === "none" || starting
        ? []
        : a.actionSet === "legacy"
          ? LEGACY_ACTION_PATHS
          : REQUIRED_MODBUS_METHODS.map((m) => modbusActionPath(m));
  }
  return out;
}

function handleExtensionLifecycle(
  agentMap: Map<string, SimAgent>,
  params: unknown,
  op: "start" | "stop",
  scenario: MockScenario,
) {
  if (params === null || typeof params !== "object") {
    throw new Error(`mock-host: ${op} requires { id, agent? }`);
  }
  const { id, agent: agentAddr } = params as { id?: unknown; agent?: unknown };
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`mock-host: ${op} requires non-empty string id`);
  }
  const addr = typeof agentAddr === "string" && agentAddr.length > 0 ? agentAddr : "localhost";
  const agent = agentMap.get(addr);
  if (!agent) throw new Error(`mock-host: unknown agent "${addr}"`);
  if (!agent.extInstalled) {
    throw new Error(`mock-host: extension "${id}" not installed on "${addr}"`);
  }
  if (op === "start") {
    agent.extState = "running";
    agent.actionSet = scenario === "extension-outdated" ? "legacy" : "full";
    // A real extension is running before it has registered anything, and the
    // gap outlives a poll cycle. Reproduce it, so "starting" is a state the app
    // is actually exercised against instead of a state nobody ever sees.
    agent.actionsReadyAt = Date.now() + STARTING_ACTIONS_MS;
    return { pid: 4321 };
  }
  agent.extState = "stopped";
  agent.actionSet = "none";
  agent.actionsReadyAt = null;
  return undefined;
}

// ─── Action dispatch ───────────────────────────────────────────────────────

/** In-band failure, exactly as the extension reports it: the action itself
 *  succeeded, the payload says otherwise. */
function failure(error: string) {
  return { status: "done", result: { error, success: false } };
}

/** A write the extension refused before sending anything. */
function refused(error: string) {
  return { status: "done", result: { error, outcome: "refused", success: false } };
}

function done<T extends object>(result: T) {
  return { status: "done", result: { ...result, success: true } };
}

/** The extension's raw-write gate: `allow_raw_writes`, then no read-only
 *  register of `table` inside `wire .. wire + count`. */
function rawWriteRefusal(
  dev: SimDevice,
  table: RegisterTableType,
  wire: number,
  count: number,
): string | null {
  if (!dev.entry.raw_writes) {
    return "Raw writes are disabled (advanced.allow_raw_writes); write a register the device map marks writable by name instead";
  }
  const base = dev.entry.address_base;
  const hit = dev.registers.find((r) => {
    const start = r.address - base;
    const span = isBitTable(r.type) ? 1 : wordCount(r.datatype);
    return r.type === table && !r.writable && start < wire + count && wire < start + span;
  });
  return hit === undefined
    ? null
    : `Address ${hit.address} is read-only in the device map (${hit.path})`;
}

async function handleActionExecute(agentMap: Map<string, SimAgent>, params: unknown) {
  if (params === null || typeof params !== "object") throw new Error("mock-host: bad params");
  const {
    agent: agentAddr,
    action,
    params: actionParams,
  } = params as { agent: string; action: string; params?: unknown };

  const agent = agentMap.get(agentAddr);
  if (!agent) throw new Error(`mock-host: unknown agent "${agentAddr}"`);
  if (!action.startsWith(MODBUS_ACTION_PREFIX)) {
    throw new Error(`mock-host: action path doesn't start with ${MODBUS_ACTION_PREFIX}: ${action}`);
  }
  const method = action.slice(MODBUS_ACTION_PREFIX.length);
  const args = (actionParams ?? {}) as Record<string, unknown>;

  if (method === MODBUS_METHODS.listDevices) {
    const devices = [...agent.devices.values()].map((d) => d.entry);
    return { status: "done", result: { devices, count: devices.length, success: true } };
  }

  const deviceName = typeof args.device === "string" ? args.device : "";
  const dev = agent.devices.get(deviceName);
  if (!dev) return failure(`Device '${deviceName}' not found`);

  switch (method) {
    case MODBUS_METHODS.getSnapshot: {
      const values: Record<string, { value: number | boolean | null; ts_ms: number }> = {};
      for (const [path, entry] of dev.values) values[path] = entry;
      return {
        status: "done",
        result: {
          device: deviceName,
          connection: dev.entry.connection,
          connected: dev.entry.connected,
          transport: dev.entry.transport,
          endpoint: dev.entry.endpoint,
          unit_id: dev.entry.unit_id,
          address_base: dev.entry.address_base,
          poll_count: dev.poll_count,
          successful_reads: dev.entry.successful_reads,
          failed_reads: dev.entry.failed_reads,
          requested_rate: dev.entry.requested_rate,
          achieved_rate: dev.entry.achieved_rate,
          overload_pct: dev.entry.overload_pct,
          tiers: dev.entry.tiers,
          demoted: dev.entry.demoted,
          retry_in_s: dev.entry.retry_in_s,
          refused: dev.entry.refused,
          error: dev.entry.error,
          map_pending: dev.entry.map_pending,
          auto_scan: dev.entry.auto_scan ?? null,
          captured_at_unix_ms: Date.now(),
          values,
          success: true,
        },
      };
    }

    case MODBUS_METHODS.listRegisters:
      return {
        status: "done",
        result: {
          // A copy: auto-scan grows the list, and the wire never shares it.
          registers: [...dev.registers],
          count: dev.registers.length,
          map_name: dev.entry.map_name,
          success: true,
        },
      };

    case MODBUS_METHODS.readNamedRegister: {
      const reg = findRegister(dev, args.name);
      if (!reg) return failure(`Register '${String(args.name)}' not found`);
      const value = readMemory(dev, reg);
      return done({
        name: reg.path,
        address: reg.address,
        type: reg.type,
        datatype: reg.datatype,
        value,
        unit: reg.unit,
      });
    }

    case MODBUS_METHODS.writeNamedRegister: {
      const reg = findRegister(dev, args.name);
      if (!reg) return refused(`Register '${String(args.name)}' not found`);
      if (!reg.writable) {
        return refused(
          `Register '${reg.path}' is read-only (the device map does not mark it writable)`,
        );
      }
      const value = Number(args.value);
      if (!Number.isFinite(value)) return refused(`Value '${String(args.value)}' is not a number`);
      writeMemory(dev, reg, isBitTable(reg.type) ? value !== 0 : value);
      // Polled registers show the new value on the next sweep; refresh the cache
      // immediately for the ones that are polled so the UI feels live.
      if (reg.rate !== 0) {
        dev.values.set(reg.path, { value: readMemory(dev, reg), ts_ms: Date.now() });
      }
      return done({
        name: reg.path,
        address: reg.address,
        type: reg.type,
        datatype: reg.datatype,
        value,
        unit: reg.unit,
        outcome: "ok",
      });
    }

    case MODBUS_METHODS.readRegister: {
      const address = Number(args.address);
      const count = Number(args.count ?? 1);
      // The extension looks the table up in `READ_METHODS`; an unknown one raises.
      if (!isRegisterTableType(args.reg_type)) {
        throw new Error(`mock-host: unknown reg_type ${String(args.reg_type)}`);
      }
      const type = args.reg_type;
      const wire = toWire(dev, address, count);
      if (wire === null) return failure(addressRangeError(dev, args.address));
      if (!Number.isInteger(count) || count < 1 || count > MAX_READ_COUNT) {
        return failure(`Count ${String(args.count)} out of range 1…${MAX_READ_COUNT}`);
      }
      return {
        status: "done",
        result: {
          address,
          type,
          count,
          values: readRange(dev.memory, type, wire, count),
          success: true,
        },
      };
    }

    case MODBUS_METHODS.writeSingleRegister: {
      const address = Number(args.address);
      const value = Number(args.value);
      if (!Number.isInteger(address) || !Number.isFinite(value)) {
        return refused("write_single_register needs an integer address and numeric value");
      }
      const wire = toWire(dev, address);
      if (wire === null) return refused(addressRangeError(dev, args.address));
      const gate = rawWriteRefusal(dev, "holding", wire, 1);
      if (gate !== null) return refused(gate);
      dev.memory.holding.set(wire, Math.trunc(value) & 0xffff);
      return done({ address, value, function_code: 6, outcome: "ok" });
    }

    case MODBUS_METHODS.writeRegisters: {
      const address = Number(args.address);
      const text = typeof args.values === "string" ? args.values : "";
      // Python's `int()` takes the whole string or nothing — `parseInt` would
      // read "12abc" as 12 and write a word the caller never asked for.
      const fields = text.split(",").map((v) => v.trim());
      const parsed = fields.map((v) =>
        /^[+-]?\d+$/.test(v) ? Number.parseInt(v, 10) : Number.NaN,
      );
      if (!Number.isInteger(address) || parsed.some((v) => !Number.isInteger(v))) {
        return refused("Values must be comma-separated integers");
      }
      const wire = toWire(dev, address, parsed.length);
      if (wire === null) return refused(addressRangeError(dev, args.address));
      const gate = rawWriteRefusal(dev, "holding", wire, parsed.length);
      if (gate !== null) return refused(gate);
      parsed.forEach((word, i) => dev.memory.holding.set(wire + i, word & 0xffff));
      return done({
        address,
        values: parsed,
        count: parsed.length,
        function_code: 16,
        outcome: "ok",
      });
    }

    case MODBUS_METHODS.writeCoil: {
      const address = Number(args.address);
      if (!Number.isInteger(address)) return refused("write_coil needs an integer address");
      const wire = toWire(dev, address);
      if (wire === null) return refused(addressRangeError(dev, args.address));
      const gate = rawWriteRefusal(dev, "coil", wire, 1);
      if (gate !== null) return refused(gate);
      const on = args.value === "ON";
      dev.memory.coil.set(wire, on);
      return done({ address, value: on, outcome: "ok" });
    }

    default:
      throw new Error(`mock-host: unknown method "${method}"`);
  }
}

function findRegister(dev: SimDevice, name: unknown): SimRegister | undefined {
  if (typeof name !== "string") return undefined;
  return dev.registers.find((r) => r.path === name || r.name === name);
}
