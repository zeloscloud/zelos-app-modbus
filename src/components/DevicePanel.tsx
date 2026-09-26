/** One section per Modbus device: a live status header, then the one table
 *  holding every row the user added to it — catalog registers and arbitrary
 *  addresses side by side, in insertion order.
 *
 *  A device with no register map (`map_name === null`) is not a special case
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
import type { ModbusDeviceEntry, PollHealth, RegisterEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { defaultRawRow, type NewWatchRow, type RowPatch, type WatchRow } from "@/lib/watch-store";

/** How long a snapshot response can go unrefreshed before the dot goes amber.
 *  The poll runs at 1 Hz, so 5 s means "several cycles have failed or stalled". */
const SNAPSHOT_STALE_MS = 5_000;

const NO_REGISTERS: readonly RegisterEntry[] = [];

/** Achieved slower than 2× requested: the device can't keep up. */
const OVERLOAD_WARN_PCT = 100;

export interface DevicePanelProps {
  bridge: BridgeTransport;
  agentAddress: string;
  device: ModbusDeviceEntry;
  /** Rows already filtered to this (agent, device), in insertion order. */
  rows: readonly WatchRow[];
  onAddRow: (input: NewWatchRow) => WatchRow;
  onUpdateRow: (id: string, patch: RowPatch) => void;
  onRemoveRow: (id: string) => void;
}

export function DevicePanel({
  bridge,
  agentAddress,
  device,
  rows,
  onAddRow,
  onUpdateRow,
  onRemoveRow,
}: DevicePanelProps) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const snapshotQuery = useSnapshot(bridge, agentAddress, device.name);
  const registersQuery = useRegisters(
    bridge,
    agentAddress,
    device.name,
    device.map_name,
    device.register_count,
    device.address_base,
  );

  const snapshot = snapshotQuery.data;
  const snapshotError = snapshotQuery.error instanceof Error ? snapshotQuery.error : null;
  const stale =
    snapshotQuery.dataUpdatedAt > 0 && Date.now() - snapshotQuery.dataUpdatedAt > SNAPSHOT_STALE_MS;

  const registers = registersQuery.data?.registers ?? NO_REGISTERS;
  const catalogError = registersQuery.error instanceof Error ? registersQuery.error : null;
  // Named rows would flash as orphans if they rendered before the catalog they
  // join against, so a mapped device waits for it. Raw rows don't care.
  const catalogPending = device.map_name !== null && registersQuery.isLoading;
  // A device with no map has nothing to join against and never will, so a
  // named row on it really is orphaned. A catalog that failed to load says
  // nothing about any row — those rows keep working on their paths alone.
  const catalogReady = device.map_name === null || registersQuery.isSuccess;
  const retryCatalog = registersQuery.refetch;

  const openPicker = React.useCallback(() => setPickerOpen(true), []);
  const addRegister = React.useCallback(
    (reg: RegisterEntry) =>
      onAddRow({ kind: "named", agent: agentAddress, device: device.name, path: reg.path }),
    [onAddRow, agentAddress, device.name],
  );
  const addRawRow = React.useCallback(
    () => onAddRow(defaultRawRow(agentAddress, device.name, device.address_base)),
    [onAddRow, agentAddress, device.name, device.address_base],
  );

  return (
    <div className="rounded-lg border border-border bg-background/40">
      <div className="flex flex-col gap-1 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <strong className="text-sm">{device.device}</strong>
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
          {snapshot?.demoted && (
            <Badge variant="warning">
              demoted
              {snapshot.retry_in_s !== null && `, retry in ${Math.ceil(snapshot.retry_in_s)}s`}
            </Badge>
          )}
          {device.map_name !== null ? (
            <span className="text-muted-foreground">map {device.map_name}</span>
          ) : (
            <Badge variant="warning">raw only</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          <span>unit {device.unit_id}</span>
          <span>polls {snapshot?.poll_count ?? "—"}</span>
          <span>reads {snapshot?.successful_reads ?? "—"}</span>
          <span
            className={cn(
              (snapshot?.failed_reads ?? 0) > 0 && "text-amber-600 dark:text-amber-400",
            )}
          >
            failed {snapshot?.failed_reads ?? "—"}
          </span>
          <RateStat health={snapshot ?? device} />
          <span>write {device.write_mode}</span>
          <span>{device.register_count} regs</span>
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
              deviceName={device.name}
              addressBase={device.address_base}
              writeMode={device.write_mode}
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
              deviceName={device.name}
              addressBase={device.address_base}
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

/** Requested vs measured poll rate of the device's worst tier. */
function RateStat({ health }: { health: PollHealth & { connected: boolean } }) {
  const { requested_rate: requested, achieved_rate: achieved, overload_pct: overloadPct } = health;
  if (requested === null) return <span>not polled</span>;
  // The link is down: no rate is achieved, whatever the last one was.
  if (!health.connected) return <span>rate {requested}s (disconnected)</span>;
  const overloaded = overloadPct !== null && overloadPct > OVERLOAD_WARN_PCT;
  return (
    <span
      className={cn(overloaded && "text-amber-600 dark:text-amber-400")}
      title={
        overloadPct === null
          ? undefined
          : `Worst tier (${requested}s): ${Math.round(overloadPct)}% slower than requested`
      }
    >
      rate {requested}s{achieved !== null && ` (achieved ${Number(achieved.toFixed(2))}s)`}
    </span>
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
