/** TanStack Query hook for the per-interface `get_snapshot` poll.
 *
 *  Polls at 1 Hz. The action reads the extension's last-polled value cache —
 *  it never touches the device — so the cadence is independent of the interface's
 *  own poll interval and costs nothing on a slow RTU link.
 *
 *  Query keys are `["modbus-snapshot", agent, interface]`, so every component
 *  that wants this interface's values (header stats, each register row) shares a
 *  single underlying poll via TanStack's key dedup instead of fanning out one
 *  request per subscriber. */

import type { BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { getSnapshot } from "@/lib/modbus-bridge";
import type { ModbusSnapshot } from "@/lib/types";

const SNAPSHOT_POLL_MS = 1_000;

export function useSnapshot(
  bridge: BridgeTransport,
  agent: string,
  iface: string,
): UseQueryResult<ModbusSnapshot> {
  return useQuery<ModbusSnapshot>({
    queryKey: ["modbus-snapshot", agent, iface],
    queryFn: async () => getSnapshot(bridge, agent, iface),
    staleTime: SNAPSHOT_POLL_MS,
    refetchInterval: SNAPSHOT_POLL_MS,
    refetchOnWindowFocus: true,
  });
}
