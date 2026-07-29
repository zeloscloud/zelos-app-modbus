/** One agent action at a time, with the same failure handling everywhere.
 *
 *  Every read, write and lifecycle toggle in this app wants the same four steps:
 *  mark itself busy, run, report a failure the shared way, clear. Hand-rolling
 *  that produced five copies of the same try/finally; this is the one copy.
 *
 *  The label is `<Kind> <target>` — "Read power/total", "Write raw coil @ 3",
 *  "Stop Modbus extension" — which is exactly what every call site was building
 *  by hand. The debug context is a thunk: the register/row snapshot that goes
 *  into a bug report is only worth assembling when there is a bug to report. */

import * as React from "react";

import { reportActionFailure } from "@/lib/errors";

export interface UseActionReturn<K extends string> {
  /** Which action is in flight, or null. Drives the disabled/spinning states. */
  busy: K | null;
  /** Fires `fn`, reporting any throw as `<Kind> <target> failed`. Extra debug
   *  fields (the value a write was carrying, say) merge into the payload.
   *
   *  A no-op while another action is in flight: the disabled states are the
   *  first line of defence, but a keyboard repeat or a double click can still
   *  land two calls before the re-render, and a second write is not something to
   *  send by accident. */
  run: (kind: K, fn: () => Promise<void>, extraDebug?: Record<string, unknown>) => void;
}

export function useAction<K extends string>(
  target: string,
  debugContext: () => Record<string, unknown>,
): UseActionReturn<K> {
  const [busy, setBusy] = React.useState<K | null>(null);

  // The caller's closures are rebuilt every render; keeping them in a ref lets
  // `run` stay identity-stable, which is what memoized rows need. `inFlight`
  // is a ref too, because two calls in one tick would both see the same state.
  const latest = React.useRef({ target, debugContext });
  latest.current = { target, debugContext };
  const inFlight = React.useRef(false);

  const run = React.useCallback(
    (kind: K, fn: () => Promise<void>, extraDebug?: Record<string, unknown>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(kind);
      void (async () => {
        try {
          await fn();
        } catch (e) {
          const { target: what, debugContext: context } = latest.current;
          reportActionFailure(`${capitalize(kind)} ${what}`, e, { ...context(), ...extraDebug });
        } finally {
          inFlight.current = false;
          setBusy(null);
        }
      })();
    },
    [],
  );

  return { busy, run };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
