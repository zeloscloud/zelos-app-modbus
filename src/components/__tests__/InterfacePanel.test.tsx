/** End-to-end wiring for the one unified section, driven by the mock host:
 *  catalog fetch → empty table → dialog → a persisted row → read/write → delete.
 *  Everything below the bridge is the real code path (hooks, store, dialog,
 *  table, codec). */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InterfacePanel } from "../InterfacePanel";
import { useWatchRows } from "@/hooks/use-watch-rows";
import { listInterfaces } from "@/lib/modbus-bridge";
import type { ModbusInterfaceEntry } from "@/lib/types";
import { loadRows } from "@/lib/watch-store";
import { installedMockBridge } from "@/mocks/mock-bridge";

const AGENT = "localhost";

let teardown: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  teardown?.();
  teardown = null;
});

function makeHost(): BridgeTransport {
  const installed = installedMockBridge("ready");
  teardown = installed.teardown;
  return installed.bridge;
}

/** Mirrors App's ownership of the row list. */
function Harness({ bridge, iface }: { bridge: BridgeTransport; iface: ModbusInterfaceEntry }) {
  const { rows, addRow, updateRow, removeRow } = useWatchRows();
  return (
    <InterfacePanel
      bridge={bridge}
      agentAddress={AGENT}
      iface={iface}
      rows={rows.filter((r) => r.interface === iface.name)}
      onAddRow={addRow}
      onUpdateRow={updateRow}
      onRemoveRow={removeRow}
    />
  );
}

/** Wraps a bridge so a test can watch — or break — individual actions. */
function intercept(
  bridge: BridgeTransport,
  hooks: { calls?: string[]; failCatalogUntil?: { count: number } } = {},
): BridgeTransport {
  const inner = bridge.invoke.bind(bridge) as (m: string, p?: unknown) => Promise<unknown>;
  return {
    ...bridge,
    invoke: async (method: string, params?: unknown) => {
      const action = (params as { action?: string } | undefined)?.action ?? method;
      hooks.calls?.push(action);
      if (action === "modbus/list_registers" && (hooks.failCatalogUntil?.count ?? 0) > 0) {
        if (hooks.failCatalogUntil) hooks.failCatalogUntil.count -= 1;
        throw new Error("catalog unavailable");
      }
      return await inner(method, params);
    },
  } as unknown as BridgeTransport;
}

/** `mapped: false` picks the interface with no register map — the raw-only path. */
async function renderPanel({
  mapped = true,
  wrap,
}: { mapped?: boolean; wrap?: (bridge: BridgeTransport) => BridgeTransport } = {}) {
  const host = makeHost();
  const bridge = wrap ? wrap(host) : host;
  const interfaces = (await listInterfaces(host, AGENT)).interfaces;
  const iface = interfaces.find((i) => (mapped ? i.map_name !== null : i.map_name === null));
  if (!iface) throw new Error(`mock host has no ${mapped ? "mapped" : "raw-only"} interface`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Harness bridge={bridge} iface={iface} />
    </QueryClientProvider>,
  );
  /** Re-render as if `list_interfaces` had reported a changed interface. */
  const update = (patch: Partial<ModbusInterfaceEntry>) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness bridge={bridge} iface={{ ...iface, ...patch }} />
      </QueryClientProvider>,
    );
  return { iface, update };
}

/** Register options in the dialog are buttons wrapping the register name. */
function dialogOption(name: string): HTMLElement {
  const button = screen.getByText(name).closest("button");
  if (!button) throw new Error(`no dialog option for ${name}`);
  return button;
}

async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getAllByRole("button", { name: /^add$/i })[0] as HTMLElement);
  return await screen.findByRole("dialog");
}

async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

describe("InterfacePanel rows section", () => {
  it("adds a register through the dialog, then deletes it", async () => {
    const { iface } = await renderPanel();

    // The catalog loads, but the table stays empty until the user opts in.
    expect(await screen.findByText(/No rows yet/)).toBeInTheDocument();
    expect(screen.queryByText("power/total")).not.toBeInTheDocument();

    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(iface.name);
    fireEvent.click(dialogOption("total"));

    // Adding closes the dialog — the new row is what the user wants next.
    await dialogClosed();

    // The row is in the table, joined to catalog metadata, and persisted.
    const row = (await screen.findByText("power/total")).closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("12 (0x000c)");
    expect(loadRows().map((r) => (r.kind === "named" ? r.path : "raw"))).toEqual(["power/total"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove power/total from the table" }));
    expect(await screen.findByText(/No rows yet/)).toBeInTheDocument();
    expect(loadRows()).toEqual([]);
  });

  it("adds the same register twice, so it can hold two write presets", async () => {
    await renderPanel();
    await screen.findByText(/No rows yet/);

    await openDialog();
    fireEvent.click(dialogOption("total"));
    await dialogClosed();
    await openDialog();
    fireEvent.click(dialogOption("total"));
    await dialogClosed();

    const inputs = await screen.findAllByLabelText("New value for power/total");
    expect(inputs).toHaveLength(2);

    // Each row latches its own value, and each survives a reload.
    fireEvent.change(inputs[0] as HTMLElement, { target: { value: "10" } });
    fireEvent.change(inputs[1] as HTMLElement, { target: { value: "20" } });
    expect(loadRows().map((r) => r.draft)).toEqual(["10", "20"]);
  });

  it("restores rows saved before raw rows existed, flagging a path the map lost", async () => {
    // No `kind` field: exactly what the previous version persisted.
    window.localStorage.setItem(
      "zelos-app-modbus.watch-rows.v1",
      JSON.stringify([
        { id: "a", agent: AGENT, interface: "meter", path: "power/total" },
        { id: "b", agent: AGENT, interface: "meter", path: "retired/register" },
      ]),
    );
    await renderPanel();

    expect(await screen.findByText("power/total")).toBeInTheDocument();
    expect(screen.getByText("retired/register")).toBeInTheDocument();
    expect(screen.getByText("not in current register map")).toBeInTheDocument();
    expect(screen.queryByText(/No rows yet/)).not.toBeInTheDocument();
  });

  it("holds named and raw rows in one table, with no tabs to switch between", async () => {
    await renderPanel();
    await screen.findByText(/No rows yet/);

    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /add raw row/i }));
    await dialogClosed();
    await openDialog();
    fireEvent.click(dialogOption("total"));
    await dialogClosed();

    // Header + the two rows.
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));
    expect(screen.getByLabelText("Raw address")).toBeInTheDocument();
    expect(screen.getByText("power/total")).toBeInTheDocument();
    // The old two-tab section is gone.
    expect(screen.queryByRole("button", { name: "Raw access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registers" })).not.toBeInTheDocument();
  });

  it("adds a raw row, edits it inline, writes it, reads it back, then deletes it", async () => {
    await renderPanel();
    await screen.findByText(/No rows yet/);

    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /add raw row/i }));

    // It arrives on the defaults, ready to edit.
    const address = await screen.findByLabelText("Raw address");
    expect(address).toHaveValue("0");
    expect(loadRows()[0]).toMatchObject({
      kind: "raw",
      address: "0",
      table: "holding",
      datatype: "uint16",
    });

    // Retarget it at an address the fake device isn't already using.
    fireEvent.change(address, { target: { value: "500" } });
    expect(loadRows()[0]).toMatchObject({ address: "500" });

    fireEvent.change(screen.getByLabelText(/^New value for raw holding uint16/), {
      target: { value: "4321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));

    // The read-back after the write is the only receipt a raw row gets.
    const row = screen.getAllByRole("row")[1] as HTMLElement;
    await waitFor(() => expect(within(row).getByText("4321")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^Remove raw holding uint16 @ 500/ }));
    expect(await screen.findByText(/No rows yet/)).toBeInTheDocument();
    expect(loadRows()).toEqual([]);
  });

  it("serves an interface with no register map through the same section", async () => {
    const { iface } = await renderPanel({ mapped: false });
    expect(iface.map_name).toBeNull();

    expect(await screen.findByText(/No rows yet/)).toBeInTheDocument();
    expect(screen.getByText("raw only")).toBeInTheDocument();

    const dialog = await openDialog();
    // Nothing to pick from, but a raw row is still one click away.
    expect(within(dialog).getByText(/no register map/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /add raw row/i }));

    expect(await screen.findByLabelText("Raw address")).toBeInTheDocument();
    expect(loadRows()).toHaveLength(1);
  });
});

describe("InterfacePanel when the catalog can't be loaded", () => {
  it("keeps the rows working instead of calling them orphans", async () => {
    window.localStorage.setItem(
      "zelos-app-modbus.watch-rows.v1",
      JSON.stringify([
        { id: "a", agent: AGENT, interface: "meter", kind: "named", path: "power/total" },
      ]),
    );
    await renderPanel({ wrap: (b) => intercept(b, { failCatalogUntil: { count: 99 } }) });

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent(/Could not load the register map/);
    // The row is still a row: it just doesn't know its own metadata.
    expect(screen.getByText("power/total")).toBeInTheDocument();
    expect(screen.queryByText("not in current register map")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^read power\/total/i })).toBeEnabled();
    expect(screen.getByLabelText("New value for power/total")).toBeEnabled();
  });

  it("retries the catalog on demand, and joins the rows once it lands", async () => {
    window.localStorage.setItem(
      "zelos-app-modbus.watch-rows.v1",
      JSON.stringify([
        { id: "a", agent: AGENT, interface: "meter", kind: "named", path: "power/total" },
      ]),
    );
    // Fails once, then works.
    await renderPanel({ wrap: (b) => intercept(b, { failCatalogUntil: { count: 1 } }) });

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // The catalog arrives: the row picks up its address and the banner goes.
    expect(await screen.findByText("12 (0x000c)")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refetches the catalog when the interface's register count changes", async () => {
    const calls: string[] = [];
    const { update } = await renderPanel({ wrap: (b) => intercept(b, { calls }) });
    await screen.findByText(/No rows yet/);
    const before = calls.filter((a) => a === "modbus/list_registers").length;
    expect(before).toBeGreaterThan(0);

    // A restart can swap a map's contents without renaming it; the count is the
    // observable that moves.
    update({ register_count: 99 });

    await waitFor(() =>
      expect(calls.filter((a) => a === "modbus/list_registers").length).toBe(before + 1),
    );
  });
});
