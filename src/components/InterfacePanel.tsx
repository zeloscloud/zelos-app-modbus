/** One section per Modbus interface: a live status header, then the one table
 *  holding every row the user added to it — catalog registers and arbitrary
 *  addresses side by side, in insertion order.
 *
 *  An interface with no register map (`map_name === null`) is not a special case
 *  any more: its catalog is simply empty, so only raw rows can be added to it. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import * as React from "react";

import { AddRegisterDialog } from "@/components/AddRegisterDialog";
import { RegisterTable } from "@/components/RegisterTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRegisters } from "@/hooks/use-registers";
import { useSnapshot } from "@/hooks/use-snapshot";
import type { ModbusInterfaceEntry, RegisterEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { defaultRawRow, type NewWatchRow, type RowPatch, type WatchRow } from "@/lib/watch-store";

/** How long a snapshot response can go unrefreshed before the dot goes amber.
 *  The poll runs at 1 Hz, so 5 s means "several cycles have failed or stalled". */
const SNAPSHOT_STALE_MS = 5_000;

const NO_REGISTERS: readonly RegisterEntry[] = [];

export interface InterfacePanelProps {
  bridge: BridgeTransport;
  agentAddress: string;
  iface: ModbusInterfaceEntry;
  /** Rows already filtered to this (agent, interface), in insertion order. */
  rows: readonly WatchRow[];
  onAddRow: (input: NewWatchRow) => WatchRow;
  onUpdateRow: (id: string, patch: RowPatch) => void;
  onRemoveRow: (id: string) => void;
}

export function InterfacePanel({
  bridge,
  agentAddress,
  iface,
  rows,
  onAddRow,
  onUpdateRow,
  onRemoveRow,
}: InterfacePanelProps) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const snapshotQuery = useSnapshot(bridge, agentAddress, iface.name);
  const registersQuery = useRegisters(
    bridge,
    agentAddress,
    iface.name,
    iface.map_name,
    iface.register_count,
  );

  const snapshot = snapshotQuery.data;
  const snapshotError = snapshotQuery.error instanceof Error ? snapshotQuery.error : null;
  const stale =
    snapshotQuery.dataUpdatedAt > 0 && Date.now() - snapshotQuery.dataUpdatedAt > SNAPSHOT_STALE_MS;

  const registers = registersQuery.data?.registers ?? NO_REGISTERS;
  const catalogError = registersQuery.error instanceof Error ? registersQuery.error : null;
  // Named rows would flash as orphans if they rendered before the catalog they
  // join against, so a mapped interface waits for it. Raw rows don't care.
  const catalogPending = iface.map_name !== null && registersQuery.isLoading;
  // An interface with no map has nothing to join against and never will, so a
  // named row on it really is orphaned. A catalog that failed to load says
  // nothing about any row — those rows keep working on their paths alone.
  const catalogReady = iface.map_name === null || registersQuery.isSuccess;
  const retryCatalog = registersQuery.refetch;

  const openPicker = React.useCallback(() => setPickerOpen(true), []);
  const addRegister = React.useCallback(
    (reg: RegisterEntry) =>
      onAddRow({ kind: "named", agent: agentAddress, interface: iface.name, path: reg.path }),
    [onAddRow, agentAddress, iface.name],
  );
  const addRawRow = React.useCallback(
    () => onAddRow(defaultRawRow(agentAddress, iface.name)),
    [onAddRow, agentAddress, iface.name],
  );

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

      {/* The blurb + Add button, the table, and the dialog that feeds it. The
          table starts empty; the catalog is only ever browsed through the
          dialog. */}
      <div className="border-t border-border px-3 py-3">
        {catalogPending ? (
          <p className="text-xs text-muted-foreground">Loading register map…</p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Named values come from the extension&apos;s poll cache; a row&apos;s refresh button
                reads from the device.
              </p>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openPicker}>
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </div>

            {catalogError && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive"
              >
                <span>
                  Could not load the register map: {catalogError.message}. Rows below still read and
                  write — only their details are missing.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 text-[11px]"
                  onClick={() => void retryCatalog()}
                  disabled={registersQuery.isFetching}
                >
                  Retry
                </Button>
              </div>
            )}

            <RegisterTable
              bridge={bridge}
              agentAddress={agentAddress}
              interfaceName={iface.name}
              interfacePollInterval={iface.poll_interval}
              registers={registers}
              rows={rows}
              catalogReady={catalogReady}
              snapshot={snapshot}
              onUpdateRow={onUpdateRow}
              onRemoveRow={onRemoveRow}
              onAdd={openPicker}
            />

            <AddRegisterDialog
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              interfaceName={iface.name}
              registers={registers}
              onAdd={addRegister}
              onAddRaw={addRawRow}
            />
          </div>
        )}
      </div>
    </div>
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
  return <span className={cn("inline-block h-1.5 w-1.5 rounded-full", className)} />;
}
