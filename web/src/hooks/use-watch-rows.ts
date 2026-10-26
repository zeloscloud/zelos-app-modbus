/** Thin hook over the localStorage row store. Every inline edit goes through
 *  `patchRow`, so the table/datatype coherence rule lives in exactly one place
 *  no matter who calls. */

import * as React from "react";

import {
  createRow,
  loadRows,
  patchRow,
  saveRows,
  type NewWatchRow,
  type RowPatch,
  type WatchRow,
} from "@/lib/watch-store";

export interface UseWatchRowsReturn {
  rows: readonly WatchRow[];
  addRow: (input: NewWatchRow) => WatchRow;
  /** Commits an inline edit — a write draft on any row, metadata on a raw one. */
  updateRow: (id: string, patch: RowPatch) => void;
  removeRow: (id: string) => void;
}

export function useWatchRows(): UseWatchRowsReturn {
  const [rows, setRows] = React.useState<readonly WatchRow[]>(() => loadRows());

  React.useEffect(() => {
    saveRows(rows);
  }, [rows]);

  const addRow = React.useCallback((input: NewWatchRow): WatchRow => {
    const row = createRow(input);
    setRows((prev) => [...prev, row]);
    return row;
  }, []);

  const updateRow = React.useCallback((id: string, patch: RowPatch): void => {
    setRows((prev) => prev.map((r) => (r.id === id ? patchRow(r, patch) : r)));
  }, []);

  const removeRow = React.useCallback((id: string): void => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  return { rows, addRow, updateRow, removeRow };
}
