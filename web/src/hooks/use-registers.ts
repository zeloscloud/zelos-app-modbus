/** TanStack Query hook for one device's register catalog.
 *
 *  A catalog changes only when the extension restarts with another map or
 *  auto-scan finds a register, and either moves `map_name` or `register_count`.
 *  Both are in the key, so an entry for a known key stays fresh forever. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { listRegisters } from "@/lib/modbus-bridge";
import type { ListRegistersResult, ModbusDeviceEntry } from "@/lib/types";

export function useRegisters(
  bridge: BridgeTransport,
  agent: string,
  device: ModbusDeviceEntry,
): UseQueryResult<ListRegistersResult> {
  return useQuery<ListRegistersResult>({
    queryKey: ["modbus-registers", agent, device.name, device.map_name, device.register_count],
    queryFn: async () => listRegisters(bridge, agent, device.name),
    // A device with no registers has no catalog to fetch.
    enabled: device.register_count > 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}
