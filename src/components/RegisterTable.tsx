/** The named-register screen: the interface's catalog grouped by trace event,
 *  with live values from the 1 Hz snapshot, an on-demand read per row, and an
 *  inline write editor on writable rows.
 *
 *  Two value sources are merged per register:
 *  - the snapshot's `values[path]`, which only contains registers the extension
 *    actually polls (`poll_interval: 0` registers are absent by design), and
 *  - a local "last read" overlay filled by the per-row Read button, which is the
 *    only way to see an unpolled register.
 *
 *  The newer of the two wins. Snapshot timestamps come from the agent clock and
 *  overlay timestamps from the browser clock, so freshness is always measured
 *  against the matching reference (`captured_at_unix_ms` vs `Date.now()`) rather
 *  than mixing the two. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { ChevronDown, ChevronRight, Lock, RefreshCw } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatAddress, formatDecodedValue, physicalRange, validateWriteValue } from "@/lib/codec";
import { reportActionFailure } from "@/lib/errors";
import { readNamedRegister, writeNamedRegister } from "@/lib/modbus-bridge";
import {
  BIT_REGISTER_TYPES,
  type ModbusSnapshot,
  type RegisterEntry,
  type RegisterTableType,
} from "@/lib/types";

/** Staleness cutoff when the effective poll interval is unknown or disabled. */
const DEFAULT_STALE_MS = 5_000;

export interface RegisterTableProps {
  bridge: BridgeTransport;
  agentAddress: string;
  interfaceName: string;
  /** Interface default poll cadence in seconds — the fallback for registers
   *  whose own `poll_interval` is null. */
  interfacePollInterval: number;
  registers: readonly RegisterEntry[];
  snapshot: ModbusSnapshot | undefined;
}

type ValueSource = "poll" | "read";

interface ResolvedValue {
  value: number | boolean;
  ts_ms: number;
  source: ValueSource;
}

type Overlay = Readonly<Record<string, { value: number | boolean; ts_ms: number }>>;

export function RegisterTable({
  bridge,
  agentAddress,
  interfaceName,
  interfacePollInterval,
  registers,
  snapshot,
}: RegisterTableProps) {
  const [overlay, setOverlay] = React.useState<Overlay>({});
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set<string>());

  const groups = React.useMemo(() => groupByEvent(registers), [registers]);

  const handleOverlay = React.useCallback((path: string, value: number | boolean) => {
    setOverlay((prev) => ({ ...prev, [path]: { value, ts_ms: Date.now() } }));
  }, []);

  const toggleGroup = React.useCallback((event: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {groups.map(({ event, registers: rows }) => {
        const isCollapsed = collapsed.has(event);
        return (
          <div key={event} className="rounded-md border border-border">
            <button
              type="button"
              onClick={() => toggleGroup(event)}
              aria-expanded={!isCollapsed}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent/50"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              <span className="font-medium">{event}</span>
              <span className="text-muted-foreground">
                {rows.length} register{rows.length === 1 ? "" : "s"}
              </span>
            </button>

            {!isCollapsed && (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[720px] table-fixed text-xs">
                  <colgroup>
                    <col className="w-[20%]" />
                    <col className="w-[110px]" />
                    <col className="w-[86px]" />
                    <col className="w-[16%]" />
                    <col className="w-[52px]" />
                    <col className="w-[16%]" />
                    <col />
                  </colgroup>
                  <thead className="text-muted-foreground">
                    <tr className="border-b border-border text-left">
                      <Th>Name</Th>
                      <Th>Address</Th>
                      <Th>Table</Th>
                      <Th>Type</Th>
                      <Th>Unit</Th>
                      <Th>Value</Th>
                      <Th>Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((reg) => (
                      <RegisterRow
                        key={`${reg.path}:${reg.address}:${reg.type}`}
                        bridge={bridge}
                        agentAddress={agentAddress}
                        interfaceName={interfaceName}
                        reg={reg}
                        resolved={resolveValue(reg.path, snapshot, overlay)}
                        thresholdMs={stalenessThresholdMs(reg.poll_interval, interfacePollInterval)}
                        snapshotCapturedAt={snapshot?.captured_at_unix_ms ?? null}
                        onValueRead={handleOverlay}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────────────────────

function RegisterRow({
  bridge,
  agentAddress,
  interfaceName,
  reg,
  resolved,
  thresholdMs,
  snapshotCapturedAt,
  onValueRead,
}: {
  bridge: BridgeTransport;
  agentAddress: string;
  interfaceName: string;
  reg: RegisterEntry;
  resolved: ResolvedValue | null;
  thresholdMs: number;
  snapshotCapturedAt: number | null;
  onValueRead: (path: string, value: number | boolean) => void;
}) {
  const [busy, setBusy] = React.useState<"read" | "write" | null>(null);
  const [draft, setDraft] = React.useState("");

  const isBoolean = BIT_REGISTER_TYPES.has(reg.type) || reg.datatype === "bool";
  const notPolled = reg.poll_interval === 0;
  const stale =
    resolved !== null &&
    !notPolled &&
    isStale(resolved, thresholdMs, snapshotCapturedAt) &&
    resolved.source === "poll";

  const debug = {
    agent: agentAddress,
    interface: interfaceName,
    register: {
      path: reg.path,
      address: reg.address,
      type: reg.type,
      datatype: reg.datatype,
      scale: reg.scale,
      byte_order: reg.byte_order,
    },
  };

  async function handleRead() {
    setBusy("read");
    try {
      const res = await readNamedRegister(bridge, agentAddress, interfaceName, reg.path);
      if (res.value === null) throw new Error("the device returned no value");
      onValueRead(reg.path, res.value);
    } catch (e) {
      reportActionFailure(`Read ${reg.path}`, e, debug);
    } finally {
      setBusy(null);
    }
  }

  async function handleWrite(value: number) {
    setBusy("write");
    try {
      await writeNamedRegister(bridge, agentAddress, interfaceName, reg.path, value);
      toast.success(`Wrote ${reg.path} = ${formatDecodedValue(isBoolean ? value !== 0 : value)}`);
      setDraft("");
      // Polled registers land on the next snapshot tick; unpolled ones would
      // otherwise show nothing at all, so confirm with a read-back.
      if (notPolled) {
        const res = await readNamedRegister(bridge, agentAddress, interfaceName, reg.path);
        if (res.value !== null) onValueRead(reg.path, res.value);
      }
    } catch (e) {
      reportActionFailure(`Write ${reg.path}`, e, { ...debug, value });
    } finally {
      setBusy(null);
    }
  }

  const range = physicalRange(reg.datatype, reg.scale);
  const trimmed = draft.trim();
  const parsed = trimmed.length === 0 ? null : Number(trimmed);
  const verdict =
    parsed === null || !Number.isFinite(parsed)
      ? null
      : validateWriteValue(parsed, reg.datatype, reg.scale);
  const draftError =
    trimmed.length === 0
      ? null
      : parsed === null || !Number.isFinite(parsed)
        ? "not a number"
        : verdict && !verdict.ok
          ? verdict.error
          : null;

  return (
    <tr className="border-b border-border/50 last:border-0">
      <Td>
        <div className="truncate" title={reg.description || reg.path}>
          {reg.name}
        </div>
        {reg.description && (
          <div className="truncate text-[10px] text-muted-foreground" title={reg.description}>
            {reg.description}
          </div>
        )}
      </Td>
      <Td className="font-mono text-[11px]">{formatAddress(reg.address)}</Td>
      <Td>
        <TableBadge type={reg.type} />
      </Td>
      <Td className="font-mono text-[11px] text-muted-foreground">
        <div className="truncate" title={typeSummary(reg)}>
          {typeSummary(reg)}
        </div>
      </Td>
      <Td className="text-[11px] text-muted-foreground">{reg.unit || "—"}</Td>
      <Td>
        <div className={stale ? "opacity-40" : undefined}>
          <span className="font-mono tabular-nums">
            {resolved === null ? "—" : formatDecodedValue(resolved.value)}
          </span>
          {resolved !== null && reg.unit ? (
            <span className="ml-1 text-[10px] text-muted-foreground">{reg.unit}</span>
          ) : null}
        </div>
        {resolved !== null && resolved.source === "read" && (
          <div className="text-[10px] text-muted-foreground">on demand</div>
        )}
        {notPolled && resolved === null && (
          <div className="text-[10px] text-muted-foreground">not polled</div>
        )}
        {stale && <div className="text-[10px] text-muted-foreground">stale</div>}
      </Td>
      <Td>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-1.5 text-[11px]"
            onClick={handleRead}
            disabled={busy !== null}
            title="Read this register from the device now"
          >
            <RefreshCw className={`h-3 w-3 ${busy === "read" ? "animate-spin" : ""}`} />
            Read
          </Button>

          {!reg.writable ? (
            <span
              className="flex items-center gap-1 text-[10px] text-muted-foreground"
              title={`${reg.type} registers are read-only`}
            >
              <Lock className="h-3 w-3" />
              read-only
            </span>
          ) : isBoolean ? (
            <Switch
              checked={resolved?.value === true}
              disabled={busy !== null}
              onCheckedChange={(on) => void handleWrite(on ? 1 : 0)}
              aria-label={`Write ${reg.path}`}
              title={`Write ${reg.path} ON/OFF`}
            />
          ) : (
            <>
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={resolved === null ? "value" : formatDecodedValue(resolved.value)}
                inputMode="decimal"
                aria-label={`New value for ${reg.path}`}
                title={`${formatDecodedValue(range.min)} … ${formatDecodedValue(range.max)}${
                  reg.unit ? ` ${reg.unit}` : ""
                }`}
                className={`h-6 w-24 px-1.5 text-[11px] tabular-nums ${
                  draftError ? "border-destructive" : ""
                }`}
              />
              <Button
                size="sm"
                variant="default"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => {
                  if (parsed !== null && Number.isFinite(parsed) && !draftError) {
                    void handleWrite(parsed);
                  }
                }}
                disabled={busy !== null || trimmed.length === 0 || draftError !== null}
              >
                Write
              </Button>
              {draftError && (
                <span className="text-[10px] text-destructive" role="alert">
                  {draftError}
                </span>
              )}
            </>
          )}
        </div>
      </Td>
    </tr>
  );
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Group registers by trace event, preserving the extension's ordering. */
export function groupByEvent(
  registers: readonly RegisterEntry[],
): Array<{ event: string; registers: RegisterEntry[] }> {
  const groups: Array<{ event: string; registers: RegisterEntry[] }> = [];
  const index = new Map<string, number>();
  for (const reg of registers) {
    const existing = index.get(reg.event);
    if (existing === undefined) {
      index.set(reg.event, groups.length);
      groups.push({ event: reg.event, registers: [reg] });
    } else {
      groups[existing]?.registers.push(reg);
    }
  }
  return groups;
}

/** Newest of (snapshot value, on-demand read). */
export function resolveValue(
  path: string,
  snapshot: ModbusSnapshot | undefined,
  overlay: Overlay,
): ResolvedValue | null {
  const polled = snapshot?.values[path];
  const read = overlay[path];
  if (read && (!polled || read.ts_ms >= polled.ts_ms)) {
    return { value: read.value, ts_ms: read.ts_ms, source: "read" };
  }
  if (polled) return { value: polled.value, ts_ms: polled.ts_ms, source: "poll" };
  return null;
}

/** ~3× the effective poll interval, falling back to 5 s when the interval is
 *  unknown or polling is disabled. */
export function stalenessThresholdMs(
  registerPollInterval: number | null,
  interfacePollInterval: number,
): number {
  const seconds = registerPollInterval ?? interfacePollInterval;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_STALE_MS;
  return Math.max(3 * seconds * 1000, 1500);
}

function isStale(
  resolved: ResolvedValue,
  thresholdMs: number,
  snapshotCapturedAt: number | null,
): boolean {
  // Compare against the clock that produced the timestamp.
  const reference = resolved.source === "poll" ? snapshotCapturedAt : Date.now();
  if (reference === null) return false;
  return reference - resolved.ts_ms > thresholdMs;
}

function typeSummary(reg: RegisterEntry): string {
  const parts: string[] = [reg.datatype];
  if (reg.byte_order !== "big") parts.push(reg.byte_order);
  if (reg.scale !== 1) parts.push(`×${reg.scale}`);
  return parts.join(" · ");
}

const TABLE_LABELS: Record<RegisterTableType, string> = {
  holding: "holding",
  input: "input",
  coil: "coil",
  discrete_input: "discrete",
};

function TableBadge({ type }: { type: RegisterTableType }) {
  const writableTable = type === "holding" || type === "coil";
  return (
    <Badge variant={writableTable ? "outline" : "secondary"} className="px-1.5 text-[10px]">
      {TABLE_LABELS[type]}
    </Badge>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="py-1.5 px-1.5 font-medium">{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-1.5 px-1.5 align-top ${className}`}>{children}</td>;
}
