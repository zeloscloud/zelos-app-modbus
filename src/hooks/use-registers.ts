/** TanStack Query hook for the per-interface register catalog.
 *
 *  The map is immutable for the life of the extension process — it only changes
 *  when the extension restarts with a different config — so the map name is part
 *  of the query key and a known name makes the entry permanently fresh. When the
 *  name isn't known yet (list_interfaces still in flight) we fall back to a 30 s
 *  staleTime so the catalog still lands without a manual refresh. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { listRegisters } from "@/lib/modbus-bridge";
import type { ListRegistersResult } from "@/lib/types";

const UNKNOWN_MAP_STALE_MS = 30_000;

export function useRegisters(
  bridge: BridgeTransport | null,
  agent: string | null,
  iface: string | null,
  /** `map_name` from `list_interfaces`; null means raw-only (no catalog). */
  mapName: string | null,
): UseQueryResult<ListRegistersResult> {
  const enabled = bridge !== null && agent !== null && iface !== null && mapName !== null;
  return useQuery<ListRegistersResult>({
    queryKey: ["modbus-registers", agent, iface, mapName],
    queryFn: async () => {
      if (!bridge || !agent || !iface) {
        throw new Error("useRegisters: bridge/agent/interface missing");
      }
      return await listRegisters(bridge, agent, iface);
    },
    enabled,
    staleTime: mapName !== null ? Number.POSITIVE_INFINITY : UNKNOWN_MAP_STALE_MS,
    refetchOnWindowFocus: false,
  });
}
