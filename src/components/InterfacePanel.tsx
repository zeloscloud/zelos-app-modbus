/** One section per Modbus interface: a live status header, then either the named
 *  register table or the raw-access rows.
 *
 *  An interface with no register map (`map_name === null`) has nothing to put in
 *  the Registers tab, so it renders raw access only. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { AlertCircle, Loader2 } from "lucide-react";
import * as React from "react";

import { RawPanel } from "@/components/RawPanel";
import { RegisterTable } from "@/components/RegisterTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRegisters } from "@/hooks/use-registers";
import { useSnapshot } from "@/hooks/use-snapshot";
import type { NewRawRow, RawRow } from "@/lib/raw-store";
import type { ModbusInterfaceEntry } from "@/lib/types";

/** How long a snapshot response can go unrefreshed before the dot goes amber.
 *  The poll runs at 1 Hz, so 5 s means "several cycles have failed or stalled". */
const SNAPSHOT_STALE_MS = 5_000;

export interface InterfacePanelProps {
  bridge: BridgeTransport;
  agentAddress: string;
  iface: ModbusInterfaceEntry;
  /** Raw rows already filtered to this (agent, interface). */
  rows: readonly RawRow[];
  onAddRow: (input: NewRawRow) => RawRow;
  onUpdateRow: (id: string, patch: Partial<RawRow>) => void;
  onRemoveRow: (id: string) => void;
}

type Tab = "registers" | "raw";

export function InterfacePanel({
  bridge,
  agentAddress,
  iface,
  rows,
  onAddRow,
  onUpdateRow,
  onRemoveRow,
}: InterfacePanelProps) {
  const rawOnly = iface.map_name === null;
  const [tab, setTab] = React.useState<Tab>(rawOnly ? "raw" : "registers");

  const snapshotQuery = useSnapshot(bridge, agentAddress, iface.name);
  const registersQuery = useRegisters(bridge, agentAddress, iface.name, iface.map_name);

  const snapshot = snapshotQuery.data;
  const snapshotError = snapshotQuery.error instanceof Error ? snapshotQuery.error : null;
  const stale =
    snapshotQuery.dataUpdatedAt > 0 && Date.now() - snapshotQuery.dataUpdatedAt > SNAPSHOT_STALE_MS;

  return (
    <div className="rounded-lg border border-border bg-background/40">
      <div className="flex flex-col gap-1 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <strong className="text-sm">{iface.name}</strong>
          <Badge variant="outline" className="font-mono">
            {iface.transport.toUpperCase()} {iface.connection}
          </Badge>
          {snapshotError ? (
            <Badge variant="destructive" className="gap-1">
              <AlertCircle className="h-3 w-3" />
              snapshot error
            </Badge>
          ) : snapshot === undefined ? (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              loading
            </Badge>
          ) : (
            <ConnectionBadge connected={snapshot.connected} stale={stale} />
          )}
          {iface.map_name !== null ? (
            <span className="text-muted-foreground">map {iface.map_name}</span>
          ) : (
            <Badge variant="warning">raw only</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          <span>unit {iface.unit_id}</span>
          <span>polls {snapshot?.poll_count ?? "—"}</span>
          <span>errors {snapshot?.error_count ?? "—"}</span>
          <span>every {iface.poll_interval}s</span>
          <span>write {iface.write_mode}</span>
          <span>{iface.register_count} regs</span>
        </div>
        {snapshotError && <p className="text-[11px] text-destructive">{snapshotError.message}</p>}
      </div>

      <div className="border-t border-border px-3 py-3 space-y-3">
        {rawOnly ? (
          <p className="text-xs text-muted-foreground">
            This interface has no register map, so there are no named registers to show. Use raw
            access below, or add a <code>register_map</code> to the interface&apos;s config.
          </p>
        ) : (
          <div className="flex items-center gap-1">
            <TabButton active={tab === "registers"} onClick={() => setTab("registers")}>
              Registers
            </TabButton>
            <TabButton active={tab === "raw"} onClick={() => setTab("raw")}>
              Raw access
            </TabButton>
          </div>
        )}

        {tab === "registers" && !rawOnly && (
          <RegistersTabBody
            bridge={bridge}
            agentAddress={agentAddress}
            iface={iface}
            registers={registersQuery.data?.registers ?? null}
            isLoading={registersQuery.isLoading}
            error={registersQuery.error instanceof Error ? registersQuery.error : null}
            snapshot={snapshot}
          />
        )}

        {tab === "raw" && (
          <RawPanel
            bridge={bridge}
            agentAddress={agentAddress}
            interfaceName={iface.name}
            rows={rows}
            onAddRow={onAddRow}
            onUpdateRow={onUpdateRow}
            onRemoveRow={onRemoveRow}
          />
        )}
      </div>
    </div>
  );
}

function RegistersTabBody({
  bridge,
  agentAddress,
  iface,
  registers,
  isLoading,
  error,
  snapshot,
}: {
  bridge: BridgeTransport;
  agentAddress: string;
  iface: ModbusInterfaceEntry;
  registers: React.ComponentProps<typeof RegisterTable>["registers"] | null;
  isLoading: boolean;
  error: Error | null;
  snapshot: React.ComponentProps<typeof RegisterTable>["snapshot"];
}) {
  if (error) {
    return (
      <p className="text-xs text-destructive">Could not load the register map: {error.message}</p>
    );
  }
  if (registers === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {isLoading ? "Loading register map…" : "No register map returned."}
      </p>
    );
  }
  if (registers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        The register map <code>{iface.map_name}</code> has no registers.
      </p>
    );
  }
  return (
    <RegisterTable
      bridge={bridge}
      agentAddress={agentAddress}
      interfaceName={iface.name}
      interfacePollInterval={iface.poll_interval}
      registers={registers}
      snapshot={snapshot}
    />
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "secondary" : "ghost"}
      onClick={onClick}
      aria-pressed={active}
      className="h-7 px-3 text-xs"
    >
      {children}
    </Button>
  );
}

function ConnectionBadge({ connected, stale }: { connected: boolean; stale: boolean }) {
  if (!connected) {
    return (
      <Badge variant="destructive" className="gap-1">
        <Dot className="bg-red-200" />
        disconnected
      </Badge>
    );
  }
  if (stale) {
    return (
      <Badge variant="warning" className="gap-1">
        <Dot className="bg-amber-500" />
        stale
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="gap-1">
      <Dot className="bg-emerald-500" />
      connected
    </Badge>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${className}`} />;
}
