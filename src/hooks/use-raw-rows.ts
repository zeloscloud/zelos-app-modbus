/** Thin hook over the localStorage raw-row store. Provides CRUD operations with
 *  stable identities so React can re-render only the affected rows. */

import * as React from "react";

import { createRow, loadRows, saveRows, type NewRawRow, type RawRow } from "@/lib/raw-store";

export interface UseRawRowsReturn {
  rows: readonly RawRow[];
  addRow: (input: NewRawRow) => RawRow;
  updateRow: (id: string, patch: Partial<RawRow>) => void;
  removeRow: (id: string) => void;
}

export function useRawRows(): UseRawRowsReturn {
  const [rows, setRows] = React.useState<readonly RawRow[]>(() => loadRows());

  React.useEffect(() => {
    saveRows(rows);
  }, [rows]);

  const addRow = React.useCallback((input: NewRawRow): RawRow => {
    const row = createRow(input);
    setRows((prev) => [...prev, row]);
    return row;
  }, []);

  const updateRow = React.useCallback((id: string, patch: Partial<RawRow>): void => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const removeRow = React.useCallback((id: string): void => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  return { rows, addRow, updateRow, removeRow };
}
