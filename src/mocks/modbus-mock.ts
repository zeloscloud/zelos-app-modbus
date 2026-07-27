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
 *  Action paths land as `modbus/<method>` to match the real agent — a single
 *  global namespace with the target selected by the `interface` parameter. All
 *  wire fields are snake_case (mirroring the Python extension's idiom), and
 *  results come back as status `"done"`, with failures expressed in-band as
 *  `{error, success: false}` exactly as the extension does. */

import type { MockBridge } from "@zeloscloud/app-extension-sdk";

import { decodeValue, encodeValue, isBitTable, wordCount } from "@/lib/codec";
import {
  MODBUS_EXTENSION_ID,
  MODBUS_METHODS,
  REQUIRED_MODBUS_METHODS,
  type ByteOrder,
  type ModbusDatatype,
  type ModbusInterfaceEntry,
  type RegisterEntry,
  type RegisterTableType,
} from "@/lib/types";

export type MockScenario =
  | "ready"
  | "extension-missing"
  | "extension-stopped"
  | "extension-outdated"
  | "no-interfaces"
  | "multi-agent";

export interface MockHostOptions {
  /** Which capability state to simulate. `"multi-agent"` makes `remote:2300`
   *  ready and `localhost:2300` missing the extension. */
  scenario?: MockScenario;
}

const TICK_MS = 1_000;

/** Action set advertised by `actions.list`: the current extension, a 0.1.4-era
 *  extension (no list_interfaces / get_snapshot / list_registers), or nothing. */
type ActionSet = "full" | "legacy" | "none";

const LEGACY_ACTIONS: string[] = [
  MODBUS_METHODS.getStatus,
  MODBUS_METHODS.readRegister,
  MODBUS_METHODS.writeSingleRegister,
  MODBUS_METHODS.writeRegisters,
  MODBUS_METHODS.writeCoil,
  MODBUS_METHODS.readNamedRegister,
  MODBUS_METHODS.writeNamedRegister,
  "list_writable_registers",
];

// ─── Fake register map (power_meter shaped) ─────────────────────────────────

interface RegisterDef {
  event: string;
  name: string;
  address: number;
  type?: RegisterTableType;
  datatype?: ModbusDatatype;
  unit?: string;
  scale?: number;
  byte_order?: ByteOrder;
  description?: string;
  poll_interval?: number | null;
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
  { event: "status", name: "relay1", address: 0, type: "coil", seed: true },
  { event: "status", name: "relay2", address: 1, type: "coil", seed: false },
  {
    event: "status",
    name: "alarm",
    address: 2,
    type: "coil",
    description: "Latched fault relay — clear it by writing OFF",
    seed: false,
  },
  { event: "inputs", name: "firmware_version", address: 0, type: "input", seed: 0x0104 },
  {
    event: "inputs",
    name: "serial_number",
    address: 1,
    type: "input",
    datatype: "uint32",
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
  { event: "setpoints", name: "voltage_high_limit", address: 100, unit: "V", seed: 253 },
  { event: "setpoints", name: "voltage_low_limit", address: 101, unit: "V", seed: 207 },
  {
    event: "setpoints",
    name: "power_limit",
    address: 102,
    datatype: "int32",
    unit: "W",
    seed: 5_000,
  },
  {
    event: "setpoints",
    name: "energy_reset",
    address: 104,
    datatype: "uint32",
    description: "Write any value to clear the energy counter; never polled",
    poll_interval: 0,
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

function toEntry(def: RegisterDef): RegisterEntry {
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
    // Input registers and discrete inputs are read-only per the Modbus spec,
    // and the extension's Register dataclass forces that too.
    writable: type !== "input" && type !== "discrete_input",
    byte_order: def.byte_order ?? "big",
    poll_interval: def.poll_interval ?? null,
  };
}

// ─── Simulator state ───────────────────────────────────────────────────────

interface Memory {
  holding: Map<number, number>;
  input: Map<number, number>;
  coil: Map<number, boolean>;
  discrete_input: Map<number, boolean>;
}

interface SimInterface {
  entry: ModbusInterfaceEntry;
  defs: RegisterDef[];
  registers: RegisterEntry[];
  memory: Memory;
  /** Last-polled cache — exactly what get_snapshot serves. */
  values: Map<string, { value: number | boolean; ts_ms: number }>;
  poll_count: number;
  error_count: number;
}

interface SimAgent {
  address: string;
  extInstalled: boolean;
  extVersion: string;
  extState: "installed" | "running" | "stopped" | "failed";
  actionSet: ActionSet;
  interfaces: Map<string, SimInterface>;
}

function emptyMemory(): Memory {
  return {
    holding: new Map(),
    input: new Map(),
    coil: new Map(),
    discrete_input: new Map(),
  };
}

function buildMeter(): SimInterface {
  const registers = REGISTER_DEFS.map(toEntry);
  const iface: SimInterface = {
    entry: {
      name: "meter",
      transport: "tcp",
      connected: true,
      connection: "127.0.0.1:5020",
      unit_id: 1,
      source: "config.json",
      map_name: "power_meter",
      register_count: registers.length,
      poll_interval: 1,
      write_mode: "auto",
    },
    defs: REGISTER_DEFS,
    registers,
    memory: emptyMemory(),
    values: new Map(),
    poll_count: 0,
    error_count: 0,
  };
  // Seed device memory, then run one poll sweep so the first snapshot has values.
  REGISTER_DEFS.forEach((def, i) => {
    const entry = toEntry(def);
    const seeded = def.live ? def.live(0, i) : def.seed;
    if (seeded === undefined) return;
    writeMemory(iface.memory, entry, seeded);
  });
  pollSweep(iface, Date.now());
  return iface;
}

/** A second interface with no register map — the raw-only path. */
function buildProbe(): SimInterface {
  return {
    entry: {
      name: "probe",
      transport: "rtu",
      connected: true,
      connection: "/dev/ttyUSB0@9600",
      unit_id: 3,
      source: "config.json",
      map_name: null,
      register_count: 0,
      poll_interval: 2,
      write_mode: "fc16",
    },
    defs: [],
    registers: [],
    memory: emptyMemory(),
    values: new Map(),
    poll_count: 0,
    error_count: 0,
  };
}

function buildAgent(address: string, scenario: MockScenario): SimAgent {
  const ready = (): SimAgent => ({
    address,
    extInstalled: true,
    extVersion: "0.1.5",
    extState: "running",
    actionSet: "full",
    interfaces: new Map([
      ["meter", buildMeter()],
      ["probe", buildProbe()],
    ]),
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
        interfaces: new Map(),
      };
    case "extension-stopped":
      return { ...ready(), extState: "stopped", actionSet: "none" };
    case "extension-outdated":
      return { ...ready(), extVersion: "0.1.4", actionSet: "legacy" };
    case "no-interfaces":
      return { ...ready(), interfaces: new Map() };
  }
}

// ─── Device memory helpers ─────────────────────────────────────────────────

function writeMemory(memory: Memory, reg: RegisterEntry, value: number | boolean): void {
  if (isBitTable(reg.type)) {
    const table = reg.type === "coil" ? memory.coil : memory.discrete_input;
    table.set(reg.address, Boolean(value));
    return;
  }
  const words = encodeValue(value, reg.datatype, reg.scale, reg.byte_order);
  const table = reg.type === "input" ? memory.input : memory.holding;
  words.forEach((word, i) => table.set(reg.address + i, word));
}

function readMemory(memory: Memory, reg: RegisterEntry): number | boolean {
  if (isBitTable(reg.type)) {
    const table = reg.type === "coil" ? memory.coil : memory.discrete_input;
    return table.get(reg.address) ?? false;
  }
  const table = reg.type === "input" ? memory.input : memory.holding;
  const words: number[] = [];
  for (let i = 0; i < wordCount(reg.datatype); i++) {
    words.push(table.get(reg.address + i) ?? 0);
  }
  const decoded = decodeValue(words, reg.datatype, reg.scale, reg.byte_order);
  return typeof decoded === "bigint" ? Number(decoded) : decoded;
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
 *  interface actually polls. `poll_interval: 0` registers are skipped, so they
 *  never appear in a snapshot — the app has to read them on demand. */
function pollSweep(iface: SimInterface, now: number): void {
  for (const reg of iface.registers) {
    if (reg.poll_interval === 0) continue;
    iface.values.set(reg.path, { value: readMemory(iface.memory, reg), ts_ms: now });
  }
  iface.poll_count += 1;
}

/** Advance the simulated device: measurement registers move, configuration
 *  registers (setpoints, coils, calibration) keep whatever was written to them. */
function tick(iface: SimInterface, elapsedSeconds: number): void {
  iface.defs.forEach((def, i) => {
    if (!def.live) return;
    writeMemory(iface.memory, toEntry(def), def.live(elapsedSeconds, i));
  });
  pollSweep(iface, Date.now());
}

// ─── Install ───────────────────────────────────────────────────────────────

/** Install the mock invoke handler. Returns a teardown function. */
export function installModbusMockHost(bridge: MockBridge, opts: MockHostOptions = {}): () => void {
  const scenario: MockScenario = opts.scenario ?? "ready";
  const agents: SimAgent[] =
    scenario === "multi-agent"
      ? [buildAgent("localhost:2300", "extension-missing"), buildAgent("remote:2300", "ready")]
      : [buildAgent("localhost:2300", scenario)];

  const agentMap = new Map(agents.map((a) => [a.address, a]));
  const startedAt = Date.now();

  const timer = window.setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    for (const agent of agentMap.values()) {
      if (agent.extState !== "running") continue;
      for (const iface of agent.interfaces.values()) tick(iface, elapsed);
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
    const methods =
      a.actionSet === "none"
        ? []
        : a.actionSet === "legacy"
          ? LEGACY_ACTIONS
          : [...REQUIRED_MODBUS_METHODS, MODBUS_METHODS.getStatus];
    out[addr] = methods.map((m) => `modbus/${m}`);
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
  const addr = typeof agentAddr === "string" && agentAddr.length > 0 ? agentAddr : "localhost:2300";
  const agent = agentMap.get(addr);
  if (!agent) throw new Error(`mock-host: unknown agent "${addr}"`);
  if (!agent.extInstalled) {
    throw new Error(`mock-host: extension "${id}" not installed on "${addr}"`);
  }
  if (op === "start") {
    agent.extState = "running";
    agent.actionSet = scenario === "extension-outdated" ? "legacy" : "full";
    return { pid: 4321 };
  }
  agent.extState = "stopped";
  agent.actionSet = "none";
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

async function handleActionExecute(agentMap: Map<string, SimAgent>, params: unknown) {
  if (params === null || typeof params !== "object") throw new Error("mock-host: bad params");
  const {
    agent: agentAddr,
    action,
    params: actionParams,
  } = params as { agent: string; action: string; params?: unknown };

  const agent = agentMap.get(agentAddr);
  if (!agent) throw new Error(`mock-host: unknown agent "${agentAddr}"`);
  if (!action.startsWith("modbus/")) {
    throw new Error(`mock-host: action path doesn't start with modbus/: ${action}`);
  }
  const method = action.slice("modbus/".length);
  const args = (actionParams ?? {}) as Record<string, unknown>;

  if (method === MODBUS_METHODS.listInterfaces) {
    const interfaces = [...agent.interfaces.values()].map((i) => i.entry);
    return { status: "done", result: { interfaces, count: interfaces.length, success: true } };
  }

  const ifaceName = typeof args.interface === "string" ? args.interface : "";
  const iface = agent.interfaces.get(ifaceName);
  if (!iface) return failure(`Interface '${ifaceName}' not found`);

  switch (method) {
    case MODBUS_METHODS.getSnapshot: {
      const values: Record<string, { value: number | boolean; ts_ms: number }> = {};
      for (const [path, entry] of iface.values) values[path] = entry;
      return {
        status: "done",
        result: {
          interface: ifaceName,
          connected: iface.entry.connected,
          transport: iface.entry.transport,
          connection: iface.entry.connection,
          unit_id: iface.entry.unit_id,
          poll_count: iface.poll_count,
          error_count: iface.error_count,
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
          registers: iface.registers,
          count: iface.registers.length,
          map_name: iface.entry.map_name,
        },
      };

    case MODBUS_METHODS.readNamedRegister: {
      const reg = findRegister(iface, args.name);
      if (!reg) return failure(`Register '${String(args.name)}' not found`);
      const value = readMemory(iface.memory, reg);
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
      const reg = findRegister(iface, args.name);
      if (!reg) return failure(`Register '${String(args.name)}' not found`);
      if (!reg.writable) {
        return failure(`Register '${reg.path}' is not writable (type: ${reg.type})`);
      }
      const value = Number(args.value);
      if (!Number.isFinite(value)) return failure(`Value '${String(args.value)}' is not a number`);
      writeMemory(iface.memory, reg, isBitTable(reg.type) ? value !== 0 : value);
      // Polled registers show the new value on the next sweep; refresh the cache
      // immediately for the ones that are polled so the UI feels live.
      if (reg.poll_interval !== 0) {
        iface.values.set(reg.path, { value: readMemory(iface.memory, reg), ts_ms: Date.now() });
      }
      return done({
        name: reg.path,
        address: reg.address,
        type: reg.type,
        datatype: reg.datatype,
        value,
        unit: reg.unit,
      });
    }

    case MODBUS_METHODS.readRegister: {
      const address = Number(args.address);
      const count = Number(args.count ?? 1);
      const type = asTable(args.reg_type);
      if (!Number.isInteger(address) || address < 0 || address > 65535) {
        return failure(`Address ${String(args.address)} out of range`);
      }
      if (!Number.isInteger(count) || count < 1 || count > 125) {
        return failure(`Count ${String(args.count)} out of range 1…125`);
      }
      return {
        status: "done",
        result: {
          address,
          type,
          count,
          values: readRange(iface.memory, type, address, count),
          success: true,
        },
      };
    }

    case MODBUS_METHODS.writeSingleRegister: {
      const address = Number(args.address);
      const value = Number(args.value);
      if (!Number.isInteger(address) || !Number.isFinite(value)) {
        return failure("write_single_register needs an integer address and numeric value");
      }
      iface.memory.holding.set(address, Math.trunc(value) & 0xffff);
      return { status: "done", result: { address, value, function_code: 6, success: true } };
    }

    case MODBUS_METHODS.writeRegisters: {
      const address = Number(args.address);
      const text = typeof args.values === "string" ? args.values : "";
      const parsed = text.split(",").map((v) => Number.parseInt(v.trim(), 10));
      if (!Number.isInteger(address) || parsed.some((v) => !Number.isInteger(v))) {
        return failure("Values must be comma-separated integers");
      }
      parsed.forEach((word, i) => iface.memory.holding.set(address + i, word & 0xffff));
      return {
        status: "done",
        result: {
          address,
          values: parsed,
          count: parsed.length,
          function_code: 16,
          success: true,
        },
      };
    }

    case MODBUS_METHODS.writeCoil: {
      const address = Number(args.address);
      if (!Number.isInteger(address)) return failure("write_coil needs an integer address");
      const on = args.value === "ON";
      iface.memory.coil.set(address, on);
      return { status: "done", result: { address, value: on, success: true } };
    }

    case MODBUS_METHODS.getStatus:
      return done({
        interface: ifaceName,
        connected: iface.entry.connected,
        transport: iface.entry.transport,
        connection: iface.entry.connection,
        unit_id: iface.entry.unit_id,
        poll_count: iface.poll_count,
        error_count: iface.error_count,
        poll_interval: iface.entry.poll_interval,
        write_mode: iface.entry.write_mode,
        block_reads: true,
        max_block_size: 125,
        max_read_gap: 0,
        registers: iface.registers.length,
      });

    default:
      throw new Error(`mock-host: unknown method "${method}"`);
  }
}

function findRegister(iface: SimInterface, name: unknown): RegisterEntry | undefined {
  if (typeof name !== "string") return undefined;
  return iface.registers.find((r) => r.path === name || r.name === name);
}

function asTable(value: unknown): RegisterTableType {
  switch (value) {
    case "input":
    case "coil":
    case "discrete_input":
      return value;
    default:
      return "holding";
  }
}
