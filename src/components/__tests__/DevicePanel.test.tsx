/** End-to-end wiring for the one unified section, driven by the mock host:
 *  catalog fetch → empty table → dialog → a persisted row → read/write → delete.
 *  Everything below the bridge is the real code path (hooks, store, dialog,
 *  table, codec). */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DevicePanel, mapState, type MapState } from "../DevicePanel";
import { useWatchRows } from "@/hooks/use-watch-rows";
import { listDevices } from "@/lib/modbus-bridge";
import type { ModbusDeviceEntry, ModbusSnapshot } from "@/lib/types";
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
function Harness({ bridge, device }: { bridge: BridgeTransport; device: ModbusDeviceEntry }) {
  const { rows, addRow, updateRow, removeRow } = useWatchRows();
  return (
    <DevicePanel
      bridge={bridge}
      agentAddress={AGENT}
      device={device}
      rows={rows.filter((r) => r.device === device.name)}
      onAddRow={addRow}
      onUpdateRow={updateRow}
      onRemoveRow={removeRow}
    />
  );
}

/** Wraps a bridge so a test can watch — or break — individual actions. */
function intercept(
  bridge: BridgeTransport,
  hooks: {
    calls?: string[];
    failCatalogUntil?: { count: number };
    snapshot?: Partial<ModbusSnapshot>;
  } = {},
): BridgeTransport {
  const inner = bridge.invoke.bind(bridge) as (m: string, p?: unknown) => Promise<unknown>;
  return {
    ...bridge,
    invoke: async (method: string, params?: unknown) => {
      const action = (params as { action?: string } | undefined)?.action ?? method;
      hooks.calls?.push(action);
      if (action === "Modbus/list_registers" && (hooks.failCatalogUntil?.count ?? 0) > 0) {
        if (hooks.failCatalogUntil) hooks.failCatalogUntil.count -= 1;
        throw new Error("catalog unavailable");
      }
      const res = await inner(method, params);
      if (action !== "Modbus/get_snapshot" || !hooks.snapshot) return res;
      const done = res as { result: ModbusSnapshot };
      return { ...done, result: { ...done.result, ...hooks.snapshot } };
    },
  } as unknown as BridgeTransport;
}

/** `mapped: false` picks the device with no register map — the raw-only path;
 *  `name` picks one device outright. */
async function renderPanel({
  mapped = true,
  name,
  wrap,
}: {
  mapped?: boolean;
  name?: string;
  wrap?: (bridge: BridgeTransport) => BridgeTransport;
} = {}) {
  const host = makeHost();
  const bridge = wrap ? wrap(host) : host;
  const devices = (await listDevices(host, AGENT)).devices;
  const device = devices.find((d) =>
    name !== undefined ? d.name === name : mapped ? d.map_name !== null : d.map_name === null,
  );
  if (!device) throw new Error(`mock host has no ${mapped ? "mapped" : "raw-only"} device`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Harness bridge={bridge} device={device} />
    </QueryClientProvider>,
  );
  /** Re-render as if `list_devices` had reported a changed device. */
  const update = (patch: Partial<ModbusDeviceEntry>) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <Harness bridge={bridge} device={{ ...device, ...patch }} />
      </QueryClientProvider>,
    );
  return { device, update, host };
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

describe("DevicePanel rows section", () => {
  it("adds a register through the dialog, then deletes it", async () => {
    const { device } = await renderPanel();

    // The catalog loads, but the table stays empty until the user opts in.
    expect(await screen.findByText(/No rows yet/)).toBeInTheDocument();
    expect(screen.queryByText("power/total")).not.toBeInTheDocument();

    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(device.name);
    fireEvent.click(dialogOption("total"));

    // Adding closes the dialog — the new row is what the user wants next.
    await dialogClosed();

    // The row is in the table, joined to catalog metadata, and persisted.
    const row = (await screen.findByText("power/total")).closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("13 (0x000d)");
    expect(loadRows().map((r) => (r.kind === "named" ? r.path : "raw"))).toEqual(["power/total"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove power/total from the table" }));
    expect(await screen.findByText(/No rows yet/)).toBeInTheDocument();
    expect(loadRows()).toEqual([]);
  });

  it("adds the same register twice, so it can hold two write presets", async () => {
    await renderPanel();
    await screen.findByText(/No rows yet/);

    await openDialog();
    fireEvent.click(dialogOption("voltage_high_limit"));
    await dialogClosed();
    await openDialog();
    fireEvent.click(dialogOption("voltage_high_limit"));
    await dialogClosed();

    const inputs = await screen.findAllByLabelText("New value for setpoints/voltage_high_limit");
    expect(inputs).toHaveLength(2);

    // Each row latches its own value, and each survives a reload.
    fireEvent.change(inputs[0] as HTMLElement, { target: { value: "10" } });
    fireEvent.change(inputs[1] as HTMLElement, { target: { value: "20" } });
    expect(loadRows().map((r) => r.draft)).toEqual(["10", "20"]);
  });

  it("restores saved rows, flagging a path the map lost", async () => {
    window.localStorage.setItem(
      "zelos-app-modbus.watch-rows.v2",
      JSON.stringify([
        { id: "a", agent: AGENT, device: "meter_panel/unit1", kind: "named", path: "power/total" },
        {
          id: "b",
          agent: AGENT,
          device: "meter_panel/unit1",
          kind: "named",
          path: "retired/register",
        },
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
    expect(address).toHaveValue("1");
    expect(loadRows()[0]).toMatchObject({
      kind: "raw",
      address: "1",
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

  it("serves a device with no register map through the same section", async () => {
    const { device } = await renderPanel({ mapped: false });
    expect(device.map_name).toBeNull();

    expect(await screen.findByText(/No rows yet/)).toBeInTheDocument();
    expect(screen.getByText("raw only")).toBeInTheDocument();

    const dialog = await openDialog();
    // Nothing to pick from, but a raw row is still one click away.
    expect(within(dialog).getByText(/no register map/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /add raw row/i }));

    expect(await screen.findByLabelText("Raw address")).toBeInTheDocument();
    expect(loadRows()).toHaveLength(1);
  });

  it("flags a demoted, overloaded device from the snapshot", async () => {
    const snapshot = {
      demoted: true,
      retry_in_s: 19.2,
      requested_rate: 1,
      achieved_rate: 2.5,
      overload_pct: 150,
      failed_reads: 3,
      refused: [{ range: "holding 40001-40010", code: 2, retry_in_s: 539.4 }],
    };
    await renderPanel({ wrap: (b) => intercept(b, { snapshot }) });

    expect(await screen.findByText("demoted, retry in 20s")).toBeInTheDocument();
    expect(screen.getByText("1 block refused")).toBeInTheDocument();
    expect(
      screen.getByText("holding 40001-40010 refused (exception 02), retry in 540s"),
    ).toBeInTheDocument();
    expect(screen.getByText("rate 1s (achieved 2.5s)")).toHaveClass("text-amber-600");
    expect(screen.getByText("failed 3")).toHaveClass("text-amber-600");
  });

  const map = { map_name: null, map_pending: false, error: null };
  it.each<[string, Parameters<typeof mapState>[0], Parameters<typeof mapState>[1], MapState]>([
    ["mapped", { ...map, map_name: "m" }, undefined, { kind: "mapped", name: "m" }],
    ["raw only", map, map, { kind: "raw" }],
    ["discovering", { ...map, map_pending: true }, undefined, { kind: "pending" }],
    // The snapshot calls it done; list_devices has yet to name the map.
    ["pending until named", { ...map, map_pending: true }, map, { kind: "pending" }],
    [
      "failed, while retrying",
      map,
      { map_pending: true, error: "boom" },
      { kind: "failed", error: "boom" },
    ],
    // The fresher snapshot clears a stale list_devices error.
    ["recovered", { ...map, error: "boom" }, map, { kind: "raw" }],
    [
      "auto-scanned",
      { ...map, auto_scan: { state: "scanning", table: "holding", found: 0, ignored: 0 } },
      { ...map, auto_scan: { state: "done", table: null, found: 3, ignored: 1 } },
      { kind: "auto-scan", scan: { state: "done", table: null, found: 3, ignored: 1 } },
    ],
  ])("reads the register map as %s", (_, device, snapshot, expected) => {
    expect(mapState(device, snapshot)).toEqual(expected);
  });

  it("offers an auto-scanned device's discovered registers as named rows", async () => {
    const { device, update, host } = await renderPanel({ name: "dev_ttyUSB0/scanner" });
    expect(
      await screen.findByText("scanning Holding registers (4x, FC03)… 0 found"),
    ).toBeInTheDocument();
    expect(screen.queryByText("raw only")).not.toBeInTheDocument();

    // The scan finds a register per tick; list_devices' count refetches the catalog.
    let found: ModbusDeviceEntry | undefined;
    await waitFor(
      async () => {
        found = (await listDevices(host, AGENT)).devices.find((d) => d.name === device.name);
        expect(found?.register_count).toBeGreaterThan(0);
      },
      { timeout: 3_000 },
    );
    if (found) update(found);
    await waitFor(() => expect(screen.queryByText("Loading register map…")).toBeNull());
    await openDialog();
    expect(await screen.findByText("1_value")).toBeInTheDocument();
  });

  it("shows disconnected instead of a rate while the link is down", async () => {
    const snapshot = { connected: false, requested_rate: 1, achieved_rate: null };
    await renderPanel({ wrap: (b) => intercept(b, { snapshot }) });
    expect(await screen.findByText("rate 1s (disconnected)")).toBeInTheDocument();
  });
});

describe("DevicePanel when the catalog can't be loaded", () => {
  it("keeps the rows working instead of calling them orphans", async () => {
    window.localStorage.setItem(
      "zelos-app-modbus.watch-rows.v2",
      JSON.stringify([
        { id: "a", agent: AGENT, device: "meter_panel/unit1", kind: "named", path: "power/total" },
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
      "zelos-app-modbus.watch-rows.v2",
      JSON.stringify([
        { id: "a", agent: AGENT, device: "meter_panel/unit1", kind: "named", path: "power/total" },
      ]),
    );
    // Fails once, then works.
    await renderPanel({ wrap: (b) => intercept(b, { failCatalogUntil: { count: 1 } }) });

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // The catalog arrives: the row picks up its address and the banner goes.
    expect(await screen.findByText("13 (0x000d)")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refetches the catalog when the device's register count changes", async () => {
    const calls: string[] = [];
    const { update } = await renderPanel({ wrap: (b) => intercept(b, { calls }) });
    await screen.findByText(/No rows yet/);
    const before = calls.filter((a) => a === "Modbus/list_registers").length;
    expect(before).toBeGreaterThan(0);

    // A restart can swap a map's contents without renaming it; the count is the
    // observable that moves.
    update({ register_count: 99 });

    await waitFor(() =>
      expect(calls.filter((a) => a === "Modbus/list_registers").length).toBe(before + 1),
    );
  });
});
