import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@zeloscloud/app-extension-sdk/react", () => ({
  useExtensionInfo: () => ({
    id: "zeloscloud.zelos-app-modbus",
    name: "Modbus Control",
    version: "0.1.0",
  }),
  useZelosBridge: () => ({
    status: "ready",
    mode: "standalone",
    bridge: {
      mode: "standalone",
      invoke: vi.fn(),
      getSnapshot: vi.fn(),
      on: vi.fn(() => () => {}),
      destroy: vi.fn(),
    },
    error: null,
    extensionInfo: {
      id: "zeloscloud.zelos-app-modbus",
      name: "Modbus Control",
      version: "0.1.0",
    },
    theme: { preference: "DARK", resolvedDark: true, tokens: {} },
    workspace: { id: "ws", name: "ws", modeKind: "NONE" },
  }),
}));

import { App, strandedRows } from "./App";
import type { AgentStatus } from "@/lib/capability";
import type { ModbusInterfaceEntry } from "@/lib/types";
import type { WatchRow } from "@/lib/watch-store";

function withQueryClient(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("App", () => {
  it("renders extension identity in the header", () => {
    render(withQueryClient(<App />));
    expect(screen.getByText("Modbus Control")).toBeInTheDocument();
    expect(screen.getByText(/zeloscloud\.zelos-app-modbus/)).toBeInTheDocument();
  });

  it("shows the not-live disabled banner when workspace is not LIVE", () => {
    render(withQueryClient(<App />));
    expect(screen.getByText(/requires a LIVE workspace/i)).toBeInTheDocument();
  });
});

describe("strandedRows", () => {
  const iface = (name: string): ModbusInterfaceEntry => ({
    name,
    transport: "tcp",
    connected: true,
    connection: "127.0.0.1:502",
    unit_id: 1,
    source: "config.json",
    map_name: "power_meter",
    register_count: 1,
    poll_interval: 1,
    write_mode: "auto",
  });

  const row = (agent: string, ifaceName: string): WatchRow => ({
    id: `${agent}-${ifaceName}`,
    kind: "named",
    agent,
    interface: ifaceName,
    path: "power/total",
  });

  const ready: AgentStatus = {
    agent: "localhost",
    kind: "ready",
    interfaces: [iface("meter")],
  };

  it("leaves a row alone while its interface is on screen", () => {
    expect(strandedRows([row("localhost", "meter")], [ready])).toEqual([]);
  });

  it("surfaces a row whose interface isn't rendered anywhere", () => {
    const gone = row("localhost", "probe");
    expect(strandedRows([row("localhost", "meter"), gone], [ready])).toEqual([gone]);
  });

  it("surfaces a row whose agent isn't there at all", () => {
    const other = row("remote:2300", "meter");
    expect(strandedRows([other], [ready])).toEqual([other]);
  });

  it("surfaces every row while an agent has no interfaces to show yet", () => {
    // An agent that never resolves is exactly the case worth surfacing — its
    // rows would otherwise be invisible and undeletable.
    const stopped: AgentStatus = { agent: "localhost", kind: "extension-stopped" };
    const rows = [row("localhost", "meter")];
    expect(strandedRows(rows, [stopped])).toEqual(rows);
  });
});
