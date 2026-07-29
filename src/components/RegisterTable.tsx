/** The one table an interface has: every row the user added, named or raw, with
 *  live values, an on-demand read and an inline write editor.
 *
 *  Two row kinds share the columns (see `lib/watch-store`):
 *
 *  - **named** rows join the catalog by path. Every metadata cell is read-only
 *    because it comes from `list_registers`; a path the current map no longer has
 *    renders as an orphan the user can delete rather than as stale metadata.
 *  - **raw** rows are arbitrary-address access and own their metadata, so their
 *    Address / Table / Type cells are the editors. Every edit commits to the
 *    store as it happens — there is no configure-then-save step — and their
 *    values are read on demand only and decoded client-side by `lib/codec`.
 *
 *  What a row *shows* is worked out in `lib/row-view` and arrives as one
 *  `ValueState` and one `WriteModel`, so `ValueCell` and `WriteCell` serve both
 *  kinds without knowing which they are serving. Rows are memoized on those
 *  states: a keystroke re-renders one row, and a 1 Hz tick re-renders only the
 *  rows whose value actually moved.
 *
 *  Column layout: Table, Type and Unit are as narrow as their content allows and
 *  the space goes to Value and Write, the two columns the user works in. The
 *  on-demand Read is icon-only and shares the Value cell with the value it
 *  refreshes; Write owns its own column; Delete is a narrow column on the right.
 *
 *  The write draft is latched: it survives a successful write and every snapshot
 *  re-render, so "type once, Write repeatedly" works. Only the user clears it,
 *  and it is persisted, so duplicate rows act as presets.
 *
 *  Success has no toast anywhere on this screen — the value cell is the receipt.
 *  A landed read flashes the value briefly (see {@link FLASH_MS}); a write is
 *  confirmed by the value it produces, on the next poll or via a read-back (raw
 *  rows and unpolled named rows have no poll to wait for). Toasts are reserved
 *  for failures, all of them through `useAction`. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import {
  formatAddress,
  formatDecodedValue,
  isBitTable,
  isByteOrder,
  isModbusDatatype,
  isRegisterTableType,
  isWritableTable,
  parseAddress,
  parseWriteDraft,
  physicalRange,
  wordCount,
} from "@/lib/codec";
import {
  readNamedRegister,
  readRegister,
  writeCoil,
  writeNamedRegister,
  writeRegisters,
  writeSingleRegister,
} from "@/lib/modbus-bridge";
import {
  BYTE_ORDER_LABELS,
  TABLE_LABELS,
  namedValueState,
  namedWriteModel,
  rawValueState,
  rawWriteModel,
  resolveValue,
  sameValueState,
  stalenessThresholdMs,
  typeSummary,
  writeDefault,
  type Overlay,
  type ValueState,
  type WriteModel,
} from "@/lib/row-view";
import {
  BYTE_ORDERS,
  MODBUS_DATATYPES,
  REGISTER_TYPES,
  type ModbusDatatype,
  type ModbusSnapshot,
  type RegisterEntry,
  type RegisterTableType,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  interpretRawRead,
  planRawRead,
  planRawWrite,
  rawRowLabel,
  rawTargetKey,
  type NamedWatchRow,
  type RawReadout,
  type RawWatchRow,
  type RowPatch,
  type WatchRow,
} from "@/lib/watch-store";

/** How long a landed read holds its highlight before fading out. Long enough to
 *  catch out of the corner of an eye, short enough to be gone by the next tick. */
const FLASH_MS = 500;

/** What the cell says instead of a number the wire couldn't carry. */
const UNREPRESENTABLE_TITLE = "device returned a non-finite value (NaN/Inf)";

/** Shared array identity, so a hint prop can't defeat the row memo. */
const NOT_POLLED: readonly string[] = ["not polled"];

export interface RegisterTableProps {
  bridge: BridgeTransport;
  agentAddress: string;
  interfaceName: string;
  /** Interface default poll cadence in seconds — the fallback for registers
   *  whose own `poll_interval` is null. */
  interfacePollInterval: number;
  /** The interface's catalog. Named rows join against it by path; nothing about a
   *  register is ever copied into a stored row. Empty for a raw-only interface. */
  registers: readonly RegisterEntry[];
  /** Rows for this (agent, interface), in insertion order. */
  rows: readonly WatchRow[];
  /** Whether {@link registers} is the catalog's real content. False while the
   *  catalog is unavailable — during which a path that isn't in it is unknown,
   *  not orphaned, and its row keeps working on the path alone. */
  catalogReady: boolean;
  snapshot: ModbusSnapshot | undefined;
  /** Commits an inline edit: a write draft on any row, metadata on a raw one. */
  onUpdateRow: (id: string, patch: RowPatch) => void;
  onRemoveRow: (id: string) => void;
  /** Opens the add dialog — used by the empty state. */
  onAdd: () => void;
}

export function RegisterTable({
  bridge,
  agentAddress,
  interfaceName,
  interfacePollInterval,
  registers,
  rows,
  catalogReady,
  snapshot,
  onUpdateRow,
  onRemoveRow,
  onAdd,
}: RegisterTableProps) {
  const [overlay, setOverlay] = React.useState<Overlay>({});

  const byPath = React.useMemo(() => new Map(registers.map((reg) => [reg.path, reg])), [registers]);

  // Read through a ref so the callback below can stay identity-stable for the
  // memoized rows while still seeing the current tick.
  const snapshotRef = React.useRef(snapshot);
  snapshotRef.current = snapshot;

  const handleOverlay = React.useCallback((path: string, value: number | boolean | null) => {
    // Remember which poll sample this read overtook, in the agent's clock, so
    // the poll can take the row back the moment it reports a newer one.
    const supersedes = snapshotRef.current?.values[path]?.ts_ms ?? null;
    setOverlay((prev) => ({ ...prev, [path]: { value, supersedes } }));
  }, []);

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/30 py-6 text-center text-sm text-muted-foreground">
        <p>No rows yet — add a register or a raw address.</p>
        <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={onAdd}>
          <Plus className="h-3 w-3" />
          Add
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[860px] table-fixed text-xs">
        {/* Table/Type/Unit are sized to the editors a raw row puts in them and no
            more; every pixel saved there is spent on Value and Write. */}
        <colgroup>
          <col className="w-[20%]" />
          <col className="w-[88px]" />
          <col className="w-[76px]" />
          <col className="w-[140px]" />
          <col className="w-[40px]" />
          <col className="w-[148px]" />
          <col className="w-[168px]" />
          <col className="w-[32px]" />
        </colgroup>
        <thead className="text-muted-foreground">
          <tr className="border-b border-border text-left">
            <Th>Register</Th>
            <Th>Address</Th>
            <Th>Table</Th>
            <Th>Type</Th>
            <Th>Unit</Th>
            <Th>Value</Th>
            <Th>Write</Th>
            <Th>
              <span className="sr-only">Delete</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.kind === "raw") {
              return (
                <RawRegisterRow
                  key={row.id}
                  bridge={bridge}
                  agentAddress={agentAddress}
                  interfaceName={interfaceName}
                  row={row}
                  onUpdateRow={onUpdateRow}
                  onRemoveRow={onRemoveRow}
                />
              );
            }
            const reg = byPath.get(row.path) ?? null;
            // Only a catalog we actually have can tell us a path is gone.
            if (reg === null && catalogReady) {
              return <OrphanRow key={row.id} row={row} onRemoveRow={onRemoveRow} />;
            }
            return (
              <NamedRegisterRow
                key={row.id}
                bridge={bridge}
                agentAddress={agentAddress}
                interfaceName={interfaceName}
                reg={reg}
                row={row}
                state={namedValueState(resolveValue(row.path, snapshot, overlay), {
                  thresholdMs: stalenessThresholdMs(
                    reg?.poll_interval ?? null,
                    interfacePollInterval,
                  ),
                  snapshotCapturedAt: snapshot?.captured_at_unix_ms ?? null,
                  polled: reg?.poll_interval !== 0,
                })}
                onValueRead={handleOverlay}
                onUpdateRow={onUpdateRow}
                onRemoveRow={onRemoveRow}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Named row ──────────────────────────────────────────────────────────────

interface NamedRowProps {
  bridge: BridgeTransport;
  agentAddress: string;
  interfaceName: string;
  /** The catalog entry, or null when the catalog couldn't be loaded. The row
   *  still works without it — every named action takes the path. */
  reg: RegisterEntry | null;
  row: NamedWatchRow;
  state: ValueState;
  onValueRead: (path: string, value: number | boolean | null) => void;
  onUpdateRow: (id: string, patch: RowPatch) => void;
  onRemoveRow: (id: string) => void;
}

function NamedRegisterRowView({
  bridge,
  agentAddress,
  interfaceName,
  reg,
  row,
  state,
  onValueRead,
  onUpdateRow,
  onRemoveRow,
}: NamedRowProps) {
  const path = row.path;
  const { flash, flashNow } = useValueFlash();
  const { busy, run } = useAction<"read" | "write">(path, () => ({
    agent: agentAddress,
    interface: interfaceName,
    register:
      reg === null
        ? { path, catalog: "unavailable" }
        : {
            path,
            address: reg.address,
            type: reg.type,
            datatype: reg.datatype,
            scale: reg.scale,
            byte_order: reg.byte_order,
          },
  }));

  // Without the catalog we can't know whether anything polls this register, and
  // an unpolled one would otherwise never show the value it was just given — so
  // confirm with a read-back, which costs one action and is never wrong.
  const readBackAfterWrite = reg === null || reg.poll_interval === 0;
  const notPolled = reg?.poll_interval === 0;

  /** A read landed: publish it and flash the value. The flash is the whole
   *  success signal — no label, no toast, no reflow. A `null` value is a landed
   *  read too (the device answered with a non-finite float), so it flashes like
   *  any other; the cell says what it can't show. */
  function acceptRead(value: number | boolean | null) {
    onValueRead(path, value);
    flashNow();
  }

  function handleWrite(value: number | boolean | bigint) {
    // A named write is a JSON number; `parseWriteDraft` has already refused
    // anything a double can't carry, so this conversion is exact.
    const numeric = typeof value === "boolean" ? (value ? 1 : 0) : Number(value);
    run(
      "write",
      async () => {
        await writeNamedRegister(bridge, agentAddress, interfaceName, path, numeric);
        // The draft is deliberately left as typed — repeating a setpoint is a
        // normal bench move, so Write stays armed until the user edits or clears
        // it. Polled registers land on the next snapshot tick; unpolled ones
        // would otherwise show nothing at all, so confirm with a read-back.
        // Either way the value cell is the only receipt the write gets, and it
        // flashes even when the value it lands on is the one already showing.
        if (readBackAfterWrite) {
          const res = await readNamedRegister(bridge, agentAddress, interfaceName, path);
          acceptRead(res.value);
        } else {
          flashNow();
        }
      },
      { value: numeric },
    );
  }

  return (
    <tr className="border-b border-border/50 last:border-0">
      <Td>
        <div className="truncate font-mono text-[11px]" title={reg?.description || path}>
          {path}
        </div>
      </Td>
      <Td className="font-mono text-[11px]">{reg === null ? "—" : formatAddress(reg.address)}</Td>
      <MetaCell text={reg === null ? "—" : TABLE_LABELS[reg.type]} />
      <MetaCell text={reg === null ? "—" : typeSummary(reg)} mono />
      <MetaCell text={reg?.unit || "—"} title={reg?.unit || undefined} />
      <ValueCell
        state={state}
        hints={notPolled && state.kind === "never" ? NOT_POLLED : undefined}
        flash={flash}
        busy={busy !== null}
        reading={busy === "read"}
        onRead={() =>
          run("read", async () => {
            const res = await readNamedRegister(bridge, agentAddress, interfaceName, path);
            acceptRead(res.value);
          })
        }
        readLabel={`Read ${path} from the device now`}
      />
      <WriteCell
        model={reg === null ? BLIND_WRITE : namedWriteModel(reg)}
        state={state}
        label={path}
        busy={busy !== null}
        initialDraft={row.draft ?? ""}
        onDraftChange={(draft) => onUpdateRow(row.id, { draft })}
        onWrite={handleWrite}
      />
      <Td>
        <RemoveButton label={path} disabled={busy !== null} onRemove={() => onRemoveRow(row.id)} />
      </Td>
    </tr>
  );
}

/** Shared identity, for the same reason as {@link NOT_POLLED}. */
const BLIND_WRITE: WriteModel = { kind: "blind" };

const NamedRegisterRow = React.memo(NamedRegisterRowView, sameRowProps);

// ─── Raw row ────────────────────────────────────────────────────────────────

interface RawRowProps {
  bridge: BridgeTransport;
  agentAddress: string;
  interfaceName: string;
  row: RawWatchRow;
  onUpdateRow: (id: string, patch: RowPatch) => void;
  onRemoveRow: (id: string) => void;
}

function RawRegisterRowView({
  bridge,
  agentAddress,
  interfaceName,
  row,
  onUpdateRow,
  onRemoveRow,
}: RawRowProps) {
  // The readout is tied to the target it came from: re-point the row and the old
  // value stops being about this row, so the cell goes back to never-read
  // without an effect firing on unrelated renders.
  const [readout, setReadout] = React.useState<{ target: string; value: RawReadout } | null>(null);
  const [addressDraft, setAddressDraft] = React.useState(row.address);
  const { flash, flashNow } = useValueFlash();
  const label = rawRowLabel(row);
  const { busy, run } = useAction<"read" | "write">(label, () => ({
    agent: agentAddress,
    interface: interfaceName,
    row,
  }));

  const bits = isBitTable(row.table);
  const target = rawTargetKey(row);
  const state = rawValueState(readout?.target === target ? readout.value : null);
  // An address the user is still typing (or has typed wrong) is not an address to
  // act on: the row would silently read or write the last committed one instead.
  const addressReady = parseAddress(addressDraft) !== null;
  const blocked = busy !== null || !addressReady;

  function patch(next: RowPatch) {
    onUpdateRow(row.id, next);
  }

  /** Commit as the user types: a parseable address lands in the store
   *  immediately; an unparseable one keeps its error ring and leaves the last
   *  good value persisted. */
  function editAddress(next: string) {
    setAddressDraft(next);
    if (next !== row.address && parseAddress(next) !== null) patch({ address: next });
  }

  /** Read one value and show it. Throws, so `useAction` reports it. */
  async function performRead() {
    const planned = planRawRead(row);
    if (!planned.ok) throw new Error(planned.error);
    const res = await readRegister(bridge, agentAddress, interfaceName, {
      address: planned.plan.address,
      reg_type: planned.plan.table,
      count: planned.plan.count,
    });
    setReadout({ target, value: interpretRawRead(row, res) });
    flashNow();
  }

  function handleWrite(value: number | boolean | bigint) {
    run(
      "write",
      async () => {
        const planned = planRawWrite(row, value);
        if (!planned.ok) throw new Error(planned.error);
        const plan = planned.plan;
        switch (plan.kind) {
          case "coil":
            await writeCoil(bridge, agentAddress, interfaceName, plan.address, plan.on);
            break;
          case "single":
            await writeSingleRegister(bridge, agentAddress, interfaceName, plan.address, plan.word);
            break;
          case "multi":
            await writeRegisters(bridge, agentAddress, interfaceName, plan.address, plan.words);
            break;
        }
        // No poll stands behind a raw row, so the read-back is the only receipt.
        await performRead();
      },
      { value },
    );
  }

  return (
    <tr className="border-b border-border/50 last:border-0">
      <Td className="text-[11px] text-muted-foreground">
        <span title="Raw row — an arbitrary address, not a register from the map">—</span>
      </Td>
      <Td>
        <Input
          value={addressDraft}
          onChange={(e) => editAddress(e.target.value)}
          onBlur={(e) => editAddress(e.target.value)}
          aria-label="Raw address"
          title="Address — decimal or 0x hex"
          className={cn(
            "h-6 w-full px-1.5 font-mono text-[11px]",
            !addressReady && "border-destructive ring-1 ring-destructive",
          )}
        />
      </Td>
      <Td>
        <RowSelect
          value={row.table}
          options={REGISTER_TYPES.map((table) => ({ value: table, label: TABLE_LABELS[table] }))}
          onChange={(next) => {
            if (isRegisterTableType(next)) patch({ table: next });
          }}
          label="Raw table"
          title={`Modbus table — ${row.table}`}
          className="w-full"
        />
      </Td>
      <Td>
        <div className="flex items-center gap-1">
          <RowSelect
            value={row.datatype}
            options={MODBUS_DATATYPES.map((datatype) => ({ value: datatype, label: datatype }))}
            onChange={(next) => {
              if (isModbusDatatype(next)) patch({ datatype: next });
            }}
            label="Raw datatype"
            disabled={bits}
            title={
              bits
                ? `${row.table} addresses are single bits — always bool`
                : `Datatype — ${row.datatype}`
            }
            className="min-w-0 flex-1"
          />
          {wordCount(row.datatype) > 1 && (
            <RowSelect
              value={row.byte_order}
              options={BYTE_ORDERS.map((order) => ({
                value: order,
                label: BYTE_ORDER_LABELS[order],
              }))}
              onChange={(next) => {
                if (isByteOrder(next)) patch({ byte_order: next });
              }}
              label="Raw word order"
              title={`Word order — ${row.byte_order} (${BYTE_ORDER_LABELS[row.byte_order]})`}
              className="shrink-0"
            />
          )}
        </div>
      </Td>
      <MetaCell text="—" />
      <ValueCell
        state={state}
        flash={flash}
        busy={blocked}
        reading={busy === "read"}
        onRead={() => run("read", performRead)}
        readLabel={`Read ${label} from the device now`}
      />
      <WriteCell
        model={rawWriteModel(row)}
        state={state}
        label={label}
        busy={blocked}
        initialDraft={row.draft ?? ""}
        onDraftChange={(draft) => patch({ draft })}
        onWrite={handleWrite}
      />
      <Td>
        <RemoveButton label={label} disabled={busy !== null} onRemove={() => onRemoveRow(row.id)} />
      </Td>
    </tr>
  );
}

const RawRegisterRow = React.memo(RawRegisterRowView);

/** A watched path the current register map doesn't have — the extension
 *  restarted with a different config. Everything but Delete is meaningless, so
 *  nothing else renders. */
const OrphanRow = React.memo(function OrphanRow({
  row,
  onRemoveRow,
}: {
  row: WatchRow;
  onRemoveRow: (id: string) => void;
}) {
  const path = row.kind === "named" ? row.path : row.id;
  return (
    <tr className="border-b border-border/50 text-muted-foreground last:border-0">
      <Td>
        <div className="truncate font-mono text-[11px]" title={path}>
          {path}
        </div>
        <div className="text-[10px]">not in current register map</div>
      </Td>
      <Td colSpan={6} className="text-[11px]">
        —
      </Td>
      <Td>
        <RemoveButton label={path} onRemove={() => onRemoveRow(row.id)} />
      </Td>
    </tr>
  );
});

// ─── Shared cells ───────────────────────────────────────────────────────────

/** A ~500 ms highlight on the value that just landed. */
function useValueFlash(): { flash: boolean; flashNow: () => void } {
  const [flash, setFlash] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const flashNow = React.useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    setFlash(true);
    timer.current = setTimeout(() => setFlash(false), FLASH_MS);
  }, []);

  return { flash, flashNow };
}

/** One of the narrow metadata columns: truncated, muted, its own tooltip. */
function MetaCell({
  text,
  title,
  mono = false,
}: {
  text: string;
  title?: string | undefined;
  mono?: boolean;
}) {
  return (
    <Td className={cn("text-[10px] text-muted-foreground", mono && "font-mono")}>
      <div className="truncate" title={title === undefined ? text : title}>
        {text}
      </div>
    </Td>
  );
}

/** The value, its hints, and the icon-only Read that refreshes it.
 *
 *  Everything the dash means is decided by the state it is handed: a sample that
 *  never arrived and one that arrived unprintable look the same, but only the
 *  second explains itself (tooltip + dotted underline), and only a sample that
 *  arrived can be stale. */
function ValueCell({
  state,
  hints,
  flash,
  busy,
  reading,
  onRead,
  readLabel,
}: {
  state: ValueState;
  hints?: readonly string[] | undefined;
  flash: boolean;
  busy: boolean;
  reading: boolean;
  onRead: () => void;
  readLabel: string;
}) {
  const unrepresentable = state.kind === "unrepresentable";
  const stale = state.kind === "value" && state.stale;
  const text = state.kind === "value" ? formatDecodedValue(state.value) : "—";
  const context = state.kind === "never" ? undefined : state.context;
  const tooltip = unrepresentable
    ? // Keep whatever context the row had (its raw words) after the reason.
      [UNREPRESENTABLE_TITLE, context].filter(Boolean).join(" — ")
    : state.kind === "value"
      ? (context ?? text)
      : undefined;

  return (
    <Td>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          {/* A landed read flashes here and fades out — the only success signal a
              read or a write gets. Padding is constant so nothing reflows. */}
          <div className={cn("min-w-0", stale && "opacity-40")} title={tooltip}>
            <span
              data-flash={flash ? "true" : undefined}
              className={cn(
                "-mx-1 inline-block max-w-full truncate rounded bg-transparent px-1 font-mono tabular-nums transition-colors duration-500 data-[flash=true]:bg-primary/25 data-[flash=true]:duration-0",
                unrepresentable && "cursor-help underline decoration-dotted",
              )}
            >
              {text}
            </span>
          </div>
          {hints?.map((hint) => (
            <div key={hint} className="text-[10px] text-muted-foreground">
              {hint}
            </div>
          ))}
          {stale && <div className="text-[10px] text-muted-foreground">stale</div>}
        </div>
        <Button
          size="icon"
          variant="outline"
          className="h-6 w-6 shrink-0"
          onClick={onRead}
          disabled={busy}
          title={readLabel}
          aria-label={readLabel}
        >
          <RefreshCw className={cn("h-3 w-3", reading && "animate-spin")} />
        </Button>
      </div>
    </Td>
  );
}

/** The write column for either row kind, switched on the model it is handed: a
 *  latched numeric draft plus Write for word registers, an ON/OFF switch for
 *  bits, and a subdued dash where the table can't be written at all.
 *
 *  The draft lives here and is mirrored into the row on every keystroke, which is
 *  what makes a row usable as a preset across reloads. It is seeded from the row
 *  rather than driven by it so that typing re-renders one cell, not the table. */
function WriteCell({
  model,
  state,
  label,
  busy,
  initialDraft,
  onDraftChange,
  onWrite,
}: {
  model: WriteModel;
  /** The value on show, for the placeholder and the switch position. */
  state: ValueState;
  /** Names the row in the controls' accessible labels. */
  label: string;
  busy: boolean;
  /** The row's persisted draft, used to seed the editor once. */
  initialDraft: string;
  onDraftChange: (draft: string) => void;
  onWrite: (value: number | boolean | bigint) => void;
}) {
  const [draft, setDraft] = React.useState(initialDraft);
  const current = writeDefault(state);

  if (model.kind === "readonly") {
    return (
      <Td>
        <span className="cursor-default text-[11px] text-muted-foreground" title={model.why}>
          <span aria-hidden="true">—</span>
          <span className="sr-only">read-only</span>
        </span>
      </Td>
    );
  }

  if (model.kind === "switch") {
    return (
      <Td>
        <Switch
          checked={current === true}
          disabled={busy}
          onCheckedChange={onWrite}
          aria-label={`Write ${label}`}
          title={`Write ${label} ON/OFF`}
        />
      </Td>
    );
  }

  // One parse feeds the error, the button and the value sent — they can't
  // disagree. With no catalog there is nothing to check against, so a blind
  // editor only insists on a number and lets the extension have the last word.
  const { value, error } =
    model.kind === "blind"
      ? blindDraft(draft)
      : parseWriteDraft(draft, model.datatype, model.scale, model.wire);
  const rangeHint =
    model.kind === "blind"
      ? "the register map is unavailable — this value is sent unchecked"
      : hintRange(model.datatype, model.scale, model.unit);

  return (
    <Td>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onDraftChange(e.target.value);
          }}
          placeholder={current === null ? "value" : formatDecodedValue(current)}
          inputMode="decimal"
          aria-label={`New value for ${label}`}
          title={rangeHint}
          className={cn("h-6 w-24 px-1.5 text-[11px] tabular-nums", error && "border-destructive")}
        />
        <Button
          size="sm"
          variant="default"
          className="h-6 px-1.5 text-[11px]"
          onClick={() => {
            if (value !== null) onWrite(value);
          }}
          disabled={busy || value === null}
        >
          Write
        </Button>
        {error && (
          <span className="w-full text-[10px] text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>
    </Td>
  );
}

/** With no catalog there is no range and no scale to check — only "is it a
 *  number". The extension validates and refuses on its side, and that refusal
 *  toasts like any other. */
function blindDraft(draft: string): { value: number | null; error: string | null } {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return { value: null, error: null };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { value: null, error: "not a number" };
  return { value: parsed, error: null };
}

function hintRange(datatype: ModbusDatatype, scale: number, unit: string): string {
  const range = physicalRange(datatype, scale);
  return `${formatDecodedValue(range.min)} … ${formatDecodedValue(range.max)}${unit ? ` ${unit}` : ""}`;
}

function RemoveButton({
  label,
  disabled = false,
  onRemove,
}: {
  label: string;
  /** Held while the row has a request in flight: deleting it mid-write would
   *  leave the result of that write with nowhere to land. */
  disabled?: boolean;
  onRemove: () => void;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-6 w-6"
      onClick={onRemove}
      disabled={disabled}
      title={`Remove ${label} from the table`}
      aria-label={`Remove ${label} from the table`}
    >
      <Trash2 className="h-3 w-3" />
    </Button>
  );
}

/** A native select sized for a table row. No portal and no pointer-capture
 *  dance, and it stays exactly as tall as the row's other `h-6` controls. */
function RowSelect({
  value,
  options,
  onChange,
  label,
  title,
  disabled = false,
  className = "",
}: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  label: string;
  title: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={cn(
        "h-6 rounded-md border border-input bg-background px-1 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-background">
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Row props are stable identities except the value state, which the poll
 *  rebuilds every tick — so that one is compared by field and the rest by
 *  reference. Generic over the prop bag, so a new prop can't silently escape the
 *  comparison. */
function sameRowProps<P extends { state: ValueState }>(prev: P, next: P): boolean {
  const keys = Object.keys(prev) as Array<keyof P & string>;
  if (keys.length !== Object.keys(next).length) return false;
  return keys.every((key) =>
    key === "state" ? sameValueState(prev.state, next.state) : prev[key] === next[key],
  );
}

// ─── Shared with the picker ─────────────────────────────────────────────────

/** The register picker's per-entry badge. The table prints the same label inline,
 *  so both name a table the same. */
export function TableBadge({ type }: { type: RegisterTableType }) {
  return (
    <Badge variant={isWritableTable(type) ? "outline" : "secondary"} className="px-1.5 text-[10px]">
      {TABLE_LABELS[type]}
    </Badge>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="py-1.5 px-1.5 font-medium">{children}</th>;
}

/** Every cell centers on the row's height, so the text columns line up with
 *  whichever control (Read, a select, the write input) made the row tall. */
function Td({
  children,
  className = "",
  colSpan,
}: {
  children: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td className={cn("py-1.5 px-1.5 align-middle", className)} {...(colSpan ? { colSpan } : {})}>
      {children}
    </td>
  );
}
