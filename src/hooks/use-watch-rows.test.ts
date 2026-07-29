/** The add/edit/remove flow the table drives: adds land at the end of the list,
 *  edits go through the store's coherence rule, and everything is persisted
 *  immediately so a reload comes back with the same table. */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { createRow, defaultRawRow, loadRows, saveRows, type WatchRow } from "@/lib/watch-store";

import { useWatchRows } from "./use-watch-rows";

const AGENT = "localhost:2300";

function named(path: string) {
  return { kind: "named", agent: AGENT, interface: "meter", path } as const;
}

/** Paths for named rows, `raw` for anything else — enough to assert ordering. */
function shape(rows: readonly WatchRow[]): string[] {
  return rows.map((r) => (r.kind === "named" ? r.path : "raw"));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("useWatchRows", () => {
  it("starts from whatever localStorage already holds", () => {
    saveRows([createRow(named("power/total"))]);
    const { result } = renderHook(() => useWatchRows());
    expect(shape(result.current.rows)).toEqual(["power/total"]);
  });

  it("appends each added row, named or raw, and persists it", () => {
    const { result } = renderHook(() => useWatchRows());
    act(() => {
      result.current.addRow(named("power/total"));
    });
    act(() => {
      result.current.addRow(defaultRawRow(AGENT, "meter"));
    });
    act(() => {
      result.current.addRow(named("status/relay1"));
    });
    expect(shape(result.current.rows)).toEqual(["power/total", "raw", "status/relay1"]);
    expect(shape(loadRows())).toEqual(["power/total", "raw", "status/relay1"]);
  });

  it("adds the same register twice, because duplicates are presets", () => {
    const { result } = renderHook(() => useWatchRows());
    act(() => {
      result.current.addRow(named("power/total"));
      result.current.addRow(named("power/total"));
    });
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.rows[0]?.id).not.toBe(result.current.rows[1]?.id);
  });

  it("returns the created row so callers can address it by id", () => {
    const { result } = renderHook(() => useWatchRows());
    let id = "";
    act(() => {
      id = result.current.addRow(named("power/total")).id;
    });
    expect(result.current.rows[0]?.id).toBe(id);
  });

  it("persists a write draft against the row it was typed on", () => {
    const { result } = renderHook(() => useWatchRows());
    let first = "";
    act(() => {
      first = result.current.addRow(named("power/total")).id;
      result.current.addRow(named("power/total"));
    });
    act(() => {
      result.current.updateRow(first, { draft: "12.5" });
    });
    expect(result.current.rows.map((r) => r.draft)).toEqual(["12.5", undefined]);
    expect(loadRows().map((r) => r.draft)).toEqual(["12.5", undefined]);
  });

  it("commits a raw row's metadata edit through the coherence rule", () => {
    const { result } = renderHook(() => useWatchRows());
    let id = "";
    act(() => {
      id = result.current.addRow(defaultRawRow(AGENT, "meter")).id;
    });
    act(() => {
      result.current.updateRow(id, { address: "0x64", datatype: "float32" });
    });
    act(() => {
      result.current.updateRow(id, { table: "coil" });
    });
    // Switching to a bit table drags the datatype with it.
    expect(loadRows()[0]).toMatchObject({ address: "0x64", table: "coil", datatype: "bool" });
  });

  it("leaves other rows alone when one is edited", () => {
    const { result } = renderHook(() => useWatchRows());
    let id = "";
    act(() => {
      id = result.current.addRow(defaultRawRow(AGENT, "meter")).id;
      result.current.addRow(defaultRawRow(AGENT, "meter"));
    });
    act(() => {
      result.current.updateRow(id, { address: "50" });
    });
    expect(loadRows().map((r) => (r.kind === "raw" ? r.address : null))).toEqual(["50", "0"]);
  });

  it("removes only the requested row, and persists that too", () => {
    const { result } = renderHook(() => useWatchRows());
    let id = "";
    act(() => {
      id = result.current.addRow(named("power/total")).id;
      result.current.addRow(named("status/relay1"));
    });
    act(() => {
      result.current.removeRow(id);
    });
    expect(shape(result.current.rows)).toEqual(["status/relay1"]);
    expect(shape(loadRows())).toEqual(["status/relay1"]);
  });
});
