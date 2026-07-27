/** CapabilityBanner covers only the top-level disabled cases (not-live,
 *  no-agents-connected). Per-agent issues live in the agent cards. */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CapabilityBanner } from "../CapabilityBanner";
import type { TopLevelDisabledReason } from "@/lib/capability";

const REASONS: readonly TopLevelDisabledReason[] = ["not-live", "no-agents-connected"];

describe("CapabilityBanner", () => {
  it.each(REASONS)("renders distinct copy for top-level reason %s", (reason) => {
    render(<CapabilityBanner reason={reason} onRefresh={vi.fn()} />);
    // The reason chip in the footer should display the exact reason string.
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("not-live banner mentions the LIVE workspace requirement", () => {
    render(<CapabilityBanner reason="not-live" onRefresh={vi.fn()} />);
    expect(screen.getByText(/LIVE workspace/i)).toBeInTheDocument();
  });

  it("no-agents-connected banner mentions adding an agent", () => {
    render(<CapabilityBanner reason="no-agents-connected" onRefresh={vi.fn()} />);
    expect(screen.getByText(/No agents are reachable/i)).toBeInTheDocument();
  });
});
