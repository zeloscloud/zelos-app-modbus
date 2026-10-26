/** The table runs behind a 1 Hz poll, so rows have to be memoized well enough
 *  that a tick costs only the rows whose value moved and a keystroke costs only
 *  the row being typed in. That is a property of the row props' identities, which
 *  is invisible from the DOM — so it is counted here instead, through the one
 *  pure helper every named row calls exactly once per render. */

import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { RegisterTable } from "../RegisterTable";
import { bridgeStub, namedRow, register, snapshot } from "./register-fixtures";
import type { ModbusSnapshot } from "@/lib/types";
import { patchRow, type WatchRow } from "@/lib/watch-store";

/** One entry per named-row render, in render order. */
const renders: string[] = [];

vi.mock("@/lib/row-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/row-view")>();
  return {
    ...actual,
    typeSummary: (reg: Parameters<typeof actual.typeSummary>[0]) => {
      renders.push(reg.path);
      return actual.typeSummary(reg);
    },
  };
});

const CATALOG = [
  register({ event: "power", name: "total", address: 12 }),
  register({ event: "power", name: "factor", address: 14 }),
];

const BRIDGE = bridgeStub();
const INITIAL_ROWS: readonly WatchRow[] = [namedRow("power/total"), namedRow("power/factor")];
const NOOP = () => {};

/** Mirrors the real ownership: the bridge and the row callbacks are stable, the
 *  snapshot is what changes. */
function Harness({ snap }: { snap: ModbusSnapshot }) {
  const [rows, setRows] = React.useState<readonly WatchRow[]>(INITIAL_ROWS);
  const onUpdateRow = React.useCallback(
    (id: string, p: Parameters<typeof patchRow>[1]) =>
      setRows((prev) => prev.map((r) => (r.id === id ? patchRow(r, p) : r))),
    [],
  );
  return (
    <RegisterTable
      bridge={BRIDGE}
      agentAddress="localhost:2300"
      interfaceName="meter"
      interfacePollInterval={1}
      registers={CATALOG}
      rows={rows}
      catalogReady
      snapshot={snap}
      onUpdateRow={onUpdateRow}
      onRemoveRow={NOOP}
      onAdd={NOOP}
    />
  );
}

function snapAt(total: number, factor: number, ts: number): ModbusSnapshot {
  return snapshot(
    { "power/total": { value: total, ts_ms: ts }, "power/factor": { value: factor, ts_ms: ts } },
    ts,
  );
}

describe("RegisterTable row memoization", () => {
  it("re-renders only the rows that changed", () => {
    const t0 = 1_700_000_000_000;
    const view = render(<Harness snap={snapAt(1, 2, t0)} />);
    expect(renders).toEqual(["power/total", "power/factor"]);

    // A tick where nothing moved: no row re-renders.
    renders.length = 0;
    view.rerender(<Harness snap={snapAt(1, 2, t0)} />);
    expect(renders).toEqual([]);

    // A tick where one value moved: only that row re-renders.
    renders.length = 0;
    view.rerender(<Harness snap={snapAt(9, 2, t0 + 1000)} />);
    expect(renders).toEqual(["power/total"]);

    // A keystroke in one row's editor: only that row re-renders.
    renders.length = 0;
    fireEvent.change(screen.getByLabelText("New value for power/factor"), {
      target: { value: "5" },
    });
    expect(renders).toEqual(["power/factor"]);
  });
});
