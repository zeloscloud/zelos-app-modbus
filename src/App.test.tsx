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
import { deviceEntry } from "@/components/__tests__/register-fixtures";
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
  const device = (name: string) => deviceEntry({ name: `meter_panel/${name}`, device: name });

  const row = (agent: string, name: string): WatchRow => ({
    id: `${agent}-${name}`,
    kind: "named",
    agent,
    device: `meter_panel/${name}`,
    path: "power/total",
  });

  const ready: AgentStatus = {
    agent: "localhost",
    kind: "ready",
    devices: [device("unit1")],
  };

  it("leaves a row alone while its device is on screen", () => {
    expect(strandedRows([row("localhost", "unit1")], [ready])).toEqual([]);
  });

  it("surfaces a row whose device isn't rendered anywhere", () => {
    const gone = row("localhost", "unit2");
    expect(strandedRows([row("localhost", "unit1"), gone], [ready])).toEqual([gone]);
  });

  it("surfaces a row whose agent isn't there at all", () => {
    const other = row("remote:2300", "unit1");
    expect(strandedRows([other], [ready])).toEqual([other]);
  });

  it("surfaces every row while an agent has no devices to show yet", () => {
    // An agent that never resolves is exactly the case worth surfacing — its
    // rows would otherwise be invisible and undeletable.
    const stopped: AgentStatus = { agent: "localhost", kind: "extension-stopped" };
    const rows = [row("localhost", "unit1")];
    expect(strandedRows(rows, [stopped])).toEqual(rows);
  });
});
