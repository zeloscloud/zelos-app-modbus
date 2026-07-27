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

import { App } from "./App";

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
