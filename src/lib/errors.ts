/** Shared failure UX: humanize an agent action error, log it, toast it with a
 *  copy-details escape hatch.
 *
 *  can-tx keeps this private to its AgentPanel; here three call sites need the
 *  same behavior (extension lifecycle, named register read/write, raw rows), so
 *  it lives in one place. */

import { toast } from "sonner";

import { copyToClipboard } from "./clipboard";

/** Strip the bridge/dispatcher framing off agent action errors so toasts read
 *  cleanly. Falls back to the raw message if no known pattern matches. */
export function humanizeActionError(raw: string): string {
  // Example raw: "Modbus write_named_register failed: status=fail, Execution
  // error: Python execution failed: ActionExecutionError: unit_id out of range."
  const pythonMarker = "ActionExecutionError:";
  const idx = raw.indexOf(pythonMarker);
  if (idx >= 0) return raw.slice(idx + pythonMarker.length).trim();
  const reasonMarker = "Execution error:";
  const ridx = raw.indexOf(reasonMarker);
  if (ridx >= 0) return raw.slice(ridx + reasonMarker.length).trim();
  return raw;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Toast + console a failed action. `debug` is copied verbatim (as JSON) when
 *  the user clicks "Copy details", so put the whole request context in it. */
export function reportActionFailure(
  label: string,
  error: unknown,
  debug: Record<string, unknown>,
): void {
  const message = errorMessage(error);
  const payload = { label, ...debug, error: message };
  // Deliberate developer escape hatch: the toast is truncated, the console isn't.
  console.error("[MODBUS] action failed", payload);
  toast.error(`${label} failed`, {
    description: humanizeActionError(message),
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
