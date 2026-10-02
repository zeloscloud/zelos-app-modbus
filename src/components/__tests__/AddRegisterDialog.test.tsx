/** The add-a-row dialog: browse the catalog grouped by event, search it, add one
 *  register — or one raw row — per visit, with the dialog closing behind each add
 *  so the new row can be edited straight away. */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AddRegisterDialog, filterRegisters, groupByEvent } from "../AddRegisterDialog";
import { register } from "./register-fixtures";
import type { RegisterEntry } from "@/lib/types";

const CATALOG: readonly RegisterEntry[] = [
  register({ event: "power", name: "total", address: 12, unit: "kW" }),
  register({ event: "power", name: "frequency", address: 16, unit: "Hz" }),
  register({
    event: "status",
    name: "temperature",
    address: 20,
    datatype: "int16",
    scale: 0.1,
    unit: "°C",
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
];

function renderDialog({ registers = CATALOG }: { registers?: readonly RegisterEntry[] } = {}) {
  const onAdd = vi.fn();
  const onAddRaw = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <AddRegisterDialog
      open
      onOpenChange={onOpenChange}
      deviceName="meter"
      addressBase={1}
      registers={registers}
      onAdd={onAdd}
      onAddRaw={onAddRaw}
    />,
  );
  return { onAdd, onAddRaw, onOpenChange };
}

function search(text: string) {
  fireEvent.change(screen.getByLabelText("Search registers"), { target: { value: text } });
}

/** The clickable option for a register, addressed by its visible name. */
function option(name: string): HTMLElement {
  const label = screen.getByText(name);
  const button = label.closest("button");
  if (!button) throw new Error(`no option button for ${name}`);
  return button;
}

describe("AddRegisterDialog", () => {
  it("lists the whole catalog grouped by event", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    for (const event of ["power", "status", "inputs"]) {
      expect(within(dialog).getByText(event)).toBeInTheDocument();
    }
    for (const name of ["total", "frequency", "temperature", "firmware_version"]) {
      expect(within(dialog).getByText(name)).toBeInTheDocument();
    }
  });

  it("shows each register's address in dec + hex, table, datatype and unit", () => {
    renderDialog();
    const row = option("temperature");
    expect(within(row).getByText("20 (0x0014)")).toBeInTheDocument();
    expect(within(row).getByText("Holding 4x")).toBeInTheDocument();
    expect(within(row).getByText("int16")).toBeInTheDocument();
    expect(within(row).getByText("°C")).toBeInTheDocument();
  });

  it("marks writability without offering any value editing", () => {
    renderDialog();
    expect(within(option("total")).getByText("writable")).toBeInTheDocument();
    expect(within(option("firmware_version")).getByText("read-only")).toBeInTheDocument();
    // A picker, not an editor: no value inputs beyond the search box.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("filters case-insensitively by name", () => {
    renderDialog();
    search("TEMP");
    expect(screen.getByText("temperature")).toBeInTheDocument();
    expect(screen.queryByText("total")).not.toBeInTheDocument();
  });

  it("filters by path, so an event name narrows the list", () => {
    renderDialog();
    search("power/");
    expect(screen.getByText("total")).toBeInTheDocument();
    expect(screen.getByText("frequency")).toBeInTheDocument();
    expect(screen.queryByText("temperature")).not.toBeInTheDocument();
  });

  it("filters by unit", () => {
    renderDialog();
    search("hz");
    expect(screen.getByText("frequency")).toBeInTheDocument();
    expect(screen.queryByText("total")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", () => {
    renderDialog();
    search("nothing-here");
    expect(screen.getByText(/No registers match/)).toBeInTheDocument();
  });

  it("adds the clicked register and closes, so the new row can be edited", () => {
    const { onAdd, onOpenChange } = renderDialog();
    fireEvent.click(option("total"));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({ path: "power/total" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("adds a register that is already in the table — duplicates are presets", () => {
    // Two visits, same register, no "already added" treatment anywhere.
    const { onAdd } = renderDialog();
    fireEvent.click(option("total"));
    expect(option("total")).toBeEnabled();
    expect(within(option("total")).queryByText("added")).not.toBeInTheDocument();
    fireEvent.click(option("total"));
    expect(onAdd.mock.calls.map((call) => (call[0] as RegisterEntry).path)).toEqual([
      "power/total",
      "power/total",
    ]);
  });

  it("starts a raw row from the button above the search, and closes", () => {
    const { onAdd, onAddRaw, onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /add raw row/i }));
    expect(onAddRaw).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers the raw row even when the device has no register map", () => {
    const { onAddRaw } = renderDialog({ registers: [] });
    expect(screen.getByText(/no register map/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add raw row/i }));
    expect(onAddRaw).toHaveBeenCalledTimes(1);
  });

  it("does not explain itself where the behavior is already obvious", () => {
    renderDialog();
    expect(screen.queryByText(/the dialog stays open/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/click one to add it/i)).not.toBeInTheDocument();
  });

  it("dismisses via the close button", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismisses on Escape", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe("filterRegisters", () => {
  it("keeps everything for an empty or whitespace query", () => {
    expect(filterRegisters(CATALOG, "")).toHaveLength(CATALOG.length);
    expect(filterRegisters(CATALOG, "   ")).toHaveLength(CATALOG.length);
  });

  it("matches name, path and unit, ignoring case", () => {
    expect(filterRegisters(CATALOG, "Firmware").map((r) => r.path)).toEqual([
      "inputs/firmware_version",
    ]);
    expect(filterRegisters(CATALOG, "STATUS/").map((r) => r.path)).toEqual(["status/temperature"]);
    expect(filterRegisters(CATALOG, "kw").map((r) => r.path)).toEqual(["power/total"]);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(filterRegisters(CATALOG, "zzz")).toEqual([]);
  });
});

describe("groupByEvent", () => {
  it("groups in first-seen order, preserving register order within a group", () => {
    expect(groupByEvent(CATALOG).map((g) => g.event)).toEqual(["power", "status", "inputs"]);
    expect(groupByEvent(CATALOG)[0]?.registers.map((r) => r.name)).toEqual(["total", "frequency"]);
  });

  it("regroups a register list that revisits an event", () => {
    const shuffled = [CATALOG[0], CATALOG[2], CATALOG[1]].filter(
      (r): r is RegisterEntry => r !== undefined,
    );
    const groups = groupByEvent(shuffled);
    expect(groups.map((g) => g.event)).toEqual(["power", "status"]);
    expect(groups[0]?.registers).toHaveLength(2);
  });

  it("returns nothing for an empty catalog", () => {
    expect(groupByEvent([])).toEqual([]);
  });
});
