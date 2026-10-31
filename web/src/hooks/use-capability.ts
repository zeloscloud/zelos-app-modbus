/** Composes `extensions.list`, `actions.list` and `Modbus/list_devices` (per
 *  agent), each polled every 5 s, into a `ModbusDiscovery` from the pure resolver.
 *
 *  Everything below memoizes on what this returns, so the per-agent device map is
 *  folded inside `useQueries` through `combine`, which reruns only when a result
 *  changes, rather than in a `useMemo` over a results array that is new every render. */

import { actions, extensions, type BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { listDevices } from "@/lib/modbus-bridge";
import { discoverModbus, type ModbusDiscovery } from "@/lib/capability";
import {
  MODBUS_EXTENSION_INSTALL_IDS,
  type ModbusDeviceEntry,
  type WorkspaceModeKind,
} from "@/lib/types";
import { errorMessage } from "@/lib/utils";

const DISCOVERY_POLL_MS = 5_000;

export interface UseModbusDiscoveryInput {
  bridge: BridgeTransport;
  workspaceModeKind: WorkspaceModeKind;
}

export function useModbusDiscovery(input: UseModbusDiscoveryInput): {
  discovery: ModbusDiscovery;
  isLoading: boolean;
  refetch: () => void;
} {
  const { bridge, workspaceModeKind } = input;
  const enabled = workspaceModeKind === "LIVE";

  const extensionsQuery = useQuery({
    queryKey: ["modbus-extensions-list"],
    queryFn: async () => extensions.list(bridge),
    enabled,
    staleTime: 2000,
    refetchInterval: enabled ? DISCOVERY_POLL_MS : false,
  });

  const actionsQuery = useQuery({
    queryKey: ["modbus-actions-list"],
    queryFn: async () => actions.list(bridge),
    enabled,
    staleTime: 2000,
    refetchInterval: enabled ? DISCOVERY_POLL_MS : false,
  });

  // Only ask `Modbus/list_devices` of agents that look like they're running
  // the Modbus extension — calling it against an agent that doesn't have it
  // produces a noisy "unknown action" error per poll cycle.
  const deviceAgents = useMemo<string[]>(() => {
    const byAgent = extensionsQuery.data;
    if (!byAgent) return [];
    const result: string[] = [];
    for (const [agent, exts] of Object.entries(byAgent)) {
      if (exts.some((e) => MODBUS_EXTENSION_INSTALL_IDS.has(e.id) && e.state === "running")) {
        result.push(agent);
      }
    }
    return result.sort();
  }, [extensionsQuery.data]);

  const devices = useQueries({
    queries: deviceAgents.map((agent) => ({
      queryKey: ["modbus-list-devices", agent],
      queryFn: async () => listDevices(bridge, agent),
      enabled,
      staleTime: 2000,
      refetchInterval: enabled ? DISCOVERY_POLL_MS : false,
    })),
    combine: (results) => ({
      byAgent: Object.fromEntries(
        deviceAgents.map((agent, i) => [agent, results[i]?.data?.devices]),
      ) as Record<string, ModbusDeviceEntry[] | undefined>,
      // A failure has to reach the resolver, or a permanently failing agent sits
      // on "Discovering devices…" forever.
      errorsByAgent: Object.fromEntries(
        deviceAgents.map((agent, i) => {
          const error = results[i]?.error;
          return [agent, error ? errorMessage(error) : undefined];
        }),
      ) as Record<string, string | undefined>,
      isLoading: results.some((r) => r.isLoading),
      refetch: () => results.forEach((r) => void r.refetch()),
    }),
  });

  const discovery = useMemo(
    () =>
      discoverModbus({
        workspaceModeKind,
        extensionsByAgent: extensionsQuery.data ?? null,
        actionsByAgent: actionsQuery.data ?? null,
        devicesByAgent: devices.byAgent,
        deviceErrorsByAgent: devices.errorsByAgent,
      }),
    [
      workspaceModeKind,
      extensionsQuery.data,
      actionsQuery.data,
      devices.byAgent,
      devices.errorsByAgent,
    ],
  );

  const queryClient = useQueryClient();
  const refetchExtensions = extensionsQuery.refetch;
  const refetchActions = actionsQuery.refetch;
  const refetchDevices = devices.refetch;
  const refetch = useCallback(() => {
    void refetchExtensions();
    void refetchActions();
    refetchDevices();
    // The register catalogs are cached forever on purpose (a map is immutable
    // for the life of an extension process), so Refresh is the only thing that
    // can retire one after a restart — or retry one that failed.
    void queryClient.invalidateQueries({ queryKey: ["modbus-registers"] });
  }, [refetchExtensions, refetchActions, refetchDevices, queryClient]);

  return {
    discovery,
    isLoading: extensionsQuery.isLoading || actionsQuery.isLoading || devices.isLoading,
    refetch,
  };
}
