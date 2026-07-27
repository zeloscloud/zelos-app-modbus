/** One panel per discovered agent. Header shows the agent address, a status
 *  badge, the Modbus extension version and a start/stop toggle; the body is one
 *  InterfacePanel per interface the extension reported. */

import { extensions, type BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { Play, Square } from "lucide-react";
import * as React from "react";

import { InterfacePanel } from "@/components/InterfacePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { remediation, type AgentStatus } from "@/lib/capability";
import { reportActionFailure } from "@/lib/errors";
import type { NewRawRow, RawRow } from "@/lib/raw-store";

export interface AgentPanelProps {
  bridge: BridgeTransport;
  agent: AgentStatus;
  /** Raw rows already filtered to this agent. */
  rows: readonly RawRow[];
  onAddRow: (input: NewRawRow) => RawRow;
  onUpdateRow: (id: string, patch: Partial<RawRow>) => void;
  onRemoveRow: (id: string) => void;
  /** Re-runs the discovery queries so the UI reflects post-start/stop state. */
  onRefresh: () => void;
}

export function AgentPanel({
  bridge,
  agent,
  rows,
  onAddRow,
  onUpdateRow,
  onRemoveRow,
  onRefresh,
}: AgentPanelProps) {
  const interfaces = agent.kind === "ready" ? (agent.interfaces ?? []) : [];
  const fixIt = remediation(agent);

  return (
    <Card>
      <CardHeader className="space-y-2 px-6 pt-3 pb-1">
        <div className="flex flex-row items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="font-mono text-sm">{agent.agent}</CardTitle>
            <AgentBadge agent={agent} />
          </div>
          {agent.extension && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Modbus v{agent.extension.version}
              </span>
              <ExtensionToggle
                bridge={bridge}
                agentAddress={agent.agent}
                extensionId={agent.extension.id}
                state={agent.extension.state}
                onRefresh={onRefresh}
              />
            </div>
          )}
        </div>

        {fixIt && <p className="text-xs text-muted-foreground">{fixIt}</p>}

        {agent.kind === "extension-outdated" && agent.missingMethods?.length ? (
          <pre className="rounded bg-muted p-3 text-xs whitespace-pre-wrap">
            {`Extension is running but missing required actions:\n  ${agent.missingMethods.join("\n  ")}`}
          </pre>
        ) : null}

        {agent.kind === "discovering-interfaces" && (
          <p className="text-xs text-muted-foreground">Discovering interfaces…</p>
        )}
      </CardHeader>

      {interfaces.length > 0 && (
        <CardContent className="px-3 pt-2 pb-4">
          <div className="flex flex-col gap-4">
            {interfaces.map((iface) => (
              <InterfacePanel
                key={iface.name}
                bridge={bridge}
                agentAddress={agent.agent}
                iface={iface}
                rows={rows.filter((r) => r.interface === iface.name)}
                onAddRow={onAddRow}
                onUpdateRow={onUpdateRow}
                onRemoveRow={onRemoveRow}
              />
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function AgentBadge({ agent }: { agent: AgentStatus }) {
  switch (agent.kind) {
    case "ready":
    case "discovering-interfaces":
      return null;
    case "extension-stopped":
      return <Badge variant="warning">extension stopped</Badge>;
    case "extension-outdated":
      return <Badge variant="warning">extension outdated</Badge>;
    case "no-interfaces":
      return <Badge variant="warning">no interfaces</Badge>;
    case "extension-missing":
      return <Badge variant="destructive">extension not installed</Badge>;
  }
}

/** Start/Stop button for the agent's Modbus extension. Uses extensions.start
 *  with the host's last-saved config — there is no way for this UI to inject a
 *  config payload through the bridge surface, by design. */
function ExtensionToggle({
  bridge,
  agentAddress,
  extensionId,
  state,
  onRefresh,
}: {
  bridge: BridgeTransport;
  agentAddress: string;
  extensionId: string;
  state: string;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = React.useState<"start" | "stop" | null>(null);
  const isRunning = state === "running";

  async function toggle() {
    const op = isRunning ? "stop" : "start";
    setBusy(op);
    try {
      if (isRunning) {
        await extensions.stop(bridge, { id: extensionId, agent: agentAddress });
      } else {
        await extensions.start(bridge, { id: extensionId, agent: agentAddress });
      }
    } catch (e) {
      reportActionFailure(`${op === "stop" ? "Stop" : "Start"} Modbus extension`, e, {
        agent: agentAddress,
        extensionId,
      });
    } finally {
      setBusy(null);
      onRefresh();
    }
  }

  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-7 w-7"
      onClick={toggle}
      disabled={busy !== null}
      title={isRunning ? "Stop the Modbus extension" : "Start the Modbus extension"}
      aria-label={isRunning ? "Stop the Modbus extension" : "Start the Modbus extension"}
    >
      {isRunning ? (
        <Square className="h-3.5 w-3.5 text-red-500" />
      ) : (
        <Play className="h-3.5 w-3.5 text-emerald-500" />
      )}
    </Button>
  );
}
