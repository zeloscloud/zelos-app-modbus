/** Arbitrary-address access: saved rows that read or write any address on this
 *  interface, with client-side type handling.
 *
 *  The extension's raw actions are untyped — `read_register` hands back 16-bit
 *  words and `write_single_register` / `write_registers` take words — so the
 *  datatype, word order and scale are applied here by `lib/codec`, which mirrors
 *  the extension's own decode/encode exactly.
 *
 *  Rows persist in localStorage; results don't (a readout from yesterday is
 *  worse than an empty one). Every request is built by `planRawRow`, so the
 *  inline validation message and the wire call can't disagree. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  decodeValue,
  formatDecodedValue,
  formatWordsHex,
  isBitTable,
  isByteOrder,
  isModbusDatatype,
  wordCount,
} from "@/lib/codec";
import { reportActionFailure } from "@/lib/errors";
import { readRegister, writeCoil, writeRegisters, writeSingleRegister } from "@/lib/modbus-bridge";
import {
  defaultRawRow,
  planRawRow,
  rawRowLabel,
  type NewRawRow,
  type RawReadPlan,
  type RawRow,
  type RawRowMode,
  type RawWritePlan,
} from "@/lib/raw-store";
import { BYTE_ORDERS, MODBUS_DATATYPES, REGISTER_TYPES, type RegisterTableType } from "@/lib/types";

interface RawResult {
  ok: boolean;
  at_ms: number;
  /** Formatted decoded values, one per value read/written. */
  values: string[] | null;
  /** Raw words in hex, when the operation involved words. */
  words_hex: string | null;
  error: string | null;
}

export interface RawPanelProps {
  bridge: BridgeTransport;
  agentAddress: string;
  interfaceName: string;
  /** Rows already filtered to this (agent, interface). */
  rows: readonly RawRow[];
  onAddRow: (input: NewRawRow) => RawRow;
  onUpdateRow: (id: string, patch: Partial<RawRow>) => void;
  onRemoveRow: (id: string) => void;
}

export function RawPanel({
  bridge,
  agentAddress,
  interfaceName,
  rows,
  onAddRow,
  onUpdateRow,
  onRemoveRow,
}: RawPanelProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Readonly<Record<string, RawResult>>>({});

  const setResult = React.useCallback((id: string, result: RawResult) => {
    setResults((prev) => ({ ...prev, [id]: result }));
  }, []);

  function add(mode: RawRowMode) {
    const row = onAddRow(defaultRawRow(agentAddress, interfaceName, mode));
    setEditingId(row.id);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Read or write any address. Values are decoded client-side from raw words.
        </p>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => add("read")}>
            <Plus className="h-3 w-3" />
            Add read
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => add("write")}>
            <Plus className="h-3 w-3" />
            Add write
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background/30 py-6 text-center text-sm text-muted-foreground">
          No raw rows on {interfaceName} yet. Use <strong>Add read</strong> or{" "}
          <strong>Add write</strong> to create one.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <RawRowView
              key={row.id}
              bridge={bridge}
              row={row}
              editing={editingId === row.id}
              result={results[row.id] ?? null}
              onEdit={() => setEditingId(editingId === row.id ? null : row.id)}
              onDoneEditing={() => setEditingId(null)}
              onUpdate={(patch) => onUpdateRow(row.id, patch)}
              onRemove={() => onRemoveRow(row.id)}
              onResult={(result) => setResult(row.id, result)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RawRowView({
  bridge,
  row,
  editing,
  result,
  onEdit,
  onDoneEditing,
  onUpdate,
  onRemove,
  onResult,
}: {
  bridge: BridgeTransport;
  row: RawRow;
  editing: boolean;
  result: RawResult | null;
  onEdit: () => void;
  onDoneEditing: () => void;
  onUpdate: (patch: Partial<RawRow>) => void;
  onRemove: () => void;
  onResult: (result: RawResult) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const planned = planRawRow(row);

  async function execute() {
    const plan = planRawRow(row);
    if (!plan.ok) {
      onResult({ ok: false, at_ms: Date.now(), values: null, words_hex: null, error: plan.error });
      return;
    }
    setBusy(true);
    try {
      onResult(
        plan.plan.kind === "read"
          ? await runRead(bridge, row, plan.plan)
          : await runWrite(bridge, row, plan.plan),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reportActionFailure(rawRowLabel(row), e, {
        agent: row.agent,
        interface: row.interface,
        row,
        plan: plan.plan,
      });
      onResult({ ok: false, at_ms: Date.now(), values: null, words_hex: null, error: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-background/30 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={row.mode === "read" ? "outline" : "secondary"} className="text-[10px]">
          {row.mode}
        </Badge>
        <span className="font-mono">{rawRowLabel(row)}</span>
        {!planned.ok && (
          <span className="text-[10px] text-destructive" role="alert">
            {planned.error}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant={row.mode === "read" ? "outline" : "default"}
            className="h-6 px-2 text-[11px]"
            onClick={() => void execute()}
            disabled={busy || !planned.ok}
          >
            {row.mode === "read" ? "Read" : "Write"}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={onEdit}
            title="Edit this row"
            aria-label="Edit this row"
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={onRemove}
            title="Delete this row"
            aria-label="Delete this row"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {result && (
        <div className="mt-1 flex flex-wrap items-baseline gap-2 font-mono text-[11px]">
          {result.ok ? (
            <>
              <span>{result.values?.join(", ") ?? "ok"}</span>
              {result.words_hex && (
                <span className="text-muted-foreground">{result.words_hex}</span>
              )}
            </>
          ) : (
            <span className="text-destructive">{result.error}</span>
          )}
          <span className="text-muted-foreground">
            {new Date(result.at_ms).toLocaleTimeString()}
          </span>
        </div>
      )}

      {editing && <RawRowEditor row={row} onUpdate={onUpdate} onDone={onDoneEditing} />}
    </div>
  );
}

// ─── Inline editor ──────────────────────────────────────────────────────────

function RawRowEditor({
  row,
  onUpdate,
  onDone,
}: {
  row: RawRow;
  onUpdate: (patch: Partial<RawRow>) => void;
  onDone: () => void;
}) {
  const bits = row.mode === "read" ? isBitTable(row.table) : row.target === "coil";
  const multiWord = !bits && wordCount(row.datatype) > 1;

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-2">
      <Field label="Address">
        <Input
          value={row.address}
          onChange={(e) => onUpdate({ address: e.target.value })}
          placeholder="0 or 0x0000"
          className="h-6 w-24 px-1.5 text-[11px]"
        />
      </Field>

      {row.mode === "read" ? (
        <Field label="Table">
          <Picker
            value={row.table}
            options={[...REGISTER_TYPES]}
            onChange={(v) => onUpdate({ table: v as RegisterTableType })}
          />
        </Field>
      ) : (
        <Field label="Target">
          <Picker
            value={row.target}
            options={["register", "coil"]}
            onChange={(v) => onUpdate({ target: v === "coil" ? "coil" : "register" })}
          />
        </Field>
      )}

      {!bits && (
        <>
          <Field label="Datatype">
            <Picker
              value={row.datatype}
              options={[...MODBUS_DATATYPES]}
              onChange={(v) => {
                if (isModbusDatatype(v)) onUpdate({ datatype: v });
              }}
            />
          </Field>
          {multiWord && (
            <Field label="Word order">
              <Picker
                value={row.byte_order}
                options={[...BYTE_ORDERS]}
                onChange={(v) => {
                  if (isByteOrder(v)) onUpdate({ byte_order: v });
                }}
              />
            </Field>
          )}
          <Field label="Scale">
            <Input
              value={String(row.scale)}
              onChange={(e) => {
                const next = Number(e.target.value);
                onUpdate({ scale: Number.isFinite(next) ? next : 1 });
              }}
              inputMode="decimal"
              className="h-6 w-16 px-1.5 text-[11px] tabular-nums"
            />
          </Field>
        </>
      )}

      {row.mode === "read" ? (
        <Field label="Count">
          <Input
            type="number"
            min={1}
            max={125}
            value={String(row.count)}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              onUpdate({ count: Number.isFinite(next) ? next : 1 });
            }}
            className="h-6 w-16 px-1.5 text-[11px] tabular-nums"
          />
        </Field>
      ) : bits ? (
        <Field label="Value">
          <Picker
            value={row.value.trim().toUpperCase() === "ON" ? "ON" : "OFF"}
            options={["ON", "OFF"]}
            onChange={(v) => onUpdate({ value: v })}
          />
        </Field>
      ) : (
        <Field label="Value">
          <Input
            value={row.value}
            onChange={(e) => onUpdate({ value: e.target.value })}
            inputMode="decimal"
            className="h-6 w-24 px-1.5 text-[11px] tabular-nums"
          />
        </Field>
      )}

      <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Picker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-6 w-[128px] px-1.5 text-[11px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option} className="text-[11px]">
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ─── Execution ──────────────────────────────────────────────────────────────

async function runRead(
  bridge: BridgeTransport,
  row: RawRow,
  plan: RawReadPlan,
): Promise<RawResult> {
  const res = await readRegister(bridge, row.agent, row.interface, {
    address: plan.address,
    reg_type: plan.table,
    count: plan.addressCount,
  });
  // `values` is number[] for word tables and boolean[] for bit tables; widen so
  // the array methods below aren't fighting a union of array types.
  const raw: Array<number | boolean> = res.values ?? [];
  if (isBitTable(plan.table)) {
    return {
      ok: true,
      at_ms: Date.now(),
      values: raw.map((v) => (v ? "ON" : "OFF")),
      words_hex: null,
      error: null,
    };
  }
  const words = raw.map((v) => Number(v));
  const values: string[] = [];
  for (let i = 0; i + plan.stride <= words.length; i += plan.stride) {
    const chunk = words.slice(i, i + plan.stride);
    values.push(formatDecodedValue(decodeValue(chunk, row.datatype, row.scale, row.byte_order)));
  }
  return {
    ok: true,
    at_ms: Date.now(),
    values,
    words_hex: formatWordsHex(words),
    error: null,
  };
}

async function runWrite(
  bridge: BridgeTransport,
  row: RawRow,
  plan: RawWritePlan,
): Promise<RawResult> {
  if (plan.kind === "coil") {
    await writeCoil(bridge, row.agent, row.interface, plan.address, plan.on);
    return {
      ok: true,
      at_ms: Date.now(),
      values: [plan.on ? "ON" : "OFF"],
      words_hex: null,
      error: null,
    };
  }
  const first = plan.words[0];
  if (plan.words.length === 1 && first !== undefined) {
    // FC6 for a single word, matching the extension's own `auto` write mode.
    await writeSingleRegister(bridge, row.agent, row.interface, plan.address, first);
  } else {
    await writeRegisters(bridge, row.agent, row.interface, plan.address, plan.words);
  }
  return {
    ok: true,
    at_ms: Date.now(),
    values: [row.value.trim()],
    words_hex: formatWordsHex(plan.words),
    error: null,
  };
}
