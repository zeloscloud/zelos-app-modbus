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
  bridge: BridgeTransport,
  agent: string,
  iface: string,
  /** `map_name` from `list_interfaces`; null means raw-only (no catalog). */
  mapName: string | null,
  /** `register_count` from `list_interfaces`. Part of the key because a restart
   *  can swap the map's contents without changing its name, and this is the one
   *  observable that moves when it does. */
  registerCount: number,
): UseQueryResult<ListRegistersResult> {
  return useQuery<ListRegistersResult>({
    queryKey: ["modbus-registers", agent, iface, mapName, registerCount],
    queryFn: async () => listRegisters(bridge, agent, iface),
    // A raw-only interface has no catalog to fetch.
    enabled: mapName !== null,
    staleTime: mapName !== null ? Number.POSITIVE_INFINITY : UNKNOWN_MAP_STALE_MS,
    refetchOnWindowFocus: false,
  });
}
