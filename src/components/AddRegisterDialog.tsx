/** The add-a-row dialog: pick a register out of the catalog, or start a raw one.
 *
 *  The catalog is read-only browsing — search, then click a register to add it.
 *  Adding anything closes the dialog, because the new row is the thing the user
 *  wants to touch next (a raw row needs its address; a named row may want a write
 *  value). Duplicates are allowed and deliberately unmarked: several rows on one
 *  register, each latching a different write value, is how presets are built.
 *
 *  Nothing about a register is editable here — a named row is identity only, and
 *  every value/format decision happens in the table. */

import { Lock, Pencil, Plus } from "lucide-react";
import * as React from "react";

import { TableBadge } from "@/components/RegisterTable";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatAddress } from "@/lib/codec";
import type { RegisterEntry } from "@/lib/types";

export interface AddRegisterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Implicit from whichever interface section opened the dialog — no in-dialog
   *  picker for the agent or the interface. */
  interfaceName: string;
  /** The interface's catalog, from `list_registers`. Empty for a raw-only
   *  interface, which can still add raw rows. */
  registers: readonly RegisterEntry[];
  onAdd: (register: RegisterEntry) => void;
  /** Appends an arbitrary-address row, to be edited inline in the table. */
  onAddRaw: () => void;
}

/** Memoized: while it is open, the interface behind it keeps re-rendering at
 *  1 Hz, and rebuilding a whole catalog of options for each snapshot is pure
 *  waste. Every prop it takes is stable. */
export const AddRegisterDialog = React.memo(function AddRegisterDialog({
  open,
  onOpenChange,
  interfaceName,
  registers,
  onAdd,
  onAddRaw,
}: AddRegisterDialogProps) {
  const [query, setQuery] = React.useState("");

  // Every visit starts from the whole catalog rather than the last search.
  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const groups = React.useMemo(
    () => groupByEvent(filterRegisters(registers, query)),
    [registers, query],
  );
  const matchCount = groups.reduce((sum, g) => sum + g.registers.length, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Add a row</DialogTitle>
          <DialogDescription>
            {registers.length} register{registers.length === 1 ? "" : "s"} in{" "}
            <code className="font-mono">{interfaceName}</code>&apos;s map.
          </DialogDescription>
        </DialogHeader>

        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 self-start text-xs"
          onClick={() => {
            onAddRaw();
            onOpenChange(false);
          }}
          title="Append an arbitrary-address row (holding, uint16, address 0) and edit it in the table"
        >
          <Plus className="h-3 w-3" />
          Add raw row
        </Button>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, path or unit…"
          aria-label="Search registers"
          className="shrink-0"
        />

        <div className="-mx-1 flex-1 overflow-y-auto px-1">
          {registers.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              This interface has no register map, so there are no named registers to add. Use{" "}
              <strong>Add raw row</strong>.
            </p>
          ) : matchCount === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No registers match <code className="font-mono">{query}</code>.
            </p>
          ) : (
            groups.map(({ event, registers: rows }) => (
              <div key={event} className="mb-2 last:mb-0">
                <div className="sticky top-0 bg-background py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {event}
                </div>
                <div className="flex flex-col">
                  {rows.map((reg) => (
                    <RegisterOption
                      key={reg.path}
                      reg={reg}
                      onAdd={() => {
                        onAdd(reg);
                        onOpenChange(false);
                      }}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});

function RegisterOption({ reg, onAdd }: { reg: RegisterEntry; onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      title={reg.description || `Add ${reg.path}`}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
    >
      <span className="min-w-0 flex-1 truncate font-medium">{reg.name}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {formatAddress(reg.address)}
      </span>
      <TableBadge type={reg.type} />
      <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground">
        {reg.datatype}
      </span>
      <span className="w-10 shrink-0 text-[10px] text-muted-foreground">{reg.unit || "—"}</span>
      <span className="shrink-0 text-muted-foreground">
        {reg.writable ? <Pencil className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
        <span className="sr-only">{reg.writable ? "writable" : "read-only"}</span>
      </span>
    </button>
  );
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Case-insensitive match on path (which carries the event and the name) and
 *  unit. An empty query keeps the whole catalog. */
export function filterRegisters(
  registers: readonly RegisterEntry[],
  query: string,
): readonly RegisterEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return registers;
  return registers.filter(
    (reg) =>
      reg.path.toLowerCase().includes(q) ||
      reg.name.toLowerCase().includes(q) ||
      reg.unit.toLowerCase().includes(q),
  );
}

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
