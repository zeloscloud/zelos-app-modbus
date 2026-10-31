import { MockBridge } from "@zeloscloud/app-extension-sdk";
import { useTheme, useZelosBridge, ZelosBridgeProvider } from "@zeloscloud/app-extension-sdk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App";
import "../index.css";
import { installModbusMockHost, type MockScenario } from "../mocks/modbus-mock";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true },
  },
});

function MockHostBootstrap({ scenario }: { scenario: MockScenario }) {
  const { status, mode, bridge } = useZelosBridge();
  // Not the whole context: it changes on every update, and reinstalling resets the device.
  React.useEffect(() => {
    if (status !== "ready" || mode !== "standalone") return;
    if (!(bridge instanceof MockBridge)) return;
    return installModbusMockHost(bridge, { scenario });
  }, [status, mode, bridge, scenario]);
  return null;
}

function HostThemedToaster() {
  const theme = useTheme();
  const resolved = theme === null ? "system" : theme.resolvedDark ? "dark" : "light";
  return <Toaster position="bottom-right" theme={resolved} richColors closeButton />;
}

function readScenarioFromQuery(): MockScenario {
  if (typeof window === "undefined") return "ready";
  const param = new URLSearchParams(window.location.search).get("mock");
  switch (param) {
    case "extension-missing":
    case "extension-stopped":
    case "extension-outdated":
    case "extension-0.1.5":
    case "no-devices":
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
