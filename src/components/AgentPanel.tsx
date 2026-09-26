/** One panel per discovered agent. Header shows the agent address, a status
 *  badge, the Modbus extension version and a start/stop toggle; the body groups
 *  the extension's devices by connection, one DevicePanel per device. */

import { extensions, type BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { Loader2, Play, Square } from "lucide-react";

import { DevicePanel } from "@/components/DevicePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAction } from "@/hooks/use-action";
import { groupByConnection, remediation, type AgentStatus } from "@/lib/capability";
import type { NewWatchRow, RowPatch, WatchRow } from "@/lib/watch-store";

export interface AgentPanelProps {
  bridge: BridgeTransport;
  agent: AgentStatus;
  /** Table rows already filtered to this agent. */
  rows: readonly WatchRow[];
  onAddRow: (input: NewWatchRow) => WatchRow;
  onUpdateRow: (id: string, patch: RowPatch) => void;
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
  // `devices` is only ever populated on a ready agent, so the kind check the
  // resolver already made doesn't need making again here.
  const connections = groupByConnection(agent.devices ?? []);
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

        {agent.kind === "discovering-devices" && (
          <p className="text-xs text-muted-foreground">Discovering devices…</p>
        )}

        {agent.kind === "extension-starting" && (
          <p className="text-xs text-muted-foreground">
            The extension is running but hasn&apos;t registered its actions yet — this usually takes
            a moment.
          </p>
        )}
      </CardHeader>

      {connections.length > 0 && (
        <CardContent className="px-3 pt-2 pb-4">
          <div className="flex flex-col gap-4">
            {connections.map((conn) => (
              <section key={conn.connection} className="flex flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2 px-1 text-xs">
                  <strong className="text-sm">{conn.connection}</strong>
                  <Badge variant="outline" className="font-mono">
                    {conn.transport.toUpperCase()} {conn.endpoint}
                  </Badge>
                </div>
                {conn.devices.map((device) => (
                  <DevicePanel
                    key={device.name}
                    bridge={bridge}
                    agentAddress={agent.agent}
                    device={device}
                    rows={rows.filter((r) => r.device === device.name)}
                    onAddRow={onAddRow}
                    onUpdateRow={onUpdateRow}
                    onRemoveRow={onRemoveRow}
                  />
                ))}
              </section>
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
    case "discovering-devices":
      return null;
    case "extension-starting":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          extension starting
        </Badge>
      );
    case "extension-stopped":
      return <Badge variant="warning">extension stopped</Badge>;
    case "extension-outdated":
      return <Badge variant="warning">extension outdated</Badge>;
    case "no-devices":
      return <Badge variant="warning">no devices</Badge>;
    case "discovery-failed":
      return <Badge variant="destructive">discovery failed</Badge>;
    case "nothing-registered":
      return <Badge variant="warning">nothing registered</Badge>;
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
  const isRunning = state === "running";
  const { busy, run } = useAction<"start" | "stop">("Modbus extension", () => ({
    agent: agentAddress,
    extensionId,
  }));

  function toggle() {
    run(isRunning ? "stop" : "start", async () => {
      try {
        const target = { id: extensionId, agent: agentAddress };
        if (isRunning) await extensions.stop(bridge, target);
        else await extensions.start(bridge, target);
      } finally {
        // Refresh either way: a failed start still moved the extension's state.
        onRefresh();
      }
    });
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
