/** Orchestration shell. One AgentPanel per discovered agent; the localStorage
 *  raw-row list lives here so rows survive interface/agent re-renders and can be
 *  filtered per (agent, interface) on the way down. */

import { useExtensionInfo, useZelosBridge } from "@zeloscloud/app-extension-sdk/react";
import { Copy, RefreshCw } from "lucide-react";
import React from "react";

import { AgentPanel } from "@/components/AgentPanel";
import { CapabilityBanner } from "@/components/CapabilityBanner";
import { Button } from "@/components/ui/button";
import { useModbusDiscovery } from "@/hooks/use-capability";
import { useRawRows } from "@/hooks/use-raw-rows";
import { copyToClipboard } from "@/lib/clipboard";
import type { WorkspaceModeKind } from "@/lib/types";

export function App() {
  const bridge = useZelosBridge();
  const info = useExtensionInfo();

  if (bridge.status === "loading") {
    return <CenteredMessage>Connecting to Zelos…</CenteredMessage>;
  }
  if (bridge.status === "error") {
    return <CenteredMessage variant="error">{bridge.error.message}</CenteredMessage>;
  }

  return (
    <main className="min-h-screen bg-background p-6 space-y-4">
      <header>
        <h1 className="text-xl font-semibold">{info?.name ?? "Modbus Control"}</h1>
        <p className="text-xs text-muted-foreground">
          {info?.id} · v{info?.version}
        </p>
      </header>

      <DiscoveryView
        bridge={bridge.bridge}
        bridgeMode={bridge.mode}
        workspaceModeKind={bridge.workspace?.modeKind ?? "NONE"}
        appId={info?.id ?? null}
        appVersion={info?.version ?? null}
      />
    </main>
  );
}

function DiscoveryView({
  bridge,
  bridgeMode,
  workspaceModeKind,
  appId,
  appVersion,
}: {
  bridge: import("@zeloscloud/app-extension-sdk").BridgeTransport;
  bridgeMode: "embedded" | "standalone";
  workspaceModeKind: WorkspaceModeKind;
  appId: string | null;
  appVersion: string | null;
}) {
  const { discovery, isLoading, refetch } = useModbusDiscovery({ bridge, workspaceModeKind });
  const { rows, addRow, updateRow, removeRow } = useRawRows();
  const [copyToast, setCopyToast] = React.useState<string | null>(null);

  const handleCopyLogs = React.useCallback(async () => {
    const log = {
      timestamp: new Date().toISOString(),
      app: { id: appId, version: appVersion },
      bridge: { mode: bridgeMode, workspaceMode: workspaceModeKind },
      discovery,
      rawRows: rows,
    };
    const text = JSON.stringify(log, null, 2);
    console.log("[MODBUS debug log]\n" + text);
    const ok = await copyToClipboard(text);
    setCopyToast(ok ? "Copied to clipboard" : "Clipboard blocked — see devtools console");
    window.setTimeout(() => setCopyToast(null), 2500);
  }, [appId, appVersion, bridgeMode, workspaceModeKind, discovery, rows]);

  if (discovery.kind === "disabled") {
    return <CapabilityBanner reason={discovery.reason} onRefresh={refetch} />;
  }

  if (isLoading && discovery.agents.length === 0) {
    return <CenteredMessage>Discovering agents…</CenteredMessage>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {discovery.agents.length} agent{discovery.agents.length === 1 ? "" : "s"} · {bridgeMode}
        </p>
        <div className="flex items-center gap-2">
          {copyToast && <span className="text-xs text-muted-foreground">{copyToast}</span>}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLogs}
            title="Copy a JSON debug snapshot to the clipboard"
          >
            <Copy className="h-3 w-3" />
            Copy logs
          </Button>
          <Button variant="outline" size="sm" onClick={refetch}>
            <RefreshCw className="h-3 w-3" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {discovery.agents.map((agent) => (
          <AgentPanel
            key={agent.agent}
            bridge={bridge}
            agent={agent}
            rows={rows.filter((r) => r.agent === agent.agent)}
            onAddRow={addRow}
            onUpdateRow={updateRow}
            onRemoveRow={removeRow}
            onRefresh={refetch}
          />
        ))}
      </div>
    </div>
  );
}

function CenteredMessage({
  children,
  variant = "info",
}: {
  children: React.ReactNode;
  variant?: "info" | "error";
}) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <p
        className={
          variant === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
        }
      >
        {children}
      </p>
    </div>
  );
}
