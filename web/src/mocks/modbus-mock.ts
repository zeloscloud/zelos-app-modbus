/** Standalone-mode mock host for `npm run dev`: a stateful Modbus simulator on
 *  `MockBridge.setInvokeHandler`, so the tab runs in every capability state with
 *  no desktop host or device.
 *
 *  It answers the extension's `Modbus/<method>` actions with the shapes and
 *  in-band `{error, success: false}` failures the extension returns. Device memory
 *  is real and goes through this app's codec, so raw reads decode as they would
 *  against hardware and writes persist. The meter is modeled on the extension's
 *  `demo/power_meter.json`, numbered from address 1. */

import type { MockBridge } from "@zeloscloud/app-extension-sdk";

import {
  MAX_READ_COUNT,
  decodeValue,
  encodeValue,
  isBitTable,
  isModbusDatatype,
  isRegisterTableType,
  wordCount,
} from "@/lib/codec";
import {
  MODBUS_ACTION_PREFIX,
  MODBUS_EXTENSION_ID,
  MODBUS_METHODS,
  REQUIRED_MODBUS_METHODS,
  type ByteOrder,
  type ModbusDatatype,
  type ModbusDeviceEntry,
  type ModbusMethodName,
  type RegisterEntry,
  type RegisterTableType,
  type WireValue,
} from "@/lib/types";

export type MockScenario =
  | "ready"
  | "extension-missing"
  | "extension-stopped"
  | "extension-outdated"
  | "extension-0.1.5"
  | "no-devices"
  | "multi-agent";

interface MockHostOptions {
  /** `"multi-agent"` makes `remote:2300` ready and `localhost` (the local agent's
   *  key, as the real host reports it) missing the extension. */
  scenario?: MockScenario;
}

const TICK_MS = 1_000;

/** How long a freshly started extension runs with no actions registered. Longer
 *  than one 5 s discovery cycle, so the app has to render the state rather than
 *  blink past it. */
export const STARTING_ACTIONS_MS = 6_000;

/** Map address of `status/spare_sensor`, the register that reads NaN. */
const NAN_ADDRESS = 23;

/** The extension's other actions, which this app never calls. */
const OTHER_ACTIONS = [
  "get_status",
  "list_writable_registers",
  "save_map",
  "scan_device",
  "verify_map",
  "auto_config",
  "list_serial_ports",
];

// ─── Fake register map (power_meter shaped) ─────────────────────────────────

interface RegisterDef {
  event: string;
  name: string;
  /** In the map's address base (1). */
  address: number;
  type?: RegisterTableType;
  datatype?: ModbusDatatype;
  unit?: string;
  scale?: number;
  byte_order?: ByteOrder;
  description?: string;
  writable?: boolean;
  /** Seconds; absent takes the device's rate, 0 = not polled. */
  rate?: number;
  /** Seed physical value written into device memory at boot. */
  seed?: number | boolean;
  /** Measurement registers get re-seeded on every tick; config ones don't, so
   *  writes to them stick. */
  live?: (t: number, index: number) => number;
}

const REGISTER_DEFS: RegisterDef[] = [
  // Three-phase measurements — float32 holding registers.
  ...phase("voltage", 1, "V", (t, i) => 230 + 4 * Math.sin(t / 7 + i) + i * 0.4),
  ...phase("current", 7, "A", (t, i) => 5 + 1.5 * Math.sin(t / 5 + i * 2) + i * 0.2),
  {
    event: "power",
    name: "total",
    address: 13,
    datatype: "float32",
    unit: "kW",
    live: (t) => 3.4 + 0.6 * Math.sin(t / 9),
  },
  {
    event: "power",
    name: "factor",
    address: 15,
    datatype: "float32",
    live: (t) => 0.95 + 0.03 * Math.sin(t / 11),
  },
  {
    event: "power",
    name: "frequency",
    address: 17,
    datatype: "float32",
    unit: "Hz",
    live: (t) => 50 + 0.05 * Math.sin(t / 3),
  },
  {
    event: "power",
    name: "energy",
    address: 19,
    datatype: "uint32",
    unit: "Wh",
    live: (t) => 120_000 + Math.floor(t * 3),
  },
  {
    event: "status",
    name: "temperature",
    address: 21,
    datatype: "int16",
    unit: "°C",
    scale: 0.1,
    description: "PCB temperature, 0.1 °C per raw count",
    writable: true,
    live: (t) => 41 + 2 * Math.sin(t / 13),
  },
  {
    event: "status",
    name: "spare_sensor",
    address: NAN_ADDRESS,
    datatype: "float32",
    unit: "°C",
    description: "Unpopulated sensor input — the device reports NaN",
    // Seeded straight into memory as 0xffff 0xffff (see buildMeter): there is no
    // physical value to encode, which is the whole point of this register.
  },
  { event: "status", name: "relay1", address: 1, type: "coil", writable: true, seed: true },
  { event: "status", name: "relay2", address: 2, type: "coil", writable: true, seed: false },
  {
    event: "status",
    name: "alarm",
    address: 3,
    type: "coil",
    description: "Latched fault relay — clear it by writing OFF",
    writable: true,
    seed: false,
  },
  { event: "inputs", name: "firmware_version", address: 1, type: "input", seed: 0x0104 },
  {
    event: "inputs",
    name: "serial_number",
    address: 2,
    type: "input",
    datatype: "uint32",
    seed: 220_417,
  },
  { event: "digital_inputs", name: "door_open", address: 1, type: "discrete_input", seed: false },
  {
    event: "digital_inputs",
    name: "external_fault",
    address: 2,
    type: "discrete_input",
    seed: false,
  },
  {
    event: "digital_inputs",
    name: "grid_connected",
    address: 3,
    type: "discrete_input",
    seed: true,
  },
  {
    event: "setpoints",
    name: "voltage_high_limit",
    address: 101,
    unit: "V",
    writable: true,
    seed: 253,
  },
  {
    event: "setpoints",
    name: "voltage_low_limit",
    address: 102,
    unit: "V",
    writable: true,
    seed: 207,
  },
  {
    event: "setpoints",
    name: "power_limit",
    address: 103,
    datatype: "int32",
    unit: "W",
    writable: true,
    seed: 5_000,
  },
  {
    event: "setpoints",
    name: "energy_reset",
    address: 105,
    datatype: "uint32",
    description: "Write any value to clear the energy counter; never polled",
    writable: true,
    rate: 0,
    seed: 0,
  },
  {
    event: "swapped_floats",
    name: "calibration_factor",
    address: 111,
    datatype: "float32",
    byte_order: "big_swap",
    seed: 1.025,
  },
  {
    event: "swapped_floats",
    name: "offset_value",
    address: 113,
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

/** A `list_registers` row, with `rate` resolved against the device's as the
 *  extension does. Input and discrete tables are read-only whatever the map says. */
function toEntry(def: RegisterDef, deviceRate: number): RegisterEntry {
  const type = def.type ?? "holding";
  return {
    name: def.name,
    event: def.event,
    path: `${def.event}/${def.name}`,
    address: def.address,
    type,
    datatype: def.datatype ?? (isBitTable(type) ? "bool" : "uint16"),
    unit: def.unit ?? "",
    scale: def.scale ?? 1,
    description: def.description ?? "",
    writable: (def.writable ?? false) && type !== "input" && type !== "discrete_input",
    byte_order: def.byte_order ?? "big",
    rate: def.rate ?? deviceRate,
  };
}

// ─── Simulator state ───────────────────────────────────────────────────────

/** Device memory by WIRE address (map address minus the address base). */
interface Memory {
  holding: Map<number, number>;
  input: Map<number, number>;
  coil: Map<number, boolean>;
  discrete_input: Map<number, boolean>;
}

interface SimDevice {
  entry: ModbusDeviceEntry;
  defs: RegisterDef[];
  registers: RegisterEntry[];
  memory: Memory;
  /** Last-polled cache: exactly what get_snapshot serves, `null` values and all. */
  values: Map<string, { value: WireValue; ts_ms: number }>;
  poll_count: number;
}

interface SimAgent {
  address: string;
  extInstalled: boolean;
  extVersion: string;
  extState: "installed" | "running" | "stopped" | "failed";
  /** Whether the running extension registers its actions. */
  registersActions: boolean;
  /** Releases before 0.1.6 serve the same methods under `modbus/`. */
  actionPrefix: string;
  /** Actions this app drives that the extension leaves out. */
  missingMethods: readonly ModbusMethodName[];
  /** While set and in the future, the extension is running but has registered
   *  nothing: the window every real Start passes through. */
  actionsReadyAt: number | null;
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

function buildMeter(): SimDevice {
  const rate = 1;
  const registers = REGISTER_DEFS.map((def) => toEntry(def, rate));
  const device: SimDevice = {
    entry: {
      name: "meter_panel/meter",
      transport: "tcp",
      endpoint: "127.0.0.1:5020",
      connected: true,
      unit_id: 1,
      address_base: 1,
      map_name: "power_meter",
      register_count: registers.length,
      rate,
      write_mode: "auto",
      raw_writes: true,
    },
    defs: REGISTER_DEFS,
    registers,
    memory: emptyMemory(),
    values: new Map(),
    poll_count: 0,
  };
  // Seed device memory, then run one poll sweep so the first snapshot has values.
  REGISTER_DEFS.forEach((def, i) => {
    const entry = registers[i];
    const seeded = def.live ? def.live(0, i) : def.seed;
    if (entry === undefined || seeded === undefined) return;
    writeMemory(device, entry, seeded);
  });
  // status/spare_sensor: all-ones words, i.e. a float32 NaN. `writeMemory` can't
  // put one there (encoding NaN throws, correctly), so the words go in directly.
  const nanWire = NAN_ADDRESS - device.entry.address_base;
  device.memory.holding.set(nanWire, 0xffff);
  device.memory.holding.set(nanWire + 1, 0xffff);
  pollSweep(device, Date.now());
  return device;
}

/** A second device with no register map and raw writes off: read-only raw access. */
function buildProbe(): SimDevice {
  return {
    entry: {
      name: "rs485/probe",
      transport: "rtu",
      endpoint: "/dev/ttyUSB0@9600",
      connected: true,
      unit_id: 3,
      address_base: 1,
      map_name: null,
      register_count: 0,
      rate: 10,
      write_mode: "fc16",
      raw_writes: false,
    },
    defs: [],
    registers: [],
    memory: emptyMemory(),
    values: new Map(),
    poll_count: 0,
  };
}

function buildAgent(address: string, scenario: MockScenario): SimAgent {
  const ready = (): SimAgent => ({
    address,
    extInstalled: true,
    extVersion: "0.2.3",
    extState: "running",
    registersActions: true,
    actionPrefix: MODBUS_ACTION_PREFIX,
    missingMethods: [],
    actionsReadyAt: null,
    devices: new Map(
      [buildMeter(), buildProbe()].map((device) => [device.entry.name, device] as const),
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
        registersActions: false,
        actionPrefix: MODBUS_ACTION_PREFIX,
        missingMethods: [],
        actionsReadyAt: null,
        devices: new Map(),
      };
    case "extension-stopped":
      return { ...ready(), extState: "stopped", registersActions: false };
    case "extension-outdated":
      return { ...ready(), missingMethods: [MODBUS_METHODS.listDevices] };
    case "extension-0.1.5":
      return { ...ready(), extVersion: "0.1.5", actionPrefix: "modbus/" };
    case "no-devices":
      return { ...ready(), devices: new Map() };
  }
}

// ─── Device memory helpers ─────────────────────────────────────────────────

function wordTable(memory: Memory, type: RegisterTableType): Map<number, number> {
  return type === "input" ? memory.input : memory.holding;
}

function bitTable(memory: Memory, type: RegisterTableType): Map<number, boolean> {
  return type === "coil" ? memory.coil : memory.discrete_input;
}

function writeMemory(device: SimDevice, reg: RegisterEntry, value: number | boolean): void {
  const wire = reg.address - device.entry.address_base;
  if (isBitTable(reg.type)) {
    bitTable(device.memory, reg.type).set(wire, Boolean(value));
    return;
  }
  if (!isModbusDatatype(reg.datatype)) return;
  const words = encodeValue(value, reg.datatype, reg.scale, reg.byte_order);
  words.forEach((word, i) => wordTable(device.memory, reg.type).set(wire + i, word));
}

/** Decode one register out of device memory, then sanitize it as the action
 *  boundary does: a non-finite float has no JSON form, so it goes out as `null`. */
function readMemory(device: SimDevice, reg: RegisterEntry): WireValue {
  const wire = reg.address - device.entry.address_base;
  if (isBitTable(reg.type)) return bitTable(device.memory, reg.type).get(wire) ?? false;
  if (!isModbusDatatype(reg.datatype)) return null;
  const words = readRange(device.memory, reg.type, wire, wordCount(reg.datatype));
  const decoded = decodeValue(words as number[], reg.datatype, reg.scale, reg.byte_order);
  const value = typeof decoded === "bigint" ? Number(decoded) : decoded;
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

function readRange(
  memory: Memory,
  type: RegisterTableType,
  wire: number,
  count: number,
): number[] | boolean[] {
  if (isBitTable(type)) {
    const table = bitTable(memory, type);
    return Array.from({ length: count }, (_, i) => table.get(wire + i) ?? false);
  }
  const table = wordTable(memory, type);
  return Array.from({ length: count }, (_, i) => table.get(wire + i) ?? 0);
}

/** One poll cycle over every register the device polls. Rate-0 registers are
 *  skipped, so they never appear in a snapshot until read on demand. */
function pollSweep(device: SimDevice, now: number): void {
  for (const reg of device.registers) {
    if (reg.rate === 0) continue;
    device.values.set(reg.path, { value: readMemory(device, reg), ts_ms: now });
  }
  device.poll_count += 1;
}

/** Advance the simulated device: measurement registers move, configuration
 *  registers (setpoints, coils, calibration) keep whatever was written to them. */
function tick(device: SimDevice, elapsedSeconds: number): void {
  device.defs.forEach((def, i) => {
    const entry = device.registers[i];
    if (!def.live || entry === undefined) return;
    writeMemory(device, entry, def.live(elapsedSeconds, i));
  });
  pollSweep(device, Date.now());
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
        return handleExtensionLifecycle(agentMap, params, "start");
      case "extensions.stop":
        return handleExtensionLifecycle(agentMap, params, "stop");
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
      !a.registersActions || starting
        ? []
        : [
            ...REQUIRED_MODBUS_METHODS.filter((m) => !a.missingMethods.includes(m)),
            ...OTHER_ACTIONS,
          ].map((m) => `${a.actionPrefix}${m}`);
  }
  return out;
}

function handleExtensionLifecycle(
  agentMap: Map<string, SimAgent>,
  params: unknown,
  op: "start" | "stop",
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
    agent.registersActions = true;
    // A real extension is running before it has registered anything, and the
    // gap outlives a poll cycle. Reproduce it, so "starting" is a state the app
    // is actually exercised against instead of a state nobody ever sees.
    agent.actionsReadyAt = Date.now() + STARTING_ACTIONS_MS;
    return { pid: 4321 };
  }
  agent.extState = "stopped";
  agent.registersActions = false;
  agent.actionsReadyAt = null;
  return undefined;
}

// ─── Action dispatch ───────────────────────────────────────────────────────

/** In-band failure, exactly as the extension reports it: the action itself
 *  succeeded, the payload says otherwise. */
function failure(error: string) {
  return { status: "done", result: { error, success: false } };
}

function done<T extends object>(result: T) {
  return { status: "done", result: { ...result, success: true } };
}

/** A write action's result, stamped with its outcome as the extension does. */
function written<T extends object>(result: T) {
  return { status: "done", result: { ...result, success: true, outcome: "ok" } };
}

function refused(error: string) {
  return { status: "done", result: { error, success: false, outcome: "refused" } };
}

function listDevicesResult(agent: SimAgent) {
  const devices = [...agent.devices.values()].map(({ entry, poll_count }) => {
    const [connection = "", name = ""] = entry.name.split("/");
    return {
      ...entry,
      connection,
      device: name,
      successful_reads: poll_count,
      failed_reads: 0,
      trace_path: `Modbus/${entry.name}`,
      error: null,
      map_pending: false,
      auto_scan: null,
      requested_rate: entry.rate,
      achieved_rate: entry.rate,
      overload_pct: 0,
      demoted: false,
      retry_in_s: null,
      tiers: [],
      refused: [],
    };
  });
  return done({ devices, count: devices.length });
}

function snapshotResult(device: SimDevice) {
  const { entry } = device;
  const [connection = ""] = entry.name.split("/");
  return done({
    device: entry.name,
    connection,
    connected: entry.connected,
    transport: entry.transport,
    endpoint: entry.endpoint,
    unit_id: entry.unit_id,
    address_base: entry.address_base,
    poll_count: device.poll_count,
    successful_reads: device.poll_count,
    failed_reads: 0,
    error: null,
    map_pending: false,
    auto_scan: null,
    captured_at_unix_ms: Date.now(),
    values: Object.fromEntries(device.values),
  });
}

/** `address` (and `count`) as the extension's `_wire` checks them: whole numbers,
 *  inside the device's address base. Returns the wire address or an error. */
function wire(device: SimDevice, address: unknown, count: unknown = 1): number | string {
  const a = Number(address);
  const n = Number(count);
  if (!Number.isInteger(a)) return `address ${String(address)} is not an integer`;
  if (!Number.isInteger(n)) return `count ${String(count)} is not an integer`;
  const base = device.entry.address_base;
  const w = a - base;
  if (w < 0 || n < 1 || w + n > 0x10000) {
    return `Address ${a} (count ${n}) is outside ${base}-${0xffff + base} (address base ${base})`;
  }
  return w;
}

/** The extension's raw-write gate: the setting, then any read-only map register
 *  the write would touch. */
function rawWriteRefusal(
  device: SimDevice,
  type: RegisterTableType,
  wire: number,
  count = 1,
): string | null {
  if (!device.entry.raw_writes) {
    return "Raw writes are disabled (advanced.allow_raw_writes); write a register the device map marks writable by name instead";
  }
  const base = device.entry.address_base;
  for (const reg of device.registers) {
    const start = reg.address - base;
    const span =
      isBitTable(reg.type) || !isModbusDatatype(reg.datatype) ? 1 : wordCount(reg.datatype);
    if (reg.type === type && !reg.writable && start < wire + count && wire < start + span) {
      return `Address ${reg.address} is read-only in the device map (${reg.path})`;
    }
  }
  return null;
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

  if (method === MODBUS_METHODS.listDevices) return listDevicesResult(agent);

  const deviceName = typeof args.device === "string" ? args.device : "";
  const device = agent.devices.get(deviceName);
  if (!device) return failure(`Device '${deviceName}' not found`);

  switch (method) {
    case MODBUS_METHODS.getSnapshot:
      return snapshotResult(device);

    case MODBUS_METHODS.listRegisters:
      return done({
        registers: device.registers,
        count: device.registers.length,
        map_name: device.entry.map_name,
      });

    case MODBUS_METHODS.readNamedRegister: {
      const reg = findRegister(device, args.name);
      if (!reg) return failure(`Register '${String(args.name)}' not found`);
      const value = readMemory(device, reg);
      if (value !== null) device.values.set(reg.path, { value, ts_ms: Date.now() });
      return done({
        name: args.name,
        address: reg.address,
        type: reg.type,
        datatype: reg.datatype,
        value,
        unit: reg.unit,
      });
    }

    case MODBUS_METHODS.writeNamedRegister: {
      const reg = findRegister(device, args.name);
      if (!reg) return refused(`Register '${String(args.name)}' not found`);
      if (!reg.writable) {
        return refused(
          `Register '${String(args.name)}' is read-only (the device map does not mark it writable)`,
        );
      }
      const value = Number(args.value);
      if (!Number.isFinite(value)) return refused(`${String(args.value)} is not a finite number`);
      try {
        writeMemory(device, reg, isBitTable(reg.type) ? value !== 0 : value);
      } catch (e) {
        return refused(e instanceof Error ? e.message : String(e));
      }
      const stored = readMemory(device, reg);
      // The extension caches what it wrote, so an unpolled register shows it too.
      device.values.set(reg.path, { value: stored, ts_ms: Date.now() });
      return written({
        name: args.name,
        address: reg.address,
        type: reg.type,
        datatype: reg.datatype,
        value: stored,
        unit: reg.unit,
      });
    }

    case MODBUS_METHODS.readRegister: {
      const type = args.reg_type;
      if (!isRegisterTableType(type)) throw new Error(`mock-host: unknown table ${String(type)}`);
      const count = Number(args.count ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > MAX_READ_COUNT) {
        return failure(`count ${String(args.count)} is outside 1-${MAX_READ_COUNT}`);
      }
      const w = wire(device, args.address, count);
      if (typeof w === "string") return failure(w);
      return done({
        address: Number(args.address),
        type,
        count,
        values: readRange(device.memory, type, w, count),
      });
    }

    case MODBUS_METHODS.writeSingleRegister: {
      const w = wire(device, args.address);
      if (typeof w === "string") return refused(w);
      const word = Number(args.value);
      if (!Number.isInteger(word) || word < -0x8000 || word > 0xffff) {
        return refused(
          `${String(args.value)} is outside 0-65535 (or -32768..-1 as two's complement)`,
        );
      }
      const refusal = rawWriteRefusal(device, "holding", w);
      if (refusal) return refused(refusal);
      device.memory.holding.set(w, word & 0xffff);
      return written({ address: Number(args.address), value: word & 0xffff, function_code: 6 });
    }

    case MODBUS_METHODS.writeRegisters: {
      const text = typeof args.values === "string" ? args.values : "";
      // Python's `int()` takes the whole field or nothing: "12abc" is refused.
      const words = text.split(",").map((v) => (/^[+-]?\d+$/.test(v.trim()) ? Number(v) : NaN));
      if (words.some((v) => !Number.isInteger(v) || v < -0x8000 || v > 0xffff)) {
        return refused("Values must be comma-separated integers");
      }
      const w = wire(device, args.address, words.length);
      if (typeof w === "string") return refused(w);
      const refusal = rawWriteRefusal(device, "holding", w, words.length);
      if (refusal) return refused(refusal);
      const masked = words.map((v) => v & 0xffff);
      masked.forEach((word, i) => device.memory.holding.set(w + i, word));
      return written({
        address: Number(args.address),
        values: masked,
        count: masked.length,
        function_code: 16,
      });
    }

    case MODBUS_METHODS.writeCoil: {
      if (args.value !== "ON" && args.value !== "OFF") {
        return refused(`'${String(args.value)}' is not a coil state (true/false, 0/1, ON/OFF)`);
      }
      const w = wire(device, args.address);
      if (typeof w === "string") return refused(w);
      const refusal = rawWriteRefusal(device, "coil", w);
      if (refusal) return refused(refusal);
      device.memory.coil.set(w, args.value === "ON");
      return written({ address: Number(args.address), value: args.value === "ON" });
    }

    default:
      throw new Error(`mock-host: unknown method "${method}"`);
  }
}

/** By `event/name` path, or a bare name only when exactly one event holds it. */
function findRegister(device: SimDevice, name: unknown): RegisterEntry | undefined {
  if (typeof name !== "string") return undefined;
  const byPath = device.registers.find((r) => r.path === name);
  if (byPath) return byPath;
  const byName = device.registers.filter((r) => r.name === name);
  return byName.length === 1 ? byName[0] : undefined;
}
