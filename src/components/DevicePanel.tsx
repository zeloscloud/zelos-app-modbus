/** One section per Modbus device: a live status header, then the one table
 *  holding every row the user added to it — catalog registers and arbitrary
 *  addresses side by side, in insertion order.
 *
 *  A device with no register map (`map_name === null`) is not a special case
 *  any more: its catalog is simply empty, so only raw rows can be added to it.
 *  A map still being discovered, or whose discovery failed, is not "no map",
 *  and neither is an auto-scanned device: its catalog is what the scan found. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import * as React from "react";

import { AddRegisterDialog } from "@/components/AddRegisterDialog";
import { RegisterTable } from "@/components/RegisterTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRegisters } from "@/hooks/use-registers";
import { useSnapshot } from "@/hooks/use-snapshot";
import { isRegisterTableType } from "@/lib/codec";
import { TABLE_NAMES } from "@/lib/row-view";
import type { AutoScanStatus, ModbusDeviceEntry, PollHealth, RegisterEntry } from "@/lib/types";
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
    device.auto_scan != null,
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
  const catalogPending =
    (device.map_name !== null || device.auto_scan != null) && registersQuery.isLoading;
  // A device with no map has nothing to join against and never will, so a
  // named row on it really is orphaned. A catalog that failed to load says
  // nothing about any row — those rows keep working on their paths alone.
  const map = mapState(device, snapshot);
  const catalogReady = map.kind === "raw" || registersQuery.isSuccess;
  const retryCatalog = registersQuery.refetch;
  const refused = (snapshot ?? device).refused;

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
          {map.kind === "mapped" && <span className="text-muted-foreground">map {map.name}</span>}
          {map.kind === "raw" && <Badge variant="warning">raw only</Badge>}
          {map.kind === "auto-scan" &&
            (map.scan.state === "scanning" ? (
              <Badge variant="outline" className="gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                scanning{map.scan.table !== null && ` ${scanTableName(map.scan.table)}`}…{" "}
                {map.scan.found} found
              </Badge>
            ) : (
              <Badge variant="outline">auto-scan: {map.scan.found} found</Badge>
            ))}
          {map.kind === "pending" && (
            <Badge variant="warning" className="gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              discovering register map
            </Badge>
          )}
          {map.kind === "failed" && (
            <Badge variant="destructive" className="gap-1">
              <AlertCircle className="h-3 w-3" />
              map discovery failed
            </Badge>
          )}
          {refused.length > 0 && (
            <Badge variant="warning">
              {refused.length} {refused.length === 1 ? "block" : "blocks"} refused
            </Badge>
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
        {map.kind === "failed" && <p className="text-[11px] text-destructive">{map.error}</p>}
        {refused.map((b) => (
          <p key={b.range} className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
            {b.range} refused (exception {formatExceptionCode(b.code)}), retry in{" "}
            {Math.ceil(b.retry_in_s)}s
          </p>
        ))}
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
              rawWrites={device.raw_writes}
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

export type MapState =
  | { kind: "mapped"; name: string }
  | { kind: "raw" }
  | { kind: "auto-scan"; scan: AutoScanStatus }
  | { kind: "pending" }
  | { kind: "failed"; error: string };

type MapFields = Pick<PollHealth, "map_pending" | "error" | "auto_scan">;

/** What the device's register map is doing. The 1 Hz snapshot is fresher than
 *  `list_devices` for pending/error; `map_name` only comes from the latter, so a
 *  map the snapshot calls done stays pending until `list_devices` names it. A
 *  failed discovery is retried (still pending) but reads as failed. Scan
 *  progress prefers the snapshot too. */
export function mapState(
  device: MapFields & { map_name: string | null },
  snapshot: MapFields | undefined,
): MapState {
  if (device.map_name !== null) return { kind: "mapped", name: device.map_name };
  const live = snapshot ?? device;
  if (live.error !== null) return { kind: "failed", error: live.error };
  const scan = live.auto_scan ?? device.auto_scan;
  if (scan != null) return { kind: "auto-scan", scan };
  if (live.map_pending || device.map_pending) return { kind: "pending" };
  return { kind: "raw" };
}

/** `2` → `"02"`, as the extension logs it. */
function formatExceptionCode(code: number): string {
  return code.toString(16).toUpperCase().padStart(2, "0");
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

/** The extension's table key as its spec name; an unknown key as sent. */
function scanTableName(table: string): string {
  return isRegisterTableType(table) ? TABLE_NAMES[table] : table;
}

function Dot({ className }: { className: string }) {
  return <span className={cn("inline-block h-1.5 w-1.5 rounded-full", className)} />;
}
