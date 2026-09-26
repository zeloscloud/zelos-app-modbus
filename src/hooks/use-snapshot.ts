/** TanStack Query hook for the per-device `get_snapshot` poll.
 *
 *  Polls at 1 Hz. The action reads the extension's last-polled value cache —
 *  it never touches the device — so the cadence is independent of the device's
 *  own poll interval and costs nothing on a slow RTU link.
 *
 *  Query keys are `["modbus-snapshot", agent, device]`, so every component
 *  that wants this device's values (header stats, each register row) shares a
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
  device: string,
): UseQueryResult<ModbusSnapshot> {
  return useQuery<ModbusSnapshot>({
    queryKey: ["modbus-snapshot", agent, device],
    queryFn: async () => getSnapshot(bridge, agent, device),
    staleTime: SNAPSHOT_POLL_MS,
    refetchInterval: SNAPSHOT_POLL_MS,
    refetchOnWindowFocus: true,
  });
}
