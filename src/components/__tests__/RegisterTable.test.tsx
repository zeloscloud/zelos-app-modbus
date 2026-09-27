/** The register table renders only the registers the user added: one flat row
 *  per watch row, joined to the catalog by path, plus the empty and orphan
 *  states. Per-row machinery (Read, the write editor, staleness) is asserted at
 *  the presentation level here and at the helper seam below.
 *
 *  Sonner is mocked for the whole file so the "success is silent, only failures
 *  toast" contract can be asserted directly. */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterTable } from "../RegisterTable";
import { bridgeStub, namedRow, rawRow, register, snapshot, watchRows } from "./register-fixtures";
import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import type { ModbusSnapshot, RegisterEntry } from "@/lib/types";
import { WRITE_UNKNOWN_MESSAGE } from "@/lib/errors";
import { patchRow, type RawWatchRow, type WatchRow } from "@/lib/watch-store";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const CATALOG: readonly RegisterEntry[] = [
  register({ event: "power", name: "total", address: 12, unit: "kW" }),
  register({
    event: "status",
    name: "temperature",
    address: 20,
    datatype: "int16",
    scale: 0.1,
    unit: "°C",
    description: "PCB temperature",
  }),
  register({
    event: "inputs",
    name: "firmware_version",
    address: 0,
    type: "input",
    datatype: "uint16",
    unit: "",
    writable: false,
  }),
  register({
    event: "setpoints",
    name: "energy_reset",
    address: 104,
    datatype: "uint32",
    unit: "",
    rate: 0,
  }),
  register({
    event: "control",
    name: "relay",
    address: 0,
    type: "coil",
    datatype: "bool",
    unit: "",
  }),
];

/** Column indices, in the order the table renders them. */
const COL = {
  register: 0,
  address: 1,
  table: 2,
  type: 3,
  unit: 4,
  value: 5,
  write: 6,
  delete: 7,
} as const;

interface TableOptions {
  rows: readonly WatchRow[];
  registers?: readonly RegisterEntry[];
  /** Defaults to true: most tests are about a table whose catalog loaded. */
  catalogReady?: boolean;
  /** The device's `raw_writes`; defaults to true. */
  rawWrites?: boolean;
  snap?: ModbusSnapshot;
  bridge?: BridgeTransport;
  onRemoveRow?: (id: string) => void;
  onAdd?: () => void;
}

/** Renders the table over a miniature store: inline edits really do land on the
 *  rows, through the same `patchRow` the app uses, so an edit's effect on the
 *  next render is part of what these tests see. */
function renderTable(opts: TableOptions) {
  const bridge = opts.bridge ?? bridgeStub();
  const registers = opts.registers ?? CATALOG;
  const onRemoveRow = opts.onRemoveRow ?? vi.fn();
  const onAdd = opts.onAdd ?? vi.fn();
  let current: readonly WatchRow[] = opts.rows;

  function Harness({ snap }: { snap: ModbusSnapshot | undefined }) {
    const [rows, setRows] = React.useState<readonly WatchRow[]>(opts.rows);
    current = rows;
    return (
      <RegisterTable
        bridge={bridge}
        agentAddress="localhost:2300"
        deviceName="meter"
        addressBase={1}
        writeMode="auto"
        rawWrites={opts.rawWrites ?? true}
        registers={registers}
        rows={rows}
        catalogReady={opts.catalogReady ?? true}
        snapshot={snap}
        onUpdateRow={(id, patch) =>
          setRows((prev) => prev.map((r) => (r.id === id ? patchRow(r, patch) : r)))
        }
        onRemoveRow={onRemoveRow}
        onAdd={onAdd}
      />
    );
  }

  const view = render(<Harness snap={opts.snap} />);
  return {
    /** Hand the table a fresh snapshot the way the 1 Hz poll does — a re-render,
     *  not a remount, so per-row state has to survive it. */
    refresh: (snap: ModbusSnapshot) => view.rerender(<Harness snap={snap} />),
    /** The rows as the store currently holds them. */
    stored: () => current,
  };
}

/** The one raw row on screen, as stored. */
function storedRaw(view: { stored: () => readonly WatchRow[] }): RawWatchRow {
  const row = view.stored().find((r) => r.kind === "raw");
  if (row === undefined || row.kind !== "raw") throw new Error("no raw row in the store");
  return row;
}

/** Body rows only — `getAllByRole("row")` includes the header row. */
function bodyRows(): HTMLElement[] {
  return screen.getAllByRole("row").slice(1);
}

/** One body row, or a hard failure — keeps `undefined` off every call site. */
function bodyRow(index = 0): HTMLElement {
  const row = bodyRows()[index];
  if (!row) throw new Error(`no body row at index ${index}`);
  return row;
}

/** One cell of a body row, addressed by {@link COL}. */
function cell(row: HTMLElement, column: number): HTMLElement {
  const found = within(row).getAllByRole("cell")[column];
  if (!found) throw new Error(`no cell at column ${column}`);
  return found;
}

/** Answers `read_named_register` with a fixed value. */
function readAnswerer(value: number | boolean): BridgeTransport {
  return bridgeStub((action, params) => {
    if (!action.endsWith("read_named_register")) throw new Error(`unexpected action ${action}`);
    return { name: String(params.name), value, success: true };
  });
}

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
});

describe("RegisterTable empty state", () => {
  it("starts empty rather than listing the catalog", () => {
    renderTable({ rows: [] });
    expect(screen.getByText(/No rows yet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // Nothing from the catalog leaks in.
    expect(screen.queryByText("power/total")).not.toBeInTheDocument();
  });

  it("names both kinds of row it could hold", () => {
    renderTable({ rows: [] });
    expect(screen.getByText(/add a register or a raw address/i)).toBeInTheDocument();
  });

  it("opens the add dialog from the empty state", () => {
    const onAdd = vi.fn();
    renderTable({ rows: [], onAdd });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("RegisterTable columns", () => {
  it("lays out eight columns, with Value and Write between the metadata and Delete", () => {
    renderTable({ rows: watchRows(["power/total"]) });
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Register",
      "Address",
      "Table",
      "Type",
      "Unit",
      "Value",
      "Write",
      "Delete",
    ]);
  });

  it("gives the table, the datatype and the unit a column each", () => {
    renderTable({ rows: watchRows(["status/temperature"]) });
    const row = bodyRow();
    expect(cell(row, COL.address)).toHaveTextContent("20 (0x0014)");
    expect(cell(row, COL.table)).toHaveTextContent("holding");
    // Scale rides along with the datatype it applies to.
    expect(cell(row, COL.type)).toHaveTextContent("int16 ×0.1");
    expect(cell(row, COL.unit)).toHaveTextContent("°C");
  });

  it("names a bit table in full and dashes an absent unit", () => {
    renderTable({ rows: watchRows(["control/relay", "inputs/firmware_version"]) });
    expect(cell(bodyRow(0), COL.table)).toHaveTextContent("coil");
    expect(cell(bodyRow(0), COL.unit)).toHaveTextContent("—");
    expect(cell(bodyRow(1), COL.table)).toHaveTextContent("input");
  });

  it("puts Read in the Value cell, and Write and Delete in their own columns", () => {
    renderTable({ rows: watchRows(["power/total"]) });
    const row = bodyRow();
    // Read rides along with the value it refreshes instead of owning a column.
    const read = within(cell(row, COL.value)).getByRole("button", { name: /^read /i });
    expect(read).toBeEnabled();
    expect(read).toHaveTextContent("");
    expect(
      within(cell(row, COL.write)).getByLabelText("New value for power/total"),
    ).toBeInTheDocument();
    expect(within(cell(row, COL.write)).getByRole("button", { name: "Write" })).toBeDisabled();
    expect(
      within(cell(row, COL.delete)).getByRole("button", { name: /^remove /i }),
    ).toBeInTheDocument();
  });

  it("centers every cell against the row's tallest control", () => {
    renderTable({ rows: watchRows(["power/total"]) });
    const cells = within(bodyRow()).getAllByRole("cell");
    expect(cells).toHaveLength(8);
    for (const td of cells) expect(td).toHaveClass("align-middle");
  });
});

describe("RegisterTable rows", () => {
  it("renders one flat row per watch row, in insertion order", () => {
    renderTable({ rows: watchRows(["status/temperature", "power/total"]) });
    const rows = bodyRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("status/temperature");
    expect(rows[1]).toHaveTextContent("power/total");
  });

  it("renders one flat table rather than per-event collapsible sections", () => {
    renderTable({ rows: watchRows(["power/total", "status/temperature"]) });
    expect(screen.getAllByRole("table")).toHaveLength(1);
    // The event sections were expand/collapse buttons carrying the event name.
    expect(document.querySelectorAll("[aria-expanded]")).toHaveLength(0);
    expect(screen.queryByText("power", { exact: true })).not.toBeInTheDocument();
  });

  it("uses the description as the register cell's tooltip when there is one", () => {
    renderTable({ rows: watchRows(["status/temperature", "power/total"]) });
    expect(screen.getByTitle("PCB temperature")).toHaveTextContent("status/temperature");
    // No description → the path is its own tooltip.
    expect(screen.getByTitle("power/total")).toHaveTextContent("power/total");
  });

  it("joins the live snapshot value", () => {
    renderTable({
      rows: watchRows(["power/total"]),
      snap: snapshot({ "power/total": { value: 3.4, ts_ms: 1_700_000_000_000 } }),
    });
    expect(within(bodyRow()).getByText("3.4")).toBeInTheDocument();
  });

  it("prints the bare value — the unit has its own column", () => {
    renderTable({
      rows: watchRows(["status/temperature"]),
      snap: snapshot({ "status/temperature": { value: 21.5, ts_ms: 1_700_000_000_000 } }),
    });
    const row = bodyRow();
    expect(cell(row, COL.value)).toHaveTextContent("21.5");
    expect(cell(row, COL.value)).not.toHaveTextContent("°C");
    expect(cell(row, COL.unit)).toHaveTextContent("°C");
  });

  it("hints that a rate: 0 register is not polled", () => {
    renderTable({ rows: watchRows(["setpoints/energy_reset"]), snap: snapshot({}) });
    expect(screen.getByText("not polled")).toBeInTheDocument();
  });

  it("dims a polled value older than the staleness threshold", () => {
    const captured = 1_700_000_000_000;
    renderTable({
      rows: watchRows(["power/total"]),
      snap: snapshot({ "power/total": { value: 3.4, ts_ms: captured - 60_000 } }, captured),
    });
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(within(bodyRow()).getByText("3.4").closest(".opacity-40")).not.toBeNull();
  });

  it("puts the ON/OFF control for a writable coil in the Write column", () => {
    renderTable({ rows: watchRows(["control/relay"]) });
    const row = bodyRow();
    expect(within(cell(row, COL.write)).getByRole("switch")).toHaveAccessibleName(
      "Write control/relay",
    );
    expect(within(row).queryByLabelText(/New value for/)).not.toBeInTheDocument();
  });

  it("marks a non-writable register with a subdued indicator in the Write column", () => {
    renderTable({ rows: watchRows(["inputs/firmware_version"]) });
    const row = bodyRow();
    const write = cell(row, COL.write);
    expect(write).toHaveTextContent("—");
    expect(within(write).getByTitle(/read-only/)).toBeInTheDocument();
    // Announced for screen readers even though the glyph carries it visually.
    expect(within(write).getByText("read-only")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Write" })).not.toBeInTheDocument();
    expect(within(row).queryByLabelText(/New value for/)).not.toBeInTheDocument();
    // Reading it on demand is still offered.
    expect(within(row).getByRole("button", { name: /^read /i })).toBeEnabled();
  });

  it("rejects an out-of-range write before it can be sent", () => {
    renderTable({ rows: watchRows(["status/temperature"]) });
    const write = cell(bodyRow(), COL.write);
    fireEvent.change(within(write).getByLabelText("New value for status/temperature"), {
      target: { value: "99999" },
    });
    expect(within(write).getByRole("alert")).toHaveTextContent(/out of range/i);
    expect(within(write).getByRole("button", { name: "Write" })).toBeDisabled();
  });

  it("deletes the row its trash button belongs to", () => {
    const onRemoveRow = vi.fn();
    const rows = watchRows(["power/total", "status/temperature"]);
    renderTable({ rows, onRemoveRow });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove status/temperature from the table" }),
    );
    expect(onRemoveRow).toHaveBeenCalledWith(rows[1]?.id);
  });
});

describe("RegisterTable read feedback", () => {
  /** The flashing element is the one holding the value text. */
  function flashed(text: string): HTMLElement {
    return within(cell(bodyRow(), COL.value)).getByText(text);
  }

  it("flashes the new value when a read lands, then fades the flash out", async () => {
    renderTable({
      rows: watchRows(["power/total"]),
      snap: snapshot({ "power/total": { value: 3.4, ts_ms: 1_700_000_000_000 } }),
      bridge: readAnswerer(9.5),
    });
    fireEvent.click(screen.getByRole("button", { name: /^read /i }));

    await waitFor(() => expect(cell(bodyRow(), COL.value)).toHaveTextContent("9.5"));
    expect(flashed("9.5")).toHaveAttribute("data-flash", "true");
    // Short-lived, and it clears itself with no help from outside.
    await waitFor(() => expect(flashed("9.5")).not.toHaveAttribute("data-flash"));
  });

  it("confirms a read with the value alone — no label, no toast", async () => {
    renderTable({
      rows: watchRows(["setpoints/energy_reset"]),
      snap: snapshot({}),
      bridge: readAnswerer(7),
    });
    expect(screen.getByText("not polled")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^read /i }));
    await waitFor(() => expect(cell(bodyRow(), COL.value)).toHaveTextContent("7"));

    expect(screen.queryByText(/on demand/i)).not.toBeInTheDocument();
    expect(screen.queryByText("not polled")).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("un-dims a stale value the moment a read lands", async () => {
    const captured = 1_700_000_000_000;
    renderTable({
      rows: watchRows(["power/total"]),
      snap: snapshot({ "power/total": { value: 3.4, ts_ms: captured - 60_000 } }, captured),
      bridge: readAnswerer(9.5),
    });
    expect(screen.getByText("stale")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^read /i }));
    await waitFor(() => expect(cell(bodyRow(), COL.value)).toHaveTextContent("9.5"));

    expect(screen.queryByText("stale")).not.toBeInTheDocument();
    expect(flashed("9.5").closest(".opacity-40")).toBeNull();
  });
});

describe("RegisterTable unrepresentable values", () => {
  /** Answers every named action with a successful read of a value JSON can't
   *  carry — what the extension sends for a NaN or ±Inf off the wire. */
  function nullValueBridge(actions: string[] = []): BridgeTransport {
    return bridgeStub((action) => {
      actions.push(action.replace(/^Modbus\//, ""));
      return {
        name: "power/total",
        address: 12,
        type: "holding",
        datatype: "float32",
        value: null,
        unit: "kW",
        success: true,
      };
    });
  }

  function valueTooltip(index = 0): string | null {
    const shown = within(cell(bodyRow(index), COL.value)).getByText("—");
    return shown.closest("[title]")?.getAttribute("title") ?? null;
  }

  it("distinguishes a value the wire couldn't carry from one never read", () => {
    renderTable({
      rows: watchRows(["power/total", "status/temperature"]),
      snap: snapshot({ "power/total": { value: null, ts_ms: 1_700_000_000_000 } }),
    });
    // Both cells show a dash; only the polled-but-unrepresentable one says why.
    expect(cell(bodyRow(0), COL.value)).toHaveTextContent("—");
    expect(valueTooltip(0)).toMatch(/non-finite value \(NaN\/Inf\)/);
    expect(cell(bodyRow(1), COL.value)).toHaveTextContent("—");
    expect(valueTooltip(1)).toBeNull();
  });

  it("never offers an unrepresentable value as the write placeholder", () => {
    renderTable({
      rows: watchRows(["power/total"]),
      snap: snapshot({ "power/total": { value: null, ts_ms: 1_700_000_000_000 } }),
    });
    expect(screen.getByLabelText("New value for power/total")).toHaveAttribute(
      "placeholder",
      "value",
    );
  });

  it("flashes a read that lands unrepresentable — the read still happened", async () => {
    renderTable({ rows: watchRows(["power/total"]), bridge: nullValueBridge() });
    fireEvent.click(screen.getByRole("button", { name: /^read /i }));

    await waitFor(() => expect(valueTooltip()).toMatch(/non-finite/));
    expect(within(cell(bodyRow(), COL.value)).getByText("—")).toHaveAttribute("data-flash", "true");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("treats an unrepresentable read-back after a write as a success", async () => {
    const actions: string[] = [];
    // An unpolled register: the read-back is the only value it will ever show.
    renderTable({
      rows: watchRows(["setpoints/energy_reset"]),
      snap: snapshot({}),
      bridge: nullValueBridge(actions),
    });
    expect(screen.getByText("not polled")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^New value for setpoints/), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));

    await waitFor(() => expect(actions).toEqual(["write_named_register", "read_named_register"]));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // The sample exists now, so it is no longer "not polled" — just unprintable.
    expect(screen.queryByText("not polled")).not.toBeInTheDocument();
    expect(valueTooltip()).toMatch(/non-finite/);
  });

  it("keeps the raw words in the tooltip when they decode to nothing printable", async () => {
    // float32 of all ones is a NaN, decoded client-side rather than sanitized.
    const bridge = bridgeStub((action, params) => {
      if (!action.endsWith("read_register")) throw new Error(`unexpected action ${action}`);
      return {
        address: Number(params.address),
        type: "holding",
        count: 2,
        values: [0xffff, 0xffff],
        success: true,
      };
    });
    renderTable({ rows: [rawRow({ datatype: "float32" })], bridge });
    fireEvent.click(screen.getByRole("button", { name: /^read /i }));

    await waitFor(() => expect(valueTooltip()).toMatch(/non-finite/));
    expect(valueTooltip()).toContain("0xffff 0xffff");
  });
});

describe("RegisterTable write draft", () => {
  /** Answers `write_named_register` and records what was sent. `fail` makes the
   *  extension report its in-band failure instead. */
  function writeRecorder(sent: number[], failure?: Record<string, unknown>): BridgeTransport {
    return bridgeStub((action, params) => {
      if (!action.endsWith("write_named_register")) throw new Error(`unexpected action ${action}`);
      sent.push(Number(params.value));
      if (failure) return { success: false, ...failure };
      return { name: String(params.name), value: Number(params.value), success: true };
    });
  }

  it("keeps the typed draft after a successful write, so the same value can be sent again", async () => {
    const sent: number[] = [];
    renderTable({ rows: watchRows(["power/total"]), bridge: writeRecorder(sent) });
    const input = screen.getByLabelText("New value for power/total");
    fireEvent.change(input, { target: { value: "12.5" } });

    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    // Write re-enables when the request settles.
    await waitFor(() => expect(screen.getByRole("button", { name: "Write" })).toBeEnabled());
    expect(sent).toEqual([12.5]);
    expect(input).toHaveValue("12.5");

    // Type once, Write repeatedly.
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Write" })).toBeEnabled());
    expect(sent).toEqual([12.5, 12.5]);
    expect(input).toHaveValue("12.5");
  });

  it("keeps the draft across a snapshot refresh, and placeholders the live value when empty", () => {
    const view = renderTable({
      rows: watchRows(["power/total"]),
      snap: snapshot({ "power/total": { value: 3.4, ts_ms: 1_700_000_000_000 } }),
    });
    const input = screen.getByLabelText("New value for power/total");
    expect(input).toHaveAttribute("placeholder", "3.4");

    fireEvent.change(input, { target: { value: "9" } });
    view.refresh(
      snapshot({ "power/total": { value: 3.6, ts_ms: 1_700_000_001_000 } }, 1_700_000_001_000),
    );

    const refreshed = screen.getByLabelText("New value for power/total");
    expect(refreshed).toHaveValue("9");
    // The value moved on and the placeholder tracks it; the draft is untouched.
    expect(cell(bodyRow(), COL.value)).toHaveTextContent("3.6");
    expect(refreshed).toHaveAttribute("placeholder", "3.6");
  });

  it("says nothing when a write succeeds", async () => {
    const sent: number[] = [];
    renderTable({ rows: watchRows(["power/total"]), bridge: writeRecorder(sent) });
    fireEvent.change(screen.getByLabelText("New value for power/total"), {
      target: { value: "12.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));

    await waitFor(() => expect(sent).toEqual([12.5]));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ["refused", toast.error, "Write power/total failed", "unit_id out of range"],
    ["unknown", toast.warning, "Write power/total: no response", WRITE_UNKNOWN_MESSAGE],
  ])("toasts a %s write with its reason", async (outcome, notify, title, description) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: number[] = [];
    const failure = { outcome, error: "unit_id out of range" };
    renderTable({ rows: watchRows(["power/total"]), bridge: writeRecorder(sent, failure) });
    fireEvent.change(screen.getByLabelText("New value for power/total"), {
      target: { value: "12.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(vi.mocked(notify).mock.calls[0]?.[0]).toBe(title);
    expect(vi.mocked(notify).mock.calls[0]?.[1]?.description).toBe(description);
    // Exactly one toast: amber for unknown, red for refused.
    expect(
      vi.mocked(toast.error).mock.calls.length + vi.mocked(toast.warning).mock.calls.length,
    ).toBe(1);
    expect(toast.success).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("RegisterTable raw rows", () => {
  interface RawCall {
    action: string;
    params: Record<string, unknown>;
  }

  /** Answers the four raw actions, recording every call. Reads come back as
   *  `values`, which the row then decodes itself. */
  function rawBridge(calls: RawCall[], values: Array<number | boolean> = [1234]): BridgeTransport {
    return bridgeStub((action, params) => {
      calls.push({ action, params });
      if (action.endsWith("read_register")) {
        return {
          address: Number(params.address),
          type: params.reg_type,
          count: Number(params.count),
          values,
          success: true,
        };
      }
      if (
        action.endsWith("write_single_register") ||
        action.endsWith("write_registers") ||
        action.endsWith("write_coil")
      ) {
        return { address: Number(params.address), success: true };
      }
      throw new Error(`unexpected action ${action}`);
    });
  }

  /** The actions issued, in order, without the `Modbus/` prefix. */
  function actions(calls: RawCall[]): string[] {
    return calls.map((c) => c.action.replace(/^Modbus\//, ""));
  }

  function select(row: HTMLElement, name: string): HTMLSelectElement {
    const el = within(row).getByLabelText(name);
    if (!(el instanceof HTMLSelectElement)) throw new Error(`${name} is not a select`);
    return el;
  }

  it("disables raw writes with the reason inline when the device has them off, reads unaffected", () => {
    renderTable({ rows: [rawRow()], rawWrites: false });
    const write = cell(bodyRow(), COL.write);
    expect(write).toHaveTextContent("raw writes are off");
    expect(within(write).queryByRole("button", { name: "Write" })).toBeNull();
    expect(within(cell(bodyRow(), COL.value)).getByRole("button")).toBeEnabled();
  });

  it("dashes the two columns an arbitrary address has no answer for", () => {
    renderTable({ rows: [rawRow()] });
    const row = bodyRow();
    expect(cell(row, COL.register)).toHaveTextContent("—");
    expect(cell(row, COL.unit)).toHaveTextContent("—");
    // …and puts an editor in each of the three it does.
    expect(within(cell(row, COL.address)).getByLabelText("Raw address")).toHaveValue("1");
    expect(select(row, "Raw table")).toHaveValue("holding");
    expect(select(row, "Raw datatype")).toHaveValue("uint16");
  });

  it("commits an address edit as typed, with no save step", () => {
    const view = renderTable({ rows: [rawRow()] });
    fireEvent.change(screen.getByLabelText("Raw address"), { target: { value: "0x64" } });
    // Stored verbatim — the user's notation round-trips.
    expect(storedRaw(view).address).toBe("0x64");
  });

  it("flags an unparseable address and leaves the last good one stored", () => {
    const view = renderTable({ rows: [rawRow({ address: "10" })] });
    const input = screen.getByLabelText("Raw address");
    fireEvent.change(input, { target: { value: "beef" } });
    expect(input).toHaveValue("beef");
    expect(input.className).toContain("border-destructive");
    expect(storedRaw(view).address).toBe("10");
    // Fixing it commits again.
    fireEvent.change(input, { target: { value: "12" } });
    expect(storedRaw(view).address).toBe("12");
    expect(screen.getByLabelText("Raw address").className).not.toContain("border-destructive");
  });

  it("forces bool onto a bit table, and back to uint16 on the way out", () => {
    const view = renderTable({ rows: [rawRow({ datatype: "float32" })] });
    fireEvent.change(select(bodyRow(), "Raw table"), { target: { value: "coil" } });
    expect(storedRaw(view)).toMatchObject({ table: "coil", datatype: "bool" });
    const datatype = select(bodyRow(), "Raw datatype");
    expect(datatype).toHaveValue("bool");
    expect(datatype).toBeDisabled();

    fireEvent.change(select(bodyRow(), "Raw table"), { target: { value: "holding" } });
    expect(storedRaw(view)).toMatchObject({ table: "holding", datatype: "uint16" });
    expect(select(bodyRow(), "Raw datatype")).toBeEnabled();
  });

  it("offers a byte-order select only where byte order can matter", () => {
    const view = renderTable({ rows: [rawRow({ datatype: "uint16" })] });
    expect(within(bodyRow()).queryByLabelText("Byte order")).not.toBeInTheDocument();

    fireEvent.change(select(bodyRow(), "Raw datatype"), { target: { value: "float32" } });
    const order = select(bodyRow(), "Byte order");
    expect(order).toHaveValue("big");
    fireEvent.change(order, { target: { value: "big_swap" } });
    expect(storedRaw(view).byte_order).toBe("big_swap");
  });

  it("reads on demand, decodes client-side, and keeps the words in the tooltip", async () => {
    const calls: RawCall[] = [];
    renderTable({
      rows: [rawRow({ address: "110", datatype: "float32" })],
      bridge: rawBridge(calls, [0x4048, 0xf5c3]),
    });
    fireEvent.click(screen.getByRole("button", { name: /^read /i }));

    await waitFor(() => expect(cell(bodyRow(), COL.value)).toHaveTextContent("3.14"));
    // One value, so the request asks for exactly the datatype's words.
    expect(calls[0]?.params).toMatchObject({ address: 110, reg_type: "holding", count: 2 });
    const shown = within(cell(bodyRow(), COL.value)).getByText("3.14");
    expect(shown).toHaveAttribute("data-flash", "true");
    expect(shown.closest("[title]")).toHaveAttribute("title", "0x4048 0xf5c3");
  });

  it("reads a coil as ON/OFF", async () => {
    const calls: RawCall[] = [];
    renderTable({
      rows: [rawRow({ table: "coil", datatype: "bool", address: "3" })],
      bridge: rawBridge(calls, [true]),
    });
    fireEvent.click(screen.getByRole("button", { name: /^read /i }));

    await waitFor(() => expect(cell(bodyRow(), COL.value)).toHaveTextContent("ON"));
    expect(calls[0]?.params).toMatchObject({ address: 3, reg_type: "coil", count: 1 });
  });

  it("writes a single word with FC6, then reads it back", async () => {
    const calls: RawCall[] = [];
    renderTable({ rows: [rawRow({ address: "100" })], bridge: rawBridge(calls, [1234]) });
    fireEvent.change(screen.getByLabelText(/^New value for raw holding uint16/), {
      target: { value: "1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));

    await waitFor(() => expect(actions(calls)).toEqual(["write_single_register", "read_register"]));
    expect(calls[0]?.params).toMatchObject({ address: 100, value: 1234 });
    // The read-back is the receipt.
    expect(cell(bodyRow(), COL.value)).toHaveTextContent("1234");
  });

  it("writes a multi-word value with FC16, as the comma string the action takes", async () => {
    const calls: RawCall[] = [];
    renderTable({
      rows: [rawRow({ address: "110", datatype: "float32" })],
      bridge: rawBridge(calls, [0x4048, 0xf5c3]),
    });
    fireEvent.change(screen.getByLabelText(/^New value for raw holding float32/), {
      target: { value: "3.14" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));

    await waitFor(() => expect(actions(calls)).toEqual(["write_registers", "read_register"]));
    expect(calls[0]?.params).toMatchObject({ address: 110, values: "16456,62915" });
  });

  it("writes a coil from the ON/OFF switch", async () => {
    const calls: RawCall[] = [];
    renderTable({
      rows: [rawRow({ table: "coil", datatype: "bool", address: "3" })],
      bridge: rawBridge(calls, [true]),
    });
    fireEvent.click(within(cell(bodyRow(), COL.write)).getByRole("switch"));

    await waitFor(() => expect(actions(calls)).toEqual(["write_coil", "read_register"]));
    expect(calls[0]?.params).toMatchObject({ address: 3, value: "ON" });
    expect(cell(bodyRow(), COL.value)).toHaveTextContent("ON");
  });

  it("marks the tables Modbus can't write, whatever the datatype", () => {
    renderTable({ rows: [rawRow({ table: "input" }), rawRow({ table: "discrete_input" })] });
    for (const index of [0, 1]) {
      const write = cell(bodyRow(index), COL.write);
      expect(within(write).getByTitle(/read-only/)).toBeInTheDocument();
      expect(within(write).queryByRole("button", { name: "Write" })).not.toBeInTheDocument();
      expect(within(write).queryByRole("switch")).not.toBeInTheDocument();
    }
    // Reading them is still on offer.
    expect(screen.getAllByRole("button", { name: /^read /i })).toHaveLength(2);
  });

  it("latches a raw row's draft through a write, like a named row's", async () => {
    const calls: RawCall[] = [];
    renderTable({ rows: [rawRow({ address: "100" })], bridge: rawBridge(calls, [1234]) });
    const input = screen.getByLabelText(/^New value for raw holding uint16/);
    fireEvent.change(input, { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Write" })).toBeEnabled());
    expect(input).toHaveValue("1234");
  });

  it("renders named and raw rows side by side, in insertion order", () => {
    renderTable({ rows: [namedRow("power/total"), rawRow(), namedRow("status/temperature")] });
    expect(bodyRows()).toHaveLength(3);
    expect(cell(bodyRow(0), COL.register)).toHaveTextContent("power/total");
    expect(within(bodyRow(1)).getByLabelText("Raw address")).toBeInTheDocument();
    expect(cell(bodyRow(2), COL.register)).toHaveTextContent("status/temperature");
  });
});

describe("RegisterTable write presets", () => {
  it("persists the draft as it is typed, so a row can be a preset", () => {
    const view = renderTable({ rows: [namedRow("power/total")] });
    fireEvent.change(screen.getByLabelText("New value for power/total"), {
      target: { value: "12.5" },
    });
    expect(view.stored()[0]?.draft).toBe("12.5");
  });

  it("seeds each duplicate row's editor from its own stored draft", () => {
    renderTable({
      rows: [
        namedRow("power/total", { draft: "5" }),
        namedRow("power/total", { draft: "50" }),
        namedRow("power/total"),
      ],
    });
    const drafts = screen
      .getAllByLabelText("New value for power/total")
      .map((input) => (input as HTMLInputElement).value);
    expect(drafts).toEqual(["5", "50", ""]);
  });

  it("keeps the two duplicates independent as one is edited", () => {
    const view = renderTable({
      rows: [namedRow("power/total", { draft: "5" }), namedRow("power/total", { draft: "50" })],
    });
    const inputs = screen.getAllByLabelText("New value for power/total");
    fireEvent.change(inputs[1] as HTMLElement, { target: { value: "500" } });
    expect(view.stored().map((r) => r.draft)).toEqual(["5", "500"]);
    expect(inputs[0]).toHaveValue("5");
  });
});

describe("RegisterTable orphan rows", () => {
  it("keeps a path the current map no longer has, with delete as the only action", () => {
    renderTable({ rows: watchRows(["retired/register"]) });
    expect(screen.getByText("not in current register map")).toBeInTheDocument();
    const row = bodyRow();
    expect(row).toHaveTextContent("retired/register");
    const buttons = within(row).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("aria-label", "Remove retired/register from the table");
  });

  it("renders orphans alongside healthy rows without disturbing them", () => {
    renderTable({ rows: watchRows(["retired/register", "power/total"]) });
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^read /i })).toBeEnabled();
  });
});

describe("RegisterTable without a catalog", () => {
  /** What the table gets when `list_registers` failed: no entries, and no claim
   *  that their absence means anything. */
  function renderUnjoined(bridge?: BridgeTransport) {
    return renderTable({
      rows: [namedRow("power/total")],
      registers: [],
      catalogReady: false,
      ...(bridge ? { bridge } : {}),
    });
  }

  it("keeps a named row working instead of calling it an orphan", () => {
    renderUnjoined();
    const row = bodyRow();
    expect(screen.queryByText("not in current register map")).not.toBeInTheDocument();
    expect(cell(row, COL.register)).toHaveTextContent("power/total");
    // Read and Write both go by path, so both stay on offer.
    expect(within(row).getByRole("button", { name: /^read power\/total/i })).toBeEnabled();
    expect(within(cell(row, COL.write)).getByLabelText("New value for power/total")).toBeEnabled();
  });

  it("dashes the details it doesn't have rather than guessing them", () => {
    renderUnjoined();
    const row = bodyRow();
    for (const column of [COL.address, COL.table, COL.type, COL.unit]) {
      expect(cell(row, column)).toHaveTextContent("—");
    }
  });

  it("still calls a path an orphan once the catalog says it is gone", () => {
    renderTable({ rows: [namedRow("retired/register")], catalogReady: true });
    expect(screen.getByText("not in current register map")).toBeInTheDocument();
  });

  it("sends an unvalidated write and lets the extension have the last word", async () => {
    const sent: unknown[] = [];
    const bridge = bridgeStub((action, params) => {
      sent.push({ action: action.replace(/^Modbus\//, ""), value: params.value });
      return { name: "power/total", value: params.value, success: true };
    });
    renderUnjoined(bridge);
    const input = screen.getByLabelText("New value for power/total");
    // No range to check against, so only "is it a number" is enforced here.
    fireEvent.change(input, { target: { value: "abc" } });
    expect(within(cell(bodyRow(), COL.write)).getByRole("alert")).toHaveTextContent("not a number");

    fireEvent.change(input, { target: { value: "99999999" } });
    expect(within(cell(bodyRow(), COL.write)).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    await waitFor(() =>
      expect(sent).toEqual([
        { action: "write_named_register", value: 99999999 },
        // Nothing says whether it is polled, so the read-back is unconditional.
        { action: "read_named_register", value: undefined },
      ]),
    );
  });
});

describe("RegisterTable row locking", () => {
  function slowBridge(): { bridge: BridgeTransport; resolve: () => void; calls: string[] } {
    const calls: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const bridge = bridgeStub((action, params) => {
      calls.push(action.replace(/^Modbus\//, ""));
      return gate.then(() => ({ name: "power/total", value: params.value ?? 1, success: true }));
    });
    return { bridge, resolve: () => release(), calls };
  }

  it("refuses a second action while one is in flight, and holds Delete", async () => {
    const onRemoveRow = vi.fn();
    const { bridge, resolve, calls } = slowBridge();
    renderTable({ rows: [namedRow("power/total")], bridge, onRemoveRow });

    fireEvent.click(screen.getByRole("button", { name: /^read power\/total/i }));
    // A second click — or a click on the other control — lands on nothing.
    fireEvent.click(screen.getByRole("button", { name: /^read power\/total/i }));
    expect(calls).toEqual(["read_named_register"]);

    const remove = screen.getByRole("button", { name: /^remove power\/total/i });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(onRemoveRow).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(remove).toBeEnabled());
  });

  it("won't act on a raw row whose address the user is still fixing", () => {
    renderTable({ rows: [rawRow({ address: "100", draft: "5" })] });
    const address = screen.getByLabelText("Raw address");

    expect(screen.getByRole("button", { name: "Write" })).toBeEnabled();
    fireEvent.change(address, { target: { value: "70000" } });

    // 70000 is past the address space, so the row would otherwise act on 100.
    expect(screen.getByRole("button", { name: "Write" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^read raw/i })).toBeDisabled();
    expect(address.className).toContain("border-destructive");

    fireEvent.change(address, { target: { value: "200" } });
    expect(screen.getByRole("button", { name: "Write" })).toBeEnabled();
  });

  it("holds the ON/OFF switch too", () => {
    renderTable({ rows: [rawRow({ table: "coil", datatype: "bool", address: "3" })] });
    fireEvent.change(screen.getByLabelText("Raw address"), { target: { value: "beef" } });
    expect(within(cell(bodyRow(), COL.write)).getByRole("switch")).toBeDisabled();
  });
});

describe("RegisterTable re-pointed raw rows", () => {
  function readingBridge(values: number[]): BridgeTransport {
    return bridgeStub((action, params) => {
      if (!action.endsWith("read_register")) throw new Error(`unexpected action ${action}`);
      return {
        address: Number(params.address),
        type: "holding",
        count: values.length,
        values,
        success: true,
      };
    });
  }

  it("drops a readout that is no longer about this row's target", async () => {
    renderTable({ rows: [rawRow({ address: "100" })], bridge: readingBridge([1234]) });
    fireEvent.click(screen.getByRole("button", { name: /^read raw/i }));
    await waitFor(() => expect(cell(bodyRow(), COL.value)).toHaveTextContent("1234"));

    // A different address is a different register — the old value isn't its value.
    fireEvent.change(screen.getByLabelText("Raw address"), { target: { value: "200" } });
    expect(cell(bodyRow(), COL.value)).toHaveTextContent("—");
    expect(cell(bodyRow(), COL.value)).not.toHaveTextContent("1234");
  });

  it("drops it when the table or the datatype changes, too", async () => {
    renderTable({ rows: [rawRow({ address: "100" })], bridge: readingBridge([1234]) });
    fireEvent.click(screen.getByRole("button", { name: /^read raw/i }));
    await waitFor(() => expect(cell(bodyRow(), COL.value)).toHaveTextContent("1234"));

    fireEvent.change(within(bodyRow()).getByLabelText("Raw datatype"), {
      target: { value: "int16" },
    });
    expect(cell(bodyRow(), COL.value)).toHaveTextContent("—");
  });
});

describe("RegisterTable write receipts", () => {
  it("flashes a polled register's value even when the write doesn't move it", async () => {
    const bridge = bridgeStub((_action, params) => ({
      name: "power/total",
      value: params.value ?? null,
      success: true,
    }));
    renderTable({
      rows: [namedRow("power/total")],
      snap: snapshot({ "power/total": { value: 3.4, ts_ms: 1_700_000_000_000 } }),
      bridge,
    });
    fireEvent.change(screen.getByLabelText("New value for power/total"), {
      target: { value: "3.4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));

    // Nothing about the value changes, so the flash is the only sign it worked.
    await waitFor(() =>
      expect(within(cell(bodyRow(), COL.value)).getByText("3.4")).toHaveAttribute(
        "data-flash",
        "true",
      ),
    );
  });
});
