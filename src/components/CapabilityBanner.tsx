/** Top-level banner — shown only when discovery itself is disabled.
 *
 *  Per-agent issues (extension missing, stopped, outdated, no interfaces) live
 *  in the agent cards. This banner covers the two cases that aren't
 *  agent-specific: workspace not LIVE, and zero agents connected at all. */

import type { TopLevelDisabledReason } from "@/lib/capability";

const DISABLED_COPY: Record<TopLevelDisabledReason, string> = {
  "not-live": "Modbus control requires a LIVE workspace. Switch to LIVE to continue.",
  "no-agents-connected":
    "No agents are reachable from this workspace. Add an agent in the desktop's workspace settings, then refresh.",
};

export interface CapabilityBannerProps {
  reason: TopLevelDisabledReason;
  onRefresh: () => void;
}

export function CapabilityBanner({ reason, onRefresh }: CapabilityBannerProps) {
  return (
    <section
      role="status"
      aria-live="polite"
      className="rounded-lg border border-border bg-card p-6 space-y-3"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Modbus control unavailable
      </h2>
      <p className="text-sm">{DISABLED_COPY[reason]}</p>
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          onClick={onRefresh}
          className="rounded border border-border px-3 py-1.5 hover:bg-background"
        >
          Refresh
        </button>
        <span className="text-muted-foreground">
          reason: <code>{reason}</code>
        </span>
      </div>
    </section>
  );
}
