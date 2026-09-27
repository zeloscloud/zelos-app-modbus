/** Shared failure UX: humanize an agent action error, log it, toast it with a
 *  copy-details escape hatch.
 *
 *  can-tx keeps this private to its AgentPanel; here several call sites need the
 *  same behavior (extension lifecycle, named register read/write, raw rows), so
 *  it lives in one place — reached through `useAction`, not called directly. */

import { toast } from "sonner";

import { copyToClipboard } from "./clipboard";
import { ModbusActionError } from "./modbus-bridge";
import { errorMessage } from "./utils";

/** Strip the bridge/dispatcher framing off an agent action error so toasts read
 *  cleanly.
 *
 *  A {@link ModbusActionError} already knows which part of itself the agent
 *  wrote: the detail is the message, framed or not. The extension's in-band
 *  failures are already clean sentences ("Register 'x' is not writable (type:
 *  input)") and deserve to be shown as they are, not behind a repeat of the
 *  action name the toast title already carries. Anything else — a foreign error
 *  — falls back to scanning the whole message. */
export function humanizeActionError(error: unknown): string {
  if (error instanceof ModbusActionError && error.detail !== null) {
    return unframe(error.detail) ?? error.detail;
  }
  const message = errorMessage(error);
  return unframe(message) ?? message;
}

/** The part after the agent's framing, or null when there was no framing. */
function unframe(raw: string): string | null {
  // Example raw: "Modbus write_named_register failed: status=fail, Execution
  // error: Python execution failed: ActionExecutionError: unit_id out of range."
  for (const marker of ["ActionExecutionError:", "Execution error:"]) {
    const idx = raw.indexOf(marker);
    if (idx >= 0) return raw.slice(idx + marker.length).trim();
  }
  return null;
}

/** What an unanswered write tells the user. */
export const WRITE_UNKNOWN_MESSAGE =
  "No response; the write may have landed; read back before retrying.";

/** Toast + console a failed action. `debug` is copied verbatim (as JSON) when
 *  the user clicks "Copy details", so put the whole request context in it. A
 *  write with an unknown outcome toasts amber, not red: it may have landed. */
export function reportActionFailure(
  label: string,
  error: unknown,
  debug: Record<string, unknown>,
): void {
  const payload = {
    label,
    ...debug,
    error: errorMessage(error),
    // A typed failure carries its pieces, so a bug report gets them unflattened.
    ...(error instanceof ModbusActionError
      ? {
          action: {
            method: error.method,
            status: error.status,
            detail: error.detail,
            outcome: error.outcome,
          },
        }
      : {}),
  };
  // Deliberate developer escape hatch: the toast is truncated, the console isn't.
  console.error("[MODBUS] action failed", payload);
  const unknown = error instanceof ModbusActionError && error.outcome === "unknown";
  const notify = unknown ? toast.warning : toast.error;
  notify(unknown ? `${label}: no response` : `${label} failed`, {
    description: unknown ? WRITE_UNKNOWN_MESSAGE : humanizeActionError(error),
    duration: 10000,
    action: {
      label: "Copy details",
      onClick: () => {
        // Use the iframe-aware clipboard helper (navigator.clipboard is blocked
        // under the zelos-app:// sandbox; the helper falls back to execCommand).
        void copyToClipboard(JSON.stringify(payload, null, 2)).then((ok) => {
          if (ok) toast.success("Failure details copied to clipboard");
          else toast.error("Clipboard blocked — see devtools console");
        });
      },
    },
  });
}
