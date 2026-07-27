import { MockBridge } from "@zeloscloud/app-extension-sdk";
import { useTheme, useZelosBridge, ZelosBridgeProvider } from "@zeloscloud/app-extension-sdk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App";
import "./index.css";
import { installModbusMockHost, type MockScenario } from "./mocks/modbus-mock";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true },
  },
});

/** Installs the mock host scenario whenever the bridge enters standalone mode.
 *  Embedded mode is a no-op: the real desktop host owns invoke dispatch. */
function MockHostBootstrap({ scenario }: { scenario: MockScenario }) {
  const bridge = useZelosBridge();
  React.useEffect(() => {
    if (bridge.status !== "ready" || bridge.mode !== "standalone") return;
    if (!(bridge.bridge instanceof MockBridge)) return;
    return installModbusMockHost(bridge.bridge, { scenario });
  }, [bridge, scenario]);
  return null;
}

/** Toasts follow the host's resolved theme rather than hardcoding dark — the
 *  desktop app's theme toggle has to move the toasts too. `null` theme (bridge
 *  still connecting) defers to the OS via sonner's "system". */
function HostThemedToaster() {
  const theme = useTheme();
  const resolved = theme === null ? "system" : theme.resolvedDark ? "dark" : "light";
  return <Toaster position="bottom-right" theme={resolved} richColors closeButton />;
}

/** Override via `?mock=extension-stopped` (etc.) in standalone dev to exercise
 *  any capability state without editing source. */
function readScenarioFromQuery(): MockScenario {
  if (typeof window === "undefined") return "ready";
  const param = new URLSearchParams(window.location.search).get("mock");
  switch (param) {
    case "extension-missing":
    case "extension-stopped":
    case "extension-outdated":
    case "no-interfaces":
    case "multi-agent":
      return param;
    default:
      return "ready";
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element");
}

const scenario = readScenarioFromQuery();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ZelosBridgeProvider>
      <QueryClientProvider client={queryClient}>
        <MockHostBootstrap scenario={scenario} />
        <App />
        <HostThemedToaster />
      </QueryClientProvider>
    </ZelosBridgeProvider>
  </React.StrictMode>,
);
